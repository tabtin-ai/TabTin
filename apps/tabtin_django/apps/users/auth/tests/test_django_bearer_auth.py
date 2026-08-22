from types import SimpleNamespace
from unittest.mock import patch

from django.test import RequestFactory, SimpleTestCase
from ninja.errors import HttpError


class DjangoBearerAuthTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    @patch("apps.users.auth.permissions.JWTAuth.authenticate")
    def test_plain_django_views_reuse_jwt_auth_semantics(self, mock_authenticate):
        from apps.users.auth.permissions import authenticate_django_bearer_request

        request = self.factory.get(
            "/api/tabmail/accounts",
            HTTP_AUTHORIZATION="Bearer session-bound-token",
        )
        user = SimpleNamespace(id="user-1")
        mock_authenticate.return_value = user

        self.assertIs(authenticate_django_bearer_request(request), user)
        mock_authenticate.assert_called_once_with(request, "session-bound-token")

    @patch("apps.users.auth.permissions.JWTAuth.authenticate")
    def test_plain_django_views_reject_missing_or_invalid_bearer(self, mock_authenticate):
        from apps.users.auth.permissions import authenticate_django_bearer_request

        request = self.factory.get("/api/tabmail/accounts")

        self.assertIsNone(authenticate_django_bearer_request(request))
        mock_authenticate.assert_not_called()

    @patch("apps.users.auth.permissions.JWTAuth.authenticate")
    def test_plain_django_views_do_not_raise_ninja_http_error(self, mock_authenticate):
        from apps.users.auth.permissions import authenticate_django_bearer_request

        request = self.factory.get(
            "/api/extensions",
            HTTP_AUTHORIZATION="Bearer api-key-with-bad-scope",
        )
        mock_authenticate.side_effect = HttpError(403, "insufficient scope")

        self.assertIsNone(authenticate_django_bearer_request(request))
        self.assertEqual(request.django_bearer_auth_error.status_code, 403)

