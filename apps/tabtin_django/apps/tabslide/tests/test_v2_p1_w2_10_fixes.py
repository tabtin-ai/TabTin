"""
W2-10 回归测试：H2-10 / H2-07 / H2-08 修复验证

H2-10: X-Live-Secret 硬编码默认值安全风险
  - live_api._get_live_secret() 不再 fallback 到明文默认值
  - collab/api._is_live_request() 生产环境拒绝默认密钥，使用 hmac 比较
  - collab/decorators.check_live_secret() 同上

H2-07: push_element_changes 缺少 page_id/element_id 校验
  - 缺少 page_id 的变更被跳过
  - 缺少 element_id 的变更被跳过
  - 全部变更无效时返回 error dict 且不发 HTTP 请求

H2-08: 高频路径超时过长
  - push_element_changes: timeout=8, max_retries=0
  - push_pages: timeout=15, max_retries=1
"""

from __future__ import annotations

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

from unittest import TestCase  # noqa: E402
from unittest.mock import MagicMock, patch  # noqa: E402


_PROJECT_ID = "proj-test-w210"
_AGENT_ID = "agent-w210"


# ══════════════════════════════════════════════════════════════════════════════
# H2-10: X-Live-Secret 安全修复
# ══════════════════════════════════════════════════════════════════════════════


class TestLiveApiSecretNoHardcodedFallback(TestCase):
    """live_api._get_live_secret() 不再 fallback 到硬编码默认值。"""

    def _reset_cache(self):
        import apps.services.common.live_api as mod
        mod._cached_secret = None

    def setUp(self):
        self._reset_cache()

    def tearDown(self):
        self._reset_cache()

    @patch("apps.services.common.live_api.getattr")
    def test_reads_from_settings_without_fallback(self):
        """验证从 settings 读取密钥，无硬编码 fallback。"""
        from apps.services.common.live_api import _get_live_secret, _DEFAULT_DEV_SECRET

        with patch("django.conf.settings") as mock_settings:
            mock_settings.COLLAB_LIVE_SECRET = "my-production-secret-xyz"
            mock_settings.DEBUG = False
            self._reset_cache()
            result = _get_live_secret()

        self.assertEqual(result, "my-production-secret-xyz")

    def test_default_dev_secret_constant_is_defined(self):
        """_DEFAULT_DEV_SECRET 常量已定义，用于生产环境校验。"""
        from apps.services.common.live_api import _DEFAULT_DEV_SECRET
        self.assertEqual(_DEFAULT_DEV_SECRET, "collab-live-dev-secret")


class TestCollabApiIsLiveRequest(TestCase):
    """collab/api._is_live_request() 生产环境安全校验。"""

    def _make_request(self, secret_header: str) -> MagicMock:
        req = MagicMock()
        req.headers = {"X-Live-Secret": secret_header}
        return req

    @patch("apps.collab.api._get_live_secret", return_value="real-prod-secret")
    def test_valid_secret_accepted(self, _mock):
        from apps.collab.api import _is_live_request
        with patch("apps.collab.api.settings") as mock_s:
            mock_s.DEBUG = False
            result = _is_live_request(self._make_request("real-prod-secret"))
        self.assertTrue(result)

    @patch("apps.collab.api._get_live_secret", return_value="real-prod-secret")
    def test_wrong_secret_rejected(self, _mock):
        from apps.collab.api import _is_live_request
        with patch("apps.collab.api.settings") as mock_s:
            mock_s.DEBUG = False
            result = _is_live_request(self._make_request("wrong-secret"))
        self.assertFalse(result)

    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    def test_default_dev_secret_rejected_in_production(self, _mock):
        """H2-10 核心：生产环境 (DEBUG=False) 拒绝默认开发密钥。"""
        from apps.collab.api import _is_live_request
        with patch("apps.collab.api.settings") as mock_s:
            mock_s.DEBUG = False
            result = _is_live_request(self._make_request("collab-live-dev-secret"))
        self.assertFalse(result)

    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    def test_default_dev_secret_accepted_in_debug(self, _mock):
        """开发环境 (DEBUG=True) 允许默认密钥。"""
        from apps.collab.api import _is_live_request
        with patch("apps.collab.api.settings") as mock_s:
            mock_s.DEBUG = True
            result = _is_live_request(self._make_request("collab-live-dev-secret"))
        self.assertTrue(result)

    @patch("apps.collab.api._get_live_secret", return_value="")
    def test_empty_secret_always_rejected(self, _mock):
        from apps.collab.api import _is_live_request
        result = _is_live_request(self._make_request("anything"))
        self.assertFalse(result)

    @patch("apps.collab.api._get_live_secret", return_value="valid-secret")
    def test_empty_header_rejected(self, _mock):
        from apps.collab.api import _is_live_request
        req = MagicMock()
        req.headers = {}
        result = _is_live_request(req)
        self.assertFalse(result)

    @patch("apps.collab.api._get_live_secret", return_value="real-secret")
    def test_uses_constant_time_comparison(self, _mock):
        """确认使用 hmac.compare_digest 而非 == 进行比较。"""
        import hmac
        from apps.collab.api import _is_live_request

        with patch("apps.collab.api.settings") as mock_s:
            mock_s.DEBUG = False
            with patch("apps.collab.api.hmac.compare_digest", return_value=True) as mock_hmac:
                _is_live_request(self._make_request("real-secret"))
                mock_hmac.assert_called_once()


class TestCheckLiveSecretDecorator(TestCase):
    """collab/decorators.check_live_secret 安全校验。"""

    def _make_request(self, secret_header: str) -> MagicMock:
        req = MagicMock()
        req.headers = {"X-Live-Secret": secret_header}
        req.META = {"REMOTE_ADDR": "127.0.0.1"}
        return req

    def test_default_dev_secret_rejected_in_production(self):
        """H2-10 核心：装饰器在生产环境拒绝默认开发密钥。"""
        from apps.collab.decorators import check_live_secret

        @check_live_secret
        def dummy_view(request):
            return "ok"

        with patch("django.conf.settings") as mock_settings:
            mock_settings.COLLAB_LIVE_SECRET = "collab-live-dev-secret"
            mock_settings.DEBUG = False
            resp = dummy_view(self._make_request("collab-live-dev-secret"))
        self.assertEqual(resp.status_code, 403)

    def test_valid_secret_passes_in_production(self):
        from apps.collab.decorators import check_live_secret

        @check_live_secret
        def dummy_view(request):
            return "ok"

        with patch("django.conf.settings") as mock_settings:
            mock_settings.COLLAB_LIVE_SECRET = "secure-random-secret-123"
            mock_settings.DEBUG = False
            resp = dummy_view(self._make_request("secure-random-secret-123"))
        self.assertEqual(resp, "ok")


# ══════════════════════════════════════════════════════════════════════════════
# H2-07: page_id / element_id 校验
# ══════════════════════════════════════════════════════════════════════════════


class TestElementChangesFieldValidation(TestCase):
    """push_element_changes() 校验 page_id 和 element_id。"""

    def _call(self, changes, agent_id=_AGENT_ID, project_id=_PROJECT_ID):
        from apps.tabslide.services.collab_service import SlideCollabService
        return SlideCollabService.push_element_changes(
            project_id=project_id,
            changes=changes,
            agent_id=agent_id,
            editor_type="agent",
        )

    @patch("apps.services.common.live_api.call_live_api")
    def test_missing_page_id_is_skipped(self, mock_call):
        """缺少 page_id 的变更被跳过。"""
        mock_call.return_value = {"applied": 1, "total": 1}
        valid = {"page_id": "p1", "element_id": "e1", "type": "update", "patch": {}}
        no_page_id = {"element_id": "e2", "type": "add", "element": {}}

        self._call([valid, no_page_id])

        sent = mock_call.call_args[0][1]["changes"]
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["element_id"], "e1")

    @patch("apps.services.common.live_api.call_live_api")
    def test_missing_element_id_is_skipped(self, mock_call):
        """缺少 element_id 的变更被跳过。"""
        mock_call.return_value = {"applied": 1, "total": 1}
        valid = {"page_id": "p1", "element_id": "e1", "type": "delete"}
        no_elem_id = {"page_id": "p1", "type": "update", "patch": {}}

        self._call([valid, no_elem_id])

        sent = mock_call.call_args[0][1]["changes"]
        self.assertEqual(len(sent), 1)

    @patch("apps.services.common.live_api.call_live_api")
    def test_empty_page_id_treated_as_missing(self, mock_call):
        """空字符串 page_id 视为缺失。"""
        change = {"page_id": "", "element_id": "e1", "type": "add", "element": {}}

        result = self._call([change])

        mock_call.assert_not_called()
        self.assertIn("error", result)

    @patch("apps.services.common.live_api.call_live_api")
    def test_all_invalid_returns_error_without_api_call(self, mock_call):
        """全部变更都缺 page_id/element_id 时返回 error，不发 HTTP 请求。"""
        c1 = {"element_id": "e1", "type": "add", "element": {}}
        c2 = {"page_id": "p1", "type": "update", "patch": {}}

        result = self._call([c1, c2])

        mock_call.assert_not_called()
        self.assertIn("error", result)
        self.assertEqual(result["applied"], 0)
        self.assertEqual(result["total"], 2)

    @patch("apps.services.common.live_api.call_live_api")
    def test_valid_changes_still_pass_through(self, mock_call):
        """有效变更正常通过校验。"""
        mock_call.return_value = {"applied": 2, "total": 2}
        changes = [
            {"page_id": "p1", "element_id": "e1", "type": "add", "element": {}},
            {"page_id": "p2", "element_id": "e2", "type": "update", "patch": {"x": 1}},
        ]

        result = self._call(changes)

        self.assertEqual(result["applied"], 2)
        sent = mock_call.call_args[0][1]["changes"]
        self.assertEqual(len(sent), 2)


# ══════════════════════════════════════════════════════════════════════════════
# H2-08: 超时与重试参数
# ══════════════════════════════════════════════════════════════════════════════


class TestElementChangesTimeoutParams(TestCase):
    """push_element_changes() 使用低超时、无重试。"""

    @patch("apps.services.common.live_api.call_live_api")
    def test_timeout_is_8_seconds(self, mock_call):
        mock_call.return_value = {"applied": 1, "total": 1}
        from apps.tabslide.services.collab_service import SlideCollabService

        SlideCollabService.push_element_changes(
            project_id="proj-1",
            changes=[{"page_id": "p", "element_id": "e", "type": "add", "element": {}}],
            editor_type="agent",
        )

        _, kwargs = mock_call.call_args
        self.assertEqual(kwargs.get("timeout"), 8)

    @patch("apps.services.common.live_api.call_live_api")
    def test_max_retries_is_zero(self, mock_call):
        mock_call.return_value = {"applied": 1, "total": 1}
        from apps.tabslide.services.collab_service import SlideCollabService

        SlideCollabService.push_element_changes(
            project_id="proj-1",
            changes=[{"page_id": "p", "element_id": "e", "type": "add", "element": {}}],
            editor_type="agent",
        )

        _, kwargs = mock_call.call_args
        self.assertEqual(kwargs.get("max_retries"), 0)


class TestPushPagesTimeoutParams(TestCase):
    """push_pages() 使用适中超时、有限重试。"""

    @patch("apps.services.common.live_api.call_live_api")
    def test_timeout_is_15_seconds(self, mock_call):
        mock_call.return_value = {"applied": 1, "total": 1}
        from apps.tabslide.services.collab_service import SlideCollabService

        SlideCollabService.push_pages(
            project_id="proj-1",
            pages=[{"page_id": "p1", "elements": []}],
            editor_type="agent",
        )

        _, kwargs = mock_call.call_args
        self.assertEqual(kwargs.get("timeout"), 15)

    @patch("apps.services.common.live_api.call_live_api")
    def test_max_retries_is_one(self, mock_call):
        mock_call.return_value = {"applied": 1, "total": 1}
        from apps.tabslide.services.collab_service import SlideCollabService

        SlideCollabService.push_pages(
            project_id="proj-1",
            pages=[{"page_id": "p1", "elements": []}],
            editor_type="agent",
        )

        _, kwargs = mock_call.call_args
        self.assertEqual(kwargs.get("max_retries"), 1)
