"""integrations_github HTTP API 测试（共用 NinjaAPI，避免 Router 重复挂载）。"""

from __future__ import annotations

import uuid
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from django.urls import path
from ninja import NinjaAPI

from apps.integrations_github.api import router as github_router
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.auth.permissions import JWTAuth

User = get_user_model()

_test_api = NinjaAPI(
    title="GitHubIntegrationsTestAPI",
    urls_namespace="github_integrations_test",
    auth=JWTAuth(),
)
_test_api.add_router("/integrations/github", github_router)
urlpatterns = [path("api/", _test_api.urls)]

_URL_CONF = "apps.integrations_github.tests.test_api"
_BASE = "/api/integrations/github"
_AUTH = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"}


@override_settings(
    ROOT_URLCONF=_URL_CONF,
    GITHUB_OAUTH_CLIENT_ID="test_client_id",
    GITHUB_OAUTH_CLIENT_SECRET="test_client_secret",
    GITHUB_OAUTH_REDIRECT_URI="http://localhost:6060/api/integrations/github/oauth/callback",
    GITHUB_OAUTH_SUCCESS_REDIRECT="http://localhost:6060/api/integrations/github/oauth/done",
)
class GitHubOAuthApiTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.user = User.objects.create_user(
            email=f"github_{uuid.uuid4().hex[:8]}@example.com",
            password="pass12345",
        )
        self.org = Organization.objects.create(name="GitHub Org", owner=self.user)
        OrganizationMember.objects.create(
            organization=self.org,
            user=self.user,
            role="owner",
        )
        self.invite_gate_patcher = patch(
            "apps.users.auth.invite_gate_middleware.is_invite_gate_enabled",
            return_value=False,
        )
        self.invite_gate_patcher.start()
        self.addCleanup(self.invite_gate_patcher.stop)
        cache.clear()

    def _auth(self):
        return patch.object(JWTAuth, "authenticate", return_value=self.user)

    def test_status_configured(self):
        with self._auth():
            resp = self.client.get(f"{_BASE}/oauth/status", **_AUTH)
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertTrue(body["data"]["configured"])

    def test_start_returns_authorize_url(self):
        state = "a" * 32
        challenge = "b" * 43
        verifier = "c" * 43
        with self._auth():
            resp = self.client.post(
                f"{_BASE}/oauth/start",
                data={
                    "organization_id": str(self.org.id),
                    "state": state,
                    "code_challenge": challenge,
                    "code_verifier": verifier,
                    "code_challenge_method": "S256",
                },
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()["data"]
        self.assertIn("github.com/login/oauth/authorize", data["authorize_url"])
        self.assertIn("code_challenge=", data["authorize_url"])
        self.assertIn(state, data["authorize_url"])

    @patch("apps.integrations_github.api.GitHubOAuthClient.exchange_code")
    @patch("apps.integrations_github.api.GitHubOAuthClient.get_user")
    def test_callback_and_claim(self, mock_user, mock_exchange):
        state = "d" * 32
        verifier = "e" * 43
        challenge = "f" * 43
        with self._auth():
            start = self.client.post(
                f"{_BASE}/oauth/start",
                data={
                    "organization_id": str(self.org.id),
                    "state": state,
                    "code_challenge": challenge,
                    "code_verifier": verifier,
                },
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(start.status_code, 200)

        mock_exchange.return_value = {
            "access_token": "gho_test_token_value",
            "token_type": "bearer",
            "scope": "repo,read:user",
        }
        mock_user.return_value = {"login": "octocat"}

        callback = self.client.get(
            f"{_BASE}/oauth/callback",
            {"code": "abc123", "state": state},
        )
        self.assertEqual(callback.status_code, 302)
        location = callback["Location"]
        self.assertIn("/oauth/done", location)
        self.assertIn("ticket=", location)

        ticket = parse_qs(urlparse(location).query)["ticket"][0]

        with self._auth():
            claim = self.client.post(
                f"{_BASE}/oauth/claim",
                data={"ticket": ticket},
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(claim.status_code, 200, claim.content)
        claim_data = claim.json()["data"]
        self.assertEqual(claim_data["access_token"], "gho_test_token_value")
        self.assertEqual(claim_data["login"], "octocat")

        with self._auth():
            claim2 = self.client.post(
                f"{_BASE}/oauth/claim",
                data={"ticket": ticket},
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(claim2.status_code, 410)

    @override_settings(GITHUB_OAUTH_CLIENT_ID="", GITHUB_OAUTH_CLIENT_SECRET="")
    def test_start_requires_config(self):
        with self._auth():
            resp = self.client.post(
                f"{_BASE}/oauth/start",
                data={
                    "organization_id": str(self.org.id),
                    "state": "a" * 32,
                    "code_challenge": "b" * 43,
                    "code_verifier": "c" * 43,
                },
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 503)
