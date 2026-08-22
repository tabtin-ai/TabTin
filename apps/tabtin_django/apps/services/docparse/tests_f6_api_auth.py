"""
F6 回归测试 — DocParse API 认证与权限校验（DP-001）

覆盖:
- /status/{file_record_id} 端点要求 JWTAuth
- /parse/{file_record_id} 端点要求 JWTAuth
- 文件归属校验：upload_user 匹配 / organization 可达 / 无权被拒绝
"""

import uuid
from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase, RequestFactory

from apps.services.docparse.api import get_parse_status, trigger_parse, _check_file_ownership


class _FakeUser:
    """模拟 JWTAuth 认证返回的 User 对象。"""

    def __init__(self, user_id=None):
        self.id = user_id or uuid.uuid4()
        self.is_active = True


def _make_file_record(upload_user="", organization_id=""):
    fr = MagicMock()
    fr.upload_user = upload_user
    fr.organization_id = organization_id
    fr.id = uuid.uuid4()
    return fr


class DocParseAPIAuthRequiredTests(SimpleTestCase):
    """DP-001: 源码级验证两个端点声明了 auth=jwt_auth。"""

    def test_status_endpoint_has_jwt_auth(self):
        import inspect
        src = inspect.getsource(
            __import__('apps.services.docparse.api', fromlist=['api'])
        )
        self.assertIn('auth=jwt_auth', src, "get_parse_status 端点必须声明 auth=jwt_auth")

    def test_parse_endpoint_has_jwt_auth(self):
        import inspect
        src = inspect.getsource(
            __import__('apps.services.docparse.api', fromlist=['api'])
        )
        self.assertIn('auth=jwt_auth', src, "trigger_parse 端点必须声明 auth=jwt_auth")


class FileOwnershipCheckTests(SimpleTestCase):
    """DP-001: _check_file_ownership 权限校验单元测试。"""

    def _make_request(self, user_id=None):
        factory = RequestFactory()
        request = factory.get("/")
        request.auth = _FakeUser(user_id=user_id)
        return request

    @patch("apps.services.docparse.api.FileRecord")
    def test_owner_allowed(self, mock_fr_cls):
        user_id = str(uuid.uuid4())
        fr = _make_file_record(upload_user=user_id)
        mock_fr_cls.objects.filter.return_value.first.return_value = fr

        request = self._make_request(user_id=user_id)
        result_fr, err = _check_file_ownership(request, str(fr.id))

        self.assertIsNone(err)
        self.assertEqual(result_fr, fr)

    @patch("apps.services.docparse.api.FileRecord")
    def test_other_user_denied(self, mock_fr_cls):
        fr = _make_file_record(upload_user=str(uuid.uuid4()), organization_id="")
        mock_fr_cls.objects.filter.return_value.first.return_value = fr

        request = self._make_request(user_id=uuid.uuid4())
        result_fr, err = _check_file_ownership(request, str(fr.id))

        self.assertIsNone(result_fr)
        self.assertIn("无权", err["message"])
        self.assertEqual(err["code"], 403)

    @patch("apps.services.docparse.api.FileRecord")
    def test_nonexistent_file_returns_404(self, mock_fr_cls):
        mock_fr_cls.objects.filter.return_value.first.return_value = None

        request = self._make_request()
        result_fr, err = _check_file_ownership(request, str(uuid.uuid4()))

        self.assertIsNone(result_fr)
        self.assertEqual(err["code"], 404)

    @patch("apps.tabtinspace.services.base.BaseService")
    @patch("apps.services.docparse.api.FileRecord")
    def test_organization_member_allowed(self, mock_fr_cls, mock_base_svc_cls):
        ws_id = str(uuid.uuid4())
        fr = _make_file_record(upload_user=str(uuid.uuid4()), organization_id=ws_id)
        mock_fr_cls.objects.filter.return_value.first.return_value = fr

        mock_svc = MagicMock()
        mock_svc.check_organization_permission.return_value = True
        mock_base_svc_cls.return_value = mock_svc

        request = self._make_request(user_id=uuid.uuid4())
        result_fr, err = _check_file_ownership(request, str(fr.id))

        self.assertIsNone(err)
        self.assertEqual(result_fr, fr)
        mock_svc.check_organization_permission.assert_called_once_with(ws_id, "viewer")

    @patch("apps.tabtinspace.services.base.BaseService")
    @patch("apps.services.docparse.api.FileRecord")
    def test_non_organization_member_denied(self, mock_fr_cls, mock_base_svc_cls):
        ws_id = str(uuid.uuid4())
        fr = _make_file_record(upload_user=str(uuid.uuid4()), organization_id=ws_id)
        mock_fr_cls.objects.filter.return_value.first.return_value = fr

        mock_svc = MagicMock()
        mock_svc.check_organization_permission.return_value = False
        mock_base_svc_cls.return_value = mock_svc

        request = self._make_request(user_id=uuid.uuid4())
        result_fr, err = _check_file_ownership(request, str(fr.id))

        self.assertIsNone(result_fr)
        self.assertEqual(err["code"], 403)


class StatusEndpointOwnershipTests(SimpleTestCase):
    """DP-001: get_parse_status 在校验不通过时返回错误。"""

    @patch("apps.services.docparse.api._check_file_ownership")
    def test_status_returns_error_when_unauthorized(self, mock_check):
        mock_check.return_value = (None, {"status": "error", "message": "无权访问此文件", "code": 403})

        factory = RequestFactory()
        request = factory.get("/")
        request.auth = _FakeUser()

        result = get_parse_status(request, str(uuid.uuid4()))

        self.assertEqual(result["code"], 403)
        mock_check.assert_called_once()

    @patch("apps.services.docparse.api.ParsedDocument")
    @patch("apps.services.docparse.api._check_file_ownership")
    def test_status_passes_when_authorized(self, mock_check, mock_pd):
        file_record = _make_file_record()
        mock_check.return_value = (file_record, None)
        mock_pd.objects.filter.return_value.first.return_value = None

        factory = RequestFactory()
        request = factory.get("/")
        request.auth = _FakeUser()

        result = get_parse_status(request, str(uuid.uuid4()))
        self.assertEqual(result["status"], "not_found")


class TriggerParseEndpointOwnershipTests(SimpleTestCase):
    """DP-001: trigger_parse 在校验不通过时返回错误。"""

    @patch("apps.services.docparse.api._check_file_ownership")
    def test_parse_returns_error_when_unauthorized(self, mock_check):
        mock_check.return_value = (None, {"status": "error", "message": "无权访问此文件", "code": 403})

        factory = RequestFactory()
        request = factory.post("/")
        request.auth = _FakeUser()

        result = trigger_parse(request, str(uuid.uuid4()))

        self.assertEqual(result["code"], 403)

    @patch("apps.services.docparse.api.DocParseService")
    @patch("apps.services.docparse.api._check_file_ownership")
    def test_parse_passes_when_authorized(self, mock_check, mock_svc):
        file_record = _make_file_record()
        mock_check.return_value = (file_record, None)
        mock_svc.parse_async.return_value = "task-123"

        factory = RequestFactory()
        request = factory.post("/")
        request.auth = _FakeUser()

        result = trigger_parse(request, str(uuid.uuid4()))
        self.assertEqual(result["status"], "queued")
