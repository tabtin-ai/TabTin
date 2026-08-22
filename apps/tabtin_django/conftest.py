"""Root conftest for the Django project.

Responsibilities:
1. Ensure DJANGO_SETTINGS_MODULE is set before Django setup
2. Patch RUNNING_TESTS so test-only cache settings kick in
3. Auto-mark tests in known infra-debt files so targeted suites stay useful
4. Hard-isolate ``settings_*_test.py`` test files (see below)

Marker / skip mechanisms:
- ``collect_ignore``: files with import-time errors that break collection
- ``_REQUIRES_PG_NATIVE`` marker: tests that need real PostgreSQL (ARRAY[],
  ::type casts, pg_indexes, etc.) — explicit SQLite compatibility suites cannot run them
- ``_INFRA_DRIFT`` marker: tests whose mocks/stubs drifted from the current
  API surface — they can be collected but fail at runtime

==============================================================================
Isolated-settings test files: design + CI contract
==============================================================================

Some test files target Django apps whose migration history contains DDL that
**only** runs under PG / MySQL (PG GIN/tsvector, MySQL FULLTEXT, MySQL
``CONVERT TO CHARACTER SET utf8mb4``, etc.). Under explicit SQLite
compatibility settings these statements explode at ``django_db_setup`` time,
before any test body runs. The fix is per-file dedicated settings — see
``tabtin/settings_permission_audit_test.py`` and
``tabtin/settings_approval_memo_test.py`` for the pattern (in-memory SQLite +
``MIGRATION_MODULES = _DisableMigrations()`` + minimal ``INSTALLED_APPS``).

This conftest enforces a strict invariant for those files:

  **An isolated test file may ONLY run under its own dedicated settings.
  It is hard-excluded from collection in every other settings module
  (including the main ``tabtin.settings``).**

Why hard-exclude (not "skip with marker"): pytest-django's session-scoped
``django_db_setup`` fixture walks ALL collected items — including those
deselected by ``unittest.skipIf`` or pytest markers — to compute which DB
aliases need ``setup_databases``. Once an isolated file is *collected* under
main settings, its ``databases = {"default", "postgresql"}`` may force an
incompatible DB setup under SQLite compatibility jobs and die on the per-app
MySQL-only / PG-only DDL mentioned above, before the skip even gets a chance
to fire.

Two cooperating mechanisms enforce the invariant:

1. ``_ISOLATED_SETTINGS_HINTS`` (auto-route): when **every** positional pytest
   target matches the same hint substring, this conftest pre-sets
   ``DJANGO_SETTINGS_MODULE`` to the dedicated isolated settings *before*
   pytest-django imports it. Lets ``pytest path/to/test_isolated.py`` Just
   Work without ``--ds=...``.

2. ``_ISOLATED_TEST_FILES`` + ``pytest_ignore_collect`` (hard-exclude): when
   the active settings module is NOT the one required by an isolated file,
   that file is dropped from collection entirely. Note: plain ``collect_ignore``
   is **not** sufficient here — pytest's collection skips ``collect_ignore``
   for files that appear *explicitly* on the command line (a deliberate
   "user asked for it, give it to them" behaviour). ``pytest_ignore_collect``
   runs for **both** explicit and recursive collection paths, so it's the
   only correct hook to enforce this invariant uniformly.

Test job contract — read this before adding a new isolated test file:

  * The main ``pytest`` job runs under ``tabtin.settings`` and local
    PostgreSQL by default. It silently skips every file in
    ``_ISOLATED_TEST_FILES`` (zero coverage for them).
  * Each isolated settings module therefore needs its own dedicated CI job
    of the form:

        pytest --ds=tabtin.settings_<name>_test \\
               apps/<package>/tests/test_<name>.py

    Without that job the tests under ``settings_<name>_test.py`` are
    effectively un-run in CI. Add the job at the same time you add the
    isolated test file.

  * Mixed / directory / full-suite invocations (e.g.
    ``pytest apps/services/`` or ``pytest`` with no args) are an
    **isolated-files-skipped** environment by design — they will never run
    those tests. Any future "main suite must include isolated files"
    proposal needs to first solve the migration-DDL problem above.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Isolated-settings auto-routing (must run BEFORE the setdefault below).
#
# Each entry: ``"<basename hint in test path>": "<dedicated settings module>"``.
# A target matches when the hint substring appears in the target string
# (filepath / directory / nodeid). Switching only happens when *every*
# positional target on the command line matches the same hint.
# ---------------------------------------------------------------------------
_ISOLATED_SETTINGS_HINTS: dict[str, str] = {
    "test_permission_audit_model": "tabtin.settings_permission_audit_test",
    "test_approval_rules_service": "tabtin.settings_approval_memo_test",
    # W3-轮 1：cancel_pending_approvals_by_thread 单测复用 PermissionAudit 表
    # 的 isolated settings（同模式 in-memory SQLite + 禁 migration syncdb），
    # 避免主 settings 路径撞 PG-only DDL。
    "test_approval_cancel": "tabtin.settings_permission_audit_test",
    # Wave 2 协作者邀请 / 管理 service 单测（TabDoc + TabData 对称）。
    "test_share_service": "tabtin.settings_share_test",
    # Wave 5 §H / ：离队级联走本机 PostgreSQL（避免双库 SQLite FK teardown 坑）。
    "test_cascade_service": "tabtin.settings_cascade_pg_test",
    "test_password_migration": "tabtin.settings_share_test",
    # W7「Agent 产物在 Space 内的打开」专题 — telemetry endpoint 集成测试。
    # 主 settings 走 SQLite syncdb 时撞 services/billing/0024 / payment/0007 的
    # MySQL 专用 CONVERT TO CHARACTER SET utf8mb4 DDL 语法错。
    "test_resource_open_telemetry": "tabtin.settings_resource_open_telemetry_test",
    # yolo PR3 模式延伸：``update_agent`` 字段级审计扩展测试。复用 share_test
    # 隔离 settings（in-memory SQLite + tabtinspace + users + 禁 migration syncdb），
    # 同样绕过主 settings 的 PG/MySQL 专用 DDL。
    "test_agent_update_audit_expanded": "tabtin.settings_share_test",
    # IA Phase 3 §8.5 P1：Agent PUT 改 exclude_unset 修"清回继承"被剥的端到端
    # 单测（router 转换 → service.update_agent → DB → resolver）。复用 share_test
    # 隔离 settings（同 audit_expanded 理由：tabtinspace 全模型 syncdb 到 in-memory
    # SQLite，绕过主 settings 的 billing/payment MySQL DDL + tabdata PG ARRAY[]）。
    "test_agent_update_exclude_unset": "tabtin.settings_share_test",
    # ：手机号邀请（phone → user 解析 + direct 邀请）service 单测，
    # 复用 share_test 隔离 settings（tabtinspace + users，绕过主 settings DDL）。
    "test_invitation_phone": "tabtin.settings_share_test",
    # ：新用户默认 Agent onboarding 单测。复用 share_test 隔离 settings
    # （tabtinspace + users，绕过主 settings DDL）。
    "test_default_agent_onboarding": "tabtin.settings_share_test",
    # work_type 主线：create_bot_space router 透传 working_dir/working_dir_type
    # 落库回归。复用 share_test 隔离 settings（同上理由：tabtinspace 全模型 syncdb
    # 到 in-memory SQLite，绕过主 settings 的 billing/payment MySQL DDL + tabdata
    # PG ARRAY[]）。
    "test_create_bot_space_working_dir": "tabtin.settings_share_test",
    # 设置 IA Phase 1·1C：MCP 后端模型单测。tabtinspace 全模型 syncdb 到
    # in-memory SQLite（含新 MCPConnection 表 + SecureCredential.device 列），
    # 绕过主 settings 的 billing/payment MySQL DDL + tabdata PG ARRAY[]。
    "test_mcp_connection": "tabtin.settings_share_test",
    # 设置 IA Phase 2：UserProfile.ui_settings 同步 API 单测。被测 profile_routes
    # import 链很深（经 api/__init__ + _shared），需全量 app；双 SQLite + syncdb
    # 绕过 billing 的 MySQL CONVERT DDL + tabdata PG ARRAY[]（同 pending_tool_result）。
    "test_ui_settings_sync": "tabtin.settings_ui_settings_test",
    # 设置 IA Phase 3 §8.6：UserProfile.personal_rules 读写 API 单测（三层规则·个人
    # 基线层）。同 ui_settings 域（profile_routes 深 import 链经 api/__init__ + _shared），
    # 复用同一 isolated settings（双 SQLite + syncdb，绕过 billing MySQL DDL + tabdata PG ARRAY[]）。
    "test_personal_rules": "tabtin.settings_ui_settings_test",
    # ：PUT /profile/settings 保存（语言）防回归单测。同 profile_routes 深 import
    # 链（api/__init__ + _shared），复用同一 isolated settings。
    "test_profile_settings_save": "tabtin.settings_ui_settings_test",
}


def _resolve_isolated_settings(argv: list[str]) -> str | None:
    """Return the isolated settings module if all targets share one hint.

    A "target" is any positional argv entry that doesn't start with ``-`` and
    isn't an addopts-style ``key=value`` pair. We deliberately keep the parser
    cheap — pytest's own argument splitter is far more permissive, but for
    the narrow auto-route use case (``pytest path/to/test_file.py``) the
    simple heuristic suffices and avoids hard-to-reason silent branches.
    """
    targets = [
        a for a in argv[1:]
        if a and not a.startswith("-") and "=" not in a
    ]
    if not targets:
        return None

    matched: set[str] = set()
    for target in targets:
        for hint, settings_module in _ISOLATED_SETTINGS_HINTS.items():
            if hint in target:
                matched.add(settings_module)
                break
        else:
            return None  # at least one target is unrelated → don't switch

    if len(matched) == 1:
        return next(iter(matched))
    return None


_isolated_settings = _resolve_isolated_settings(sys.argv)
if _isolated_settings:
    # 单文件 isolated 跑场景：覆盖任何已有值（包括 pytest-django 从 pytest.ini
    # 写入的兜底值），让 ``settings_*_test.py`` 在 ``pytest_configure`` trylast 阶段
    # 被 ``_setup_django`` 真正加载。
    os.environ["DJANGO_SETTINGS_MODULE"] = _isolated_settings

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

_CONFTEST_DIR = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------
# Infra-debt registry: test *files* whose failures are caused by
# infrastructure mismatch, NOT by business-logic bugs.
#
# Bucket 1 – requires_pg_native
#   SQLite cannot emulate PG ARRAY[] / ::type casts / pg_indexes etc.
#   These tests must stay on real PostgreSQL with the native table schema.
#
# Bucket 2 – infra_drift
#   Mock/stub/fixture no longer matches current API surface (renamed
#   methods, changed signatures, missing django_db mark, etc.).
#   Fixing them requires updating test infrastructure, not prod code.
# ---------------------------------------------------------------------------

_REQUIRES_PG_NATIVE: set[str] = {
    "apps/services/agent_engine/tests/test_pending_interaction_service.py",
    # ---- tabdata (1181 ERRORs: sqlite3.OperationalError: near "[]") ----
    "apps/tabdata/tests/test_agent_sql.py",
    "apps/tabdata/tests/test_api.py",
    "apps/tabdata/tests/test_attachment_cleanup.py",
    "apps/tabdata/tests/test_attachment_service.py",
    "apps/tabdata/tests/test_cascade_service.py",
    "apps/tabdata/tests/test_cd003_list_connectors.py",
    "apps/tabdata/tests/test_collab_ydoc_merge_window.py",
    "apps/tabdata/tests/test_cr035_cr036_cr037_concurrency.py",
    "apps/tabdata/tests/test_cross_db.py",
    "apps/tabdata/tests/test_de17_de18_security.py",
    "apps/tabdata/tests/test_de19_jwt_scope_narrowing.py",
    "apps/tabdata/tests/test_default_fields.py",
    "apps/tabdata/tests/test_dual_write.py",
    "apps/tabdata/tests/test_dv007_dv009_dv019_dv021_dv023_regression.py",
    "apps/tabdata/tests/test_fh012_bulk_create_race.py",
    "apps/tabdata/tests/test_field_conversion_service.py",
    "apps/tabdata/tests/test_field_type_validation.py",
    "apps/tabdata/tests/test_form_password_security.py",
    "apps/tabdata/tests/test_hierarchical_api.py",
    "apps/tabdata/tests/test_history_events.py",
    "apps/tabdata/tests/test_import_export_enhanced.py",
    "apps/tabdata/tests/test_link_field_cross_space_security.py",
    "apps/tabdata/tests/test_link_field_e2e.py",
    "apps/tabdata/tests/test_linkable_records_selection.py",
    "apps/tabdata/tests/test_models.py",
    "apps/tabdata/tests/test_native_foundation.py",
    "apps/tabdata/tests/test_native_read.py",
    "apps/tabdata/tests/test_open_api_adjacent_guards.py",
    "apps/tabdata/tests/test_open_api_exchange.py",
    "apps/tabdata/tests/test_open_api_idempotency.py",
    "apps/tabdata/tests/test_open_space_api.py",
    "apps/tabdata/tests/test_perf_admin_summary.py",
    "apps/tabdata/tests/test_permissions.py",
    "apps/tabdata/tests/test_phase3_cleanup.py",
    "apps/tabdata/tests/test_record_change_log.py",
    "apps/tabdata/tests/test_record_collab_sync.py",
    "apps/tabdata/tests/test_collab_ydoc_anchor.py",
    "apps/tabdata/tests/test_record_service_search.py",
    "apps/tabdata/tests/test_remove_field_column_meta.py",
    "apps/tabdata/tests/test_sdi_024_token_space_permission.py",
    "apps/tabdata/tests/test_search_index_service.py",
    "apps/tabdata/tests/test_services.py",
    "apps/tabdata/tests/test_sub_record_api.py",
    "apps/tabdata/tests/test_sub_record_service.py",
    "apps/tabdata/tests/test_table_api.py",
    "apps/tabdata/tests/test_undo_redo.py",
    "apps/tabdata/tests/test_undo_redo_structure_ops.py",
    "apps/tabdata/tests/test_version_sync_tokens.py",
    "apps/tabdata/tests/test_view_api.py",
    "apps/tabdata/tests/test_view_data_service.py",
    "apps/tabdata/tests/test_view_validators.py",
    "apps/tabdata/tests/test_organization_api.py",
    "apps/tabdata/tests/test_organization_service_delete_cleanup.py",
    # ---- rag (sqlite array syntax in fixture setup) ----
    "apps/rag/tests/test_legacy.py",
    "apps/rag/tests/test_sc002_sc004_sc019_fixes.py",
    "apps/rag/tests/test_sk002_sk003_sk004_fixes.py",
    "apps/rag/tests/test_eb012_index_service_metadata.py",
    # ---- tabtinspace (sqlite array syntax) ----
    "apps/tabtinspace/tests/test_app_catalog.py",
    "apps/tabtinspace/tests/test_agent_private_visibility.py",
    "apps/tabtinspace/tests/test_space_private_visibility.py",
    "apps/tabtinspace/tests/test_content_admin_api.py",
    "apps/tabtinspace/tests/test_context_item_service.py",
    "apps/tabtinspace/tests/test_perf008_010_summary_aggregate.py",
    #  回归探针：single_pg 下事务 alias 与 ORM 路由一致性。fixture 建库
    # 阶段就撞 PG 专有 SQL（'5 minutes' interval），需真 PG 跑（USE_SQLITE_FOR_TESTS=0）。
    "apps/tabtinspace/tests/test_singlepg_atomic_alias.py",
    # 团队 Space 动态流（阶段3）：TestCase + databases={default, postgresql}，
    # sqlite 建库阶段撞 PG 专有迁移 SQL；手动用 USE_SQLITE_FOR_TESTS=0 跑真 PG。
    "apps/tabtinspace/tests/test_space_activity.py",
    # PR3 yolo gate 审计 + 0049 迁移测试：用 TestCase + databases={default,
    # postgresql}，setup_databases 走 SQLite 替身时撞 services_billing 的
    # MySQL-only DDL（CONVERT TO CHARACTER SET utf8mb4）报错——需真 MySQL+PG。
    # SQLite compatibility suite 跳过，真库 job 仍跑。
    "apps/tabtinspace/tests/test_pr3_allow_yolo_mode_and_audit.py",
    # ---- chat (sqlite array syntax in agent/space fixture) ----
    "apps/chat/conversation/tests/test_checkpoint_api.py",
    "apps/chat/conversation/tests/test_comms_p0_regression.py",
    "apps/chat/conversation/tests/test_context_group_runtime.py",
    "apps/chat/conversation/tests/test_model_switching.py",
    "apps/chat/conversation/tests/test_session_reuse.py",
    # W1b 协议层 message_kind 历史 API 测试——需要真 MySQL，sqlite 跑不起来。
    # Root cause：pytest-django session-scoped `django_db_setup` walks ALL apps' migrations，
    # 撞到 `services_billing` 的 MySQL-only DDL（`ALTER TABLE services_billing_admin_audit_log
    # CONVERT TO CHARACTER SET utf8mb4`）就 fail——和该测试本身无关，是 sqlite 跑不动
    # 任意带 MySQL 专有 DDL 的 migration。文件内的 source-level guard 测试是 plain function
    # 不继承 TestCase，_MARKED 路径会保留它们；仅 MessageKindHistoryApiTestCase 被 skip。
    "apps/chat/conversation/tests/test_message_kind_history_api.py",
    # 多端历史增量同步协议探针需要真实 PostgreSQL 查询语义。SQLite compatibility
    # 建测试库阶段会撞 PG ArrayField / PG 方言迁移；主验证走本地 PG。
    "apps/chat/conversation/tests/test_message_history_delta_sync.py",
    "apps/chat/conversation/tests/test_title_generator.py",
    # 计费 metadata 落库归属测试——同上，建测试库阶段就撞 services_billing 的
    # MySQL-only DDL；纯函数提取部分在 test_relay_cost_metadata.py（无 DB，正常跑）。
    "apps/services/common/ws/tests/test_relay_cost_metadata_db.py",
    # ---- capabilities ----
    "apps/capabilities/tests/test_tool_embedding.py",
    # ---- billing (sqlite array in fixture setup) ----
    "apps/services/billing/tests/test_alert_dispatch.py",
    "apps/services/billing/tests/test_api.py",
    "apps/services/billing/tests/test_api_admin.py",
    "apps/services/billing/tests/test_billing_e2e.py",
    "apps/services/billing/tests/test_collection_service.py",
    "apps/services/billing/tests/test_guard_service.py",
    "apps/services/billing/tests/test_llm_budget_service.py",
    "apps/services/billing/tests/test_refund_service.py",
    "apps/services/billing/tests/test_settlement_service.py",
    "apps/services/billing/tests/test_storage_billing.py",
    "apps/services/billing/tests/test_organization_cleanup_admin_api.py",
    "apps/services/billing/tests/test_organization_lifecycle_cleanup_service.py",
    "apps/services/billing/tests/test_organization_lifecycle_cleanup_tabmail_scope.py",
    "apps/services/billing/tests/test_organization_llm_billing_integration.py",
    # ---- skills (sqlite array) ----
    "apps/skills/tests/test_bl001_bl002_billing_context.py",
    "apps/skills/tests/test_eci003_eci004_eci005_regression.py",
    "apps/skills/tests/test_eq003_cleanup_stale.py",
    "apps/skills/tests/test_eq015_eq016_embedding.py",
    "apps/skills/tests/test_sk001_ghost_record_regression.py",
    "apps/skills/tests/test_skill_tools_validation.py",
    # Wave 1 重写后需要真 PG（涉及 Skill / SkillEnablement 表）
    "apps/skills/tests/test_skill_key_resolution.py",
    "apps/skills/tests/test_h4_organization_fallback.py",
    "apps/skills/tests/test_bra012_managed_skill_agents.py",
    "apps/skills/tests/test_scr_managed_service_regression.py",
    "apps/skills/tests/test_f24_regression.py",
    # ---- tins (sqlite array) ----
    "apps/tins/tests/test_services.py",
    # ---- tabdoc (sqlite array in embedding/perf fixtures) ----
    "apps/tabdoc/tests/test_eb012_embedding_metadata.py",
    "apps/tabdoc/tests/test_perf_admin_summary.py",
    # ---- tabslide (sqlite array in Django TestCase setUp) ----
    "apps/tabslide/tests/test_a2_04_05_read_path.py",
    "apps/tabslide/tests/test_admin_api.py",
    "apps/tabslide/tests/test_api_integration.py",
    "apps/tabslide/tests/test_j3_security_fixes.py",
    "apps/tabslide/tests/test_parse_pptx_base64_guard.py",
    "apps/tabslide/tests/test_perf_admin_summary.py",
    "apps/tabslide/tests/test_sdi_007_008_space_permission.py",
    "apps/tabslide/tests/test_sdi_019_parse_pptx_rate_limit.py",
    "apps/tabslide/tests/test_upload_image.py",
    "apps/tabslide/tests/test_w4_03_fixes.py",
    "apps/tabslide/tests/test_wave4_bs006_bs012_bs016.py",
    "apps/tabslide/tests/test_wave5_bs002_bs004_bs007.py",
    "apps/tabslide/tests/test_wave5_bs003_bs005_bs014.py",
    "apps/tabslide/tests/test_wave6_bs008_bs013.py",
    # ---- channel_gateway (sqlite array in fixture) ----
    "apps/channel_gateway/tests/test_binding_service.py",
    "apps/channel_gateway/tests/test_comms_p0_regression.py",
    "apps/channel_gateway/tests/test_outbound_service.py",
    "apps/channel_gateway/tests/test_p0_fixes.py",
    "apps/channel_gateway/tests/test_policy_api.py",
    # ---- services/llm (sqlite array) ----
    "apps/services/llm/tests/test_admin_form.py",
    "apps/services/llm/tests/test_async_fixes.py",
    "apps/services/llm/tests/test_f1_base_pruner_p0.py",
    "apps/services/llm/tests/test_factory_p0_regression.py",
    "apps/services/llm/tests/test_services.py",
    "apps/services/llm/tests/test_utils.py",
    # ---- services/payment (sqlite array) ----
    "apps/services/payment/tests/test_api.py",
    "apps/services/payment/tests/test_benefit_service.py",
    "apps/services/payment/tests/test_callback_handler.py",
    "apps/services/payment/tests/test_finance_p0.py",
    "apps/services/payment/tests/test_sync_order.py",
    # ---- services/search (sqlite array) ----
    "apps/services/search/tests/test_admin_api.py",
    "apps/services/search/tests/test_search_service.py",
    # ---- services/sms (sqlite array) ----
    "apps/services/sms/tests/test_services.py",
    # ---- updater (sqlite array) ----
    "apps/updater/tests/test_admin_api.py",
    # ---- users/auth (sqlite array) ----
    "apps/users/auth/tests/test_ca24_session_cleanup_race.py",
    "apps/users/auth/tests/test_ca4_ca5_ca8_ca15.py",
    "apps/users/auth/tests/test_ca6_ca12_ca14.py",
    "apps/users/auth/tests/test_ca7_ca10_ca11_ca13.py",
    "apps/users/auth/tests/test_cr010_cr012_cr015_session_race.py",
    "apps/users/auth/tests/test_de06_daemon_token_revocation.py",
    "apps/users/auth/tests/test_jwt_auth_session_binding.py",
    "apps/users/auth/tests/test_perf003_summary_aggregate.py",
    "apps/users/auth/tests/test_perf043_045_046_signal_batch.py",
    "apps/users/auth/tests/test_perf044_perf047_disable_collab_revoke.py",
    "apps/users/auth/tests/test_rv004_rv005_deactivation_session_cleanup.py",
    "apps/users/auth/tests/test_sdi014_centrifugo_disconnect.py",
    "apps/users/auth/tests/test_sdi014_session_invalidation.py",
    "apps/users/auth/tests/test_verification_security.py",
    # ---- users/membership (sqlite array) ----
    "apps/users/membership/tests/test_finance_p0.py",
    # ---- users/wallet (sqlite array) ----
    "apps/users/wallet/tests/test_freeze_reclaim.py",
    "apps/users/wallet/tests/test_precision_billing.py",
    "apps/users/wallet/tests/test_wallet_idempotency.py",
    "apps/users/wallet/tests/test_wallet_recharge_idempotent.py",
}

_INFRA_DRIFT: set[str] = {
    # ---- tabdata: mock/fixture drift (missing methods, bad stubs) ----
    "apps/tabdata/tests/test_cd013_cd016_security.py",
    "apps/tabdata/tests/test_collab_service_query_guards.py",
    "apps/tabdata/tests/test_csc015_016_017_018_regression.py",
    "apps/tabdata/tests/test_csc021_022_024_029_regression.py",
    "apps/tabdata/tests/test_dv005_dv017_undo_stack_restore.py",
    "apps/tabdata/tests/test_dv011_dv028_dv032_regression.py",
    "apps/tabdata/tests/test_f16_p0_fixes.py",
    "apps/tabdata/tests/test_fh001_fh004_field_changelog.py",
    "apps/tabdata/tests/test_fh007_fh008_field_history.py",
    "apps/tabdata/tests/test_field_reference_manager_unit.py",
    "apps/tabdata/tests/test_history_ttl.py",
    "apps/tabdata/tests/test_model_registry.py",
    "apps/tabdata/tests/test_restore_field_sync.py",
    "apps/tabdata/tests/test_truncated_snapshot_fallback.py",
    "apps/tabdata/tests/test_w1_1_d8_b6_record_history.py",
    "apps/tabdata/tests/test_w1_3_c1_field_undo.py",
    "apps/tabdata/tests/test_w1_3_c3_schema_token.py",
    # ---- collab: adapter/service API drift ----
    "apps/collab/tests/test_ap006_007_008_012_changelog_coverage.py",
    "apps/collab/tests/test_ap010_ap011_ap014_regression.py",
    "apps/collab/tests/test_cc003_cc005_cc014_cc027_checkpoint.py",
    "apps/collab/tests/test_cc004_cc022_cc028_cc029_regression.py",
    "apps/collab/tests/test_cc007_cc008_cc009_cc017_cc021_regression.py",
    "apps/collab/tests/test_cc010_cc011_cc015_cc018_cc019_cc020_regression.py",
    "apps/collab/tests/test_cl005_cl013_cl024_regression.py",
    "apps/collab/tests/test_cl007_cl010_regression.py",
    "apps/collab/tests/test_csc005_docs_restore_on_commit_window.py",
    "apps/collab/tests/test_docs_adapter_serialize_symmetry.py",
    "apps/collab/tests/test_dv001_dv003_dv004_regression.py",
    "apps/collab/tests/test_e2e007_pre_change_version_regression.py",
    "apps/collab/tests/test_e2e015_016_017_018_025_026_rollback_semantics.py",
    "apps/collab/tests/test_e2e_010_011_012_013_014_031_regression.py",
    "apps/collab/tests/test_p1_wave3_restore_fixes.py",
    "apps/collab/tests/test_slide_adapter_serialize_symmetry.py",
    "apps/collab/tests/test_version_history_service.py",
    "apps/collab/tests/test_vs006_007_009_016_regression.py",
    # ---- rag: embedding/index service drift ----
    "apps/rag/tests/test_da003_da004_fixes.py",
    "apps/rag/tests/test_da006_da007_fixes.py",
    "apps/rag/tests/test_eb007_eb008_eb009_eb010_fixes.py",
    "apps/rag/tests/test_emb001_to_emb005_fixes.py",
    "apps/rag/tests/test_ss002_ss003_ss004_ss005_fixes.py",
    # ---- chat: session/fork API drift ----
    "apps/chat/conversation/tests/test_fork_session.py",
    "apps/chat/conversation/tests/test_title_manual.py",
    # 注：原 ``apps/scheduler/*`` 测试条目已随 2026-05-28 ScheduledJob 子系统下线 +
    # 波次 3b 模块改名（apps/scheduler → apps/tracker）清理完毕。Tracker 域回归测试
    # 现在直接活在 ``apps/tracker/tests/`` 下，按 PG 原生 / drift 标签按需归类。
    # ---- tabtinspace: auth/binding drift ----
    "apps/tabtinspace/tests/test_cd001_cd004_endpoint_dual_auth.py",
    "apps/tabtinspace/tests/test_daemon_token_renew.py",
    "apps/tabtinspace/tests/test_de20_activate_rate_limit.py",
    "apps/tabtinspace/tests/test_execution_binding_semantics.py",
    "apps/tabtinspace/tests/test_rb005_leave_workspace_centrifugo.py",
    # ---- billing: celery schedule loading drift ----
    "apps/services/billing/tests/test_celery_schedule_loading.py",
    # ---- tabdoc: service/adapter API drift ----
    "apps/tabdoc/tests/test_be04_be06_fixes.py",
    "apps/tabdoc/tests/test_csc001_csc004_csc006_regression.py",
    "apps/tabdoc/tests/test_dv005_dv009_editor_type_fixes.py",
    "apps/tabdoc/tests/test_eci007_eci008_eci009_billing_fixes.py",
    "apps/tabdoc/tests/test_history_cleanup_tasks.py",
    "apps/tabdoc/tests/test_incremental_diff.py",
    "apps/tabdoc/tests/test_tabdoc_service_metrics.py",
    "apps/tabdoc/tests/test_tabdoc_tasks.py",
    # ---- tabmemo: service/format API drift ----
    "apps/tabmemo/tests/test_agent_tools.py",
    "apps/tabmemo/tests/test_api_format.py",
    "apps/tabmemo/tests/test_crt_fixes.py",
    "apps/tabmemo/tests/test_error_codes.py",
    "apps/tabmemo/tests/test_memo_service.py",
    "apps/tabmemo/tests/test_rate_limit.py",
    "apps/tabmemo/tests/test_tasks.py",
    # ---- tabsite: service/schema drift ----
    "apps/tabsite/tests/test_acb001_acb006_regression.py",
    "apps/tabsite/tests/test_cc008_ts013_views_regression.py",
    "apps/tabsite/tests/test_f05_site_service_regression.py",
    "apps/tabsite/tests/test_schema_validations.py",
    "apps/tabsite/tests/test_site_service_f06_regression.py",
    # ---- tabslide: service/adapter API drift ----
    "apps/tabslide/tests/test_cl016_legacy_fallback.py",
    "apps/tabslide/tests/test_crt_fixes.py",
    "apps/tabslide/tests/test_csc019_csc037_editor_type_regression.py",
    "apps/tabslide/tests/test_csc030_031_032_033_034_036_038_regression.py",
    "apps/tabslide/tests/test_data_foundation_fixes.py",
    "apps/tabslide/tests/test_e2e002_e2e003_post_save_regression.py",
    "apps/tabslide/tests/test_history_cleanup_tasks.py",
    "apps/tabslide/tests/test_html_pipeline_quality_guards.py",
    "apps/tabslide/tests/test_post_save_hooks.py",
    "apps/tabslide/tests/test_preview_p0_i506_i510.py",
    "apps/tabslide/tests/test_preview_security_p0_f02.py",
    "apps/tabslide/tests/test_tsv002_008_versioning_fixes.py",
    "apps/tabslide/tests/test_tsv006_vh_cl_atomicity.py",
    "apps/tabslide/tests/test_tsv009_014_versioning_fixes.py",
    "apps/tabslide/tests/test_tsv015_016_migrate_incremental.py",
    "apps/tabslide/tests/test_v2_data_foundation_p0.py",
    "apps/tabslide/tests/test_v2_import_export_p0.py",
    "apps/tabslide/tests/test_v2_p0_security_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w2_01_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w2_02_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w2_03_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w2_03b_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w2_09_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w2_10_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w2_11_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w2_12_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w2_12b_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w2_security_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w3_01_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w3_02_fixes.py",
    "apps/tabslide/tests/test_v2_p1_w3_09_fixes.py",
    "apps/tabslide/tests/test_v2_special_elements_p0.py",
    "apps/tabslide/tests/test_w2_special_elements_p1.py",
    "apps/tabslide/tests/test_w4_02_pptx_template_cleanup.py",
    "apps/tabslide/tests/test_wave5_b203_image_limit.py",
    "apps/tabslide/tests/test_wave5_sp05_sp13_sp14.py",
    "apps/tabslide/tests/test_wave5_sp06_sp11_fixes.py",
    "apps/tabslide/tests/test_pptx_latex_chain.py",
    "apps/tabslide/tests/test_pptx_v2_ie_p1_fixes.py",
    # ---- channel_gateway: adapter/security drift ----
    "apps/channel_gateway/tests/test_de01_de02_de03_security.py",
    "apps/channel_gateway/tests/test_dingtalk_adapter.py",
    "apps/channel_gateway/tests/test_feishu_adapter.py",
    "apps/channel_gateway/tests/test_googlechat_adapter.py",
    "apps/channel_gateway/tests/test_mattermost_adapter.py",
    "apps/channel_gateway/tests/test_msteams_adapter.py",
    "apps/channel_gateway/tests/test_slack_adapter.py",
    "apps/channel_gateway/tests/test_telegram_adapter.py",
    "apps/channel_gateway/tests/test_webhook_view.py",
    "apps/channel_gateway/tests/test_wechat_work_adapter.py",
    # ---- client_errors ----
    "apps/client_errors/tests/test_admin_api_permissions.py",
    # ---- services/common: middleware/ws drift ----
    "apps/services/common/tests/test_cc001_cc023_middleware_regression.py",
    "apps/services/common/tests/test_middleware_xff.py",
    "apps/services/common/tests/test_unicode_security.py",
    "apps/services/common/ws/tests/test_e2e_device.py",
    "apps/services/common/ws/tests/test_e2e_gateway.py",
    "apps/services/common/ws/tests/test_e2e_resume.py",
    "apps/services/common/ws/tests/test_rb001_rb002_rb012.py",
    # ---- services/llm: billing/service drift ----
    "apps/services/llm/tests/test_admin_api_permissions.py",
    "apps/services/llm/tests/test_billing_service.py",
    "apps/services/llm/tests/test_f19_idempotency_billing.py",
    "apps/services/llm/tests/test_minimax_service.py",
    "apps/services/llm/tests/test_moonshot_service.py",
    "apps/services/llm/tests/test_openai_codex_gateway.py",
    # ---- services/speech ----
    "apps/services/speech/tests/test_api_error_response.py",
    "apps/services/speech/tts/tests/test_audio_utils.py",
    # ---- tabtinspace ----
    "apps/tabtinspace/tests/test_device_status.py",
    # ---- users/auth: auth/session drift ----
    "apps/users/auth/tests/test_api_key_scope.py",
    "apps/users/auth/tests/test_cr001_cr005_refresh_token_race.py",
    "apps/users/auth/tests/test_cr006_cr009_concurrency_race.py",
    "apps/users/auth/tests/test_rb004_logout_collab_revoke.py",
    "apps/users/auth/tests/test_rv007_session_rotation.py",
    # ---- tabtin settings/infra ----
    "tabtin/tests/test_security_settings.py",
    "tests/infra/test_celery_infra.py",
}


def pytest_configure(config: pytest.Config) -> None:
    import django
    from django.conf import settings

    if not settings.configured:
        django.setup()

    if not getattr(settings, "RUNNING_TESTS", False):
        settings.RUNNING_TESTS = True

    _validate_registry_paths()
    _patch_fixture_teardown_allow_cascade()


def _patch_fixture_teardown_allow_cascade() -> None:
    """让 TransactionTestCase 的 flush 默认走 TRUNCATE ... CASCADE。

    Django 的 ``TransactionTestCase._fixture_teardown`` 默认 ``allow_cascade=False``，
    依赖 ``django_table_names()`` 完整覆盖 DB 里所有表。本仓库历史上多次出现"表
    在 migration 0011/0014/0024 等里 CreateModel 后又把 model 类从 models.py 中剔除"
    的局面（``client_error_group_user_seen`` / ``client_error_release_user_seen``
    是典型例子；可能还有更多）。结果 PG truncate 漏掉子表，``ForeignKeyConstraint``
    拒删，整条 TransactionTestCase 链路无法 teardown，Layer B CI 在 fixture
    teardown 阶段挂掉。

    最小侵入修复：monkey-patch ``_fixture_teardown`` 让它始终走 cascade。测试只
    清自己的 DB（``_TEST_DATABASES``），cascade 不会扩散到生产 schema。代价是
    被 TRUNCATE 的 ``django_migrations`` / ``content_type`` 等系统表也会被清——
    Django 的 ``flush`` 已经处理这种情况（``inhibit_post_migrate=True`` 时不
    跳后置 hook，且 ``available_apps`` 路径也是这么走的）。
    """
    from django.test import TransactionTestCase

    original = TransactionTestCase._fixture_teardown

    def _fixture_teardown_cascade(self):  # type: ignore[no-redef]
        from django.core.management import call_command
        from django.db import connections
        from django.test.testcases import connections_support_transactions

        if not connections_support_transactions():
            return original(self)
        # 镜像 Django 4.2 TransactionTestCase._fixture_teardown 但强制 allow_cascade=True
        for db_name in self._databases_names(include_mirrors=False):
            inhibit = bool(getattr(self, "available_apps", None))
            call_command(
                "flush",
                verbosity=0,
                interactive=False,
                database=db_name,
                reset_sequences=False,
                allow_cascade=True,
                inhibit_post_migrate=inhibit,
            )
            connections[db_name].close()

    TransactionTestCase._fixture_teardown = _fixture_teardown_cascade


def _validate_registry_paths() -> None:
    """Warn about stale entries that reference deleted/renamed test files."""
    import warnings

    for path in _REQUIRES_PG_NATIVE | _INFRA_DRIFT:
        if not (_CONFTEST_DIR / path).exists():
            warnings.warn(
                f"Infra-skip registry references missing file: {path}",
                stacklevel=2,
            )


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    """Auto-apply markers + drop isolated items collected via explicit args.

    Two responsibilities here:

    1. Auto-mark tests in ``_REQUIRES_PG_NATIVE`` / ``_INFRA_DRIFT`` files so
       marker filters can still isolate known infra-debt suites when needed.

    2. Physically remove items belonging to ``_ISOLATED_TEST_FILES`` when the
       active settings module isn't the one those files require. This handles
       the explicit-CLI-path case where ``pytest_ignore_collect`` does not
       fire (pytest constructs the ``Module`` directly for typed-in paths).

       Why "remove from items list" works: pytest-django's
       ``django_db_setup`` reads ``request.session.items`` to compute which
       DB aliases need ``setup_databases``. Removing isolated items here —
       *before* that fixture is first triggered — keeps their
       ``databases = {"default", "postgresql"}`` declaration out of the
       computation, so explicit SQLite compatibility jobs are never asked to
       apply MySQL/PG-only DDL for unrelated isolated files.
    """
    pg_mark = pytest.mark.requires_pg_native
    drift_mark = pytest.mark.infra_drift
    active = os.environ.get("DJANGO_SETTINGS_MODULE")

    kept: list[pytest.Item] = []
    deselected: list[pytest.Item] = []
    for item in items:
        item_path = Path(str(item.fspath)).resolve()
        required = _ISOLATED_TEST_FILES_ABS.get(item_path)
        if required is not None and active != required:
            deselected.append(item)
            continue

        rel = item_path.relative_to(_CONFTEST_DIR).as_posix()
        if rel in _REQUIRES_PG_NATIVE:
            item.add_marker(pg_mark)
        if rel in _INFRA_DRIFT:
            item.add_marker(drift_mark)
        kept.append(item)

    if deselected:
        config.hook.pytest_deselected(items=deselected)
        items[:] = kept


collect_ignore_glob = [
    "backups/*",
    "scripts/*",
    "venv/*",
    "**/bench_*.py",
]

# Files excluded from collection entirely (import-time errors prevent even
# collecting them; different from marker-based skipping which collects but
# deselects at runtime).
collect_ignore = [
    "apps/services/billing/tests/test_urls.py",
    "apps/tabdata/tests/test_urls.py",
    "apps/tins/tests/test_api.py",
    "apps/updater/tests/test_urls.py",
    "apps/services/llm/tests/test_qwen_service.py",
    "apps/tabdata/tests/test_column_meta_backfill_migration.py",
]

# ---------------------------------------------------------------------------
# Isolated-settings test files: hard-exclude when active settings != required.
#
# See module docstring "Isolated-settings test files: design + CI contract"
# for the full rationale. Short version:
#
# - pytest-django's session-scoped ``django_db_setup`` walks ALL collected
#   items (including unittest.skipIf-skipped ones) to compute DB aliases.
#   Letting an isolated file get collected under main settings still triggers
#   ``setup_databases`` on SQLite, which dies on per-app MySQL/PG-only DDL.
#
# - Plain ``collect_ignore`` is INSUFFICIENT: pytest deliberately bypasses
#   ``collect_ignore`` for paths typed explicitly on the command line. Mixed
#   invocations like
#       pytest apps/tabtinspace/tests/test_approval_memo_service.py \\
#              apps/services/agent_engine/tests/test_permission_audit_model.py
#   would still drag the isolated file into collection → ``setup_databases``
#   → ``OperationalError: near "CONVERT": syntax error`` (and friends).
#
# - ``pytest_ignore_collect`` runs for BOTH explicit and recursive collection
#   targets, so it's the only hook that uniformly enforces the invariant
#   "isolated file never coexists with main settings".
#
# Single-file invocations (``pytest path/to/isolated.py``) still work because
# ``_resolve_isolated_settings`` above pre-sets DJANGO_SETTINGS_MODULE to the
# dedicated isolated settings, so the active-vs-required check passes.
# ---------------------------------------------------------------------------
_ISOLATED_TEST_FILES: dict[str, str] = {
    "apps/services/agent_engine/tests/test_permission_audit_model.py":
        "tabtin.settings_permission_audit_test",
    # W2-轮 2 §9.7 L2-1-N：UserAgentApprovalMemo / ApprovalRulesService 的 PG 表
    # 同样需要 isolated settings（避免默认主 settings 走 SQLite 撞 ARRAY[]/JSON 约束）。
    "apps/services/common/tests/test_approval_rules_service.py":
        "tabtin.settings_approval_memo_test",
    # W3-轮 1：approval_cancel 服务端权威清理接口单测，复用 PermissionAudit 表
    # 的 isolated settings（同模式）。
    "apps/services/common/tests/test_approval_cancel.py":
        "tabtin.settings_permission_audit_test",
    # Wave 2 协作者邀请 / 管理 service 单测（TabDoc + TabData 对称）。
    "apps/tabdoc/tests/test_share_service.py":
        "tabtin.settings_share_test",
    "apps/tabdata/tests/test_share_service.py":
        "tabtin.settings_share_test",
    # Wave 5 §H / ：离队级联走本机 PostgreSQL（避免双库 SQLite FK teardown 坑）。
    "apps/tabtinspace/tests/test_cascade_service.py":
        "tabtin.settings_cascade_pg_test",
    # 设置 IA Phase 1·1C：MCP 后端模型单测（databases={default,postgresql}），
    # 必须在主 settings 默认 suite 硬排除，避免 file-SQLite 全量 migration 撞
    # billing/payment 的 MySQL-only DDL。
    "apps/tabtinspace/tests/test_mcp_connection.py":
        "tabtin.settings_share_test",
    # ：手机号邀请 service 单测复用 settings_share_test。
    "apps/tabtinspace/tests/test_invitation_phone.py":
        "tabtin.settings_share_test",
    # ：默认 Agent onboarding service 单测复用 settings_share_test。
    "apps/tabtinspace/tests/test_default_agent_onboarding.py":
        "tabtin.settings_share_test",
    "apps/tabdata/tests/test_password_migration.py":
        "tabtin.settings_share_test",
    # W7「Agent 产物在 Space 内的打开」专题 — ResourceOpenEvent endpoint
    # 集成测试需要 syncdb 建表 + 跑 ninja Client POST，主 settings SQLite 撞
    # billing/payment 的 MySQL DDL；用专用 in-memory + DisableMigrations。
    "apps/services/agent_engine/tests/test_resource_open_telemetry.py":
        "tabtin.settings_resource_open_telemetry_test",
    # 设置 IA Phase 2：UserProfile.ui_settings 同步 API 单测。全量 app 继承 +
    # 双 SQLite + syncdb（见 tabtin/settings_ui_settings_test.py）。主 settings
    # 默认 suite 硬排除，避免 file-SQLite 全量 migration 撞 billing MySQL DDL。
    "apps/users/auth/tests/test_ui_settings_sync.py":
        "tabtin.settings_ui_settings_test",
    # ：PUT /profile/settings 保存（语言）防回归单测。主 settings 默认 suite
    # 硬排除，避免 file-SQLite 全量 migration 撞 PG-only DDL。
    "apps/users/auth/tests/test_profile_settings_save.py":
        "tabtin.settings_ui_settings_test",
}

# Resolve to absolute paths once at import time so the ``pytest_ignore_collect``
# hook can do a fast set lookup against ``collection_path.resolve()``.
_ISOLATED_TEST_FILES_ABS: dict[Path, str] = {
    (_CONFTEST_DIR / _rel).resolve(): _required
    for _rel, _required in _ISOLATED_TEST_FILES.items()
}


def pytest_ignore_collect(collection_path, config):  # type: ignore[no-untyped-def]
    """Hard-exclude isolated test files when active settings can't run them.

    Covers **recursive** collection (directories, packages). For paths typed
    *explicitly* on the command line, pytest's ``Session.collect`` constructs
    the ``Module`` directly and skips this hook — that case is handled by the
    sys.argv rewrite at module import time (see ``_drop_forbidden_isolated_args``
    above), which physically removes isolated paths before pytest parses argv.

    NOTE on signature: pytest >=7 uses ``(collection_path: pathlib.Path,
    config)``; older releases used ``(path: py.path.local, config)``. The
    parameter must be named ``collection_path`` so pytest >=8 wires up the
    hook by argument name. Verified on pytest 9.0.2.
    """
    required = _ISOLATED_TEST_FILES_ABS.get(Path(str(collection_path)).resolve())
    if required is None:
        return None
    active = os.environ.get("DJANGO_SETTINGS_MODULE")
    return active != required
