"""#9222：PUT /chat/sessions/{id} 可选写入 agent_mode，旧请求不传则不变。"""

from __future__ import annotations

import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TransactionTestCase, override_settings
from django.utils import timezone
from pydantic import ValidationError

from apps.chat.conversation.api.session import update_session
from apps.chat.conversation.models import ChatSession
from apps.chat.conversation.schemas import UpdateSessionRequest
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager

User = get_user_model()


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class UpdateSessionAgentModeTest(TransactionTestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization

        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization

        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent

        ctx = create_test_organization_with_agent(prefix="upd_agent_mode")
        self.user = ctx["user"]
        self.organization = ctx["organization"]
        self.space = ctx["space"]
        self.agent = ctx["agent"]

        self.raw_session_key = "upd_agent_mode_test_session_key_00000001"
        UserSession.objects.create(
            user=self.user,
            session_key=SessionManager.hash_session_key(self.raw_session_key),
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="upd-agent-mode-test",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )
        self.factory = RequestFactory()
        self.session = ChatSession.objects.create(
            id=uuid.uuid4(),
            user=self.user,
            organization_id=str(self.organization.id),
            workspace=self.space,
            agent=self.agent,
            title="agent mode sync",
            agent_mode="agent",
        )

    def tearDown(self):
        from apps.tabtinspace.tests.fixtures import cleanup_test_organization

        cleanup_test_organization(self.organization, delete_user=True)

    def _put(self, data: UpdateSessionRequest):
        request = self.factory.put(f"/api/chat/sessions/{self.session.id}")
        request.auth = self.user
        return update_session(request, str(self.session.id), data)

    def test_update_agent_mode_persists_and_returns(self):
        response = self._put(UpdateSessionRequest(agent_mode="plan"))
        self.assertIsInstance(response, dict)
        self.assertTrue(response.get("success"))
        self.assertEqual(response["data"]["agent_mode"], "plan")

        self.session.refresh_from_db()
        self.assertEqual(self.session.agent_mode, "plan")

    def test_omitting_agent_mode_leaves_existing_value(self):
        self.session.agent_mode = "ask"
        self.session.save(update_fields=["agent_mode"])

        response = self._put(UpdateSessionRequest(title="renamed-only"))
        self.assertIsInstance(response, dict)
        self.assertTrue(response.get("success"))
        self.session.refresh_from_db()
        self.assertEqual(self.session.agent_mode, "ask")
        self.assertEqual(self.session.title, "renamed-only")

    def test_rejects_non_selectable_agent_mode(self):
        with self.assertRaises(ValidationError):
            UpdateSessionRequest(agent_mode="yolo")

    def test_set_pin_persists_explicit_value_and_timestamp(self):
        response = self._put(UpdateSessionRequest(is_pinned=True))
        self.assertTrue(response.get("success"))
        self.assertTrue(response["data"]["is_pinned"])

        self.session.refresh_from_db()
        self.assertTrue(self.session.is_pinned)
        self.assertIsNotNone(self.session.pinned_at)

        response = self._put(UpdateSessionRequest(is_pinned=False))
        self.assertTrue(response.get("success"))
        self.session.refresh_from_db()
        self.assertFalse(self.session.is_pinned)
        self.assertIsNone(self.session.pinned_at)

    def test_omitting_pin_leaves_existing_value(self):
        self.session.is_pinned = True
        self.session.pinned_at = timezone.now()
        self.session.save(update_fields=["is_pinned", "pinned_at"])

        self._put(UpdateSessionRequest(title="pin-preserved"))
        self.session.refresh_from_db()
        self.assertTrue(self.session.is_pinned)
        self.assertIsNotNone(self.session.pinned_at)
