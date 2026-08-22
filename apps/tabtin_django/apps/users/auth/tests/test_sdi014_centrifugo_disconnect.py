"""SDI-014 回归测试: 禁用账号时主动断开 Centrifugo 连接"""

from unittest.mock import patch

from django.test import TestCase, RequestFactory

from apps.users.auth.models import User
from apps.users.auth.admin_api import update_user_status
from apps.users.auth.admin_schemas import AdminUserStatusUpdateSchema


class TestSDI014CentrifugoDisconnectOnDisable(TestCase):
    """禁用账号时必须调用 disconnect_centrifugo_user"""

    databases = {"default"}

    def setUp(self):
        self.factory = RequestFactory()
        self.admin = User.objects.create_user(
            email="admin_sdi014@test.com",
            password="Test1234!",
            is_staff=True,
            is_superuser=True,
        )
        self.target = User.objects.create_user(
            email="target_sdi014@test.com",
            password="Test1234!",
        )

    def _make_request(self):
        request = self.factory.put("/admin/users/{}/status".format(self.target.id))
        request.auth = self.admin
        return request

    @patch("apps.tabchat.centrifugo_proxy.disconnect_centrifugo_user")
    @patch("apps.users.auth.admin_api._cancel_active_agent_runs")
    @patch("apps.users.auth.admin_api.SessionManager")
    @patch("apps.users.auth.admin_api._schedule_account_collab_revoke")
    def test_single_user_disable_triggers_centrifugo_disconnect(
        self, mock_collab, mock_session_mgr, mock_cancel, mock_disconnect
    ):
        request = self._make_request()
        payload = AdminUserStatusUpdateSchema(status="inactive")

        with patch("apps.services.tools.invalidate_user_cache"):
            with patch(
                "apps.users.auth.admin_api._build_related_maps",
                return_value=({}, {}, {}),
            ):
                with patch(
                    "apps.users.auth.admin_api._serialize_user",
                    return_value={},
                ):
                    update_user_status(request, str(self.target.id), payload)

        mock_disconnect.assert_called_once_with(str(self.target.id))
