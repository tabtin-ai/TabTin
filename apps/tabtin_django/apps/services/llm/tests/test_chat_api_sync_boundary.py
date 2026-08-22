from __future__ import annotations

import inspect
import json
from pathlib import Path

from django.contrib.auth import get_user_model
from django.test import Client, RequestFactory, SimpleTestCase, TestCase, override_settings

from apps.services.billing.services.billing_precheck import (
    LAYER_BALANCE,
    LAYER_GUARD,
    LAYER_SERVICE_GUARD,
)
from apps.services.llm.api import _chat_billing_skip_layers, chat
from apps.tabtinspace.models import Organization
from apps.users.auth.api._shared import _create_auth_session


class ChatApiSyncBoundaryTests(SimpleTestCase):
    def test_chat_route_is_sync_so_orm_guards_run_outside_async_context(self):
        self.assertFalse(inspect.iscoroutinefunction(chat))

    def test_envelope_wraps_billing_then_sync_chat_view(self):
        layer = chat
        layer_files = []
        while True:
            self.assertFalse(inspect.iscoroutinefunction(layer))
            layer_files.append(Path(layer.__code__.co_filename).name)
            if not hasattr(layer, "__wrapped__"):
                break
            layer = layer.__wrapped__

        self.assertEqual(layer_files, ["api_common.py", "decorators.py", "api.py"])

    @override_settings(TABTIN_EDITION="community")
    def test_community_byok_chat_skips_only_the_financial_balance_layer(self):
        self.assertEqual(
            _chat_billing_skip_layers(),
            frozenset({LAYER_GUARD, LAYER_SERVICE_GUARD, LAYER_BALANCE}),
        )

    @override_settings(TABTIN_EDITION="saas")
    def test_saas_chat_keeps_the_existing_balance_precheck(self):
        self.assertEqual(
            _chat_billing_skip_layers(),
            frozenset({LAYER_GUARD, LAYER_SERVICE_GUARD}),
        )


@override_settings(
    TABTIN_EDITION="saas",
    TABTIN_REQUIRE_INVITE_CODE=False,
    REQUIRE_INVITE_CODE=False,
)
class SaaSChatApiSyncCompatibilityTests(TestCase):
    def setUp(self) -> None:
        user_model = get_user_model()
        self.member = user_model.objects.create_user(
            email="phase3-saas-member@example.com",
            password="unused-phase3-password",
        )
        self.outsider = user_model.objects.create_user(
            email="phase3-saas-outsider@example.com",
            password="unused-phase3-password",
        )
        self.organization = Organization.objects.get(owner=self.member)

    def _token_for(self, user) -> str:
        request = RequestFactory().post("/auth")
        access_token, _, _ = _create_auth_session(
            user,
            request,
            session_type="api",
        )
        return access_token

    def _post_missing_model(self, user):
        return Client().post(
            "/api/services/llm/chat",
            data=json.dumps(
                {
                    "model": "phase3-saas-model-that-does-not-exist",
                    "messages": [{"role": "user", "content": "hello"}],
                    "organization_id": str(self.organization.id),
                    "stream": False,
                }
            ),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {self._token_for(user)}",
        )

    def test_authenticated_member_keeps_bad_request_envelope(self):
        response = self._post_missing_model(self.member)

        self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(
            set(response.json()),
            {"success", "code", "message", "data", "trace_id"},
        )
        self.assertFalse(response.json()["success"])
        self.assertEqual(response.json()["code"], "BAD_REQUEST")
        self.assertIsNone(response.json()["data"])
        self.assertTrue(response.json()["trace_id"])
        self.assertNotIn("SynchronousOnlyOperation", response.content.decode())

    def test_authenticated_outsider_keeps_forbidden_envelope(self):
        response = self._post_missing_model(self.outsider)

        self.assertEqual(response.status_code, 403, response.content)
        self.assertEqual(
            set(response.json()),
            {"success", "code", "message", "data", "trace_id"},
        )
        self.assertFalse(response.json()["success"])
        self.assertEqual(response.json()["code"], "FORBIDDEN")
        self.assertIsNone(response.json()["data"])
        self.assertTrue(response.json()["trace_id"])
        self.assertNotIn("SynchronousOnlyOperation", response.content.decode())
