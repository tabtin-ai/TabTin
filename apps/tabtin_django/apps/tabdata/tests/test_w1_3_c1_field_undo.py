"""Wave 1.3 / C1 单元测试 — 字段 undo (删除可追悔)。

覆盖范围
--------

C1 ``undo_redo_field_restore`` 模块（纯函数 + 元数据）：
- ``SIMPLE_RESTORABLE_FIELD_TYPES`` 仅包含仍在使用的简单类型
- ``COMPLEX_RESTORE_DEFERRED_FIELD_TYPES`` 仅包含关联字段
- ``can_restore_field_type`` 判定矩阵
- ``explain_field_restore_capability`` 三档反馈：simple_supported /
  complex_supported / not_in_wave1
- ``restore_field`` 非白名单字段抛 ``FieldRestoreNotSupportedError``
- ``restore_fields`` 批量入口 best-effort 语义

C1.2 ``UndoRedoOperationService.execute`` + ``UndoRedoService.undo_table_operation``
（mock）：
- ``FieldRestoreNotSupportedError`` 被抛出（不被通用兜底吞）

C1.3 ``api_field.explain_field_action`` 端点 schema：
- 返回 ``undo_capability`` / ``impact`` / ``warning_level``

设计取舍：与 W1.1 保持一致，**不创建** Organization → Space → Table → Record
依赖链，避开 BillingAnomalyAlert / ctx_space_bot_requires_agent 不一致问题。
DB 路径用 mock，纯函数路径直接断言。
"""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.tabdata.exceptions import FieldRestoreNotSupportedError  # noqa: E402
from apps.tabdata.services.undo_redo_field_restore import (  # noqa: E402
    COMPLEX_RESTORE_DEFERRED_FIELD_TYPES,
    SIMPLE_RESTORABLE_FIELD_TYPES,
    can_restore_field_type,
    explain_field_restore_capability,
    restore_field,
    restore_fields,
)


# ── 1. 常量集合精确匹配（任务严格定义） ──────────────────────


class TestSimpleFieldTypes:
    """简单可恢复类型仅包含当前产品支持的字段。"""

    def test_count_is_exactly_14(self):
        assert len(SIMPLE_RESTORABLE_FIELD_TYPES) == 14, (
            f"简单可恢复字段应为 14 种，当前 "
            f"{len(SIMPLE_RESTORABLE_FIELD_TYPES)}: "
            f"{sorted(SIMPLE_RESTORABLE_FIELD_TYPES)}"
        )

    def test_exact_set_match(self):
        expected = frozenset({
            "text", "long_text", "number", "percent", "currency",
            "select", "multi_select",
            "date", "checkbox", "rating",
            "url", "email", "phone", "attachment",
        })
        assert SIMPLE_RESTORABLE_FIELD_TYPES == expected

    def test_includes_long_text(self):
        assert "long_text" in SIMPLE_RESTORABLE_FIELD_TYPES

class TestComplexFieldTypes:
    """关联字段是唯一仍支持撤销的复杂字段。"""

    def test_count_is_exactly_1(self):
        assert len(COMPLEX_RESTORE_DEFERRED_FIELD_TYPES) == 1

    def test_exact_set_match(self):
        expected = frozenset({"link"})
        assert COMPLEX_RESTORE_DEFERRED_FIELD_TYPES == expected

    def test_no_overlap_with_simple(self):
        assert (
            SIMPLE_RESTORABLE_FIELD_TYPES & COMPLEX_RESTORE_DEFERRED_FIELD_TYPES
        ) == frozenset()


# ── 2. can_restore_field_type 判定 ────────────────────────────


class TestCanRestoreFieldType:
    """简单类型返回 True，其余全 False。"""

    @pytest.mark.parametrize("ftype", sorted(SIMPLE_RESTORABLE_FIELD_TYPES))
    def test_simple_types_can_restore(self, ftype):
        assert can_restore_field_type(ftype) is True

    @pytest.mark.parametrize("ftype", sorted(COMPLEX_RESTORE_DEFERRED_FIELD_TYPES))
    def test_complex_types_can_restore_wave2(self, ftype):
        """Wave 2 升级：复杂类型现在也支持 undo。"""
        assert can_restore_field_type(ftype) is True

    def test_unknown_type_cannot_restore(self):
        assert can_restore_field_type("nonexistent_type_xyz") is False

    def test_empty_string_cannot_restore(self):
        assert can_restore_field_type("") is False

    def test_none_cannot_restore(self):
        assert can_restore_field_type(None) is False  # type: ignore[arg-type]

    def test_whitespace_normalization(self):
        assert can_restore_field_type("  text  ") is True


# ── 3. explain_field_restore_capability 三档反馈 ──────────────


class TestExplainFieldRestoreCapability:
    @pytest.mark.parametrize("ftype", sorted(SIMPLE_RESTORABLE_FIELD_TYPES))
    def test_simple_supported(self, ftype):
        result = explain_field_restore_capability(ftype)
        assert result["can_undo"] is True
        assert result["reason_code"] == "simple_supported"
        assert result["deferred_to"] is None
        # W0-7 文案要求"撤销"用词，不出现"回滚"/"还原"
        assert "撤销" in result["reason"]
        assert "回滚" not in result["reason"]
        assert "还原" not in result["reason"]

    @pytest.mark.parametrize("ftype", sorted(COMPLEX_RESTORE_DEFERRED_FIELD_TYPES))
    def test_complex_supported_wave2(self, ftype):
        """Wave 2 升级：复杂类型现在返回 can_undo=True。"""
        result = explain_field_restore_capability(ftype)
        assert result["can_undo"] is True
        assert result["reason_code"] == "complex_supported"
        assert result["deferred_to"] is None
        assert "依赖" in result["reason"]

    def test_long_text_now_supported(self):
        """#4039: long_text 已纳入简单可恢复类型。"""
        result = explain_field_restore_capability("long_text")
        assert result["can_undo"] is True
        assert result["reason_code"] == "simple_supported"
        assert result["deferred_to"] is None
        assert "撤销" in result["reason"]

    def test_unknown_type_is_not_supported(self):
        result = explain_field_restore_capability("retired_field_type")
        assert result["can_undo"] is False
        assert result["reason_code"] == "unknown_type"
        assert result["deferred_to"] == "version_history"
        assert "即将上线" not in result["reason"]
        assert "版本时间线" in result["reason"] or "版本历史" in result["reason"]

    def test_unknown_type(self):
        result = explain_field_restore_capability("xyz_unknown")
        assert result["can_undo"] is False
        assert result["reason_code"] == "unknown_type"
        assert result["deferred_to"] == "version_history"


# ── 4. restore_field 非白名单类型抛 FieldRestoreNotSupportedError ──


class TestRestoreFieldComplexRaises409:
    """非白名单类型抛 FieldRestoreNotSupportedError。"""

    def test_unknown_type_raises_not_supported(self):
        payload = {
            "id": str(uuid4()),
            "table_id": str(uuid4()),
            "name": "未知字段",
            "field_type": "retired_field_type",
        }
        with pytest.raises(FieldRestoreNotSupportedError) as excinfo:
            restore_field(payload, write_changelog=False)

        assert excinfo.value.reason_code == "unknown_type"


# ── 5. restore_fields 批量入口"全或无"语义 ─────────────────────


class TestRestoreFieldsBatchAllOrNothing:
    def test_pure_simple_proceeds(self):
        """全部简单字段时，不抛错（实际 restore 失败由 mock 控制）。"""
        payloads = [
            {"id": str(uuid4()), "table_id": str(uuid4()),
             "name": f"f{i}", "field_type": "text"}
            for i in range(3)
        ]
        # 让 restore_field 假装全部成功
        with patch(
            "apps.tabdata.services.undo_redo_field_restore.restore_field",
            return_value=(True, None),
        ):
            restored, errors = restore_fields(payloads, write_changelog=False)

        assert len(restored) == 3
        assert errors == []

    def test_mixed_link_no_longer_aborts(self):
        """关联字段不触发整体 409，混合批量走 best-effort。"""
        payloads = [
            {"id": str(uuid4()), "table_id": str(uuid4()),
             "name": "name_a", "field_type": "text"},
            {"id": str(uuid4()), "table_id": str(uuid4()),
             "name": "name_b", "field_type": "link"},
            {"id": str(uuid4()), "table_id": str(uuid4()),
             "name": "name_c", "field_type": "number"},
        ]

        with patch(
            "apps.tabdata.services.undo_redo_field_restore.restore_field",
            return_value=(True, None),
        ):
            restored, errors = restore_fields(payloads, write_changelog=False)

        assert len(restored) == 3
        assert errors == []

    def test_simple_per_record_failure_continues(self):
        """简单字段单条失败时，其他继续 restore（best-effort）。"""
        payloads = [
            {"id": str(uuid4()), "table_id": str(uuid4()),
             "name": "f1", "field_type": "text"},
            {"id": str(uuid4()), "table_id": str(uuid4()),
             "name": "f2", "field_type": "number"},
        ]

        # 第一条失败、第二条成功
        call_count = [0]

        def _flaky_restore(payload, **_kw):
            call_count[0] += 1
            if call_count[0] == 1:
                return False, "模拟 DB 错误"
            return True, None

        with patch(
            "apps.tabdata.services.undo_redo_field_restore.restore_field",
            side_effect=_flaky_restore,
        ):
            restored, errors = restore_fields(payloads, write_changelog=False)

        assert len(restored) == 1
        assert len(errors) == 1
        assert errors[0][1] == "模拟 DB 错误"


# ── 6. UndoRedoOperationService.execute 不吞 FieldRestoreNotSupportedError ──


class TestExecuteDoesNotSwallowNotSupported:
    """非白名单类型 undo 时仍抛异常，不被吞掉。"""

    def test_execute_raises_for_non_restorable_type(self):
        from apps.tabdata.services.undo_redo_operation_service import (
            UndoRedoOperationName,
            UndoRedoOperationService,
        )

        svc = UndoRedoOperationService(user=None)
        operation = svc.build_operation(
            name=UndoRedoOperationName.DELETE_FIELDS,
            table_id=uuid4(),
            action="delete",
            action_display="删除字段",
            field_changes={"_fields": {"old": [], "new": None}},
            items=[],
            result={
                "fields": [{
                    "id": str(uuid4()),
                    "table_id": str(uuid4()),
                    "name": "未知字段",
                    "field_type": "retired_field_type",
                }],
            },
            window_id=None,
        )

        with pytest.raises(FieldRestoreNotSupportedError):
            svc.execute(operation=operation, direction="undo")


# ── 7. api_undo_redo._field_restore_not_supported_response 输出结构 ──


class TestFieldRestoreNotSupportedResponse:
    """C1.2 API 层 409 响应结构验证（W1.4 前端消费）。"""

    def test_response_status_409(self):
        from apps.tabdata.api_undo_redo import _field_restore_not_supported_response

        exc = FieldRestoreNotSupportedError(
            "无法撤销删除「测试」（未知字段）",
            field_id="abc-id",
            field_name="测试",
            field_type="retired_field_type",
            reason_code="unknown_type",
        )
        status, body = _field_restore_not_supported_response(exc)

        assert status == 409
        assert body["success"] is False
        from apps.tabdata.error_codes import ErrorCode
        assert body["code"] == ErrorCode.FIELD_RESTORE_NOT_SUPPORTED
        assert body["data"]["field_id"] == "abc-id"
        assert body["data"]["field_name"] == "测试"
        assert body["data"]["field_type"] == "retired_field_type"
        assert body["data"]["reason_code"] == "unknown_type"
        # P0 修复（Review §B-2）：本期不交付字段回收站
        assert body["data"]["deferred_to"] == "version_history"
        # P0 修复（Review §B-1）：响应携带全量分类列表
        assert "unrestorable_fields" in body["data"]
        assert "restorable_fields" in body["data"]

    def test_response_carries_full_classification_lists(self):
        """B-1 P0：批量字段 undo 含复杂字段时,响应携带全量 unrestorable / restorable 列表。"""
        from apps.tabdata.api_undo_redo import _field_restore_not_supported_response

        unrestorable = [
            {"field_id": "f1", "field_name": "旧字段", "field_type": "retired_field_type",
             "reason_code": "unknown_type", "reason": "..."},
        ]
        restorable = [
            {"field_id": "f2", "field_name": "客户名", "field_type": "text",
             "reason_code": "simple_supported", "reason": "..."},
            {"field_id": "f3", "field_name": "数量", "field_type": "number",
             "reason_code": "simple_supported", "reason": "..."},
        ]
        exc = FieldRestoreNotSupportedError(
            "无法撤销删除「旧字段」（未知字段）",
            field_id="f1", field_name="旧字段", field_type="retired_field_type",
            reason_code="unknown_type",
            unrestorable_fields=unrestorable,
            restorable_fields=restorable,
        )
        status, body = _field_restore_not_supported_response(exc)

        assert body["data"]["unrestorable_fields"] == unrestorable
        assert body["data"]["restorable_fields"] == restorable
        assert len(body["data"]["restorable_fields"]) == 2
        assert len(body["data"]["unrestorable_fields"]) == 1


# ── 8. C1 simple-field 原子 restore 流程（mock DB） ──────────


class TestRestoreFieldSimpleAtomicFlow:
    """简单字段必须走全链路：ORM update + native add_column + view + ChangeLog。"""

    @patch("apps.tabdata.services.undo_redo_field_restore._write_field_restore_changelog")
    @patch("apps.tabdata.services.undo_redo_field_restore._restore_native_column_for_field")
    @patch("apps.tabdata.services.table_service.TableService")
    @patch("apps.tabdata.models.TableField.objects")
    def test_simple_text_field_calls_full_chain(
        self, mock_objects, mock_table_service, mock_native, mock_changelog,
    ):
        """text 字段 restore 应触发：ORM update + native add + service refresh + ChangeLog。"""
        # mock 字段存在且已删
        existing_field = MagicMock(
            is_deleted=True,
            id=uuid4(),
            field_type="text",
            name="text_field",
            description="",
            config={},
            order=0,
            width=150,
            is_primary=False,
            is_hidden=False,
            validation_rules={},
        )
        # 模拟两次 .filter() 链：duplicate check（exists=False）+ pk lookup（first=existing_field）
        # 用 side_effect 让第一次调用返回"无重名"，第二次返回 existing_field
        duplicate_mgr = MagicMock()
        duplicate_mgr.exclude.return_value.exists.return_value = False
        first_mgr = MagicMock()
        first_mgr.first.return_value = existing_field
        update_mgr = MagicMock()
        update_mgr.update.return_value = 1

        mock_objects.using.return_value.filter.side_effect = [
            duplicate_mgr,   # filter(table_id=, name=, is_deleted=False)
            first_mgr,       # filter(id=field_id).first()
            update_mgr,      # filter(id=field_id).update(...)
        ]

        # mock TableService 内部 _refresh_field_count / _increment_schema_version /
        # _auto_add_field_to_views / _publish_field_event
        svc_instance = MagicMock()
        mock_table_service.return_value = svc_instance

        payload = {
            "id": str(uuid4()),
            "table_id": str(uuid4()),
            "name": "text_field",
            "field_type": "text",
            "config": {},
            "order": 0,
        }

        success, err = restore_field(payload, user=MagicMock(id="user-1"))

        assert success is True, f"应该返回 True，实际 err={err}"
        # native 列重建必须被调用
        assert mock_native.called
        # service 内部各 refresh 都被调用
        assert svc_instance._refresh_field_count.called
        assert svc_instance._increment_schema_version.called
        # P1 修复（Review §A-1）：现在走 _restore_field_to_views_at_order
        # 而不是 _auto_add_field_to_views（避免字段位置错乱）
        # _publish_field_event 仍走 service
        assert svc_instance._publish_field_event.called
        # ChangeLog 写入（C5 链路）
        assert mock_changelog.called

    @patch("apps.tabdata.models.TableField.objects")
    def test_field_not_found_returns_error(self, mock_objects):
        # duplicate check 返回 false
        duplicate_mgr = MagicMock()
        duplicate_mgr.exclude.return_value.exists.return_value = False
        # field 不存在
        first_mgr = MagicMock()
        first_mgr.first.return_value = None

        mock_objects.using.return_value.filter.side_effect = [
            duplicate_mgr,
            first_mgr,
        ]

        payload = {
            "id": str(uuid4()),
            "table_id": str(uuid4()),
            "name": "missing",
            "field_type": "text",
        }

        success, err = restore_field(payload, write_changelog=False)
        assert success is False
        assert "不存在" in err or "永久删除" in err

    @patch("apps.tabdata.models.TableField.objects")
    def test_duplicate_name_returns_error(self, mock_objects):
        # 假设有同名活字段
        duplicate_mgr = MagicMock()
        duplicate_mgr.exclude.return_value.exists.return_value = True

        mock_objects.using.return_value.filter.side_effect = [
            duplicate_mgr,
        ]

        payload = {
            "id": str(uuid4()),
            "table_id": str(uuid4()),
            "name": "dup_name",
            "field_type": "text",
        }

        success, err = restore_field(payload, write_changelog=False)
        assert success is False
        assert "同名" in err

    @patch("apps.tabdata.models.TableField.objects")
    def test_field_already_active_idempotent(self, mock_objects):
        """字段已激活时（is_deleted=False），幂等返回成功，不重复跑后续步骤。"""
        existing_field = MagicMock(is_deleted=False, name="already")

        duplicate_mgr = MagicMock()
        duplicate_mgr.exclude.return_value.exists.return_value = False
        first_mgr = MagicMock()
        first_mgr.first.return_value = existing_field

        mock_objects.using.return_value.filter.side_effect = [
            duplicate_mgr,
            first_mgr,
        ]

        payload = {
            "id": str(uuid4()),
            "table_id": str(uuid4()),
            "name": "already",
            "field_type": "text",
        }

        success, err = restore_field(payload, write_changelog=False)
        assert success is True
        assert err is None


# ── 9. ErrorCode 常量已注册 ────────────────────────────────


class TestErrorCodeRegistration:
    def test_field_restore_not_supported_code_exists(self):
        from apps.tabdata.error_codes import ErrorCode, ErrorMessage

        assert hasattr(ErrorCode, "FIELD_RESTORE_NOT_SUPPORTED")
        # i18n key 已注册
        assert ErrorCode.FIELD_RESTORE_NOT_SUPPORTED in ErrorMessage._CODE_TO_I18N
        # 文案 fallback 已注册
        assert ErrorCode.FIELD_RESTORE_NOT_SUPPORTED in ErrorMessage.MESSAGES
        # 文案符合 W0-7：用「无法撤销删除」 + 「版本历史」引导（P0 修复 Review §B-2）
        msg = ErrorMessage.MESSAGES[ErrorCode.FIELD_RESTORE_NOT_SUPPORTED]
        assert "无法撤销删除" in msg
        # P0 修复：本期不交付字段回收站,不再写"即将上线"空头承诺,改引导版本历史
        assert "版本历史" in msg
        assert "即将上线" not in msg
        # 禁用「回滚」（"还原"在版本恢复语境下合规,不再禁用）
        assert "回滚" not in msg

    def test_i18n_keys_registered_in_all_three_locales(self):
        """P0 修复（Review §3 P0-1）：i18n 词条必须在 zh-CN/en-US/ja-JP 三处注册。"""
        import json
        import os

        base_dir = os.path.join(
            os.path.dirname(__file__), "..", "..", "i18n", "locales",
        )
        for locale in ["zh-CN.json", "en-US.json", "ja-JP.json"]:
            with open(os.path.join(base_dir, locale), encoding="utf-8") as f:
                data = json.load(f)
            tabdata = data.get("tabdata", {})
            assert "field_restore_not_supported" in tabdata, (
                f"{locale} 缺 tabdata.field_restore_not_supported 词条"
            )
            assert "table_schema_token_mismatch" in tabdata, (
                f"{locale} 缺 tabdata.table_schema_token_mismatch 词条"
            )
