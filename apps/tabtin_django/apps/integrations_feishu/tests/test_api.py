"""integrations_feishu HTTP API 测试（共用一个 NinjaAPI，避免 Router 重复挂载）。"""

from __future__ import annotations

import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlparse

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import close_old_connections
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.urls import path
from django.utils import timezone
from ninja import NinjaAPI

from apps.integrations_feishu.api import (
    _get_cached_untitled_resources,
    router as feishu_router,
)
from apps.integrations_feishu.client import FeishuAPIError, UntitledResourceCatalog
from apps.integrations_feishu.constants import OAUTH_STATE_CACHE_PREFIX, OAUTH_SCOPES
from apps.integrations_feishu.models import (
    FeishuImportJob,
    FeishuOAuthConnection,
    FeishuOAuthProvider,
)
from apps.tabtinspace.models import (
    Collection,
    Device,
    Organization,
    OrganizationMember,
    Workspace,
)
from apps.users.auth.permissions import JWTAuth

User = get_user_model()

_test_api = NinjaAPI(
    title="FeishuIntegrationsTestAPI",
    urls_namespace="feishu_integrations_test",
    auth=JWTAuth(),
)
_test_api.add_router("/integrations/feishu", feishu_router)
urlpatterns = [path("api/", _test_api.urls)]

_URL_CONF = "apps.integrations_feishu.tests.test_api"
_BASE = "/api/integrations/feishu"
_AUTH = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"}


def _unwrap(resp) -> dict:
    body = resp.json()
    if isinstance(body, dict) and "data" in body and body.get("success") is True:
        return body["data"]
    return body


@override_settings(
    ROOT_URLCONF=_URL_CONF,
    FEISHU_OAUTH_APP_ID="",
    FEISHU_OAUTH_APP_SECRET="",
    FEISHU_OAUTH_REDIRECT_URI="http://localhost:6060/api/integrations/feishu/oauth/callback",
    FEISHU_OAUTH_SUCCESS_REDIRECT="http://localhost:6060/api/integrations/feishu/oauth/done",
)
class FeishuAPITests(TestCase):
    def setUp(self):
        self.feature_gate_patcher = patch(
            "apps.integrations_feishu.api.feishu_import_enabled_for_organization",
            return_value=True,
        )
        self.feature_gate = self.feature_gate_patcher.start()
        self.addCleanup(self.feature_gate_patcher.stop)
        self.client = Client()
        self.user = User.objects.create_user(
            email=f"feishu_{uuid.uuid4().hex[:8]}@example.com",
            password="pass12345",
        )
        self.org = Organization.objects.create(name="Feishu Org", owner=self.user)
        OrganizationMember.objects.create(
            organization=self.org, user=self.user, role="owner",
        )
        device = Device.objects.create(
            organization=self.org,
            user=self.user,
            name="Feishu Test Device",
            device_type="electron",
            fingerprint=f"feishu-test-{uuid.uuid4().hex[:12]}",
        )
        self.workspace = Workspace.objects.create(
            organization=self.org,
            device=device,
            created_by=self.user,
            name="Feishu WS",
            working_dir=f"/tmp/feishu-test/{self.org.id}",
            normalized_working_dir=f"/tmp/feishu-test/{self.org.id}",
            kind=Workspace.Kind.STANDARD,
        )
        self.space_id = self.workspace.id
        self.collection = Collection.objects.create(
            organization=self.org,
            name="Feishu Folder",
            created_by=self.user,
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

    def _auth_as(self, user):
        return patch.object(JWTAuth, "authenticate", return_value=user)

    def _create_provider(self, app_id: str = "cli_customer_app") -> FeishuOAuthProvider:
        return FeishuOAuthProvider.objects.create(
            organization=self.org,
            app_id=app_id,
            credentials={"app_secret": "customer-secret"},
            status=FeishuOAuthProvider.Status.ACTIVE,
            verified_at=timezone.now(),
            created_by=self.user,
            updated_by=self.user,
        )

    def _create_connection(self, **overrides) -> FeishuOAuthConnection:
        provider = overrides.pop("provider", None) or self._create_provider()
        values = {
            "user": self.user,
            "organization_id": self.org.id,
            "provider": provider,
            "credential_version": provider.credential_version,
            "tokens": {"access_token": "t", "refresh_token": "r"},
            "status": FeishuOAuthConnection.Status.CONNECTED,
        }
        values.update(overrides)
        return FeishuOAuthConnection.objects.create(**values)

    # ── connection ─────────────────────────────────────────

    def test_connection_requires_auth(self):
        resp = self.client.get(
            f"{_BASE}/connection",
            {"organization_id": str(self.org.id)},
        )
        self.assertIn(resp.status_code, (401, 403))

    @patch("apps.integrations_feishu.api.run_feishu_import_task.delay")
    def test_feature_gate_blocks_entry_and_import_but_keeps_existing_task_access(
        self,
        mock_delay,
    ):
        self.feature_gate.return_value = False
        job = FeishuImportJob.objects.create(
            user=self.user,
            organization_id=self.org.id,
            space_id=self.space_id,
            tables=[{"app_token": "app1", "table_id": "tbl1"}],
            status=FeishuImportJob.Status.PENDING,
        )

        with self._auth():
            connection_resp = self.client.get(
                f"{_BASE}/connection",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )
            import_resp = self.client.post(
                f"{_BASE}/import",
                data=json.dumps({
                    "organization_id": str(self.org.id),
                    "space_id": str(self.space_id),
                    "tables": [{"app_token": "app1", "table_id": "tbl1"}],
                }),
                content_type="application/json",
                **_AUTH,
            )
            status_resp = self.client.get(f"{_BASE}/import/{job.id}", **_AUTH)

        self.assertEqual(connection_resp.status_code, 403)
        self.assertEqual(import_resp.status_code, 403)
        self.assertEqual(status_resp.status_code, 200)
        self.assertEqual(FeishuImportJob.objects.count(), 1)
        mock_delay.assert_not_called()

    def test_connection_not_connected(self):
        with self._auth():
            resp = self.client.get(
                f"{_BASE}/connection",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(_unwrap(resp)["connected"])

    def test_connection_connected_without_tokens(self):
        self._create_connection(
            tokens={"access_token": "secret", "refresh_token": "r"},
            open_id="ou_1",
            display_name="Alice",
        )
        with self._auth():
            resp = self.client.get(
                f"{_BASE}/connection",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 200)
        body = _unwrap(resp)
        self.assertTrue(body["connected"])
        self.assertEqual(body["display_name"], "Alice")
        raw = resp.content.decode()
        self.assertNotIn("secret", raw)
        self.assertNotIn("access_token", raw)

    @override_settings(
        FEISHU_OAUTH_APP_ID="legacy-app",
        FEISHU_OAUTH_APP_SECRET="legacy-secret",
    )
    def test_connection_keeps_legacy_providerless_connection_during_rollout(self):
        FeishuOAuthConnection.objects.create(
            user=self.user,
            organization_id=self.org.id,
            provider=None,
            credential_version=None,
            tokens={"access_token": "legacy-token"},
            status=FeishuOAuthConnection.Status.CONNECTED,
        )

        with self._auth():
            resp = self.client.get(
                f"{_BASE}/connection",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )

        state = _unwrap(resp)
        self.assertTrue(state["connected"])
        self.assertFalse(state["provider_configured"])

    # ── organization OAuth provider ─────────────────────────

    @patch("apps.integrations_feishu.api.FeishuClient.validate_tenant_credentials")
    def test_owner_can_configure_and_read_sanitized_provider(self, mock_validate):
        mock_validate.return_value = {"tenant_access_token": "tenant-secret"}

        with self._auth(), patch(
            "apps.users.auth.invite_gate_middleware.is_invite_gate_enabled",
            return_value=False,
        ):
            saved = self.client.put(
                f"{_BASE}/oauth/provider",
                data=json.dumps(
                    {
                        "organization_id": str(self.org.id),
                        "app_id": "cli_customer_app",
                        "app_secret": "customer-secret",
                    }
                ),
                content_type="application/json",
                **_AUTH,
            )

        self.assertEqual(saved.status_code, 200)
        body = _unwrap(saved)
        self.assertTrue(body["configured"])
        self.assertTrue(body["can_manage"])
        self.assertEqual(body["app_id"], "cli_customer_app")
        self.assertNotIn("customer-secret", saved.content.decode())
        self.assertNotIn("tenant-secret", saved.content.decode())

        with self._auth(), patch(
            "apps.users.auth.invite_gate_middleware.is_invite_gate_enabled",
            return_value=False,
        ):
            fetched = self.client.get(
                f"{_BASE}/oauth/provider",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )

        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(_unwrap(fetched)["app_id"], "cli_customer_app")
        self.assertNotIn("customer-secret", fetched.content.decode())

    def test_regular_member_can_read_provider_state_but_cannot_manage_it(self):
        self._create_provider()
        member = User.objects.create_user(
            email=f"member_{uuid.uuid4().hex[:8]}@example.com",
            password="pass12345",
        )
        OrganizationMember.objects.create(
            organization=self.org,
            user=member,
            role="editor",
        )

        with self._auth_as(member):
            fetched = self.client.get(
                f"{_BASE}/oauth/provider",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )
            saved = self.client.put(
                f"{_BASE}/oauth/provider",
                data=json.dumps(
                    {
                        "organization_id": str(self.org.id),
                        "app_id": "forbidden-app",
                        "app_secret": "forbidden-secret",
                    }
                ),
                content_type="application/json",
                **_AUTH,
            )

        state = _unwrap(fetched)
        self.assertTrue(state["configured"])
        self.assertFalse(state["can_manage"])
        self.assertIsNone(state["app_id"])
        self.assertEqual(saved.status_code, 403)
        self.assertEqual(saved.json()["code"], "forbidden")

    @patch(
        "apps.integrations_feishu.api.FeishuClient.validate_tenant_credentials",
        side_effect=FeishuAPIError("invalid"),
    )
    def test_invalid_credentials_do_not_overwrite_provider(self, _mock_validate):
        self._create_provider(app_id="existing-app")

        with self._auth():
            saved = self.client.put(
                f"{_BASE}/oauth/provider",
                data=json.dumps(
                    {
                        "organization_id": str(self.org.id),
                        "app_id": "bad-app",
                        "app_secret": "bad-secret",
                    }
                ),
                content_type="application/json",
                **_AUTH,
            )

        self.assertEqual(saved.status_code, 400)
        self.assertEqual(saved.json()["code"], "provider_invalid")
        self.assertEqual(
            FeishuOAuthProvider.objects.get(organization=self.org).app_id,
            "existing-app",
        )

    @patch("apps.integrations_feishu.api.FeishuClient.validate_tenant_credentials")
    def test_resubmitting_same_credentials_keeps_version_and_connection(self, mock_validate):
        mock_validate.return_value = {"tenant_access_token": "tenant-secret"}
        provider = self._create_provider(app_id="same-app")
        connection = FeishuOAuthConnection.objects.create(
            user=self.user,
            organization_id=self.org.id,
            provider=provider,
            credential_version=provider.credential_version,
            tokens={"access_token": "user-secret"},
            status=FeishuOAuthConnection.Status.CONNECTED,
        )

        with self._auth():
            saved = self.client.put(
                f"{_BASE}/oauth/provider",
                data=json.dumps(
                    {
                        "organization_id": str(self.org.id),
                        "app_id": "same-app",
                        "app_secret": "customer-secret",
                    },
                ),
                content_type="application/json",
                **_AUTH,
            )

        self.assertEqual(saved.status_code, 200)
        provider.refresh_from_db()
        connection.refresh_from_db()
        self.assertEqual(provider.credential_version, 1)
        self.assertEqual(connection.status, FeishuOAuthConnection.Status.CONNECTED)

    @patch("apps.integrations_feishu.api.FeishuClient.validate_tenant_credentials")
    def test_secret_rotation_requires_reauthorization_and_app_change_removes_connections(
        self,
        mock_validate,
    ):
        mock_validate.return_value = {"tenant_access_token": "tenant-secret"}
        provider = self._create_provider(app_id="same-app")
        connection = FeishuOAuthConnection.objects.create(
            user=self.user,
            organization_id=self.org.id,
            provider=provider,
            credential_version=provider.credential_version,
            tokens={"access_token": "user-secret"},
            status=FeishuOAuthConnection.Status.CONNECTED,
        )

        with self._auth():
            rotated = self.client.put(
                f"{_BASE}/oauth/provider",
                data=json.dumps(
                    {
                        "organization_id": str(self.org.id),
                        "app_id": "same-app",
                        "app_secret": "rotated-secret",
                    }
                ),
                content_type="application/json",
                **_AUTH,
            )

        self.assertEqual(rotated.status_code, 200)
        provider.refresh_from_db()
        connection.refresh_from_db()
        self.assertEqual(provider.credential_version, 2)
        self.assertEqual(connection.status, "reauthorization_required")
        self.assertEqual(connection.tokens, {})

        with self._auth():
            connection_state = self.client.get(
                f"{_BASE}/connection",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )
        self.assertFalse(_unwrap(connection_state)["connected"])

        with self._auth():
            changed = self.client.put(
                f"{_BASE}/oauth/provider",
                data=json.dumps(
                    {
                        "organization_id": str(self.org.id),
                        "app_id": "new-app",
                        "app_secret": "new-secret",
                    }
                ),
                content_type="application/json",
                **_AUTH,
            )

        self.assertEqual(changed.status_code, 200)
        self.assertFalse(FeishuOAuthConnection.objects.filter(id=connection.id).exists())

    @patch("apps.integrations_feishu.api.FeishuClient.validate_tenant_credentials")
    def test_provider_reauthentication_interrupts_active_imports(self, mock_validate):
        mock_validate.return_value = {"tenant_access_token": "tenant-secret"}
        provider = self._create_provider(app_id="busy-app")
        running = FeishuImportJob.objects.create(
            user=self.user,
            organization_id=self.org.id,
            space_id=self.space_id,
            tables=[],
            documents=[],
            status=FeishuImportJob.Status.RUNNING,
            celery_task_id="running-task",
        )
        pending = FeishuImportJob.objects.create(
            user=self.user,
            organization_id=self.org.id,
            space_id=self.space_id,
            tables=[],
            documents=[],
            status=FeishuImportJob.Status.PENDING,
        )
        other_org = Organization.objects.create(name="Other Feishu Org", owner=self.user)
        other_org_job = FeishuImportJob.objects.create(
            user=self.user,
            organization_id=other_org.id,
            space_id=self.space_id,
            tables=[],
            documents=[],
            status=FeishuImportJob.Status.RUNNING,
        )

        with (
            patch("celery.current_app") as celery_app,
            self.captureOnCommitCallbacks(execute=True),
            self._auth(),
        ):
            response = self.client.put(
                f"{_BASE}/oauth/provider",
                data=json.dumps(
                    {
                        "organization_id": str(self.org.id),
                        "app_id": "busy-app",
                        "app_secret": "customer-secret",
                    },
                ),
                content_type="application/json",
                **_AUTH,
            )

        self.assertEqual(response.status_code, 200)
        running.refresh_from_db()
        pending.refresh_from_db()
        other_org_job.refresh_from_db()
        for job in (running, pending):
            self.assertEqual(job.status, FeishuImportJob.Status.FAILED)
            self.assertEqual(job.result["phase"], "interrupted")
            self.assertEqual(job.result["interrupted_reason"], "provider_reauthenticated")
            self.assertIn("企业应用已重新认证", job.error)
        celery_app.control.revoke.assert_called_once_with("running-task", terminate=True)
        self.assertEqual(other_org_job.status, FeishuImportJob.Status.RUNNING)
        provider.refresh_from_db()
        self.assertEqual(provider.app_id, "busy-app")

    def test_active_import_still_blocks_provider_delete(self):
        provider = self._create_provider(app_id="busy-app")
        FeishuImportJob.objects.create(
            user=self.user,
            organization_id=self.org.id,
            space_id=self.space_id,
            tables=[],
            documents=[],
            status=FeishuImportJob.Status.RUNNING,
        )

        with self._auth():
            deleted = self.client.delete(
                f"{_BASE}/oauth/provider?organization_id={self.org.id}",
                **_AUTH,
            )

        self.assertEqual(deleted.status_code, 409)
        self.assertEqual(deleted.json()["code"], "provider_busy")
        provider.refresh_from_db()
        self.assertEqual(provider.app_id, "busy-app")

    # ── oauth ──────────────────────────────────────────────

    def test_oauth_start_stores_state_and_returns_authorize_url(self):
        provider = self._create_provider()
        with self._auth():
            resp = self.client.get(
                f"{_BASE}/oauth/start",
                {
                    "organization_id": str(self.org.id),
                    "return_deep_link": "tabtin://feishu",
                },
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 200)
        body = _unwrap(resp)
        self.assertIn("authorize_url", body)
        self.assertIn("client_id=cli_customer_app", body["authorize_url"])
        # scope 需含云文档只读，否则搜索多维表会 99991679
        self.assertIn("drive%3Adrive%3Areadonly", body["authorize_url"])
        state = parse_qs(urlparse(body["authorize_url"]).query)["state"][0]
        cached = cache.get(f"{OAUTH_STATE_CACHE_PREFIX}{state}")
        self.assertIsNotNone(cached)
        self.assertEqual(cached["user_id"], str(self.user.id))
        self.assertEqual(cached["provider_id"], str(provider.id))
        self.assertEqual(cached["provider_app_id"], "cli_customer_app")
        self.assertEqual(cached["provider_credential_version"], provider.credential_version)
        self.assertEqual(cached["return_deep_link"], "tabtin://feishu")

    @patch("apps.integrations_feishu.api.FeishuClient.exchange_code")
    def test_oauth_callback_rechecks_feature_gate_before_exchanging_code(
        self,
        mock_exchange,
    ):
        provider = self._create_provider()
        with self._auth():
            start_resp = self.client.get(
                f"{_BASE}/oauth/start",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )
        authorize_url = _unwrap(start_resp)["authorize_url"]
        state = parse_qs(urlparse(authorize_url).query)["state"][0]
        self.feature_gate.return_value = False

        callback_resp = self.client.get(
            f"{_BASE}/oauth/callback",
            {"code": "code-after-rollout-closed", "state": state},
        )

        self.assertEqual(callback_resp.status_code, 403)
        self.assertEqual(callback_resp.json()["code"], "feature_not_available")
        mock_exchange.assert_not_called()
        self.assertFalse(
            FeishuOAuthConnection.objects.filter(
                user=self.user,
                organization_id=self.org.id,
                provider=provider,
            ).exists()
        )

    def test_oauth_start_requires_organization_provider(self):
        with self._auth():
            resp = self.client.get(
                f"{_BASE}/oauth/start",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )

        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()["code"], "provider_not_configured")

    @override_settings(
        FEISHU_OAUTH_APP_ID="legacy-app",
        FEISHU_OAUTH_APP_SECRET="legacy-secret",
    )
    def test_legacy_client_can_start_oauth_before_provider_is_configured(self):
        with self._auth():
            resp = self.client.get(
                f"{_BASE}/oauth/start",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )

        self.assertEqual(resp.status_code, 200)
        authorize_url = _unwrap(resp)["authorize_url"]
        self.assertIn("client_id=legacy-app", authorize_url)
        state = parse_qs(urlparse(authorize_url).query)["state"][0]
        cached = cache.get(f"{OAUTH_STATE_CACHE_PREFIX}{state}")
        self.assertNotIn("provider_id", cached)

    @override_settings(
        FEISHU_OAUTH_APP_ID="legacy-app",
        FEISHU_OAUTH_APP_SECRET="legacy-secret",
    )
    @patch("apps.integrations_feishu.api.FeishuClient.exchange_code")
    @patch("apps.integrations_feishu.api.FeishuClient.get_user_info")
    def test_legacy_oauth_state_can_finish_after_backend_upgrade(
        self,
        mock_info,
        mock_exchange,
    ):
        state = "legacy-state-token"
        cache.set(
            f"{OAUTH_STATE_CACHE_PREFIX}{state}",
            {
                "user_id": str(self.user.id),
                "organization_id": str(self.org.id),
                "return_deep_link": "tabtin://done",
            },
            timeout=600,
        )
        mock_exchange.return_value = {
            "access_token": "legacy-access",
            "refresh_token": "legacy-refresh",
            "expires_in": 7200,
        }
        mock_info.return_value = {"open_id": "ou_legacy", "name": "旧客户端用户"}

        resp = self.client.get(
            f"{_BASE}/oauth/callback",
            {"code": "legacy-code", "state": state},
        )

        self.assertEqual(resp.status_code, 302)
        connection = FeishuOAuthConnection.objects.get(user=self.user)
        self.assertIsNone(connection.provider_id)
        self.assertIsNone(connection.credential_version)
        self.assertEqual(connection.tokens["access_token"], "legacy-access")

    @override_settings(
        FEISHU_OAUTH_APP_ID="legacy-app",
        FEISHU_OAUTH_APP_SECRET="legacy-secret",
    )
    @patch("apps.integrations_feishu.api.FeishuClient.exchange_code")
    def test_providerless_callback_rejects_explicit_incomplete_scopes(
        self,
        mock_exchange,
    ):
        state = "legacy-incomplete-scope-state"
        cache.set(
            f"{OAUTH_STATE_CACHE_PREFIX}{state}",
            {
                "user_id": str(self.user.id),
                "organization_id": str(self.org.id),
            },
            timeout=600,
        )
        mock_exchange.return_value = {
            "access_token": "legacy-access",
            "refresh_token": "legacy-refresh",
            "expires_in": 7200,
            "scope": OAUTH_SCOPES.replace("search:docs:read ", ""),
        }

        resp = self.client.get(
            f"{_BASE}/oauth/callback",
            {"code": "legacy-code", "state": state},
        )

        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["code"], "provider_permission_incomplete")
        self.assertFalse(
            FeishuOAuthConnection.objects.filter(
                user=self.user,
                organization_id=self.org.id,
            ).exists()
        )

    def test_oauth_done_rejects_script_injection_in_deep_link(self):
        """deep_link 不得把 </script> 反射进 HTML script 上下文。"""
        evil = "tabtin://x</script><script>alert(1)</script>"
        resp = self.client.get(
            f"{_BASE}/oauth/done",
            {"deep_link": evil, "connected": "1"},
        )
        self.assertEqual(resp.status_code, 200)
        body = resp.content.decode()
        self.assertNotIn("</script><script>", body)
        self.assertNotIn("alert(1)", body)
        # 非法 deep_link 回退默认协议
        self.assertIn("tabtin://integrations/feishu/connected", body)
        self.assertIn('data-href=', body)

    def test_oauth_done_allows_safe_deep_link(self):
        resp = self.client.get(
            f"{_BASE}/oauth/done",
            {"deep_link": "tabtin://integrations/feishu/connected?org=1", "connected": "1"},
        )
        self.assertEqual(resp.status_code, 200)
        body = resp.content.decode()
        self.assertIn("tabtin://integrations/feishu/connected?org=1", body)
        self.assertIn("getAttribute('data-href')", body)
        # 不得再把 deep_link 以 JSON 字面量内联进 script
        self.assertNotIn('var href = "tabtin://', body)

    def test_callback_bad_state(self):
        resp = self.client.get(
            f"{_BASE}/oauth/callback",
            {"code": "abc", "state": "not-a-real-state"},
        )
        self.assertEqual(resp.status_code, 400)

    def test_callback_missing_params(self):
        resp = self.client.get(f"{_BASE}/oauth/callback")
        self.assertEqual(resp.status_code, 400)

    @patch("apps.integrations_feishu.api.FeishuClient.exchange_code")
    @patch("apps.integrations_feishu.api.FeishuClient.get_user_info")
    def test_callback_success_redirect(self, mock_info, mock_exchange):
        state = "good-state-token"
        provider = self._create_provider()
        cache.set(
            f"{OAUTH_STATE_CACHE_PREFIX}{state}",
            {
                "user_id": str(self.user.id),
                "organization_id": str(self.org.id),
                "provider_id": str(provider.id),
                "provider_app_id": provider.app_id,
                "provider_credential_version": provider.credential_version,
                "return_deep_link": "tabtin://done",
            },
            timeout=600,
        )
        mock_exchange.return_value = {
            "code": 0,
            "access_token": "u-access",
            "refresh_token": "u-refresh",
            "expires_in": 7200,
            "refresh_token_expires_in": 604800,
            "scope": OAUTH_SCOPES,
        }
        mock_info.return_value = {
            "open_id": "ou_test",
            "name": "测试用户",
            "tenant_key": "tenant_test",
        }

        resp = self.client.get(
            f"{_BASE}/oauth/callback",
            {"code": "auth-code", "state": state},
        )
        self.assertEqual(resp.status_code, 302)
        self.assertIn("/integrations/feishu/oauth/done", resp["Location"])
        self.assertIn("deep_link=", resp["Location"])
        self.assertNotIn("u-access", resp["Location"])

        conn = FeishuOAuthConnection.objects.get(
            user=self.user, organization_id=self.org.id,
        )
        self.assertEqual(conn.open_id, "ou_test")
        self.assertEqual(conn.tokens.get("access_token"), "u-access")
        self.assertEqual(conn.provider_id, provider.id)
        self.assertEqual(conn.credential_version, provider.credential_version)
        self.assertIsNotNone(conn.refresh_token_expires_at)
        provider.refresh_from_db()
        self.assertEqual(provider.tenant_key, "tenant_test")

    @patch("apps.integrations_feishu.api.FeishuClient.exchange_code")
    def test_callback_rejects_missing_required_scopes(self, mock_exchange):
        state = "missing-scope-state"
        provider = self._create_provider()
        cache.set(
            f"{OAUTH_STATE_CACHE_PREFIX}{state}",
            {
                "user_id": str(self.user.id),
                "organization_id": str(self.org.id),
                "provider_id": str(provider.id),
                "provider_app_id": provider.app_id,
                "provider_credential_version": provider.credential_version,
            },
            timeout=600,
        )
        mock_exchange.return_value = {
            "access_token": "u-access",
            "refresh_token": "u-refresh",
            "expires_in": 7200,
            "scope": "offline_access",
        }

        resp = self.client.get(
            f"{_BASE}/oauth/callback",
            {"code": "auth-code", "state": state},
        )

        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["code"], "provider_permission_incomplete")
        self.assertFalse(
            FeishuOAuthConnection.objects.filter(
                user=self.user,
                organization_id=self.org.id,
            ).exists()
        )

    def test_callback_rejects_provider_changed_after_oauth_start(self):
        state = "stale-provider-state"
        provider = self._create_provider(app_id="original-app")
        cache.set(
            f"{OAUTH_STATE_CACHE_PREFIX}{state}",
            {
                "user_id": str(self.user.id),
                "organization_id": str(self.org.id),
                "provider_id": str(provider.id),
                "provider_app_id": "original-app",
                "provider_credential_version": provider.credential_version,
            },
            timeout=600,
        )
        provider.app_id = "replacement-app"
        provider.save(update_fields=["app_id", "updated_at"])

        resp = self.client.get(
            f"{_BASE}/oauth/callback",
            {"code": "auth-code", "state": state},
        )

        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()["code"], "provider_invalid")

    @patch("apps.integrations_feishu.api.FeishuClient.exchange_code")
    @patch("apps.integrations_feishu.api.FeishuClient.get_user_info")
    def test_callback_rejects_secret_rotated_during_token_exchange(
        self,
        mock_info,
        mock_exchange,
    ):
        state = "provider-rotation-race-state"
        provider = self._create_provider(app_id="same-app")
        cache.set(
            f"{OAUTH_STATE_CACHE_PREFIX}{state}",
            {
                "user_id": str(self.user.id),
                "organization_id": str(self.org.id),
                "provider_id": str(provider.id),
                "provider_app_id": provider.app_id,
                "provider_credential_version": provider.credential_version,
            },
            timeout=600,
        )

        def rotate_secret_during_exchange(*_args, **_kwargs):
            provider.credentials = {"app_secret": "rotated-secret"}
            provider.secret_fingerprint = "rotated-fingerprint"
            provider.credential_version += 1
            provider.save(
                update_fields=[
                    "credentials",
                    "secret_fingerprint",
                    "credential_version",
                    "updated_at",
                ],
            )
            return {
                "access_token": "u-access",
                "refresh_token": "u-refresh",
                "expires_in": 7200,
                "scope": OAUTH_SCOPES,
            }

        mock_exchange.side_effect = rotate_secret_during_exchange
        mock_info.return_value = {
            "open_id": "ou_race",
            "name": "竞态用户",
            "tenant_key": "tenant_race",
        }

        resp = self.client.get(
            f"{_BASE}/oauth/callback",
            {"code": "auth-code", "state": state},
        )

        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()["code"], "provider_invalid")
        self.assertFalse(
            FeishuOAuthConnection.objects.filter(
                user=self.user,
                organization_id=self.org.id,
            ).exists(),
        )

    @patch("apps.integrations_feishu.api.FeishuClient.exchange_code")
    def test_callback_cannot_use_provider_from_another_organization(self, mock_exchange):
        other_org = Organization.objects.create(name="Other Provider Org", owner=self.user)
        other_provider = FeishuOAuthProvider.objects.create(
            organization=other_org,
            app_id="other-app",
            credentials={"app_secret": "other-secret"},
            secret_fingerprint="other-fingerprint",
            status=FeishuOAuthProvider.Status.ACTIVE,
        )
        state = "cross-organization-provider-state"
        cache.set(
            f"{OAUTH_STATE_CACHE_PREFIX}{state}",
            {
                "user_id": str(self.user.id),
                "organization_id": str(self.org.id),
                "provider_id": str(other_provider.id),
                "provider_app_id": other_provider.app_id,
                "provider_credential_version": other_provider.credential_version,
            },
            timeout=600,
        )

        resp = self.client.get(
            f"{_BASE}/oauth/callback",
            {"code": "auth-code", "state": state},
        )

        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()["code"], "provider_invalid")
        mock_exchange.assert_not_called()

    @patch("apps.integrations_feishu.api.FeishuClient.exchange_code")
    @patch("apps.integrations_feishu.api.FeishuClient.get_user_info")
    def test_callback_rejects_mismatched_feishu_tenant(self, mock_info, mock_exchange):
        state = "tenant-mismatch-state"
        provider = self._create_provider()
        provider.tenant_key = "tenant_expected"
        provider.save(update_fields=["tenant_key", "updated_at"])
        cache.set(
            f"{OAUTH_STATE_CACHE_PREFIX}{state}",
            {
                "user_id": str(self.user.id),
                "organization_id": str(self.org.id),
                "provider_id": str(provider.id),
                "provider_app_id": provider.app_id,
                "provider_credential_version": provider.credential_version,
            },
            timeout=600,
        )
        mock_exchange.return_value = {
            "access_token": "u-access",
            "refresh_token": "u-refresh",
            "expires_in": 7200,
            "scope": OAUTH_SCOPES,
        }
        mock_info.return_value = {
            "open_id": "ou_other",
            "name": "其他企业用户",
            "tenant_key": "tenant_other",
        }

        resp = self.client.get(
            f"{_BASE}/oauth/callback",
            {"code": "auth-code", "state": state},
        )

        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()["code"], "provider_invalid")

    # ── bitable / import 未连接 ────────────────────────────

    def test_list_apps_requires_connection(self):
        with self._auth():
            resp = self.client.get(
                f"{_BASE}/bitable/apps",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 403)

    def test_list_tables_requires_connection(self):
        with self._auth():
            resp = self.client.get(
                f"{_BASE}/bitable/apps/appXXX/tables",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 403)

    def test_untitled_resource_catalog_is_cached_per_connection(self):
        self._connect()
        catalog_calls = []
        catalog_owner_calls = []
        owner_calls = []

        class FakeClient:
            def get_valid_access_token(self, connection):
                return "token"

            def _untitled_kinds_matching(self, search_key, kinds):
                return list(kinds)

            def list_untitled_resource_catalog(
                self,
                access_token,
                *,
                kinds,
                owner_ids=None,
            ):
                catalog_calls.append(list(kinds))
                catalog_owner_calls.append(list(owner_ids or []))
                return UntitledResourceCatalog(
                    resources=[
                        {"token": "docxBlank", "name": "未命名文档", "kind": "docx"},
                    ],
                    complete=True,
                )

            def list_importable_resources(
                self,
                access_token,
                *,
                search_key,
                kinds,
                untitled_candidates=None,
                owner_ids=None,
                defer_wiki_resolution=False,
                max_search_pages=1,
                tenant_host_resolver=None,
            ):
                owner_calls.append(list(owner_ids or []))
                return list(untitled_candidates or [])

        with self._auth(), patch(
            "apps.integrations_feishu.api.FeishuClient",
            FakeClient,
        ):
            first = self.client.get(
                f"{_BASE}/resources",
                {
                    "organization_id": str(self.org.id),
                    "q": "未命名",
                    "kinds": "all",
                },
                **_AUTH,
            )
            second = self.client.get(
                f"{_BASE}/resources",
                {
                    "organization_id": str(self.org.id),
                    "q": "未命名文档",
                    "kinds": "docx",
                },
                **_AUTH,
            )

        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(second.status_code, 200, second.content)
        self.assertEqual(catalog_calls, [["bitable", "docx"]])
        self.assertEqual(catalog_owner_calls, [[]])
        self.assertEqual(owner_calls, [[], []])
        self.assertEqual(_unwrap(second), [
            {"token": "docxBlank", "name": "未命名文档", "kind": "docx"},
        ])

    def test_interactive_search_defers_wiki_resolution(self):
        self._connect()
        calls = []

        class FakeClient:
            def get_valid_access_token(self, connection):
                return "token"

            def _untitled_kinds_matching(self, search_key, kinds):
                return []

            def list_importable_resources(self, access_token, **kwargs):
                calls.append(kwargs)
                return [{
                    "token": "wikiNode",
                    "name": "Wiki document",
                    "kind": "docx",
                    "wiki_node_token": "wikiNode",
                }]

        with self._auth(), patch(
            "apps.integrations_feishu.api.FeishuClient",
            FakeClient,
        ):
            response = self.client.get(
                f"{_BASE}/resources",
                {
                    "organization_id": str(self.org.id),
                    "q": "Wiki",
                    "defer_wiki_resolution": "true",
                },
                **_AUTH,
            )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(calls[0]["defer_wiki_resolution"])
        self.assertEqual(calls[0]["max_search_pages"], 3)
        self.assertEqual(_unwrap(response)[0]["wiki_node_token"], "wikiNode")

    def test_wiki_only_search_reports_missing_domain_field_permission(self):
        self._connect()

        class FakeClient:
            def get_valid_access_token(self, connection):
                return "token"

            def _untitled_kinds_matching(self, search_key, kinds):
                return []

            def get_tenant_domain(self, app_id, app_secret):
                return {"tenant_key": "", "domain": ""}

            def list_importable_resources(self, access_token, **kwargs):
                kwargs["tenant_host_resolver"]()
                return []

        with self._auth(), patch(
            "apps.integrations_feishu.api.FeishuClient",
            FakeClient,
        ):
            response = self.client.get(
                f"{_BASE}/resources",
                {
                    "organization_id": str(self.org.id),
                    "q": "Wiki",
                    "defer_wiki_resolution": "true",
                },
                **_AUTH,
            )

        self.assertEqual(response.status_code, 403, response.content)
        self.assertIn("tenant:tenant.domain:read", response.content.decode())

    def test_wiki_only_search_maps_tenant_api_permission_error_to_403(self):
        self._connect()

        class FakeClient:
            def get_valid_access_token(self, connection):
                return "token"

            def _untitled_kinds_matching(self, search_key, kinds):
                return []

            def get_tenant_domain(self, app_id, app_secret):
                raise FeishuAPIError(
                    "无权限获取企业信息",
                    code=1184001,
                    status_code=403,
                )

            def list_importable_resources(self, access_token, **kwargs):
                kwargs["tenant_host_resolver"]()
                return []

        with self._auth(), patch(
            "apps.integrations_feishu.api.FeishuClient",
            FakeClient,
        ):
            response = self.client.get(
                f"{_BASE}/resources",
                {
                    "organization_id": str(self.org.id),
                    "q": "Wiki",
                    "defer_wiki_resolution": "true",
                },
                **_AUTH,
            )

        self.assertEqual(response.status_code, 403, response.content)
        body = response.content.decode()
        self.assertIn("tenant:tenant:readonly", body)
        self.assertIn("tenant:tenant.domain:read", body)

    def test_resolve_selected_wiki_resource(self):
        self._connect()

        class FakeClient:
            def get_valid_access_token(self, connection):
                return "token"

            def get_wiki_node(self, access_token, node_token, *, raise_on_error=False):
                return {
                    "token": "docxReal",
                    "name": "Wiki document",
                    "import_kind": "docx",
                }

        with self._auth(), patch(
            "apps.integrations_feishu.api.FeishuClient",
            FakeClient,
        ):
            response = self.client.get(
                f"{_BASE}/resources/wiki/resolve",
                {
                    "organization_id": str(self.org.id),
                    "node_token": "wikiNode",
                },
                **_AUTH,
            )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(_unwrap(response), {
            "token": "docxReal",
            "name": "Wiki document",
            "kind": "docx",
        })

    def test_resolve_wiki_resource_refreshes_expired_access_token_once(self):
        self._connect()
        token_calls = []

        class FakeClient:
            def get_valid_access_token(self, connection, *, force_refresh=False):
                token_calls.append(force_refresh)
                return "fresh" if force_refresh else "expired"

            def get_wiki_node(self, access_token, node_token, *, raise_on_error=False):
                if access_token == "expired":
                    raise FeishuAPIError("expired", code=99991677, status_code=401)
                return {
                    "token": "docxReal",
                    "name": "Wiki document",
                    "import_kind": "docx",
                }

        with self._auth(), patch(
            "apps.integrations_feishu.api.FeishuClient",
            FakeClient,
        ):
            response = self.client.get(
                f"{_BASE}/resources/wiki/resolve",
                {
                    "organization_id": str(self.org.id),
                    "node_token": "wikiNode",
                    "expected_kind": "docx",
                },
                **_AUTH,
            )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(token_calls, [False, True])

    def test_resolve_wiki_resource_rejects_changed_resource_kind(self):
        self._connect()

        class FakeClient:
            def get_valid_access_token(self, connection, *, force_refresh=False):
                return "token"

            def get_wiki_node(self, access_token, node_token, *, raise_on_error=False):
                return {
                    "token": "baseReal",
                    "name": "Changed resource",
                    "import_kind": "bitable",
                }

        with self._auth(), patch(
            "apps.integrations_feishu.api.FeishuClient",
            FakeClient,
        ):
            response = self.client.get(
                f"{_BASE}/resources/wiki/resolve",
                {
                    "organization_id": str(self.org.id),
                    "node_token": "wikiNode",
                    "expected_kind": "docx",
                },
                **_AUTH,
            )

        self.assertEqual(response.status_code, 409, response.content)
        self.assertIn("重新搜索", str(response.json()))

    def test_resolve_wiki_resource_returns_chinese_unavailable_error(self):
        self._connect()

        class FakeClient:
            def get_valid_access_token(self, connection, *, force_refresh=False):
                return "token"

            def get_wiki_node(self, access_token, node_token, *, raise_on_error=False):
                raise FeishuAPIError("forbidden code=99991679", code=99991679, status_code=403)

        with self._auth(), patch(
            "apps.integrations_feishu.api.FeishuClient",
            FakeClient,
        ):
            response = self.client.get(
                f"{_BASE}/resources/wiki/resolve",
                {
                    "organization_id": str(self.org.id),
                    "node_token": "wikiNode",
                },
                **_AUTH,
            )

        self.assertEqual(response.status_code, 404, response.content)
        body = response.json()
        self.assertNotIn("99991679", str(body))
        self.assertNotIn("forbidden", str(body).lower())

    def test_resolve_wiki_resource_returns_chinese_retry_error_for_upstream_failure(self):
        self._connect()

        class FakeClient:
            def get_valid_access_token(self, connection, *, force_refresh=False):
                return "token"

            def get_wiki_node(self, access_token, node_token, *, raise_on_error=False):
                raise FeishuAPIError("upstream exploded code=500", code=500, status_code=500)

        with self._auth(), patch(
            "apps.integrations_feishu.api.FeishuClient",
            FakeClient,
        ):
            response = self.client.get(
                f"{_BASE}/resources/wiki/resolve",
                {
                    "organization_id": str(self.org.id),
                    "node_token": "wikiNode",
                },
                **_AUTH,
            )

        self.assertEqual(response.status_code, 502, response.content)
        body = response.json()
        self.assertNotIn("code=500", str(body))
        self.assertNotIn("exploded", str(body).lower())

    def test_untitled_resource_catalog_merges_concurrent_cache_misses(self):
        self._connect()
        connection = FeishuOAuthConnection.objects.get(user=self.user)
        started = Event()
        release = Event()
        calls_lock = Lock()
        catalog_calls = 0

        class FakeClient:
            def list_untitled_resource_catalog(
                self,
                access_token,
                *,
                kinds,
                owner_ids=None,
            ):
                nonlocal catalog_calls
                with calls_lock:
                    catalog_calls += 1
                started.set()
                release.wait(timeout=2)
                return UntitledResourceCatalog(
                    resources=[
                        {"token": "docxBlank", "name": "未命名文档", "kind": "docx"},
                    ],
                    complete=True,
                )

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(
                _get_cached_untitled_resources,
                FakeClient(),
                "token",
                connection,
            )
            self.assertTrue(started.wait(timeout=1))
            second = pool.submit(
                _get_cached_untitled_resources,
                FakeClient(),
                "token",
                connection,
            )
            time.sleep(0.1)
            release.set()
            self.assertEqual(first.result(timeout=2), second.result(timeout=2))

        self.assertEqual(catalog_calls, 1)

    def test_partial_untitled_catalog_uses_short_cache_ttl(self):
        self._connect()
        connection = FeishuOAuthConnection.objects.get(user=self.user)

        class FakeClient:
            def list_untitled_resource_catalog(
                self,
                access_token,
                *,
                kinds,
                owner_ids=None,
            ):
                return UntitledResourceCatalog(
                    resources=[
                        {"token": "docxBlank", "name": "未命名文档", "kind": "docx"},
                    ],
                    complete=False,
                    failed_sources=("wiki",),
                )

        with patch.object(cache, "set", wraps=cache.set) as cache_set:
            resources = _get_cached_untitled_resources(
                FakeClient(),
                "token",
                connection,
            )

        self.assertEqual([row["token"] for row in resources], ["docxBlank"])
        self.assertEqual(cache_set.call_args.kwargs["timeout"], 60)

    def test_import_requires_connection(self):
        payload = {
            "organization_id": str(self.org.id),
            "space_id": str(self.space_id),
            "tables": [{"app_token": "app1", "table_id": "tbl1"}],
        }
        with self._auth():
            resp = self.client.post(
                f"{_BASE}/import",
                data=json.dumps(payload),
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 403)

    def test_import_empty_tables_bad_request(self):
        self._create_connection()
        payload = {
            "organization_id": str(self.org.id),
            "space_id": str(self.space_id),
            "tables": [],
        }
        with self._auth():
            resp = self.client.post(
                f"{_BASE}/import",
                data=json.dumps(payload),
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 400)

    @patch("apps.integrations_feishu.api.run_feishu_import_task.delay")
    def test_import_documents_only_creates_job(self, mock_delay):
        mock_delay.return_value = MagicMock(id="celery-doc-1")
        self._create_connection()
        payload = {
            "organization_id": str(self.org.id),
            "space_id": str(self.space_id),
            "tables": [],
            "documents": [{"doc_token": "docxTOKEN", "name": "说明文档", "doc_type": "docx"}],
        }
        with self._auth():
            resp = self.client.post(
                f"{_BASE}/import",
                data=json.dumps(payload),
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 200)
        job = FeishuImportJob.objects.get()
        self.assertEqual(job.tables, [])
        self.assertEqual(len(job.documents), 1)
        self.assertEqual(job.documents[0]["doc_token"], "docxTOKEN")
        mock_delay.assert_called_once_with(str(job.id))

    @patch("apps.integrations_feishu.api.run_feishu_import_task.delay")
    def test_import_accepts_more_than_legacy_resource_limits(self, mock_delay):
        mock_delay.return_value = MagicMock(id="celery-unlimited")
        self._create_connection()
        payload = {
            "organization_id": str(self.org.id),
            "space_id": str(self.space_id),
            "tables": [
                {"app_token": "app", "table_id": f"tbl{i}"} for i in range(16)
            ],
            "documents": [
                {"doc_token": f"docx{i}", "name": f"文档 {i}", "doc_type": "docx"}
                for i in range(21)
            ],
        }
        with self._auth():
            resp = self.client.post(
                f"{_BASE}/import",
                data=json.dumps(payload),
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        job = FeishuImportJob.objects.get()
        self.assertEqual(len(job.tables), 16)
        self.assertEqual(len(job.documents), 21)
        mock_delay.assert_called_once_with(str(job.id))

    def test_preview_accepts_more_than_legacy_table_limit(self):
        self._create_connection()
        tables = [
            {"app_token": "app1", "table_id": f"tbl{i}", "name": f"表 {i}"}
            for i in range(16)
        ]

        class FakeClient:
            def get_valid_access_token(self, connection):
                return "token"

            def list_tables(self, access_token, app_token):
                return [
                    {"table_id": row["table_id"], "name": row["name"]}
                    for row in tables
                ]

            def list_fields(self, access_token, app_token, table_id):
                return [{"field_name": "标题", "type": 1}]

        with self._auth(), patch(
            "apps.integrations_feishu.api.FeishuClient",
            FakeClient,
        ):
            resp = self.client.post(
                f"{_BASE}/import/preview",
                data=json.dumps({
                    "organization_id": str(self.org.id),
                    "tables": tables,
                }),
                content_type="application/json",
                **_AUTH,
            )

        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(len(_unwrap(resp)["tables"]), 16)

    def test_preview_import_closure(self):
        self._create_connection()
        payload = {
            "organization_id": str(self.org.id),
            "tables": [{"app_token": "app1", "table_id": "tblA", "name": "订单"}],
        }

        class FakeClient:
            def get_valid_access_token(self, connection):
                return "token"

            def list_tables(self, access_token, app_token):
                return [
                    {"table_id": "tblA", "name": "订单"},
                    {"table_id": "tblB", "name": "客户"},
                ]

            def list_fields(self, access_token, app_token, table_id):
                if table_id == "tblA":
                    return [
                        {"field_name": "标题", "type": 1},
                        {
                            "field_name": "客户",
                            "type": 18,
                            "property": {"table_id": "tblB"},
                        },
                    ]
                return [{"field_name": "名称", "type": 1}]

        with self._auth(), patch(
            "apps.integrations_feishu.api.FeishuClient",
            FakeClient,
        ):
            resp = self.client.post(
                f"{_BASE}/import/preview",
                data=json.dumps(payload),
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        data = _unwrap(resp)
        ids = {t["table_id"] for t in data["tables"]}
        self.assertEqual(ids, {"tblA", "tblB"})
        self.assertEqual(len(data["edges"]), 1)

    def test_cancel_and_skip_table_endpoints(self):
        job = FeishuImportJob.objects.create(
            user=self.user,
            organization_id=self.org.id,
            space_id=self.space_id,
            tables=[
                {"app_token": "app1", "table_id": "tbl1"},
                {"app_token": "app1", "table_id": "tbl2"},
            ],
            status=FeishuImportJob.Status.RUNNING,
            result={"created_tables": [], "progress": {"done": 0, "total": 2}},
        )
        with self._auth():
            skip_resp = self.client.post(
                f"{_BASE}/import/{job.id}/skip-table",
                data=json.dumps({"app_token": "app1", "table_id": "tbl1"}),
                content_type="application/json",
                **_AUTH,
            )
            cancel_resp = self.client.post(
                f"{_BASE}/import/{job.id}/cancel-table",
                data=json.dumps({"app_token": "app1", "table_id": "tbl2"}),
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(skip_resp.status_code, 200, skip_resp.content)
        self.assertEqual(cancel_resp.status_code, 200, cancel_resp.content)
        job.refresh_from_db()
        self.assertIn("app1:tbl1", job.result.get("skipped_keys") or [])
        self.assertIn("app1:tbl2", job.result.get("cancelled_keys") or [])

    def _connect(self):
        self._create_connection(
            tokens={"access_token": "at", "refresh_token": "rt"},
            open_id="ou_1",
            display_name="Alice",
        )

    def test_resolve_urls_bitable_and_docx(self):
        self._connect()

        class FakeClient:
            def get_valid_access_token(self, connection):
                return "token"

            def get_bitable_app_name(self, access_token, app_token):
                return "销售库"

            def list_tables(self, access_token, app_token):
                return [{"table_id": "tbl1", "name": "线索"}]

            def get_drive_file_name(self, access_token, file_token, *, doc_type="docx"):
                return "周报"

            def get_docx_markdown(self, access_token, doc_token):
                return "# hi"

            def get_wiki_node(self, access_token, node_token):
                # 不可导入的纯容器节点 → wiki_node（无子节点可展开）
                return {
                    "selectable": False,
                    "name": "知识库目录",
                    "node_token": node_token,
                    "has_child": False,
                    "expandable": False,
                }

        payload = {
            "organization_id": str(self.org.id),
            "urls": [
                "https://x.feishu.cn/base/BaseSales?table=tbl1",
                "https://x.feishu.cn/docx/DocWeekly",
                "https://x.feishu.cn/wiki/WikiNode",
            ],
        }
        with self._auth(), patch(
            "apps.integrations_feishu.api.FeishuClient",
            FakeClient,
        ):
            resp = self.client.post(
                f"{_BASE}/resolve",
                data=json.dumps(payload),
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        items = _unwrap(resp)["items"]
        self.assertEqual(len(items), 3)
        self.assertEqual(items[0]["kind"], "bitable")
        self.assertEqual(items[0]["token"], "BaseSales")
        self.assertTrue(items[0]["accessible"])
        self.assertEqual(items[0]["name"], "销售库")
        self.assertEqual(items[1]["kind"], "docx")
        self.assertTrue(items[1]["accessible"])
        self.assertEqual(items[2]["kind"], "wiki_node")
        self.assertFalse(items[2]["accessible"])

    def test_resolve_requires_connection(self):
        with self._auth():
            resp = self.client.post(
                f"{_BASE}/resolve",
                data=json.dumps({
                    "organization_id": str(self.org.id),
                    "urls": ["https://x.feishu.cn/docx/Doc1"],
                }),
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 403)

    def test_parse_flow_returns_tabdoc_compatible_hierarchy(self):
        self._connect()

        class FakeClient:
            def get_valid_access_token(self, connection):
                return "token"

            def get_wiki_node(self, access_token, node_token):
                return {
                    "selectable": True,
                    "import_kind": "docx",
                    "token": "DocFlow",
                    "name": "审批流程",
                }

            def list_docx_blocks(self, access_token, doc_token):
                return [{"block_type": 43, "board": {"token": "BoardFlow"}}]

            def list_whiteboard_nodes(self, access_token, whiteboard_id):
                return [
                    {
                        "id": "root",
                        "type": "composite_shape",
                        "x": 0,
                        "y": 0,
                        "text": {"text": "发起审批"},
                    },
                    {
                        "id": "done",
                        "type": "composite_shape",
                        "x": 0,
                        "y": 100,
                        "text": {"text": "审批完成"},
                    },
                    {
                        "id": "edge",
                        "type": "connector",
                        "connector": {
                            "start": {"attached_object": {"id": "root"}},
                            "end": {
                                "arrow_style": "line_arrow",
                                "attached_object": {"id": "done"},
                            },
                        },
                    },
                ]

        with self._auth(), patch("apps.integrations_feishu.api.FeishuClient", FakeClient):
            resp = self.client.post(
                f"{_BASE}/flow/parse",
                data=json.dumps(
                    {
                        "organization_id": str(self.org.id),
                        "url": "https://x.feishu.cn/wiki/WikiFlow",
                    }
                ),
                content_type="application/json",
                **_AUTH,
            )

        self.assertEqual(resp.status_code, 200, resp.content)
        payload = _unwrap(resp)
        self.assertEqual(payload["title"], "发起审批")
        self.assertEqual(payload["nodes"][1]["parent_id"], "root")
        self.assertEqual(payload["source"]["whiteboard_tokens"], ["BoardFlow"])

    def test_oauth_scopes_include_docx_content_read(self):
        self.assertIn("docs:document.content:read", OAUTH_SCOPES)

    def test_oauth_scopes_include_document_search(self):
        self.assertIn("search:docs:read", OAUTH_SCOPES)

    def test_oauth_start_rejects_non_member(self):
        outsider = User.objects.create_user(
            email=f"outsider_{uuid.uuid4().hex[:8]}@example.com",
            password="pass12345",
        )
        with self._auth_as(outsider):
            resp = self.client.get(
                f"{_BASE}/oauth/start",
                {"organization_id": str(self.org.id)},
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 403)

    def test_import_status_rejects_other_user(self):
        job = FeishuImportJob.objects.create(
            user=self.user,
            organization_id=self.org.id,
            space_id=self.space_id,
            tables=[{"app_token": "app1", "table_id": "tbl1"}],
            status=FeishuImportJob.Status.PENDING,
        )
        other = User.objects.create_user(
            email=f"other_{uuid.uuid4().hex[:8]}@example.com",
            password="pass12345",
        )
        OrganizationMember.objects.create(
            organization=self.org, user=other, role="editor",
        )
        with self._auth_as(other):
            resp = self.client.get(f"{_BASE}/import/{job.id}", **_AUTH)
        self.assertEqual(resp.status_code, 404)

    @patch("apps.integrations_feishu.api.run_feishu_import_task.delay")
    def test_import_rejects_foreign_space(self, mock_delay):
        self._connect()
        payload = {
            "organization_id": str(self.org.id),
            "space_id": str(uuid.uuid4()),
            "tables": [{"app_token": "app1", "table_id": "tbl1"}],
        }
        with self._auth():
            resp = self.client.post(
                f"{_BASE}/import",
                data=json.dumps(payload),
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 404)
        mock_delay.assert_not_called()
    @patch("apps.integrations_feishu.api.run_feishu_import_task.delay")
    def test_import_rejects_foreign_collection(self, mock_delay):
        self._connect()
        other_user = User.objects.create_user(
            email=f"org2_{uuid.uuid4().hex[:8]}@example.com",
            password="pass12345",
        )
        other_org = Organization.objects.create(name="Other Org", owner=other_user)
        foreign_collection = Collection.objects.create(
            organization=other_org,
            name="Foreign",
            created_by=other_user,
        )
        payload = {
            "organization_id": str(self.org.id),
            "space_id": str(self.space_id),
            "collection_id": str(foreign_collection.id),
            "documents": [{"doc_token": "docxX", "name": "doc"}],
        }
        with self._auth():
            resp = self.client.post(
                f"{_BASE}/import",
                data=json.dumps(payload),
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 404)
        mock_delay.assert_not_called()

    @patch("apps.integrations_feishu.api.run_feishu_import_task.delay")
    def test_import_accepts_org_collection(self, mock_delay):
        mock_delay.return_value = MagicMock(id="celery-ok")
        self._connect()
        payload = {
            "organization_id": str(self.org.id),
            "space_id": str(self.space_id),
            "collection_id": str(self.collection.id),
            "documents": [{"doc_token": "docxOK", "name": "ok"}],
        }
        with self._auth():
            resp = self.client.post(
                f"{_BASE}/import",
                data=json.dumps(payload),
                content_type="application/json",
                **_AUTH,
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        job = FeishuImportJob.objects.get()
        self.assertEqual(job.collection_id, self.collection.id)


class FeishuProviderImportConcurrencyTests(TransactionTestCase):
    """Provider 变更与导入入队必须经过同一组织锁。"""

    reset_sequences = True

    def setUp(self):
        self.feature_gate_patcher = patch(
            "apps.integrations_feishu.api.feishu_import_enabled_for_organization",
            return_value=True,
        )
        self.feature_gate_patcher.start()
        self.addCleanup(self.feature_gate_patcher.stop)
        self.user = User.objects.create_user(
            email=f"feishu_race_{uuid.uuid4().hex[:8]}@example.com",
            password="pass12345",
        )
        self.org = Organization.objects.create(name="Feishu Race Org", owner=self.user)
        OrganizationMember.objects.create(
            organization=self.org,
            user=self.user,
            role="owner",
        )
        device = Device.objects.create(
            organization=self.org,
            user=self.user,
            name="Feishu Race Device",
            device_type="electron",
            fingerprint=f"feishu-race-{uuid.uuid4().hex[:12]}",
        )
        self.workspace = Workspace.objects.create(
            organization=self.org,
            device=device,
            created_by=self.user,
            name="Feishu Race WS",
            working_dir=f"/tmp/feishu-race/{self.org.id}",
            normalized_working_dir=f"/tmp/feishu-race/{self.org.id}",
            kind=Workspace.Kind.STANDARD,
        )
        provider = FeishuOAuthProvider.objects.create(
            organization=self.org,
            app_id="race-app",
            credentials={"app_secret": "race-secret"},
            secret_fingerprint="",
            status=FeishuOAuthProvider.Status.ACTIVE,
        )
        FeishuOAuthConnection.objects.create(
            user=self.user,
            organization_id=self.org.id,
            provider=provider,
            credential_version=provider.credential_version,
            tokens={"access_token": "race-token"},
            status=FeishuOAuthConnection.Status.CONNECTED,
        )

    def test_provider_rotation_interrupts_import_committed_during_race(self):
        from apps.integrations_feishu import api as feishu_api
        from apps.integrations_feishu.provider_service import (
            configure_provider,
            lock_provider_guard,
        )
        from apps.integrations_feishu.schemas import ImportRequestIn

        import_has_lock = Event()
        release_import = Event()

        def pause_after_import_lock(organization_id):
            lock_provider_guard(organization_id)
            import_has_lock.set()
            self.assertTrue(release_import.wait(timeout=10))

        def enqueue_import():
            close_old_connections()
            try:
                user = User.objects.get(id=self.user.id)
                body = ImportRequestIn(
                    organization_id=self.org.id,
                    space_id=self.workspace.id,
                    tables=[{"app_token": "app", "table_id": "table"}],
                )
                return feishu_api.start_import(SimpleNamespace(auth=user), body)
            finally:
                close_old_connections()

        def rotate_provider():
            close_old_connections()
            try:
                user = User.objects.get(id=self.user.id)
                return configure_provider(
                    user,
                    organization_id=self.org.id,
                    app_id="race-app",
                    app_secret="rotated-secret",
                )
            finally:
                close_old_connections()

        delayed_task = MagicMock(id="race-task")
        with (
            patch.object(feishu_api, "lock_provider_guard", pause_after_import_lock),
            patch.object(feishu_api.run_feishu_import_task, "delay", return_value=delayed_task),
            patch(
                "apps.integrations_feishu.provider_service.FeishuClient.validate_tenant_credentials",
                return_value={"tenant_access_token": "tenant-token"},
            ),
            ThreadPoolExecutor(max_workers=2) as pool,
        ):
            import_future = pool.submit(enqueue_import)
            self.assertTrue(import_has_lock.wait(timeout=10))
            rotate_future = pool.submit(rotate_provider)
            time.sleep(0.2)
            self.assertFalse(rotate_future.done())
            release_import.set()
            import_future.result(timeout=10)
            rotated = rotate_future.result(timeout=10)

        self.assertEqual(rotated["app_id"], "race-app")
        self.assertTrue(
            FeishuImportJob.objects.filter(
                organization_id=self.org.id,
                status=FeishuImportJob.Status.FAILED,
                error__contains="企业应用已重新认证",
            ).exists(),
        )
