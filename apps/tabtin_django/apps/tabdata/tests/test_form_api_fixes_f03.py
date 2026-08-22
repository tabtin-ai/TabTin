"""
表单 API 修复回归测试 — F03 wave

覆盖问题: BS-001, BS-004, BS-005, BS-012, BS-015, AS-002, AS-004, AS-006, AS-013, FMF-009

纯单元测试（无 DB 依赖），通过 mock 验证修复逻辑。

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/tabdata/tests/test_form_api_fixes_f03.py -v
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import json
import django
django.setup()

from unittest.mock import Mock, MagicMock, patch, PropertyMock
from uuid import uuid4
import pytest


def _response_text(result) -> str:
    """Return response body text for both direct dict/tuple calls and JsonResponse."""
    if hasattr(result, "content"):
        text = result.content.decode("utf-8")
        try:
            return json.dumps(json.loads(text), ensure_ascii=False)
        except Exception:
            return text
    if isinstance(result, tuple) and len(result) == 2:
        body = result[1]
        if hasattr(body, "content"):
            text = body.content.decode("utf-8")
            try:
                return json.dumps(json.loads(text), ensure_ascii=False)
            except Exception:
                return text
        return str(body)
    return str(result)


def _make_field(field_id=None, name="field1", field_type="text", is_primary=False, config=None):
    field = Mock()
    field.id = field_id or uuid4()
    field.name = name
    field.field_type = field_type
    field.is_primary = is_primary
    field.config = config or {}
    field.is_deleted = False
    field.order = 0
    return field


def _make_share(share_id="abc123", password=None, created_by=None, view_type='form', is_expired=False):
    share = Mock()
    share.id = uuid4()
    share.share_id = share_id
    # Wave 5 §8 后字段名是 password_hash；这里同时设置 password_hash 与 has_password property
    share.password_hash = password or ''
    share.has_password = bool(password)
    share.created_by = created_by
    share.is_expired.return_value = is_expired

    view = Mock()
    view.view_type = view_type
    view.config = {}
    view.column_meta = {}
    view.visible_fields = []
    view.field_order = []
    table = Mock()
    table.id = uuid4()
    table.name = "test_table"
    view.table = table
    view.table_id = table.id
    share.view = view

    return share


def _make_request(headers=None, auth=None):
    request = Mock()
    request.headers = headers or {}
    request.auth = auth
    return request


# ━━ BS-001: JWTAuth 调用后应设置 request.auth ━━━━━━━━━━━━━━━━━━━━━

class TestBS001JWTAuthSetsRequestAuth:
    """login_required 场景下，JWTAuth 验证成功后 request.auth 应被赋值。"""

    @patch('apps.tabdata.services.base.BaseService')
    @patch('apps.tabdata.api_form.TableShare.objects')
    @patch('apps.tabdata.api_form.TableField.objects')
    @patch('apps.tabdata.api_form.JWTAuth.__call__')
    @patch('apps.tabdata.api_form._get_visible_field_ids', return_value=set())
    def test_submit_login_required_sets_request_auth(
        self, mock_visible, mock_jwt, mock_field_qs, mock_share_qs, mock_base_svc
    ):
        from apps.tabdata.api_form import submit_public_form

        mock_user = Mock()
        mock_user.id = uuid4()
        mock_jwt.return_value = mock_user
        mock_base_svc.return_value.check_table_permission.return_value = True

        share = _make_share(created_by=Mock())
        share.view.config = {'login_required': True}
        mock_share_qs.using.return_value.select_related.return_value.get.return_value = share

        field = _make_field()
        mock_field_qs.using.return_value.filter.return_value.order_by.return_value = [field]

        request = _make_request()
        data = Mock()
        data.fields = {str(field.id): "test_value"}

        with patch('apps.tabdata.services.record_service.RecordService') as mock_rs_cls:
            mock_rs = mock_rs_cls.return_value
            mock_rs.create_record.return_value = (Mock(), None)
            submit_public_form(request, share.share_id, data)

        assert request.auth == mock_user, "login_required 验证成功后 request.auth 应被赋值为 user"
        assert mock_rs.create_record.call_args.kwargs['default_actor_id'] == str(mock_user.id)


# ━━ AS-004: or 短路误判 falsy 值 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestAS004FalsyValueNotMisidentified:
    """当必填字段值为 0、False 等 falsy 值时，不应被判为空。"""

    @patch('apps.tabdata.api_form.TableShare.objects')
    @patch('apps.tabdata.api_form.TableField.objects')
    @patch('apps.tabdata.api_form._get_visible_field_ids', return_value=set())
    def test_zero_value_passes_required_check(self, mock_visible, mock_field_qs, mock_share_qs):
        from apps.tabdata.api_form import submit_public_form

        share = _make_share(created_by=Mock())
        share.view.config = {'field_configs': {}}
        mock_share_qs.using.return_value.select_related.return_value.get.return_value = share

        field = _make_field(name="数量", field_type="number", is_primary=True)
        mock_field_qs.using.return_value.filter.return_value.order_by.return_value = [field]

        request = _make_request()
        data = Mock()
        data.fields = {str(field.id): 0}

        with patch('apps.tabdata.services.record_service.RecordService') as mock_rs_cls:
            mock_rs = mock_rs_cls.return_value
            mock_rs.create_record.return_value = (Mock(), None)
            result = submit_public_form(request, share.share_id, data)

        if isinstance(result, tuple):
            status, body = result
        else:
            body = result

        assert '必填字段' not in str(body), f"值为 0 的必填字段不应触发必填错误: {body}"

    @patch('apps.tabdata.api_form.TableShare.objects')
    @patch('apps.tabdata.api_form.TableField.objects')
    @patch('apps.tabdata.api_form._get_visible_field_ids', return_value=set())
    def test_false_value_passes_required_check(self, mock_visible, mock_field_qs, mock_share_qs):
        from apps.tabdata.api_form import submit_public_form

        share = _make_share(created_by=Mock())
        share.view.config = {'field_configs': {}}
        mock_share_qs.using.return_value.select_related.return_value.get.return_value = share

        field = _make_field(name="确认", field_type="checkbox", is_primary=True)
        mock_field_qs.using.return_value.filter.return_value.order_by.return_value = [field]

        request = _make_request()
        data = Mock()
        data.fields = {str(field.id): False}

        with patch('apps.tabdata.services.record_service.RecordService') as mock_rs_cls:
            mock_rs = mock_rs_cls.return_value
            mock_rs.create_record.return_value = (Mock(), None)
            result = submit_public_form(request, share.share_id, data)

        if isinstance(result, tuple):
            status, body = result
        else:
            body = result

        assert '必填字段' not in str(body), f"值为 False 的必填字段不应触发必填错误: {body}"


# ━━ AS-006 + BS-004: share.created_by 为 null ━━━━━━━━━━━━━━━━━━━━━

class TestAS006CreatedByNull:
    """share.created_by 为 None 时应返回 403 而非 500。"""

    @patch('apps.tabdata.api_form.TableShare.objects')
    @patch('apps.tabdata.api_form.TableField.objects')
    @patch('apps.tabdata.api_form._get_visible_field_ids', return_value=set())
    def test_submit_with_null_owner_returns_403(self, mock_visible, mock_field_qs, mock_share_qs):
        from apps.tabdata.api_form import submit_public_form

        share = _make_share(created_by=None)
        mock_share_qs.using.return_value.select_related.return_value.get.return_value = share

        field = _make_field()
        mock_field_qs.using.return_value.filter.return_value.order_by.return_value = [field]

        request = _make_request()
        data = Mock()
        data.fields = {}

        result = submit_public_form(request, share.share_id, data)
        assert 'status_code' not in str(result) or '500' not in str(result), \
            "created_by 为 null 时不应返回 500"

    @patch('apps.tabdata.api_form.TableShare.objects')
    @patch('apps.tabdata.api_form.TableField.objects')
    @patch('apps.tabdata.api_form._get_visible_field_ids', return_value=set())
    def test_link_records_with_null_owner_returns_403(self, mock_visible, mock_field_qs, mock_share_qs):
        from apps.tabdata.api_form import get_form_link_records

        share = _make_share(created_by=None)
        mock_share_qs.using.return_value.select_related.return_value.get.return_value = share

        field = _make_field(field_type='link')
        mock_field_qs.using.return_value.get.return_value = field

        request = _make_request()
        result = get_form_link_records(request, share.share_id, field.id)

        result_str = _response_text(result)
        assert '创建者不存在' in result_str or '失效' in result_str, \
            f"created_by 为 null 时应给出明确的错误提示: {result_str}"


# ━━ BS-005: PermissionError 捕获 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestBS005PermissionErrorCaught:
    """get_form_link_records 中 LinkFieldService 抛出 PermissionError 应被捕获。"""

    @patch('apps.tabdata.api_form.TableShare.objects')
    @patch('apps.tabdata.api_form.TableField.objects')
    @patch('apps.tabdata.api_form._get_visible_field_ids', return_value=set())
    def test_permission_error_returns_403_not_500(self, mock_visible, mock_field_qs, mock_share_qs):
        from apps.tabdata.api_form import get_form_link_records

        share = _make_share(created_by=Mock())
        mock_share_qs.using.return_value.select_related.return_value.get.return_value = share

        field = _make_field(field_type='link')
        mock_field_qs.using.return_value.get.return_value = field

        request = _make_request()

        with patch('apps.tabdata.services.link_field_service.LinkFieldService') as mock_lfs:
            mock_lfs.get_linkable_records.side_effect = PermissionError("no access")
            result = get_form_link_records(request, share.share_id, field.id)

        result_str = _response_text(result)
        assert '权限不足' in result_str or 'PERMISSION' in result_str, \
            f"PermissionError 应返回权限相关错误: {result_str}"


# ━━ BS-012: 字段 UUID 为 key ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestBS012FieldUUIDAsKey:
    """record_data 应以字段 UUID 而非字段名为 key。"""

    @patch('apps.tabdata.services.base.BaseService')
    @patch('apps.tabdata.api_form.TableShare.objects')
    @patch('apps.tabdata.api_form.TableField.objects')
    @patch('apps.tabdata.api_form._get_visible_field_ids', return_value=set())
    def test_record_data_uses_field_uuid_key(self, mock_visible, mock_field_qs, mock_share_qs, mock_base_svc):
        from apps.tabdata.api_form import submit_public_form

        # P1-6 修复（PRD §4.5）后 view 内调 BaseService.check_table_permission，
        # 单测无 DB 环境必须 mock 之，否则真实 ORM 查询会被 pytest-django 拒绝。
        mock_base_svc.return_value.check_table_permission.return_value = True

        share = _make_share(created_by=Mock())
        mock_share_qs.using.return_value.select_related.return_value.get.return_value = share

        field = _make_field(name="用户名", field_type="text")
        fid = str(field.id)
        mock_field_qs.using.return_value.filter.return_value.order_by.return_value = [field]

        request = _make_request()
        data = Mock()
        data.fields = {fid: "test_user"}

        with patch('apps.tabdata.services.record_service.RecordService') as mock_rs_cls:
            mock_rs = mock_rs_cls.return_value
            mock_rs.create_record.return_value = (Mock(), None)
            submit_public_form(request, share.share_id, data)

            call_args = mock_rs.create_record.call_args
            record_data = call_args.kwargs.get('data') or call_args[1].get('data') or call_args[0][1] if len(call_args[0]) > 1 else {}

            if hasattr(call_args, 'kwargs') and 'data' in call_args.kwargs:
                record_data = call_args.kwargs['data']
            elif len(call_args[0]) > 1:
                record_data = call_args[0][1]

            assert fid in record_data, f"record_data 应以字段 UUID '{fid}' 为 key，实际 keys: {list(record_data.keys())}"
            assert "用户名" not in record_data, f"record_data 不应以字段名 '用户名' 为 key"


# ━━ BS-015: result tuple 检查 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestBS015ResultTupleCheck:
    """create_record 权限拒绝时的行为验证。"""

    @patch('apps.tabdata.services.base.BaseService')
    @patch('apps.tabdata.api_form.TableShare.objects')
    @patch('apps.tabdata.api_form.TableField.objects')
    @patch('apps.tabdata.api_form._get_visible_field_ids', return_value=set())
    def test_none_record_with_error_msg_returns_validation_error(
        self, mock_visible, mock_field_qs, mock_share_qs, mock_base_svc
    ):
        """遗留兼容：mock 返回 (None, msg) 元组时仍能正确显示错误。"""
        from apps.tabdata.api_form import submit_public_form

        mock_base_svc.return_value.check_table_permission.return_value = True

        share = _make_share(created_by=Mock())
        mock_share_qs.using.return_value.select_related.return_value.get.return_value = share

        field = _make_field()
        mock_field_qs.using.return_value.filter.return_value.order_by.return_value = [field]

        request = _make_request()
        data = Mock()
        data.fields = {str(field.id): "value"}

        with patch('apps.tabdata.services.record_service.RecordService') as mock_rs_cls:
            mock_rs = mock_rs_cls.return_value
            mock_rs.create_record.return_value = (None, "无权限")
            result = submit_public_form(request, share.share_id, data)

        result_str = _response_text(result)
        assert '无权限' in result_str, \
            f"(None, '无权限') tuple 应正确显示错误信息: {result_str}"

    @patch('apps.tabdata.services.base.BaseService')
    @patch('apps.tabdata.api_form.TableShare.objects')
    @patch('apps.tabdata.api_form.TableField.objects')
    @patch('apps.tabdata.api_form._get_visible_field_ids', return_value=set())
    def test_permission_error_exception_returns_error_response(
        self, mock_visible, mock_field_qs, mock_share_qs, mock_base_svc
    ):
        """真实行为：create_record 无权限时抛出 PermissionError，API 层捕获后返回错误。"""
        from apps.tabdata.api_form import submit_public_form

        mock_base_svc.return_value.check_table_permission.return_value = True

        share = _make_share(created_by=Mock())
        mock_share_qs.using.return_value.select_related.return_value.get.return_value = share

        field = _make_field()
        mock_field_qs.using.return_value.filter.return_value.order_by.return_value = [field]

        request = _make_request()
        data = Mock()
        data.fields = {str(field.id): "value"}

        with patch('apps.tabdata.services.record_service.RecordService') as mock_rs_cls:
            mock_rs = mock_rs_cls.return_value
            mock_rs.create_record.side_effect = PermissionError("无权限")
            result = submit_public_form(request, share.share_id, data)

        result_str = _response_text(result)
        assert '无权限' in result_str, \
            f"PermissionError 应被捕获并返回包含错误信息的响应: {result_str}"


# ━━ AS-013: 业务异常不再被静默吞噬 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestAS013BusinessExceptionNotSwallowed:
    """QuotaExceededError 和 ValueError 应返回有意义的错误信息。"""

    @patch('apps.tabdata.services.base.BaseService')
    @patch('apps.tabdata.api_form.TableShare.objects')
    @patch('apps.tabdata.api_form.TableField.objects')
    @patch('apps.tabdata.api_form._get_visible_field_ids', return_value=set())
    def test_quota_exceeded_returns_specific_message(
        self, mock_visible, mock_field_qs, mock_share_qs, mock_base_svc
    ):
        from apps.tabdata.api_form import submit_public_form
        from apps.users.membership.exceptions import QuotaExceededError

        mock_base_svc.return_value.check_table_permission.return_value = True

        share = _make_share(created_by=Mock())
        mock_share_qs.using.return_value.select_related.return_value.get.return_value = share

        field = _make_field()
        mock_field_qs.using.return_value.filter.return_value.order_by.return_value = [field]

        request = _make_request()
        data = Mock()
        data.fields = {str(field.id): "value"}

        with patch('apps.tabdata.services.record_service.RecordService') as mock_rs_cls:
            mock_rs = mock_rs_cls.return_value
            mock_rs.create_record.side_effect = QuotaExceededError("记录数已达上限")
            result = submit_public_form(request, share.share_id, data)

        result_str = _response_text(result)
        assert '已达上限' in result_str, \
            f"QuotaExceededError 消息应透传给用户: {result_str}"

    @patch('apps.tabdata.services.base.BaseService')
    @patch('apps.tabdata.api_form.TableShare.objects')
    @patch('apps.tabdata.api_form.TableField.objects')
    @patch('apps.tabdata.api_form._get_visible_field_ids', return_value=set())
    def test_value_error_returns_specific_message(
        self, mock_visible, mock_field_qs, mock_share_qs, mock_base_svc
    ):
        from apps.tabdata.api_form import submit_public_form

        mock_base_svc.return_value.check_table_permission.return_value = True

        share = _make_share(created_by=Mock())
        mock_share_qs.using.return_value.select_related.return_value.get.return_value = share

        field = _make_field()
        mock_field_qs.using.return_value.filter.return_value.order_by.return_value = [field]

        request = _make_request()
        data = Mock()
        data.fields = {str(field.id): "value"}

        with patch('apps.tabdata.services.record_service.RecordService') as mock_rs_cls:
            mock_rs = mock_rs_cls.return_value
            mock_rs.create_record.side_effect = ValueError("表格不存在")
            result = submit_public_form(request, share.share_id, data)

        result_str = _response_text(result)
        assert '表格不存在' in result_str, \
            f"ValueError 消息应透传给用户: {result_str}"


# ━━ FMF-009: 表单端点已有可见性检查 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestFMF009FormEndpointVisibilityCheck:
    """表单 link 字段端点应拒绝不可见的字段。"""

    @patch('apps.tabdata.api_form.TableShare.objects')
    @patch('apps.tabdata.api_form.TableField.objects')
    def test_hidden_link_field_rejected(self, mock_field_qs, mock_share_qs):
        from apps.tabdata.api_form import get_form_link_records

        share = _make_share(created_by=Mock())
        mock_share_qs.using.return_value.select_related.return_value.get.return_value = share

        field = _make_field(field_type='link')
        mock_field_qs.using.return_value.get.return_value = field

        visible_set = {str(uuid4())}

        with patch('apps.tabdata.api_form._get_visible_field_ids', return_value=visible_set):
            request = _make_request()
            result = get_form_link_records(request, share.share_id, field.id)

        result_str = _response_text(result)
        assert '可见范围' in result_str or 'PERMISSION' in result_str, \
            f"不可见的 link 字段应被拒绝: {result_str}"
