"""
BO-017 / BO-018 / BO-019 回归测试。

覆盖：
  BO-017: update_link_field 变更 foreignTableId 时必须校验用户对新目标表的权限
  BO-018: BO-017 修复后，config 无法被污染指向无权限表，元数据泄漏路径关闭
  BO-019: table_service.update_field 中 PermissionError 不应被吞为 ValueError

运行方式：
    cd apps/tabtin_django
    python -m pytest apps/tabdata/tests/test_bo017_update_link_permission.py -v
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from apps.tabdata.services.link_field_service import LinkFieldService


def _make_field(table_id=None, field_id=None, config=None):
    field = MagicMock()
    field.id = field_id or uuid4()
    field.table_id = table_id or uuid4()
    field.config = config or {}
    field.field_type = "link"
    field.is_deleted = False
    field.save = MagicMock()
    return field


def _make_table(table_id=None, space_id=None):
    table = MagicMock()
    table.id = table_id or uuid4()
    table.space_id = space_id or uuid4()
    table.is_archived = False
    return table


_NO_TX_ENTER = patch("django.db.transaction.Atomic.__enter__", return_value=None)
_NO_TX_EXIT = patch("django.db.transaction.Atomic.__exit__", return_value=False)


# ─── BO-017: update_link_field 变更 foreignTableId 时须校验权限 ───


@_NO_TX_EXIT
@_NO_TX_ENTER
@patch.object(LinkFieldService, "_handle_foreign_table_change")
@patch.object(LinkFieldService, "_check_foreign_table_permission", return_value=False)
@patch("apps.tabdata.services.link_field_service.Table")
def test_bo017_blocked_without_permission(mock_table_model, mock_check, mock_handle, *_):
    """无权限用户修改 foreignTableId 应抛出 PermissionError"""
    user = MagicMock(id=uuid4())
    old_target, new_target = uuid4(), uuid4()
    old_config = {"foreignTableId": str(old_target), "isOneWay": True}
    new_config = {"foreignTableId": str(new_target), "isOneWay": True}
    field = _make_field(config=dict(old_config))

    mock_table_model.objects.using.return_value.get.return_value = _make_table(table_id=new_target)

    with pytest.raises(PermissionError, match=str(new_target)):
        LinkFieldService.update_link_field(field, old_config, new_config, user=user)

    mock_handle.assert_not_called()


@_NO_TX_EXIT
@_NO_TX_ENTER
@patch.object(LinkFieldService, "_handle_foreign_table_change")
@patch.object(LinkFieldService, "_check_foreign_table_permission", return_value=True)
@patch("apps.tabdata.services.link_field_service.Table")
def test_bo017_allowed_with_permission(mock_table_model, mock_check, mock_handle, *_):
    """有权限用户修改 foreignTableId 应正常执行"""
    user = MagicMock(id=uuid4())
    new_target = uuid4()
    old_config = {"foreignTableId": str(uuid4()), "isOneWay": True}
    new_config = {"foreignTableId": str(new_target), "isOneWay": True}
    field = _make_field(config=dict(old_config))

    target_table = _make_table(table_id=new_target)
    mock_table_model.objects.using.return_value.get.return_value = target_table

    LinkFieldService.update_link_field(field, old_config, new_config, user=user)

    mock_check.assert_called_once_with(target_table, user, "viewer")
    mock_handle.assert_called_once()


@_NO_TX_EXIT
@_NO_TX_ENTER
@patch.object(LinkFieldService, "_handle_foreign_table_change")
@patch.object(LinkFieldService, "_check_foreign_table_permission")
def test_bo017_no_user_bypasses_check(mock_check, mock_handle, *_):
    """user=None（系统操作）跳过权限检查"""
    old_config = {"foreignTableId": str(uuid4()), "isOneWay": True}
    new_config = {"foreignTableId": str(uuid4()), "isOneWay": True}
    field = _make_field(config=dict(old_config))

    LinkFieldService.update_link_field(field, old_config, new_config, user=None)

    mock_check.assert_not_called()
    mock_handle.assert_called_once()


@_NO_TX_EXIT
@_NO_TX_ENTER
@patch.object(LinkFieldService, "_handle_foreign_table_change")
@patch.object(LinkFieldService, "_check_foreign_table_permission", return_value=True)
@patch("apps.tabdata.services.link_field_service.Table")
def test_bo017_user_forwarded_to_handler(mock_table_model, mock_check, mock_handle, *_):
    """user 参数正确传递给 _handle_foreign_table_change"""
    user = MagicMock(id=uuid4())
    old_config = {"foreignTableId": str(uuid4()), "isOneWay": True}
    new_config = {"foreignTableId": str(uuid4()), "isOneWay": True}
    field = _make_field(config=dict(old_config))

    mock_table_model.objects.using.return_value.get.return_value = _make_table()

    LinkFieldService.update_link_field(field, old_config, new_config, user=user)

    _, kwargs = mock_handle.call_args
    assert kwargs.get("user") is user


# ─── BO-018: 权限拒绝后 config 不被污染 ───


@_NO_TX_EXIT
@_NO_TX_ENTER
@patch.object(LinkFieldService, "_handle_foreign_table_change")
@patch.object(LinkFieldService, "_check_foreign_table_permission", return_value=False)
@patch("apps.tabdata.services.link_field_service.Table")
def test_bo018_config_not_polluted(mock_table_model, mock_check, mock_handle, *_):
    """权限拒绝后 field.config.foreignTableId 仍指向旧目标表"""
    old_target, new_target = uuid4(), uuid4()
    old_config = {"foreignTableId": str(old_target), "isOneWay": True}
    new_config = {"foreignTableId": str(new_target), "isOneWay": True}
    field = _make_field(config=dict(old_config))

    mock_table_model.objects.using.return_value.get.return_value = _make_table(table_id=new_target)

    with pytest.raises(PermissionError):
        LinkFieldService.update_link_field(
            field, old_config, new_config, user=MagicMock(),
        )

    assert field.config["foreignTableId"] == str(old_target)
    mock_handle.assert_not_called()


# ─── BO-019: PermissionError 穿透 table_service.update_field ───


def _setup_bo019_service_and_field():
    """BO-019 测试公共 setup：构造 TableService + mock field"""
    from apps.tabdata.services.table_service import TableService

    service = TableService.__new__(TableService)
    service.user = MagicMock(id=uuid4())

    field_id = uuid4()
    old_foreign = str(uuid4())
    new_foreign = str(uuid4())
    mock_field = _make_field(field_id=field_id, config={
        "relationship": "ManyOne",
        "foreignTableId": old_foreign,
        "isOneWay": True,
    })
    mock_field.field_type = "link"
    mock_field.is_primary = False

    return service, field_id, new_foreign, mock_field


def _patch_models_for_bo019(mock_tf, mock_table, mock_field, mock_ops, new_foreign, service):
    """配置 BO-019 测试的 mock，确保 DoesNotExist 是真正的异常类"""
    from apps.tabdata.models import TableField as RealTableField
    from apps.tabdata.models import Table as RealTable

    mock_tf.objects.using.return_value.get.return_value = mock_field
    mock_tf.DoesNotExist = RealTableField.DoesNotExist
    mock_table.objects.using.return_value.get.return_value = MagicMock(is_system_table=False)
    mock_table.DoesNotExist = RealTable.DoesNotExist
    mock_ops.return_value.serialize_field.return_value = {}


@_NO_TX_EXIT
@_NO_TX_ENTER
@patch("apps.tabdata.services.link_field_service.LinkFieldService.update_link_field",
       side_effect=PermissionError("无权限访问目标表"))
def test_bo019_permission_error_not_swallowed(mock_update, *_):
    """PermissionError 应穿透 update_field，不被转为 ValueError"""
    service, field_id, new_foreign, mock_field = _setup_bo019_service_and_field()

    with patch("apps.tabdata.services.table_service.TableField") as mock_tf, \
         patch("apps.tabdata.services.table_service.Table") as mock_table, \
         patch.object(service, "check_table_permission", return_value=True), \
         patch.object(service, "_get_operation_service") as mock_ops, \
         patch.object(service, "_normalize_field_options", return_value={
             "relationship": "ManyOne",
             "foreignTableId": new_foreign,
             "isOneWay": True,
         }):
        _patch_models_for_bo019(mock_tf, mock_table, mock_field, mock_ops, new_foreign, service)

        with pytest.raises(PermissionError):
            service.update_field(field_id=field_id, options={"foreignTableId": new_foreign})


@_NO_TX_EXIT
@_NO_TX_ENTER
@patch("apps.tabdata.services.link_field_service.LinkFieldService.update_link_field",
       side_effect=RuntimeError("内部错误"))
def test_bo019_other_exceptions_still_become_value_error(mock_update, *_):
    """非 PermissionError 的异常仍应被转为 ValueError"""
    service, field_id, new_foreign, mock_field = _setup_bo019_service_and_field()

    with patch("apps.tabdata.services.table_service.TableField") as mock_tf, \
         patch("apps.tabdata.services.table_service.Table") as mock_table, \
         patch.object(service, "check_table_permission", return_value=True), \
         patch.object(service, "_get_operation_service") as mock_ops, \
         patch.object(service, "_normalize_field_options", return_value={
             "relationship": "ManyOne",
             "foreignTableId": new_foreign,
             "isOneWay": True,
         }):
        _patch_models_for_bo019(mock_tf, mock_table, mock_field, mock_ops, new_foreign, service)

        with pytest.raises(ValueError, match="Link 字段配置更新失败"):
            service.update_field(field_id=field_id, options={"foreignTableId": new_foreign})
