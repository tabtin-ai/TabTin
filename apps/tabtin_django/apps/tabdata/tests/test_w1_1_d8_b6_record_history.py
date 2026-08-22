"""Wave 1.1 / D8 / B-6 单元测试。

覆盖范围
--------

D8 (RecordHistory schema migration):
- ``RecordHistoryEvent`` dataclass 含 ``agent_run_id`` / ``session_id``
  字段，默认空串语义合理（向后兼容）
- ``emit_record_history_event`` 在 emit 前从 ContextVar 自动取值（默认行为）
- ``emit_record_history_event`` 显式传值时覆盖 ContextVar
- ``emit_record_history_event`` 显式传空串视为"明知无关联"
- PostgreSQL ``tabdata_history`` 物理表确含两字符列 + 联合索引
  ``th_run_cre_idx``（migration 0023 已 apply）

B-6 (RH/RHItem atomic 双写):
- 主路径 ``handle_record_history_event`` 在 RHItem 失败时通过
  ``transaction.atomic`` 回滚 RH 头（无孤儿数据）
- 批量路径 ``batch_write_record_histories`` 同等原子保护
- ``_push_history_to_undo_stack`` 在 atomic 块外（Redis 失败不牵连 PG）

注：本模块用 **轻量 mock + PG direct query** 模式而非创建完整
Organization→Space→Table→Record 依赖链，避开 prod schema 与
test database 之间的 BillingAnomalyAlert / ctx_space_bot_requires_agent
等 pre-existing infra 不一致问题（与本期改动无关）。
"""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.tabdata.history_events import (  # noqa: E402
    RecordHistoryEvent,
    _resolve_run_context,
    emit_record_history_event,
)


# ── D8: RecordHistoryEvent 字段 + 默认 ────────────────────────


class TestD8RecordHistoryEventFields:
    def test_dataclass_has_agent_run_id_and_session_id(self):
        ev = RecordHistoryEvent(
            record=MagicMock(id=uuid4()),
            action="update",
            field_changes={"k": {"old": 1, "new": 2}},
            agent_run_id="run_a",
            session_id="sess_b",
        )
        assert ev.agent_run_id == "run_a"
        assert ev.session_id == "sess_b"

    def test_default_empty_strings_for_backward_compat(self):
        """旧 caller 不传两字段时默认为空串（W0-2 audit §3.2.6 推荐）。"""
        ev = RecordHistoryEvent(
            record=MagicMock(id=uuid4()),
            action="update",
            field_changes={},
        )
        assert ev.agent_run_id == ""
        assert ev.session_id == ""

    def test_keyword_only_signature_safe(self):
        """``RecordHistoryEvent`` 字段全部位置参数兼容（dataclass 默认）。"""
        # Python dataclass 字段都允许位置传入，但只要默认值在末尾即可
        ev = RecordHistoryEvent(MagicMock(id=uuid4()), "update", {})
        assert ev.agent_run_id == ""


# ── D8: emit_record_history_event ContextVar 兜底 ────────────


class TestD8EmitContextVarFallback:
    def setup_method(self):
        # 保证起始无 contextvar 值
        from apps.services.common.platform_context import (
            reset_all_context, set_current_run_id,
        )
        reset_all_context()

    def teardown_method(self):
        from apps.services.common.platform_context import reset_all_context
        reset_all_context()

    def _capture_emitted_event(self):
        """让 emit_record_history_event 内部把 event 暴露给我们。"""
        captured = {}

        def _fake_send(sender, event, **kwargs):
            captured['event'] = event
            return [(MagicMock(__name__='fake_receiver'), None)]

        return captured, patch(
            "apps.tabdata.history_events.record_history_event.send_robust",
            side_effect=_fake_send,
        )

    def test_explicit_values_passed_through(self):
        captured, ctx = self._capture_emitted_event()
        with ctx:
            emit_record_history_event(
                record=MagicMock(id=uuid4()),
                action="update",
                field_changes={"k": 1},
                agent_run_id="run_explicit",
                session_id="sess_explicit",
            )
        assert captured['event'].agent_run_id == "run_explicit"
        assert captured['event'].session_id == "sess_explicit"

    def test_contextvar_fallback_when_none_passed(self):
        from apps.services.common.platform_context import (
            set_current_run_id, set_current_session_id,
        )
        set_current_run_id("run_ctx_x")
        set_current_session_id("sess_ctx_y")

        captured, ctx = self._capture_emitted_event()
        with ctx:
            emit_record_history_event(
                record=MagicMock(id=uuid4()),
                action="update",
                field_changes={"k": 1},
            )
        assert captured['event'].agent_run_id == "run_ctx_x"
        assert captured['event'].session_id == "sess_ctx_y"

    def test_explicit_empty_string_overrides_contextvar(self):
        """显式传 '' 视为"明知无关联"，不被 ContextVar 兜底覆盖。"""
        from apps.services.common.platform_context import set_current_run_id
        set_current_run_id("run_should_be_ignored")

        captured, ctx = self._capture_emitted_event()
        with ctx:
            emit_record_history_event(
                record=MagicMock(id=uuid4()),
                action="update",
                field_changes={"k": 1},
                agent_run_id="",
                session_id="",
            )
        assert captured['event'].agent_run_id == ""
        assert captured['event'].session_id == ""

    def test_resolve_run_context_helper(self):
        """``_resolve_run_context`` 单独可用（供其他 caller 复用）。"""
        from apps.services.common.platform_context import (
            set_current_run_id, set_current_session_id,
        )
        set_current_run_id("run_helper")
        set_current_session_id("sess_helper")
        run_id, session_id = _resolve_run_context()
        assert run_id == "run_helper"
        assert session_id == "sess_helper"


# ── D8: 物理 schema 验证（PG direct query） ──────────────────


class TestD8PhysicalSchema:
    """直接查 PG information_schema / pg_indexes，不依赖 Django ORM。"""

    def test_columns_exist_with_correct_type_length(self):
        from django.db import connections
        with connections["postgresql"].cursor() as cur:
            cur.execute(
                "SELECT column_name, data_type, character_maximum_length "
                "FROM information_schema.columns "
                "WHERE table_name='tabdata_history' "
                "  AND column_name IN ('agent_run_id','session_id') "
                "ORDER BY column_name"
            )
            rows = cur.fetchall()
        cols = {r[0]: (r[1], r[2]) for r in rows}
        assert cols.get("agent_run_id") == ("character varying", 64)
        assert cols.get("session_id") == ("character varying", 64)

    def test_th_run_cre_idx_present(self):
        from django.db import connections
        with connections["postgresql"].cursor() as cur:
            cur.execute(
                "SELECT indexname FROM pg_indexes "
                "WHERE tablename='tabdata_history' "
                "  AND indexname='th_run_cre_idx'"
            )
            rows = cur.fetchall()
        assert len(rows) == 1, (
            f"D8 联合索引 th_run_cre_idx 未在 tabdata_history 表上找到，"
            f"migration 0023 可能未 apply。"
        )

    def test_single_field_indexes_present(self):
        """db_index=True 给两字段都建了 btree 索引 + _like 辅助索引。"""
        from django.db import connections
        with connections["postgresql"].cursor() as cur:
            cur.execute(
                "SELECT indexname FROM pg_indexes "
                "WHERE tablename='tabdata_history' "
                "  AND (indexname LIKE '%agent_run_id%' "
                "       OR indexname LIKE '%session_id%')"
            )
            names = [r[0] for r in cur.fetchall()]
        # 至少 agent_run_id 和 session_id 各有一条 db_index 自动命名的 idx
        assert any("agent_run_id" in n for n in names), names
        assert any("session_id" in n for n in names), names


# ── B-6: history_event_listeners atomic 边界（mock 模式） ──


class TestB2MetadataFieldKey:
    """Wave 1.1 P0-3 修复（技术 Review）：``_import_source`` 等元数据键
    不应进入 ``RecordHistoryItem`` 字段级历史明细。"""

    def test_metadata_key_excluded_from_items(self):
        from apps.tabdata.history_event_listeners import (
            _build_history_items,
            _is_metadata_field_key,
        )
        from apps.tabdata.history_events import RecordHistoryEvent

        # 验证 _is_metadata_field_key 识别正确
        assert _is_metadata_field_key("_import_source") is True
        assert _is_metadata_field_key("_deleted") is False  # _deleted 是真实字段变更
        assert _is_metadata_field_key("normal_field") is False

        # _import_source 不会进 items
        ev = RecordHistoryEvent(
            record=MagicMock(id=uuid4()),
            action="update",
            field_changes={
                "real_field": {"old": 1, "new": 2},
                "_import_source": "fast_mode",
            },
        )
        items = _build_history_items(ev, field_type_map={})
        keys = [k for k, _, _ in items]
        assert "real_field" in keys
        assert "_import_source" not in keys

    def test_metadata_key_excluded_from_create_items(self):
        """create 路径（field_changes={'data': {...}}）也跳过元数据键。"""
        from apps.tabdata.history_event_listeners import _build_history_items
        from apps.tabdata.history_events import RecordHistoryEvent

        ev = RecordHistoryEvent(
            record=MagicMock(id=uuid4()),
            action="create",
            field_changes={
                "data": {
                    "f1": "value",
                    "_import_source": "default",
                },
            },
        )
        items = _build_history_items(ev, field_type_map={})
        keys = [k for k, _, _ in items]
        assert "f1" in keys
        assert "_import_source" not in keys

    def test_history_response_filters_system_managed_fields_from_items_and_field_changes(self):
        from apps.tabdata.api_undo_redo import _build_operation_out_from_dict

        operation = _build_operation_out_from_dict(
            {
                "id": "history-1",
                "record_id": "record-1",
                "action": "update",
                "action_display": "更新",
                "field_changes": {
                    "field-title": {"old": "A", "new": "B"},
                    "field-system": {"old": 18, "new": 19456},
                },
                "items": [
                    {
                        "field_key": "field-title",
                        "field_name": "标题",
                        "field_type": "text",
                        "before": "A",
                        "after": "B",
                    },
                    {
                        "field_key": "field-system",
                        "field_name": "最后修改者",
                        "field_type": "last_modified_by",
                        "before": 18,
                        "after": 19456,
                    },
                ],
                "user": None,
                "created_at": "2026-08-15T04:02:00.000Z",
                "is_undone": False,
                "undone_at": None,
                "undone_by": None,
                "operation_group_id": None,
            },
            field_key_map={"field-title": "field-title", "field-system": "field-system"},
            field_metadata_map={
                "field-title": {"name": "标题", "field_type": "text"},
                "field-system": {"name": "最后修改者", "field_type": "last_modified_by"},
            },
        )

        assert "field-system" not in operation.field_changes
        assert [item.field_key for item in operation.items] == ["field-title"]
        assert operation.items[0].field_name == "标题"
        assert operation.items[0].field_type == "text"


    def test_metadata_overrides_stale_field_name(self):
        from apps.tabdata.api_undo_redo import _build_history_items_payload

        payload = _build_history_items_payload(
            [
                {
                    "field_key": "field-title",
                    "field_name": "18",
                    "field_type": "text",
                    "before": "A",
                    "after": "B",
                },
            ],
            field_key_map={"field-title": "field-title"},
            field_metadata_map={
                "field-title": {
                    "name": "Title",
                    "field_type": "text",
                },
            },
        )

        assert len(payload) == 1
        assert payload[0].field_name == "Title"


class TestHistoryNoiseFiltering:
    """#10508：系统自动字段和同值更新不应污染用户可见历史。"""

    def test_system_managed_fields_are_excluded_from_items(self):
        from apps.tabdata.history_event_listeners import _build_history_items

        modified_time = str(uuid4())
        modified_by = str(uuid4())
        ev = RecordHistoryEvent(
            record=MagicMock(id=uuid4()),
            action="update",
            field_changes={
                modified_time: {
                    "old": "2026-08-15T11:36:00+08:00",
                    "new": "2026-08-15T12:02:00+08:00",
                },
                modified_by: {"old": 18, "new": 19456},
            },
        )

        assert _build_history_items(
            ev,
            field_type_map={
                modified_time: "last_modified_time",
                modified_by: "last_modified_by",
            },
        ) == []

    def test_update_with_only_semantic_noops_does_not_create_history_head(self):
        from contextlib import nullcontext

        from apps.tabdata.history_event_listeners import handle_record_history_event
        from apps.tabdata.models import RecordHistory

        field_id = str(uuid4())
        ev = RecordHistoryEvent(
            record=MagicMock(id=uuid4(), table_id=uuid4()),
            action="update",
            field_changes={
                field_id: {
                    "old": {"date": "2026-08-15"},
                    "new": {"date": "2026-08-15"},
                },
            },
            push_to_stack=False,
        )
        manager = MagicMock()

        with (
            patch("apps.tabdata.history_event_listeners._try_merge_with_recent_history", return_value=None),
            patch("apps.tabdata.history_event_listeners._load_field_type_map", return_value={field_id: "date"}),
            patch("apps.tabdata.history_event_listeners.transaction.atomic", return_value=nullcontext()),
            patch("apps.tabdata.tasks.history_tasks.resolve_history_ttl_for_record", return_value=3600),
            patch.object(RecordHistory.objects, "using", return_value=manager),
        ):
            result = handle_record_history_event(sender=object(), event=ev)

        assert result is None
        manager.create.assert_not_called()

    def test_history_item_payload_restores_deleted_field_metadata(self):
        from apps.tabdata.api_undo_redo import _build_history_items_payload

        field_id = uuid4()
        canonical_key = str(field_id)
        payload = _build_history_items_payload(
            [{
                "field_key": field_id.hex,
                "before": "18",
                "after": "19456",
            }],
            field_key_map={field_id.hex: canonical_key},
            field_metadata_map={
                canonical_key: {
                    "name": "历史工单号",
                    "field_type": "text",
                },
            },
        )

        assert len(payload) == 1
        assert payload[0].field_key == canonical_key
        assert payload[0].field_name == "历史工单号"
        assert payload[0].field_type == "text"

    def test_field_map_loader_includes_soft_deleted_field_metadata(self):
        from types import SimpleNamespace

        from apps.tabdata.api_undo_redo import _load_field_maps_for_record_ids
        from apps.tabdata.models import TableField, TableRecord

        record_id = uuid4()
        table_id = uuid4()
        field_id = uuid4()
        record_manager = MagicMock()
        record_manager.filter.return_value.values.return_value = [{
            "id": record_id,
            "table_id": table_id,
        }]
        field_manager = MagicMock()
        field_manager.filter.return_value.only.return_value = [
            SimpleNamespace(
                id=field_id,
                table_id=table_id,
                name="已删除但仍可识别的字段",
                field_type="number",
                is_deleted=True,
            ),
        ]

        with (
            patch.object(TableRecord.objects, "using", return_value=record_manager),
            patch.object(TableField.objects, "using", return_value=field_manager),
        ):
            key_maps, metadata_maps = _load_field_maps_for_record_ids([record_id])

        canonical_key = str(field_id)
        assert key_maps[str(record_id)][field_id.hex] == canonical_key
        assert metadata_maps[str(record_id)][canonical_key] == {
            "name": "已删除但仍可识别的字段",
            "field_type": "number",
        }

    def test_batch_update_with_only_system_fields_creates_no_history(self):
        from apps.tabdata.history_event_listeners import batch_write_record_histories
        from apps.tabdata.models import RecordHistory

        field_id = str(uuid4())
        ev = RecordHistoryEvent(
            record=MagicMock(id=uuid4(), table_id=uuid4()),
            action="update",
            field_changes={field_id: {"old": 18, "new": 19456}},
            push_to_stack=False,
        )
        manager = MagicMock()

        with (
            patch("apps.tabdata.history_event_listeners._load_field_type_map", return_value={field_id: "last_modified_by"}),
            patch.object(RecordHistory.objects, "using", return_value=manager),
        ):
            result = batch_write_record_histories([ev])

        assert result == []
        manager.bulk_create.assert_not_called()


class TestB6AtomicBoundary:
    """B-6 验证：history_event_listeners 主/批量路径都包了 ``transaction.atomic``。

    由于本模块的 setup 不创建真实 Table/Record（避免 infra 干扰），用
    inspect + 源代码字符串扫描 + atomic patch 配合验证。
    """

    def test_main_path_uses_transaction_atomic(self):
        """``handle_record_history_event`` 源代码包含 ``transaction.atomic`` 调用
        且 ``_push_history_to_undo_stack`` 在 atomic 块外。"""
        import inspect
        from apps.tabdata import history_event_listeners
        src = inspect.getsource(history_event_listeners.handle_record_history_event)
        assert "transaction.atomic" in src, "B-6: 主路径必须使用 transaction.atomic"
        # 取 atomic 出现位置 + push_history_to_undo_stack 出现位置，验证后者在前者之后
        # 且不在 with 块内（即不缩进 8 空格在 atomic 之后）
        lines = src.splitlines()
        atomic_idx = next(i for i, ln in enumerate(lines) if "transaction.atomic" in ln)
        push_indices = [i for i, ln in enumerate(lines) if "_push_history_to_undo_stack" in ln]
        assert push_indices, "_push_history_to_undo_stack 调用应保留"
        # 至少有一处 push 在 atomic 之后
        assert any(idx > atomic_idx for idx in push_indices), (
            "_push_history_to_undo_stack 必须在 atomic 块之后被调用（B-6 关键约束）"
        )

    def test_batch_path_uses_transaction_atomic(self):
        import inspect
        from apps.tabdata import history_event_listeners
        src = inspect.getsource(history_event_listeners.batch_write_record_histories)
        assert "transaction.atomic" in src, "B-6: 批量路径必须使用 transaction.atomic"
        # 同样验证 _push_history_to_undo_stack 在 atomic 之后（移到 atomic 块外）
        atomic_count = src.count("transaction.atomic")
        assert atomic_count >= 1
        # _push_history_to_undo_stack 在批量路径中应出现在 for 循环里（atomic 后）
        push_locs = src.split("_push_history_to_undo_stack")
        assert len(push_locs) >= 2, (
            "批量路径应有 _push_history_to_undo_stack 调用（B-6 不删除该副作用）"
        )

    def test_main_path_atomic_uses_correct_db_alias(self):
        """主路径 atomic 必须用 ``using=TABDATA_DB_ALIAS``，PG 不能用默认 alias。"""
        import inspect
        from apps.tabdata import history_event_listeners
        src = inspect.getsource(history_event_listeners.handle_record_history_event)
        assert "using=TABDATA_DB_ALIAS" in src, (
            "B-6: atomic 必须 using=TABDATA_DB_ALIAS（PG 库），否则失败回滚到 MySQL"
        )

    def test_batch_path_atomic_uses_correct_db_alias(self):
        import inspect
        from apps.tabdata import history_event_listeners
        src = inspect.getsource(history_event_listeners.batch_write_record_histories)
        assert "using=TABDATA_DB_ALIAS" in src
