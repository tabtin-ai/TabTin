"""W3.0c / G1.a · G3 · G4 · G6 — 4 项 P0 flag 注册 + 降级路径单元测试。

业务背景
--------

Wave 3 启动门禁 #4 回退演练(``wave3-rollback-rehearsal.md`` v1.1)发现
4 项 P0 flag 缺失:

- **G1.a** ``TABDATA_BULK_UPDATE_USE_RAW_SQL`` — A2 raw SQL 路径独立开关
- **G3**   ``TABDATA_A3_ENABLED`` — A3 update-by-filter 整体一键关闭
- **G4**   ``TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES`` — C1 按字段类型禁用 restore
- **G6**   10 个 saga settings(W0-5 §12.1 + §11.3)— D1-Checkpoint 灰度开关

本文件按 Charter 三段式覆盖:

1. **settings 注册** — 读 ``django.conf.settings`` 验证默认值 + 类型
2. **关闭路径行为** — ``override_settings`` 切到关闭值,断言降级路径生效
3. **边界 / 反向** — 读取容错(无 settings)、回退后恢复语义、空字符串等

设计取舍
--------

- 不依赖真实 PG/Redis;``SimpleTestCase`` + ``override_settings`` + ``MagicMock``。
- ``api_update_by_filter`` 直接调用 ninja 视图函数(传 mock request),不
  起 HTTP server。
- ``batch_update_records`` 只断言降级路径被调用,不验证整链路(已有
  ``test_w2_a2_r11_optimizations.py`` 做覆盖)。
"""
from __future__ import annotations

import os
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from django.test import SimpleTestCase, override_settings  # noqa: E402


# ═══════════════════════════════════════════════════════════════════
# Section 1:G1.a — TABDATA_BULK_UPDATE_USE_RAW_SQL
# ═══════════════════════════════════════════════════════════════════


class TestG1aRawSqlFlagRegistration(SimpleTestCase):
    """settings.py 必须注册 ``TABDATA_BULK_UPDATE_USE_RAW_SQL``,默认 True。"""

    def test_flag_is_registered(self):
        assert hasattr(settings, "TABDATA_BULK_UPDATE_USE_RAW_SQL")

    def test_default_is_true(self):
        # 默认走 W2.perf raw SQL 高速路径;关闭仅限紧急回退。
        assert settings.TABDATA_BULK_UPDATE_USE_RAW_SQL is True

    def test_value_is_bool(self):
        assert isinstance(settings.TABDATA_BULK_UPDATE_USE_RAW_SQL, bool)


class TestG1aRawSqlDowngradePath(SimpleTestCase):
    """关 flag 时 ``_raw_orm_batch_update`` 走 ORM bulk_update 降级。"""

    @override_settings(TABDATA_BULK_UPDATE_USE_RAW_SQL=False)
    @patch(
        "apps.tabdata.handlers.batch_update_records."
        "BatchUpdateRecordsHandler._orm_bulk_update_fallback"
    )
    @patch(
        "apps.tabdata.handlers.batch_update_records."
        "BatchUpdateRecordsHandler._raw_orm_batch_update_sql"
    )
    def test_flag_off_skips_raw_sql(self, mock_raw, mock_fallback):
        from apps.tabdata.handlers.batch_update_records import (
            BatchUpdateRecordsHandler,
        )

        snapshot = SimpleNamespace(
            id=uuid4(),
            formatted_data={},
            version=1,
            updated_at=None,
            updated_by=None,
        )
        event = SimpleNamespace(changed_field_ids=[])
        BatchUpdateRecordsHandler._raw_orm_batch_update([(snapshot, event)])

        mock_raw.assert_not_called()
        mock_fallback.assert_called_once()

    @override_settings(TABDATA_BULK_UPDATE_USE_RAW_SQL=True)
    @patch(
        "apps.tabdata.handlers.batch_update_records."
        "BatchUpdateRecordsHandler._orm_bulk_update_fallback"
    )
    @patch(
        "apps.tabdata.handlers.batch_update_records."
        "BatchUpdateRecordsHandler._raw_orm_batch_update_sql"
    )
    def test_flag_on_uses_raw_sql(self, mock_raw, mock_fallback):
        from apps.tabdata.handlers.batch_update_records import (
            BatchUpdateRecordsHandler,
        )

        snapshot = SimpleNamespace(
            id=uuid4(),
            formatted_data={},
            version=1,
            updated_at=None,
            updated_by=None,
        )
        event = SimpleNamespace(changed_field_ids=[])
        BatchUpdateRecordsHandler._raw_orm_batch_update([(snapshot, event)])

        mock_raw.assert_called_once()
        mock_fallback.assert_not_called()

    def test_empty_results_short_circuits(self):
        from apps.tabdata.handlers.batch_update_records import (
            BatchUpdateRecordsHandler,
        )
        # 空批不应触碰任一路径
        BatchUpdateRecordsHandler._raw_orm_batch_update([])


# ═══════════════════════════════════════════════════════════════════
# Section 2:G3 — TABDATA_A3_ENABLED
# ═══════════════════════════════════════════════════════════════════


class TestG3A3FlagRegistration(SimpleTestCase):
    """settings.py 必须注册 ``TABDATA_A3_ENABLED``,默认 True。"""

    def test_flag_is_registered(self):
        assert hasattr(settings, "TABDATA_A3_ENABLED")

    def test_default_is_true(self):
        assert settings.TABDATA_A3_ENABLED is True

    def test_value_is_bool(self):
        assert isinstance(settings.TABDATA_A3_ENABLED, bool)


class TestG3A3Disabled503Response(SimpleTestCase):
    """关 flag 时 preflight + commit 入口立即返 503 + i18n 错误码。"""

    def _make_request(self):
        # ninja 视图最少需要 ``request.auth``;真实业务由 JWTAuth 注入
        request = MagicMock()
        request.auth = MagicMock(id=uuid4())
        return request

    @override_settings(TABDATA_A3_ENABLED=False)
    def test_preflight_returns_503_when_disabled(self):
        from apps.tabdata.api_update_by_filter import (
            UpdateByFilterPreflightRequest,
            preflight_update_by_filter,
        )
        from apps.tabdata.error_codes import ErrorCode

        body = UpdateByFilterPreflightRequest(
            filter_clause={"a": 1}, patch={"b": 2},
        )
        result = preflight_update_by_filter(
            self._make_request(), uuid4(), body,
        )
        # api_error_handler 装饰器对正常 (status, payload) 直接透传
        assert isinstance(result, tuple)
        status, payload = result
        assert status == 503
        assert payload["success"] is False
        assert payload["code"] == ErrorCode.A3_FEATURE_DISABLED
        assert payload["data"] is None
        # 文案需可读且不暴露具体下线原因
        assert payload["message"]
        assert "SQL" not in payload["message"]
        assert "注入" not in payload["message"]

    @override_settings(TABDATA_A3_ENABLED=False)
    def test_commit_returns_503_when_disabled(self):
        from apps.tabdata.api_update_by_filter import (
            UpdateByFilterCommitRequest,
            commit_update_by_filter,
        )
        from apps.tabdata.error_codes import ErrorCode

        body = UpdateByFilterCommitRequest(
            confirm_token="dummy.signature",
            filter_clause={"a": 1},
            patch={"b": 2},
        )
        result = commit_update_by_filter(
            self._make_request(), uuid4(), body,
        )
        assert isinstance(result, tuple)
        status, payload = result
        assert status == 503
        assert payload["code"] == ErrorCode.A3_FEATURE_DISABLED

    def test_preflight_route_declares_503(self):
        """W3.0c 三视角 Review P0:OpenAPI 契约必须含 503 响应,
        否则客户端代码生成器 / 监控 / 允许码校验会漏。
        """
        from apps.tabdata.api_update_by_filter import preflight_update_by_filter
        # ninja 把 response 字典挂到 wrapper 的 ``_ninja_contribute_to_operation``
        # 或者函数本身的 __decorated__ 链上;最简单是直接读源码字符串
        import inspect
        from apps.tabdata import api_update_by_filter
        src = inspect.getsource(api_update_by_filter)
        # preflight 路由声明段落应含 503
        preflight_block_start = src.find('"/tables/{table_id}/records/update-by-filter/preflight"')
        assert preflight_block_start > 0
        preflight_decl = src[preflight_block_start:preflight_block_start + 400]
        assert "503" in preflight_decl, (
            "preflight 路由 response={...} 必须包含 503 以匹配 G3 关闭路径"
        )

    def test_commit_route_declares_503(self):
        from apps.tabdata import api_update_by_filter
        import inspect
        src = inspect.getsource(api_update_by_filter)
        commit_block_start = src.find('"/tables/{table_id}/records/update-by-filter/commit"')
        assert commit_block_start > 0
        commit_decl = src[commit_block_start:commit_block_start + 400]
        assert "503" in commit_decl

    @override_settings(TABDATA_A3_ENABLED=True)
    @patch("apps.tabdata.api_update_by_filter._resolve_space_id")
    def test_preflight_continues_when_enabled(self, mock_resolve):
        # flag 开 + space_id 缺失 → 应走 ``_resolve_space_id`` 404 分支,
        # 状态码必然不是 503(503 仅由 flag 关触发)。证明 flag 开启时
        # preflight 进入主流程而非短路返回。
        from apps.tabdata.api_update_by_filter import (
            UpdateByFilterPreflightRequest,
            preflight_update_by_filter,
        )

        mock_resolve.return_value = ""  # 触发 404
        body = UpdateByFilterPreflightRequest(
            filter_clause={"a": 1}, patch={"b": 2},
        )
        result = preflight_update_by_filter(
            self._make_request(), uuid4(), body,
        )
        status = result[0]
        assert status != 503  # 不是 flag 关闭路径
        # 实际由 ``error_response`` 帮忙返 (404, (400, {...})) 的元组结构,
        # 这里只关心 outer status 不为 503,断言 flag 真的"放行"了
        assert status == 404


class TestG3A3I18nMessageDefined(SimpleTestCase):
    """A3_FEATURE_DISABLED 错误码必须有 i18n 文案落地(zh/en/ja 全部就位)。"""

    def test_error_code_has_message(self):
        from apps.tabdata.error_codes import ErrorCode, ErrorMessage

        msg = ErrorMessage.get(ErrorCode.A3_FEATURE_DISABLED)
        assert msg
        assert msg != ErrorCode.A3_FEATURE_DISABLED  # 不能 fallback 到错误码本身

    def _load_locale(self, locale: str) -> dict:
        import json
        from pathlib import Path

        path = (
            Path(__file__).resolve().parents[3]
            / "apps" / "i18n" / "locales" / f"{locale}.json"
        )
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def test_zh_cn_locale_has_key(self):
        data = self._load_locale("zh-CN")
        assert "a3_feature_disabled" in data["tabdata"]
        # 用户向文案不能暴露内部下线原因
        msg = data["tabdata"]["a3_feature_disabled"]
        assert "SQL" not in msg
        assert "注入" not in msg

    def test_en_us_locale_has_key(self):
        data = self._load_locale("en-US")
        assert "a3_feature_disabled" in data["tabdata"]
        msg = data["tabdata"]["a3_feature_disabled"]
        # 同样 c5 合规:不暴露内部术语
        assert "SQL injection" not in msg
        assert "Checkpoint" not in msg
        assert "saga" not in msg

    def test_ja_jp_locale_has_key(self):
        data = self._load_locale("ja-JP")
        # ja-JP 在 tabdata namespace
        assert "a3_feature_disabled" in data["tabdata"]


# ── G4 i18n 联动:三视角 Review P0 修复验证 ────────────────────


class TestG4I18nKeyWiredIntoApiResponse(SimpleTestCase):
    """W3.0c 三视角 Review P0:``field_restore_type_disabled`` 必须真正
    被 ``api_undo_redo._field_restore_not_supported_response`` 使用,
    而非 ``str(exc)`` 直接吐硬编码中文。
    """

    def _load_locale(self, locale: str) -> dict:
        import json
        from pathlib import Path

        path = (
            Path(__file__).resolve().parents[3]
            / "apps" / "i18n" / "locales" / f"{locale}.json"
        )
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def test_locale_key_exists_in_three_languages(self):
        # 三语对称才能确保英/日客户端不收到中文
        for locale in ("zh-CN", "en-US", "ja-JP"):
            data = self._load_locale(locale)
            assert "field_restore_type_disabled" in data["tabdata"], locale

    def test_response_uses_i18n_for_temporarily_disabled(self):
        from apps.tabdata.api_undo_redo import (
            _field_restore_not_supported_response,
        )
        from apps.tabdata.exceptions import FieldRestoreNotSupportedError

        # 模拟 G4 关闭路径产生的异常
        exc = FieldRestoreNotSupportedError(
            "硬编码中文 reason(不应被原样返回)",
            field_id="fid-1",
            field_name="Customer Link",
            field_type="link",
            reason_code="temporarily_disabled",
        )
        status, body = _field_restore_not_supported_response(exc)
        assert status == 409
        # message 必须是 i18n 渲染后的(包含 field_name 占位符替换),
        # 而不是异常构造时传入的"硬编码中文 reason"
        assert "Customer Link" in body["message"]
        assert "硬编码中文 reason(不应被原样返回)" not in body["message"]
        # reason_code 直传给前端
        assert body["data"]["reason_code"] == "temporarily_disabled"

    def test_response_keeps_str_exc_for_non_temporarily_disabled(self):
        # 非 temporarily_disabled 走原有 str(exc) 路径,保持向后兼容
        from apps.tabdata.api_undo_redo import (
            _field_restore_not_supported_response,
        )
        from apps.tabdata.exceptions import FieldRestoreNotSupportedError

        exc = FieldRestoreNotSupportedError(
            "原有 W1 复杂字段不支持的 reason",
            field_id="fid-2",
            field_name="Old Field",
            field_type="retired_field_type",
            reason_code="unknown_type",
        )
        status, body = _field_restore_not_supported_response(exc)
        assert status == 409
        assert body["message"] == "原有 W1 复杂字段不支持的 reason"


# ═══════════════════════════════════════════════════════════════════
# Section 3:G4 — TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES
# ═══════════════════════════════════════════════════════════════════


class TestG4ComplexRestoreFlagRegistration(SimpleTestCase):
    """settings.py 必须注册 ``TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES``,默认 ''。"""

    def test_flag_is_registered(self):
        assert hasattr(settings, "TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES")

    def test_default_is_empty_string(self):
        # 默认空字符串 = 不禁用任何字段类型
        assert settings.TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES == ""


class TestG4DisableSpecificFieldType(SimpleTestCase):
    """关 flag 时 ``can_restore_field_type`` 对禁用类型返回 False。"""

    def test_default_all_15_types_restorable(self):
        from apps.tabdata.services.undo_redo_field_restore import (
            ALL_RESTORABLE_FIELD_TYPES, can_restore_field_type,
        )
        assert len(ALL_RESTORABLE_FIELD_TYPES) == 15
        for ft in ALL_RESTORABLE_FIELD_TYPES:
            assert can_restore_field_type(ft) is True, ft

    @override_settings(TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES="link")
    def test_single_type_disabled(self):
        from apps.tabdata.services.undo_redo_field_restore import (
            can_restore_field_type,
        )
        assert can_restore_field_type("link") is False
        # 其他类型不受影响
        assert can_restore_field_type("attachment") is True
        assert can_restore_field_type("text") is True

    @override_settings(
        TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES="link,attachment,date",
    )
    def test_multiple_types_disabled(self):
        from apps.tabdata.services.undo_redo_field_restore import (
            can_restore_field_type,
        )
        for disabled in ("link", "attachment", "date"):
            assert can_restore_field_type(disabled) is False, disabled
        # 未列出的不受影响
        for kept in ("checkbox", "text", "number"):
            assert can_restore_field_type(kept) is True, kept

    @override_settings(
        TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES=" link , attachment ",
    )
    def test_whitespace_in_list_is_trimmed(self):
        from apps.tabdata.services.undo_redo_field_restore import (
            can_restore_field_type,
        )
        assert can_restore_field_type("link") is False
        assert can_restore_field_type("attachment") is False

    @override_settings(TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES="")
    def test_empty_disables_nothing(self):
        from apps.tabdata.services.undo_redo_field_restore import (
            can_restore_field_type,
        )
        assert can_restore_field_type("link") is True
        assert can_restore_field_type("attachment") is True


class TestG4ExplainCapabilityReflectsDisabled(SimpleTestCase):
    """``explain_field_restore_capability`` 对禁用类型返回 ``temporarily_disabled``。"""

    @override_settings(TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES="link")
    def test_disabled_type_reason_code(self):
        from apps.tabdata.services.undo_redo_field_restore import (
            explain_field_restore_capability,
        )
        out = explain_field_restore_capability("link")
        assert out["can_undo"] is False
        assert out["reason_code"] == "temporarily_disabled"
        assert out["deferred_to"] == "version_history"
        # 文案明确指向"版本时间线",符合 c5 §3.1 命名
        assert "版本时间线" in out["reason"]

    @override_settings(TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES="link")
    def test_non_disabled_type_unaffected(self):
        from apps.tabdata.services.undo_redo_field_restore import (
            explain_field_restore_capability,
        )
        out = explain_field_restore_capability("attachment")
        assert out["can_undo"] is True
        assert out["reason_code"] == "simple_supported"


class TestG4RestoreFieldRaisesWhenDisabled(SimpleTestCase):
    """``restore_field`` 在禁用类型上抛 FieldRestoreNotSupportedError。"""

    @override_settings(TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES="link")
    def test_restore_link_raises_when_disabled(self):
        from apps.tabdata.exceptions import FieldRestoreNotSupportedError
        from apps.tabdata.services.undo_redo_field_restore import restore_field

        payload = {
            "id": str(uuid4()),
            "table_id": str(uuid4()),
            "name": "Link to Customer",
            "field_type": "link",
            "config": {"foreignTableId": str(uuid4())},
        }
        try:
            restore_field(payload, write_changelog=False)
        except FieldRestoreNotSupportedError as exc:
            assert exc.reason_code == "temporarily_disabled"
            assert exc.field_type == "link"
            assert exc.field_name == "Link to Customer"
        else:
            raise AssertionError("expected FieldRestoreNotSupportedError")


# ═══════════════════════════════════════════════════════════════════
# Section 4:G6 — 11 个 saga settings(W0-5 §12.1 + §11.3 allowlist)
# ═══════════════════════════════════════════════════════════════════


class TestG6SagaSettingsRegistration(SimpleTestCase):
    """settings.py 必须注册 W0-5 §12.1 完整清单 + §11.3 灰度 allowlist。

    清单(对照 ``checkpoint-saga-statemachine.md`` §12.1 / §11.3):

    1. TABDATA_SAGA_ENABLED                          — 主开关
    2. TABDATA_SAGA_ORGANIZATION_ALLOWLIST               — 灰度 allowlist (§11.3)
    3. TABDATA_SAGA_STEP_RETRY_LIMITS                — 5 step retry 上限
    4. TABDATA_SAGA_STEP_RETRY_BACKOFF_MAX           — 退避上限
    5. TABDATA_SAGA_PAUSE_OUTBOX_TIMEOUT_SECONDS     — pause_outbox 超时
    6. TABDATA_SAGA_RECONCILE_INTERVAL_MINUTES       — 对账周期
    7. TABDATA_SAGA_RECONCILE_BATCH_SIZE             — 对账批量
    8. TABDATA_SAGA_MANUAL_INTERVENTION_RETENTION_DAYS  — manual_intervention 保留
    9. TABDATA_SAGA_SUCCEEDED_RETENTION_DAYS         — succeeded 保留
    10. TABDATA_SAGA_PAYLOAD_INLINE_LIMIT_BYTES      — 行内载荷上限
    11. TABDATA_SAGA_ARCHIVE_TTL_DAYS                — 归档保留
    """

    def test_main_switch_default_false(self):
        # 默认 False:Wave 3 D1-Checkpoint 启用前不允许走 saga
        assert hasattr(settings, "TABDATA_SAGA_ENABLED")
        assert settings.TABDATA_SAGA_ENABLED is False

    def test_organization_allowlist_default_empty(self):
        assert hasattr(settings, "TABDATA_SAGA_ORGANIZATION_ALLOWLIST")
        assert settings.TABDATA_SAGA_ORGANIZATION_ALLOWLIST == []

    def test_step_retry_limits_full_dict(self):
        assert hasattr(settings, "TABDATA_SAGA_STEP_RETRY_LIMITS")
        limits = settings.TABDATA_SAGA_STEP_RETRY_LIMITS
        assert isinstance(limits, dict)
        # 5 个 step 必须全部就位
        for step in ("prepare", "pause_outbox", "restore_data", "mark_collab", "cleanup"):
            assert step in limits, step
            assert isinstance(limits[step], int)
            assert limits[step] >= 1
        # 默认按 §12.1:prepare/pause/restore/mark = 3, cleanup = 5
        assert limits["prepare"] == 3
        assert limits["pause_outbox"] == 3
        assert limits["restore_data"] == 3
        assert limits["mark_collab"] == 3
        assert limits["cleanup"] == 5

    def test_step_retry_backoff_max_default_30(self):
        assert hasattr(settings, "TABDATA_SAGA_STEP_RETRY_BACKOFF_MAX")
        assert settings.TABDATA_SAGA_STEP_RETRY_BACKOFF_MAX == 30

    def test_pause_outbox_timeout_default_300(self):
        assert hasattr(settings, "TABDATA_SAGA_PAUSE_OUTBOX_TIMEOUT_SECONDS")
        # §12.1 默认 300s = 5 min
        assert settings.TABDATA_SAGA_PAUSE_OUTBOX_TIMEOUT_SECONDS == 300

    def test_reconcile_interval_default_5_minutes(self):
        assert hasattr(settings, "TABDATA_SAGA_RECONCILE_INTERVAL_MINUTES")
        assert settings.TABDATA_SAGA_RECONCILE_INTERVAL_MINUTES == 5

    def test_reconcile_batch_size_default_100(self):
        assert hasattr(settings, "TABDATA_SAGA_RECONCILE_BATCH_SIZE")
        assert settings.TABDATA_SAGA_RECONCILE_BATCH_SIZE == 100

    def test_manual_intervention_retention_default_90(self):
        assert hasattr(settings, "TABDATA_SAGA_MANUAL_INTERVENTION_RETENTION_DAYS")
        assert settings.TABDATA_SAGA_MANUAL_INTERVENTION_RETENTION_DAYS == 90

    def test_succeeded_retention_default_30(self):
        assert hasattr(settings, "TABDATA_SAGA_SUCCEEDED_RETENTION_DAYS")
        assert settings.TABDATA_SAGA_SUCCEEDED_RETENTION_DAYS == 30

    def test_payload_inline_limit_default_8192(self):
        assert hasattr(settings, "TABDATA_SAGA_PAYLOAD_INLINE_LIMIT_BYTES")
        # §12.1 默认 8 KB
        assert settings.TABDATA_SAGA_PAYLOAD_INLINE_LIMIT_BYTES == 8192

    def test_archive_ttl_default_90(self):
        assert hasattr(settings, "TABDATA_SAGA_ARCHIVE_TTL_DAYS")
        assert settings.TABDATA_SAGA_ARCHIVE_TTL_DAYS == 90


class TestG6SagaSettingsToggleable(SimpleTestCase):
    """saga settings 全部支持 ``override_settings``(灰度 / 应急回退验证)。"""

    @override_settings(TABDATA_SAGA_ENABLED=True)
    def test_main_switch_can_be_enabled(self):
        assert settings.TABDATA_SAGA_ENABLED is True

    @override_settings(TABDATA_SAGA_ORGANIZATION_ALLOWLIST=["wt_001", "wt_002"])
    def test_allowlist_can_be_set(self):
        assert settings.TABDATA_SAGA_ORGANIZATION_ALLOWLIST == ["wt_001", "wt_002"]

    @override_settings(TABDATA_SAGA_PAUSE_OUTBOX_TIMEOUT_SECONDS=60)
    def test_pause_timeout_can_be_lowered(self):
        # 演练 / 紧急情况下临时缩短 pause_outbox 等待
        assert settings.TABDATA_SAGA_PAUSE_OUTBOX_TIMEOUT_SECONDS == 60


# ═══════════════════════════════════════════════════════════════════
# Section 5:跨 flag 综合(回归保险)
# ═══════════════════════════════════════════════════════════════════


class TestAllFourFlagsCoexist(SimpleTestCase):
    """4 项 flag 同时关闭时,各自降级路径互不干扰。"""

    @override_settings(
        TABDATA_BULK_UPDATE_USE_RAW_SQL=False,
        TABDATA_A3_ENABLED=False,
        TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES="link,attachment",
        TABDATA_SAGA_ENABLED=False,
    )
    def test_simultaneous_off_state_is_consistent(self):
        # G1.a:raw SQL flag 已关
        assert settings.TABDATA_BULK_UPDATE_USE_RAW_SQL is False
        # G3:A3 flag 已关
        assert settings.TABDATA_A3_ENABLED is False
        # G4:link / attachment 禁用 restore
        from apps.tabdata.services.undo_redo_field_restore import (
            can_restore_field_type,
        )
        assert can_restore_field_type("link") is False
        assert can_restore_field_type("attachment") is False
        assert can_restore_field_type("number") is True  # 未禁用
        # G6:saga 主开关已关
        assert settings.TABDATA_SAGA_ENABLED is False
