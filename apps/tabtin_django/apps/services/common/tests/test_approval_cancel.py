"""
W3-轮 1 子任务 B1 单测 · ``cancel_pending_approvals_by_thread``（PRD 05 v0.4 §7.6.2 接口 A）。

业务场景：用户回滚一个 thread → 该 thread 下所有 pending 审批应该被批量 cancel：
* PG ``ConversationState.interrupt_state.pending_approvals`` 中 status='pending' 条目
  更新为 ``status='resolved'`` ``outcome='cancelled_by_rollback'``；
* 每条写一行 ``PermissionAudit``，``decision='cancelled_by_rollback'`` ``source='rollback'``；
* 同 thread topic publish ``approval_resolved`` 让镜像端 ApprovalPanel 自动关闭。

5 个核心测试 + 额外边界覆盖：
1. thread 下 N 个 pending → cancel → N 行 audit + interrupt_state 清 + N 条广播
2. 幂等：同 rollback_event_id 重调
3. thread 下无 pending（已 resolve 全）→ no-op + already_resolved_ids 含全部
4. thread_id 不存在 → not_found=True
5. 事务原子性：mock 写 audit 失败 → interrupt_state 不应该被改

跑法（settings_permission_audit_test 已含 agent_engine + users.auth）::

    cd apps/tabtin_django && source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings_permission_audit_test \
        python -m pytest apps/services/common/tests/test_approval_cancel.py -v

或直接走 conftest auto-route::

    pytest apps/services/common/tests/test_approval_cancel.py
"""

from __future__ import annotations

import os
import sys
import unittest
import uuid
from typing import Any, Dict, List, Optional, Tuple
from unittest.mock import patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings_permission_audit_test")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

if not getattr(django.apps, "apps_ready", False):
    django.setup()

from django.conf import settings as _dj_settings  # noqa: E402
from django.test import TestCase  # noqa: E402

from apps.services.agent_engine.models import ConversationState, PermissionAudit  # noqa: E402
from apps.services.common.approval_cancel import (  # noqa: E402
    CancelPendingResult,
    build_cancel_audit_record,
    cancel_pending_approvals_by_thread,
)


_NEEDS_ISOLATED_SETTINGS = (
    _dj_settings.SETTINGS_MODULE != "tabtin.settings_permission_audit_test"
)
_ISOLATED_SETTINGS_HINT = (
    "approval_cancel DB tests need migration-disabled in-memory SQLite settings; "
    "run with: `pytest --ds=tabtin.settings_permission_audit_test "
    "apps/services/common/tests/test_approval_cancel.py`"
)


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _fixed_uuid_strings() -> Tuple[str, str, str]:
    """返回稳定的 (organization_id, agent_id, session_id) 字符串三元组——所有测试共享，
    避免 ``_resolve_tenant_for_thread`` 跨测试引用对象漂移。"""
    return (
        "11111111-1111-1111-1111-111111111111",  # organization
        "22222222-2222-2222-2222-222222222222",  # agent
        "33333333-3333-3333-3333-333333333333",  # session
    )


def _fake_tenant(_thread_id: str) -> Optional[Tuple[str, str, str]]:
    return _fixed_uuid_strings()


# 测试用稳定 UUID 字面量（PermissionAudit.batch_id / request_id 是 UUIDField，
# 必须传合法 UUID 字符串；wire schema 上 batch_id/request_id 是 string，但 Django
# model 端 UUID 强校验）。生产环境由 runtime 用 randomUUID() 生成，这里固定值
# 让断言可读。
_BATCH_A = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa"
_BATCH_B = "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb"
_REQ_1 = "11111111-aaaa-aaaa-aaaa-111111111111"
_REQ_2 = "22222222-aaaa-aaaa-aaaa-222222222222"
_REQ_3 = "33333333-aaaa-aaaa-aaaa-333333333333"
_REQ_A1 = "a1a1a1a1-aaaa-aaaa-aaaa-a1a1a1a1a1a1"
_REQ_B1 = "b1b1b1b1-bbbb-bbbb-bbbb-b1b1b1b1b1b1"


def _make_pending_entry(
    request_id: str,
    tool_call_id: str,
    *,
    tool_name: str = "list_directory",
    status: str = "pending",
    outcome: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "request_id": request_id,
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "tool_namespace": "",
        "tool_input_preview": "<preview>",
        "decision_reason": {"type": "user_interactive"},
        "skill_context": None,
        "risk_level": "medium",
        "status": status,
        "outcome": outcome,
        "scope": None,
        "approver_user_id": None,
        "rejection_message": "",
        "resolved_at": None,
    }


def _make_batch_meta(
    batch_id: str,
    entries: List[Dict[str, Any]],
    *,
    runtime_mode: str = "solo",
) -> Dict[str, Any]:
    return {
        "batch_id": batch_id,
        "approval_type": "tool_permission",
        "runtime_mode": runtime_mode,
        "expires_at": None,
        "schema_version": 1,
        "created_at": 1_700_000_000_000,
        "entries": entries,
    }


def _create_state_with_pending(thread_id: str, pending_approvals: List[Dict[str, Any]]) -> ConversationState:
    return ConversationState.objects.using("postgresql").create(
        thread_id=thread_id,
        interrupt_state={"version": 2, "pending_approvals": pending_approvals},
        version=1,
    )


def _reload(obj: ConversationState) -> ConversationState:
    return ConversationState.objects.using("postgresql").get(pk=obj.pk)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@unittest.skipIf(_NEEDS_ISOLATED_SETTINGS, _ISOLATED_SETTINGS_HINT)
class CancelPendingApprovalsByThreadTests(TestCase):
    """``cancel_pending_approvals_by_thread`` 主路径 + 幂等 + 边界。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        # 每个测试都 patch tenant 反查，避免依赖 ChatSession 表
        # （settings_permission_audit_test 没装 chat.conversation）。
        self._tenant_patch = patch(
            "apps.services.common.approval_cancel._resolve_tenant_for_thread",
            side_effect=_fake_tenant,
        )
        self._tenant_patch.start()

        # 默认 mock 广播——不让事务后路径打到真 redis / channels
        self._publish_patch = patch(
            "apps.services.common.approval_cancel._publish_cancelled_by_rollback",
        )
        self._mock_publish = self._publish_patch.start()

        self.thread_id = "thread-cancel-test"
        self.rollback_event_id = "rb-evt-001"

    def tearDown(self):
        self._tenant_patch.stop()
        self._publish_patch.stop()

    # ── 用例 1：N pending → cancel + N 行 audit + N 条广播 ──────────────────

    def test_cancel_all_pending_in_one_batch(self):
        """thread 下 N 个 pending（同 batch）→ cancel → N 行 audit + 清 pending + 1 次广播（按 batch 聚合）。"""
        entries = [
            _make_pending_entry(_REQ_1, "tu-1", tool_name="list_directory"),
            _make_pending_entry(_REQ_2, "tu-2", tool_name="read_file"),
            _make_pending_entry(_REQ_3, "tu-3", tool_name="write_file"),
        ]
        batch = _make_batch_meta(_BATCH_A, entries)
        _create_state_with_pending(self.thread_id, [batch])

        result = cancel_pending_approvals_by_thread(
            self.thread_id, reason="rollback_auto_cancel",
            rollback_event_id=self.rollback_event_id,
        )

        self.assertIsInstance(result, CancelPendingResult)
        self.assertFalse(result.not_found)
        self.assertEqual(sorted(result.cancelled_ids), sorted([_REQ_1, _REQ_2, _REQ_3]))
        self.assertEqual(result.already_resolved_ids, [])

        # interrupt_state 中的 entries 全部 status='resolved' / outcome='cancelled_by_rollback'
        obj = ConversationState.objects.using("postgresql").get(thread_id=self.thread_id)
        pending = obj.interrupt_state["pending_approvals"]
        self.assertEqual(len(pending), 1)
        for entry in pending[0]["entries"]:
            self.assertEqual(entry["status"], "resolved")
            self.assertEqual(entry["outcome"], "cancelled_by_rollback")
            self.assertEqual(entry["rejection_message"], "rollback_auto_cancel")
            self.assertEqual(entry["rollback_event_id"], self.rollback_event_id)

        # PermissionAudit 写了 3 行
        audit_rows = list(
            PermissionAudit.objects.using("postgresql").filter(thread_id=self.thread_id)
        )
        self.assertEqual(len(audit_rows), 3)
        for row in audit_rows:
            self.assertEqual(row.decision, "cancelled_by_rollback")
            self.assertEqual(row.source, "rollback")
            self.assertEqual(row.reason.get("cancel_reason"), "rollback_auto_cancel")
            self.assertEqual(row.reason.get("rollback_event_id"), self.rollback_event_id)
            self.assertEqual(str(row.batch_id), _BATCH_A)

        # 广播：1 条（按 batch 聚合，含 3 条 decisions）
        self.assertEqual(self._mock_publish.call_count, 1)
        kwargs = self._mock_publish.call_args.kwargs
        self.assertEqual(kwargs["thread_id"], self.thread_id)
        self.assertEqual(kwargs["batch_id"], _BATCH_A)
        self.assertEqual(kwargs["rollback_event_id"], self.rollback_event_id)
        self.assertEqual(len(kwargs["decisions"]), 3)
        for d in kwargs["decisions"]:
            self.assertEqual(d["outcome"], "cancelled_by_rollback")
            self.assertEqual(d["rejection_message"], "rollback_auto_cancel")

    # ── 用例 2：幂等 ──────────────────────────────────────────────────────

    def test_idempotent_same_rollback_event_id(self):
        """同一 rollback_event_id 重调 → 第二次 cancelled_ids 空，全在 already_resolved_ids。"""
        entries = [_make_pending_entry(_REQ_1, "tu-1")]
        _create_state_with_pending(self.thread_id, [_make_batch_meta(_BATCH_A, entries)])

        first = cancel_pending_approvals_by_thread(
            self.thread_id, reason="rollback_auto_cancel",
            rollback_event_id=self.rollback_event_id,
        )
        self.assertEqual(first.cancelled_ids, [_REQ_1])
        self.assertEqual(first.already_resolved_ids, [])
        self.assertEqual(self._mock_publish.call_count, 1)

        # 重调
        second = cancel_pending_approvals_by_thread(
            self.thread_id, reason="rollback_auto_cancel",
            rollback_event_id=self.rollback_event_id,
        )
        self.assertEqual(second.cancelled_ids, [])
        self.assertEqual(second.already_resolved_ids, [_REQ_1])

        # 第二次不应该再写 audit 行（同 request_id 不重复）
        audit_count = (
            PermissionAudit.objects.using("postgresql")
            .filter(thread_id=self.thread_id)
            .count()
        )
        self.assertEqual(audit_count, 1)

        # 第二次广播不应该发（broadcast_decisions 为空）
        self.assertEqual(self._mock_publish.call_count, 1)

    # ── 用例 3：thread 下全已 resolved → no-op ───────────────────────────

    def test_no_op_when_all_already_resolved(self):
        entries = [
            _make_pending_entry(_REQ_1, "tu-1", status="resolved", outcome="allow"),
            _make_pending_entry(_REQ_2, "tu-2", status="resolved", outcome="deny"),
        ]
        _create_state_with_pending(self.thread_id, [_make_batch_meta(_BATCH_A, entries)])

        result = cancel_pending_approvals_by_thread(
            self.thread_id, reason="rollback_auto_cancel",
        )

        self.assertFalse(result.not_found)
        self.assertEqual(result.cancelled_ids, [])
        self.assertEqual(sorted(result.already_resolved_ids), sorted([_REQ_1, _REQ_2]))

        # 不写 audit、不广播
        self.assertEqual(
            PermissionAudit.objects.using("postgresql")
            .filter(thread_id=self.thread_id).count(),
            0,
        )
        self.assertEqual(self._mock_publish.call_count, 0)

        # interrupt_state 不变
        obj = ConversationState.objects.using("postgresql").get(thread_id=self.thread_id)
        for entry in obj.interrupt_state["pending_approvals"][0]["entries"]:
            self.assertEqual(entry["status"], "resolved")  # 与 setup 一致

    # ── 用例 4：thread_id 不存在 ──────────────────────────────────────────

    def test_thread_not_found(self):
        result = cancel_pending_approvals_by_thread(
            "nonexistent-thread", reason="rollback_auto_cancel",
        )
        self.assertTrue(result.not_found)
        self.assertEqual(result.cancelled_ids, [])
        self.assertEqual(result.already_resolved_ids, [])
        self.assertEqual(self._mock_publish.call_count, 0)

    # ── 用例 5：事务原子性（mock audit bulk_create 失败 → interrupt_state 不应被改） ──

    def test_atomic_transaction_rolls_back_on_audit_failure(self):
        entries = [_make_pending_entry(_REQ_1, "tu-1")]
        _create_state_with_pending(self.thread_id, [_make_batch_meta(_BATCH_A, entries)])

        # mock PermissionAudit.objects.using(...).bulk_create 抛 RuntimeError
        from apps.services.agent_engine.models import PermissionAudit as _Audit

        original_bulk_create = _Audit.objects.using("postgresql").bulk_create

        def _failing_bulk_create(*args, **kwargs):
            raise RuntimeError("simulated audit write failure")

        with patch.object(
            type(_Audit.objects.using("postgresql")),
            "bulk_create",
            side_effect=_failing_bulk_create,
        ):
            with self.assertRaises(RuntimeError):
                cancel_pending_approvals_by_thread(
                    self.thread_id, reason="rollback_auto_cancel",
                )

        # 事务回滚 → interrupt_state.entries[0].status 仍为 'pending'
        obj = ConversationState.objects.using("postgresql").get(thread_id=self.thread_id)
        entry = obj.interrupt_state["pending_approvals"][0]["entries"][0]
        self.assertEqual(entry["status"], "pending")
        self.assertIsNone(entry["outcome"])
        self.assertNotIn("rollback_event_id", entry)

        # 事务回滚 → 没有 audit 行
        self.assertEqual(
            PermissionAudit.objects.using("postgresql")
            .filter(thread_id=self.thread_id).count(),
            0,
        )

        # 事务回滚 → 不发广播
        self.assertEqual(self._mock_publish.call_count, 0)

        # 用 original 跑一次确保 fixture 仍可用（防止 mock 副作用）
        del original_bulk_create

    # ── 边界：mixed batch（部分 pending + 部分 resolved） ───────────────────

    def test_mixed_batch_only_cancels_pending_entries(self):
        entries = [
            _make_pending_entry(_REQ_1, "tu-1", status="resolved", outcome="allow"),
            _make_pending_entry(_REQ_2, "tu-2", status="pending"),
            _make_pending_entry(_REQ_3, "tu-3", status="pending"),
        ]
        _create_state_with_pending(self.thread_id, [_make_batch_meta(_BATCH_A, entries)])

        result = cancel_pending_approvals_by_thread(
            self.thread_id, reason="rollback_auto_cancel",
        )
        self.assertEqual(sorted(result.cancelled_ids), sorted([_REQ_2, _REQ_3]))
        self.assertEqual(result.already_resolved_ids, [_REQ_1])

        # audit 只 2 行（req-1 已 resolved 不写）
        self.assertEqual(
            PermissionAudit.objects.using("postgresql")
            .filter(thread_id=self.thread_id).count(),
            2,
        )

        obj = ConversationState.objects.using("postgresql").get(thread_id=self.thread_id)
        entries_after = obj.interrupt_state["pending_approvals"][0]["entries"]
        # req-1 不动（仍 outcome='allow'）
        self.assertEqual(entries_after[0]["outcome"], "allow")
        self.assertEqual(entries_after[0]["status"], "resolved")
        # req-2 / req-3 改为 cancelled_by_rollback
        self.assertEqual(entries_after[1]["outcome"], "cancelled_by_rollback")
        self.assertEqual(entries_after[2]["outcome"], "cancelled_by_rollback")

    # ── 边界：thread_id 为空 → ValueError ───────────────────────────────

    def test_empty_thread_id_raises(self):
        with self.assertRaises(ValueError):
            cancel_pending_approvals_by_thread("", reason="rollback_auto_cancel")

    # ── 边界：tenant 反查失败 → RuntimeError + 事务回滚（W3-轮 1 三视角 review 自修） ──

    def test_tenant_lookup_failure_rolls_back_transaction(self):
        """tenant 反查 None / UUID 解析失败时直接 raise 让事务回滚。

        防止"PG entry 改了但 PermissionAudit 缺失"这种脱节状态——
        与 cancel_pending_approvals_by_thread 「每条写一行 audit」「原子事务」
        合同保证一致。
        """
        entries = [_make_pending_entry(_REQ_1, "tu-1")]
        _create_state_with_pending(self.thread_id, [_make_batch_meta(_BATCH_A, entries)])

        # 把 tenant patch 换成"返回 None"
        self._tenant_patch.stop()
        with patch(
            "apps.services.common.approval_cancel._resolve_tenant_for_thread",
            return_value=None,
        ):
            with self.assertRaisesRegex(RuntimeError, "tenant lookup returned None"):
                cancel_pending_approvals_by_thread(
                    self.thread_id, reason="rollback_auto_cancel",
                )
        # 重新启动原 patch 让 tearDown 不报错
        self._tenant_patch.start()

        # 事务回滚：interrupt_state 不变（仍为 pending）+ 无 audit + 无广播
        obj = ConversationState.objects.using("postgresql").get(thread_id=self.thread_id)
        entry = obj.interrupt_state["pending_approvals"][0]["entries"][0]
        self.assertEqual(entry["status"], "pending")
        self.assertIsNone(entry["outcome"])
        self.assertEqual(
            PermissionAudit.objects.using("postgresql")
            .filter(thread_id=self.thread_id).count(),
            0,
        )
        self.assertEqual(self._mock_publish.call_count, 0)

    def test_tenant_uuid_parse_failure_rolls_back_transaction(self):
        """tenant 反查返回非 UUID 字符串时也走 RuntimeError + 回滚。"""
        entries = [_make_pending_entry(_REQ_1, "tu-1")]
        _create_state_with_pending(self.thread_id, [_make_batch_meta(_BATCH_A, entries)])

        self._tenant_patch.stop()
        with patch(
            "apps.services.common.approval_cancel._resolve_tenant_for_thread",
            return_value=("not-a-uuid", "also-not-uuid", "junk"),
        ):
            with self.assertRaisesRegex(RuntimeError, "tenant UUID parse failed"):
                cancel_pending_approvals_by_thread(
                    self.thread_id, reason="rollback_auto_cancel",
                )
        self._tenant_patch.start()

        # 事务回滚校验
        obj = ConversationState.objects.using("postgresql").get(thread_id=self.thread_id)
        entry = obj.interrupt_state["pending_approvals"][0]["entries"][0]
        self.assertEqual(entry["status"], "pending")

    # ── 边界：跨 batch 多 batch 各发一条广播 ─────────────────────────────

    def test_multi_batch_multiple_broadcasts(self):
        entries_a = [_make_pending_entry(_REQ_A1, "tu-A1")]
        entries_b = [_make_pending_entry(_REQ_B1, "tu-B1")]
        _create_state_with_pending(
            self.thread_id,
            [_make_batch_meta(_BATCH_A, entries_a), _make_batch_meta(_BATCH_B, entries_b)],
        )

        result = cancel_pending_approvals_by_thread(
            self.thread_id, reason="rollback_auto_cancel",
        )
        self.assertEqual(sorted(result.cancelled_ids), sorted([_REQ_A1, _REQ_B1]))

        # 广播：2 次（两个 batch 各一条）
        self.assertEqual(self._mock_publish.call_count, 2)
        broadcast_batch_ids = sorted(
            call.kwargs["batch_id"] for call in self._mock_publish.call_args_list
        )
        self.assertEqual(broadcast_batch_ids, sorted([_BATCH_A, _BATCH_B]))


# ---------------------------------------------------------------------------
# build_cancel_audit_record 单测（不打 DB）
# ---------------------------------------------------------------------------


@unittest.skipIf(_NEEDS_ISOLATED_SETTINGS, _ISOLATED_SETTINGS_HINT)
class BuildCancelAuditRecordTests(TestCase):
    """``build_cancel_audit_record`` 纯构造路径，不打 DB。"""

    databases = {"default", "postgresql"}

    def test_build_cancel_audit_record_fields(self):
        wt = uuid.uuid4()
        ag = uuid.uuid4()
        sid = uuid.uuid4()
        bid = "12345678-1234-1234-1234-123456781234"
        rid = "abcdefab-abcd-abcd-abcd-abcdefabcdef"
        record = build_cancel_audit_record(
            organization_id=wt,
            agent_id=ag,
            thread_id="t1",
            session_id=sid,
            batch_id=bid,
            request_id=rid,
            tool_call_id="tu-1",
            tool_name="bash",
            tool_namespace="",
            tool_input_preview="rm -rf /tmp/foo",
            decision_reason={"type": "user_interactive"},
            skill_context=None,
            runtime_mode="solo",
            cancel_reason="rollback_auto_cancel",
            rollback_event_id="rb-evt-1",
        )

        self.assertEqual(record.organization_id, wt)
        self.assertEqual(record.agent_id, ag)
        self.assertEqual(record.thread_id, "t1")
        self.assertEqual(str(record.batch_id), bid)
        self.assertEqual(record.request_id, rid)
        self.assertEqual(record.tool_name, "bash")
        self.assertEqual(record.decision, "cancelled_by_rollback")
        self.assertEqual(record.source, "rollback")
        self.assertEqual(record.reason["type"], "user_interactive")
        self.assertEqual(record.reason["cancel_reason"], "rollback_auto_cancel")
        self.assertEqual(record.reason["rollback_event_id"], "rb-evt-1")
        self.assertEqual(record.scope, "")
        self.assertEqual(record.runtime_mode, "solo")
        self.assertEqual(record.rejection_message, "rollback_auto_cancel")

    # ── _flatten_pending_approvals_for_wire（W3-轮 1 三视角 review 自修） ──

    def test_flatten_nested_batches_to_per_request_entries(self):
        """PG 嵌套 batches → wire 扁平 per-request 形态。

        防止 Daemon 整包 PromptForwardPayloadSchema.safeParse 失败导致 crash
        resume 死链（Review 1 CRITICAL #1）。
        """
        from apps.services.agent_engine.services.prompt_forward_service import (  # noqa: E402
            PromptForwardService,
        )

        nested = [
            {
                "batch_id": _BATCH_A,
                "approval_type": "tool_permission",
                "runtime_mode": "solo",
                "expires_at": 1_700_000_300_000,
                "schema_version": 1,
                "created_at": 1_700_000_000_000,
                "entries": [
                    {
                        "request_id": _REQ_1,
                        "tool_call_id": "tu-1",
                        "tool_name": "list_directory",
                        "status": "pending",
                        "decision_reason": {"type": "user_interactive"},
                    },
                    {
                        "request_id": _REQ_2,
                        "tool_call_id": "tu-2",
                        "tool_name": "read_file",
                        "status": "resolved",
                        "outcome": "allow",
                    },
                ],
            },
            {
                "batch_id": _BATCH_B,
                "runtime_mode": "interactive",
                "entries": [
                    {
                        "request_id": _REQ_B1,
                        "tool_call_id": "tu-B1",
                        "tool_name": "write_file",
                        "status": "pending",
                    },
                ],
            },
        ]
        flat = PromptForwardService._flatten_pending_approvals_for_wire(nested)

        self.assertEqual(len(flat), 3)
        # 第一条：从 batch-A 下放 batch_id / runtime_mode / expires_at / created_at
        self.assertEqual(flat[0]["batch_id"], _BATCH_A)
        self.assertEqual(flat[0]["runtime_mode"], "solo")
        self.assertEqual(flat[0]["expires_at"], 1_700_000_300_000)
        self.assertEqual(flat[0]["created_at"], 1_700_000_000_000)
        self.assertEqual(flat[0]["request_id"], _REQ_1)
        # 第二条：保留 entry 的 status='resolved' / outcome='allow'
        self.assertEqual(flat[1]["status"], "resolved")
        self.assertEqual(flat[1]["outcome"], "allow")
        # 第三条：来自 batch-B
        self.assertEqual(flat[2]["batch_id"], _BATCH_B)
        self.assertEqual(flat[2]["runtime_mode"], "interactive")

    def test_flatten_skips_invalid_entries(self):
        """容错：非 dict 元素 / 缺必填字段直接跳过。"""
        from apps.services.agent_engine.services.prompt_forward_service import (  # noqa: E402
            PromptForwardService,
        )

        nested = [
            "not-a-dict",  # 跳过
            {
                "batch_id": _BATCH_A,
                "entries": [
                    None,  # 跳过
                    {"request_id": _REQ_1},  # 缺 tool_call_id / tool_name 跳过
                    {
                        "request_id": _REQ_2,
                        "tool_call_id": "tu-2",
                        "tool_name": "ok_tool",
                        "status": "pending",
                    },
                ],
            },
            {
                # 损坏数据：既无 entries 也无顶层 request_id → 跳过
                "batch_id": "broken-batch",
            },
        ]
        flat = PromptForwardService._flatten_pending_approvals_for_wire(nested)
        self.assertEqual(len(flat), 1)
        self.assertEqual(flat[0]["request_id"], _REQ_2)

    def test_flatten_passthrough_already_flat_format(self):
        """向前兼容：如果 PG 端已经 flat 形态，直接透传。"""
        from apps.services.agent_engine.services.prompt_forward_service import (  # noqa: E402
            PromptForwardService,
        )

        already_flat = [
            {
                "batch_id": _BATCH_A,
                "request_id": _REQ_1,
                "tool_call_id": "tu-1",
                "tool_name": "list_directory",
                "status": "pending",
            },
        ]
        flat = PromptForwardService._flatten_pending_approvals_for_wire(already_flat)
        self.assertEqual(len(flat), 1)
        self.assertEqual(flat[0]["request_id"], _REQ_1)

    def test_build_cancel_audit_record_without_rollback_event_id(self):
        wt = uuid.uuid4()
        ag = uuid.uuid4()
        sid = uuid.uuid4()
        rid = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        record = build_cancel_audit_record(
            organization_id=wt,
            agent_id=ag,
            thread_id="t1",
            session_id=sid,
            batch_id=None,
            request_id=rid,
            tool_call_id="tu-1",
            tool_name="bash",
            tool_namespace="",
            tool_input_preview="",
            decision_reason={},
            skill_context=None,
            runtime_mode="",
            cancel_reason="user_rollback_all",
        )
        self.assertEqual(record.runtime_mode, "interactive")  # 空字符串走 fallback
        self.assertNotIn("rollback_event_id", record.reason)
        self.assertEqual(record.reason["cancel_reason"], "user_rollback_all")
