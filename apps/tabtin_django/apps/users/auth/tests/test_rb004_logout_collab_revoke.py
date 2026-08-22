"""RB-004 回归测试: logout/change_password 必须通知 collab-live 断连"""

from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase, RequestFactory

from apps.users.auth.api import logout_user, change_password
from apps.users.auth.schemas import PasswordChangeSchema


class TestRB004LogoutCollabRevocation(SimpleTestCase):
    """logout 和 change_password 路径必须通知 collab-live"""

    @patch("apps.users.auth.api._notify_logout_revocations")
    @patch("apps.users.auth.api.SessionManager")
    @patch("apps.users.auth.api.verify_jwt_token")
    @patch("apps.users.auth.api.log_user_action")
    def test_logout_triggers_collab_revocation(
        self, mock_log, mock_verify, mock_session_mgr, mock_revoke
    ):
        mock_verify.return_value = {"sid": "test-session-key"}
        mock_session_mgr.invalidate_session.return_value = True

        mock_user = MagicMock()
        mock_user.id = "test-user-id"

        factory = RequestFactory()
        request = factory.post("/api/auth/logout")
        request.auth = mock_user
        request.META["HTTP_AUTHORIZATION"] = "Bearer fake-access-token"

        logout_user(request)

        mock_revoke.assert_called_once_with(str(mock_user.id))

    @patch("apps.users.auth.api._notify_logout_revocations")
    @patch("apps.users.auth.api.log_user_action")
    def test_change_password_triggers_collab_revocation(
        self, mock_log, mock_revoke
    ):
        mock_user = MagicMock()
        mock_user.id = "test-user-id"
        mock_user.check_password.side_effect = lambda password: password == "OldPass1!"

        factory = RequestFactory()
        request = factory.post("/api/auth/change-password")
        request.auth = mock_user

        with patch("apps.users.auth.api.validate_user_password"):
            with patch("apps.users.auth.api.UserSession") as MockSession:
                MockSession.objects.filter.return_value.update.return_value = 3
                data = PasswordChangeSchema(
                    old_password="OldPass1!", new_password="NewPass1!!"
                )
                change_password(request, data)

        mock_revoke.assert_called_once_with(str(mock_user.id))
