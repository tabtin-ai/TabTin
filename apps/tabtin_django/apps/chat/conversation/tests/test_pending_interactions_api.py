from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase
from django.utils import timezone

from apps.chat.conversation.api.pending_interactions import dismiss_pending_interaction


class PendingInteractionsApiTests(SimpleTestCase):
    def _request(self, user_id: str = "00000000-0000-0000-0000-000000000001"):
        return SimpleNamespace(auth=SimpleNamespace(id=user_id))

    def _patch_interaction(self, interaction):
        qs = MagicMock()
        qs.filter.return_value.first.return_value = interaction
        manager = MagicMock()
        manager.using.return_value = qs
        return patch(
            "apps.chat.conversation.api.pending_interactions.PendingInteraction.objects",
            manager,
        )

    def test_dismiss_rejects_unexpired_pending_interaction(self):
        interaction = SimpleNamespace(
            id="interaction-1",
            status="pending",
            expires_at=timezone.now() + timedelta(seconds=60),
        )

        with self._patch_interaction(interaction), patch(
            "apps.chat.conversation.api.pending_interactions.mark_interaction_resolved",
        ) as mark_resolved:
            response = dismiss_pending_interaction(self._request(), "interaction-1")

        self.assertEqual(response.status_code, 409)
        mark_resolved.assert_not_called()

    def test_dismiss_expires_stale_pending_interaction(self):
        interaction = SimpleNamespace(
            id="interaction-2",
            kind="tool_approval",
            thread_id="chat-session-test",
            request_key="batch-1",
            status="pending",
            expires_at=timezone.now() - timedelta(seconds=1),
        )
        expired = SimpleNamespace(id="interaction-2", status="expired")

        with self._patch_interaction(interaction), patch(
            "apps.chat.conversation.api.pending_interactions.mark_interaction_resolved",
            return_value=expired,
        ) as mark_resolved:
            response = dismiss_pending_interaction(self._request(), "interaction-2")

        self.assertEqual(response["data"]["status"], "expired")
        mark_resolved.assert_called_once_with(
            kind="tool_approval",
            thread_id="chat-session-test",
            request_key="batch-1",
            status="expired",
            result={"reason": "dismissed_by_client"},
            publish=True,
        )
