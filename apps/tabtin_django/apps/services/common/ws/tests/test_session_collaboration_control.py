import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, call, patch

from django.test import SimpleTestCase

from apps.chat.conversation.models import SessionShare
from apps.chat.conversation.services.session_collaboration_events import (
    send_collaboration_state_changed,
)
from apps.services.common.ws.handlers.auth import _filter_capabilities
from apps.services.common.ws.handlers.subscription_validators import (
    SessionCollaborationValidator,
)
from apps.services.common.ws.gateway import GatewayConsumer
from apps.services.common.ws.organization_context import OrganizationContext
from apps.tabtinspace.models import Organization


class SessionCollaborationAccessControlTests(SimpleTestCase):
    @patch(
        "apps.chat.conversation.services.session_collaboration_events.async_to_sync",
        side_effect=lambda callback: callback,
    )
    @patch("apps.chat.conversation.services.session_collaboration_events.get_channel_layer")
    def test_access_change_invalidates_owner_card(self, get_channel_layer, _async_to_sync):
        layer = SimpleNamespace(group_send=Mock())
        get_channel_layer.return_value = layer
        share = SimpleNamespace(
            id="019fcaa1-2222-7222-8222-222222222222",
            session_id="019fcaa1-1111-7111-8111-111111111111",
            owner_user_id="owner-1",
            grantee_user_id="recipient-1",
            version=3,
            access_epoch=1,
            session=SimpleNamespace(thread_id="thread-1"),
        )

        send_collaboration_state_changed(share, revoked=False)

        self.assertEqual(
            layer.group_send.call_args_list,
            [
                call(
                    "user.recipient-1",
                    {
                        "type": "session_collaboration_access_control",
                        "share_id": str(share.id),
                        "session_id": share.session_id,
                        "thread_id": "thread-1",
                        "version": 3,
                        "access_epoch": 1,
                        "revoked": False,
                    },
                ),
                call(
                    "user.owner-1",
                    {
                        "type": "relay_message",
                        "message": {
                            "type": "session.collaboration.changed",
                            "payload": {
                                "object_id": str(share.id),
                                "version": 3,
                            },
                        },
                    },
                ),
                call(
                    "user.recipient-1",
                    {
                        "type": "relay_message",
                        "message": {
                            "type": "session.collaboration.changed",
                            "payload": {
                                "object_id": str(share.id),
                                "version": 3,
                            },
                        },
                    },
                ),
            ],
        )

    def test_electron_can_declare_session_collaboration_capability(self):
        self.assertEqual(
            _filter_capabilities("electron", {"session.collaboration"}),
            {"session.collaboration"},
        )

    def test_revoke_removes_relation_and_runtime_subscriptions(self):
        session_id = "019fcaa1-1111-7111-8111-111111111111"
        share_id = "019fcaa1-2222-7222-8222-222222222222"
        consumer = SimpleNamespace(
            subscriptions={
                f"session.collaboration.{share_id}.1",
                f"agent.session.{session_id}",
                "agent.stream.chat-session-019fcaa1-1111-7111-8111-111111111111",
                "notifications.user-1",
            },
            _leave_group=AsyncMock(),
            _send_envelope=AsyncMock(),
        )

        asyncio.run(
            GatewayConsumer.session_collaboration_access_control(
                consumer,
                {
                    "share_id": share_id,
                    "session_id": session_id,
                    "thread_id": "chat-session-019fcaa1-1111-7111-8111-111111111111",
                    "version": 2,
                    "access_epoch": 2,
                    "revoked": True,
                },
            )
        )

        self.assertEqual(consumer.subscriptions, {"notifications.user-1"})
        self.assertEqual(
            consumer._revoked_collaboration_topics[share_id],
            {
                f"session.collaboration.{share_id}.1",
                f"agent.session.{session_id}",
                "agent.stream.chat-session-019fcaa1-1111-7111-8111-111111111111",
            },
        )
        consumer._send_envelope.assert_awaited_once_with(
            {
                "type": "session.collaboration.access_revoked",
                "payload": {
                    "object_id": share_id,
                    "version": 2,
                    "access_epoch": 2,
                },
            }
        )

    def test_restore_notifies_recipient_to_reload_authoritative_access(self):
        share_id = "019fcaa1-2222-7222-8222-222222222222"
        consumer = SimpleNamespace(
            subscriptions={"notifications.user-1"},
            _revoked_collaboration_topics={share_id: set()},
            _send_envelope=AsyncMock(),
        )

        asyncio.run(
            GatewayConsumer.session_collaboration_access_control(
                consumer,
                {
                    "share_id": share_id,
                    "session_id": "019fcaa1-1111-7111-8111-111111111111",
                    "version": 3,
                    "access_epoch": 3,
                    "revoked": False,
                },
            )
        )

        self.assertNotIn(share_id, consumer._revoked_collaboration_topics)
        consumer._send_envelope.assert_awaited_once_with(
            {
                "type": "session.collaboration.access_restored",
                "payload": {
                    "object_id": share_id,
                    "version": 3,
                    "access_epoch": 3,
                },
            }
        )


class SessionCollaborationSubscriptionTests(SimpleTestCase):
    def test_current_membership_overrides_connection_snapshot(self):
        owner_id = "019fcaa1-1111-7111-8111-111111111111"
        organization_id = "019fcaa1-2222-7222-8222-222222222222"
        share_id = "019fcaa1-3333-7333-8333-333333333333"
        share = SimpleNamespace(
            organization_id=organization_id,
            owner_user_id=owner_id,
            grantee_user_id="019fcaa1-4444-7444-8444-444444444444",
            status="pending",
            eligibility_status="eligible",
        )
        consumer = SimpleNamespace(
            user_id=owner_id,
            organization_ctx=OrganizationContext(
                "019fcaa1-5555-7555-8555-555555555555",
                {"019fcaa1-5555-7555-8555-555555555555"},
            ),
        )
        topic = f"session.collaboration.{share_id}.1"
        share_query = Mock()
        share_query.first.return_value = share
        membership_query = Mock()
        membership_query.exists.return_value = True

        with (
            patch.object(SessionShare.objects, "filter", return_value=share_query),
            patch.object(
                Organization.objects,
                "filter",
                return_value=membership_query,
            ),
        ):
            error = asyncio.run(
                SessionCollaborationValidator().validate(
                    consumer,
                    topic,
                    topic.split(".", 2),
                )
            )
            self.assertIsNone(error)

            consumer.organization_ctx = OrganizationContext(
                organization_id,
                {organization_id},
            )
            membership_query.exists.return_value = False
            error = asyncio.run(
                SessionCollaborationValidator().validate(
                    consumer,
                    topic,
                    topic.split(".", 2),
                )
            )

        self.assertEqual(error, "collaboration access denied")
