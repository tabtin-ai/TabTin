"""FeishuClient token 刷新单测。"""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.integrations_feishu.client import FeishuAuthError, FeishuClient
from apps.integrations_feishu.models import FeishuOAuthConnection, FeishuOAuthProvider
from apps.tabtinspace.models import Organization

User = get_user_model()


class TokenRefreshTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email=f"tok_{uuid.uuid4().hex[:8]}@example.com",
            password="pass12345",
        )
        self.org = Organization.objects.create(name="Token Org", owner=self.user)
        self.provider = FeishuOAuthProvider.objects.create(
            organization=self.org,
            app_id="customer-app",
            credentials={"app_secret": "customer-secret"},
            status=FeishuOAuthProvider.Status.ACTIVE,
        )
        self.conn = FeishuOAuthConnection.objects.create(
            user=self.user,
            organization_id=self.org.id,
            provider=self.provider,
            credential_version=self.provider.credential_version,
            tokens={"access_token": "old-access", "refresh_token": "old-refresh"},
            expires_at=timezone.now() - timedelta(seconds=10),
            status=FeishuOAuthConnection.Status.CONNECTED,
        )

    @patch.object(FeishuClient, "refresh_access_token")
    def test_credential_version_mismatch_rejects_unexpired_access_token(self, mock_refresh):
        self.conn.expires_at = timezone.now() + timedelta(hours=1)
        self.conn.save(update_fields=["expires_at", "updated_at"])
        self.provider.credential_version += 1
        self.provider.save(update_fields=["credential_version", "updated_at"])

        with self.assertRaises(FeishuAuthError):
            FeishuClient().get_valid_access_token(self.conn)

        mock_refresh.assert_not_called()
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.status, "reauthorization_required")

    @patch.object(FeishuClient, "refresh_access_token")
    def test_refresh_before_expiry_skew(self, mock_refresh):
        mock_refresh.return_value = {
            "code": 0,
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in": 7200,
            "refresh_token_expires_in": 604800,
        }
        client = FeishuClient()
        token = client.get_valid_access_token(self.conn)
        self.assertEqual(token, "new-access")
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.tokens["access_token"], "new-access")
        self.assertEqual(self.conn.status, "connected")
        self.assertIsNotNone(self.conn.refresh_token_expires_at)

    @patch.object(FeishuClient, "refresh_access_token")
    def test_stale_caller_reuses_token_refreshed_under_row_lock(self, mock_refresh):
        mock_refresh.return_value = {
            "code": 0,
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in": 7200,
        }
        first = FeishuOAuthConnection.objects.get(id=self.conn.id)
        stale = FeishuOAuthConnection.objects.get(id=self.conn.id)
        client = FeishuClient()

        self.assertEqual(client.get_valid_access_token(first), "new-access")
        self.assertEqual(client.get_valid_access_token(stale), "new-access")
        self.assertEqual(mock_refresh.call_count, 1)

    @patch.object(FeishuClient, "refresh_access_token")
    def test_force_refresh_replaces_token_even_when_expiry_is_still_in_future(self, mock_refresh):
        self.conn.expires_at = timezone.now() + timedelta(hours=1)
        self.conn.save(update_fields=["expires_at", "updated_at"])
        mock_refresh.return_value = {
            "code": 0,
            "access_token": "forced-access",
            "refresh_token": "forced-refresh",
            "expires_in": 7200,
        }

        token = FeishuClient().get_valid_access_token(self.conn, force_refresh=True)

        self.assertEqual(token, "forced-access")
        mock_refresh.assert_called_once()

    def test_refresh_failure_marks_revoked(self):
        from apps.integrations_feishu.client import FeishuAPIError

        with patch.object(
            FeishuClient, "refresh_access_token", side_effect=FeishuAPIError("fail"),
        ):
            client = FeishuClient()
            with self.assertRaises(FeishuAuthError):
                client.get_valid_access_token(self.conn)
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.status, "revoked")

    @patch.object(FeishuClient, "refresh_access_token")
    def test_expired_refresh_token_revokes_without_remote_call(self, mock_refresh):
        self.conn.refresh_token_expires_at = timezone.now() - timedelta(seconds=1)
        self.conn.save(update_fields=["refresh_token_expires_at", "updated_at"])

        with self.assertRaises(FeishuAuthError):
            FeishuClient().get_valid_access_token(self.conn)

        mock_refresh.assert_not_called()
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.status, "revoked")

    @override_settings(
        FEISHU_OAUTH_APP_ID="legacy-app",
        FEISHU_OAUTH_APP_SECRET="legacy-secret",
    )
    @patch.object(FeishuClient, "refresh_access_token")
    def test_providerless_connection_uses_legacy_credentials_during_rollout(self, mock_refresh):
        self.conn.provider = None
        self.conn.credential_version = None
        self.conn.save(update_fields=["provider", "credential_version", "updated_at"])
        self.provider.delete()
        mock_refresh.return_value = {
            "access_token": "legacy-new-access",
            "refresh_token": "legacy-new-refresh",
            "expires_in": 7200,
        }

        token = FeishuClient().get_valid_access_token(self.conn)

        self.assertEqual(token, "legacy-new-access")
        mock_refresh.assert_called_once_with("old-refresh")
