import json
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from apps.chat.conversation.services import (
    im_business_projection_service,
    session_share_card_service,
)
from apps.chat.conversation.api import session_share as session_share_api


class SessionShareRevokeApiTests(SimpleTestCase):
    def test_committed_revoke_is_success_when_client_accepts_projection_lag(self):
        actor = SimpleNamespace(id="owner-1")
        request = SimpleNamespace(auth=actor)
        revoked = {"id": "share-1", "status": "revoked"}
        error = session_share_card_service.SessionShareRefreshUnconfirmed(
            result=revoked,
        )

        with patch.object(
            session_share_api.session_share_card_service,
            "revoke_and_refresh_card",
            side_effect=error,
        ):
            response = session_share_api.revoke_session_share_card(
                request,
                "share-1",
                session_share_api.RevokeSessionShareCardRequest(
                    accept_committed_revoke=True,
                ),
            )

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["status"], "revoked")
        self.assertEqual(
            response["data"]["card_refresh_status"],
            "unconfirmed",
        )

    def test_legacy_client_keeps_refresh_unconfirmed_error_contract(self):
        request = SimpleNamespace(auth=SimpleNamespace(id="owner-1"))
        error = session_share_card_service.SessionShareRefreshUnconfirmed(
            result={"id": "share-1", "status": "revoked"},
        )

        with patch.object(
            session_share_api.session_share_card_service,
            "revoke_and_refresh_card",
            side_effect=error,
        ):
            response = session_share_api.revoke_session_share_card(
                request,
                "share-1",
                None,
            )

        payload = json.loads(response.content)
        self.assertEqual(response.status_code, 503)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["code"], "IM_REFRESH_UNCONFIRMED")
        self.assertEqual(payload["data"]["status"], "revoked")


class SessionShareCardRefreshRetryTests(SimpleTestCase):
    def _share(self):
        share = SimpleNamespace(
            id="share-1",
            owner_user_id="owner-1",
            grantee_user_id="user-2",
            organization_id="org-1",
            session_id="session-1",
            session=SimpleNamespace(title="新任务", workspace=None),
            can_fork=False,
            can_chat=False,
            status="revoked",
            card_message_ref="019fcaa1-3333-7333-8333-333333333333",
            card_conversation_id="conversation-1",
            card_message_id=42,
            card_refresh_status="confirmed",
            forked_session_id=None,
            created_at=None,
            revoked_at=None,
        )
        share.save = Mock()
        return share

    def test_revoke_refresh_failure_persists_and_enqueues_retry(self):
        actor = SimpleNamespace(id="owner-1")
        share = self._share()

        with (
            patch.object(
                session_share_card_service.session_share_service,
                "get_share_for_user",
                return_value=share,
            ),
            patch.object(
                session_share_card_service.session_share_service,
                "revoke_share",
                return_value=share,
            ),
            patch.object(
                session_share_card_service,
                "revoke_session_share_resource_grants",
            ),
            patch.object(
                session_share_card_service,
                "_refresh_card",
                side_effect=RuntimeError("temporary failure"),
            ),
            patch.object(
                session_share_card_service,
                "_enqueue_card_refresh_retry",
            ) as enqueue_retry,
            patch.object(
                session_share_card_service.transaction,
                "atomic",
                return_value=nullcontext(),
            ),
        ):
            with self.assertRaises(
                session_share_card_service.SessionShareRefreshUnconfirmed,
            ):
                session_share_card_service.revoke_and_refresh_card(
                    actor_user=actor,
                    share_id="share-1",
                )

        self.assertEqual(share.card_refresh_status, "unconfirmed")
        share.save.assert_called_with(update_fields=["card_refresh_status"])
        enqueue_retry.assert_called_once_with(share)

    def test_revoke_and_restore_publish_the_unified_state_change(self):
        actor = SimpleNamespace(id="owner-1")
        share = self._share()
        share.card_contract = "session_share_v2"
        share.version = 3
        share.access_epoch = 2
        share.session.thread_id = "thread-1"

        with (
            patch.object(
                session_share_card_service.session_share_service,
                "get_share_for_user",
                return_value=share,
            ),
            patch.object(
                session_share_card_service.session_share_service,
                "revoke_share",
                return_value=share,
            ),
            patch.object(
                session_share_card_service,
                "revoke_session_share_resource_grants",
            ),
            patch.object(session_share_card_service, "_refresh_card_with_retry_tracking"),
            patch.object(
                session_share_card_service.transaction,
                "atomic",
                return_value=nullcontext(),
            ),
            patch(
                "apps.chat.conversation.services.session_collaboration_events.send_collaboration_state_changed",
            ) as publish_changed,
        ):
            session_share_card_service.revoke_and_refresh_card(
                actor_user=actor,
                share_id="share-1",
            )

        publish_changed.assert_called_once_with(share, revoked=True)

        with (
            patch.object(
                session_share_card_service.session_share_service,
                "get_share_for_user",
                return_value=share,
            ),
            patch.object(
                session_share_card_service.session_share_service,
                "restore_share",
                return_value=share,
            ),
            patch.object(session_share_card_service, "sync_session_share_resource_grants"),
            patch.object(session_share_card_service, "_refresh_card_with_retry_tracking"),
            patch.object(
                session_share_card_service,
                "get_share_detail",
                return_value={"id": "share-1"},
            ),
            patch(
                "apps.chat.conversation.services.session_collaboration_events.send_collaboration_state_changed",
            ) as publish_changed,
        ):
            session_share_card_service.restore_and_refresh_card(
                actor_user=actor,
                share_id="share-1",
            )

        publish_changed.assert_called_once_with(share, revoked=False)

    def test_retry_marks_projection_confirmed_after_refresh(self):
        share = self._share()
        share.card_refresh_status = "unconfirmed"
        queryset = Mock()
        queryset.select_related.return_value.filter.return_value.first.return_value = share

        with (
            patch(
                "apps.chat.conversation.models.SessionShare.objects.select_for_update",
                return_value=queryset,
            ),
            patch.object(session_share_card_service, "_refresh_card") as refresh_card,
            patch.object(
                session_share_card_service.transaction,
                "atomic",
                return_value=nullcontext(),
            ),
        ):
            refreshed = session_share_card_service.retry_unconfirmed_card_refresh(
                share_id="share-1",
            )

        self.assertTrue(refreshed)
        refresh_card.assert_called_once_with(share)
        self.assertEqual(share.card_refresh_status, "confirmed")
        share.save.assert_called_with(update_fields=["card_refresh_status"])


class SessionShareDjangoImDeliveryTests(SimpleTestCase):
    def _pending_share(self):
        return SimpleNamespace(
            id="share-1",
            organization_id="org-1",
            grantee_user_id="user-2",
            status="pending",
            card_contract="session_share_v2",
            delivery_status="pending",
            card_conversation_id="",
            card_message_id=None,
        )

    def test_django_im_creates_dm_and_sends_card_without_tencent(self):
        actor = SimpleNamespace(id="owner-1")
        share = self._pending_share()
        message = SimpleNamespace(id=88, seq=7, conversation_id="django-dm-1")

        with (
            patch.object(
                session_share_card_service,
                "_load_or_create_pending_share",
                return_value=share,
            ),
            patch.object(
                session_share_card_service,
                "_result",
                return_value={"id": "share-1", "status": "pending"},
            ),
            patch.object(
                session_share_card_service,
                "_resolve_django_direct_conversation",
                return_value="django-dm-1",
            ) as resolve_dm,
            patch.object(
                session_share_card_service,
                "_send_django_share_card",
                return_value={"id": message.id, "seq": message.seq},
            ) as send_card,
            patch.object(
                session_share_card_service,
                "_card_content",
                return_value="[共享任务] 新任务",
            ),
            patch.object(
                session_share_card_service,
                "_card_metadata",
                return_value={"card": {"type": "session_share_v2", "object_id": "share-1"}},
            ),
            patch.object(
                session_share_card_service,
                "_finalize_delivered_share",
                return_value=share,
            ) as finalize,
            patch.object(
                session_share_card_service,
                "_refresh_card_with_retry_tracking",
            ),
        ):
            result = session_share_card_service.share_and_send_card(
                actor_user=actor,
                session_id="session-1",
                grantee_user_id="user-2",
                client_request_id="019fcaa1-3333-7333-8333-333333333333",
                card_contract="session_share_v2",
            )

        resolve_dm.assert_called_once_with(
            organization_id="org-1",
            actor_user_id="owner-1",
            other_user_id="user-2",
            conversation_id_hint=None,
        )
        send_card.assert_called_once()
        finalize.assert_called_once()
        self.assertEqual(finalize.call_args.kwargs["conversation_id"], "django-dm-1")
        self.assertEqual(finalize.call_args.kwargs["sequence"], 7)
        self.assertEqual(result["id"], "share-1")

    def test_django_im_member_validation_is_rejected_not_unconfirmed(self):
        actor = SimpleNamespace(id="owner-1")
        share = self._pending_share()

        with (
            patch.object(
                session_share_card_service,
                "_load_or_create_pending_share",
                return_value=share,
            ),
            patch.object(
                session_share_card_service,
                "_result",
                return_value={"id": "share-1", "status": "pending"},
            ),
            patch.object(
                session_share_card_service,
                "_resolve_django_direct_conversation",
                side_effect=ValueError("部分目标用户不属于该组织"),
            ),
            patch.object(
                session_share_card_service.session_share_service,
                "set_share_delivery_status",
                return_value=share,
            ),
        ):
            with self.assertRaises(
                session_share_card_service.SessionShareDeliveryRejected,
            ):
                session_share_card_service.share_and_send_card(
                    actor_user=actor,
                    session_id="session-1",
                    grantee_user_id="user-2",
                    client_request_id="019fcaa1-3333-7333-8333-333333333333",
                    card_contract="session_share_v2",
                )

    def test_django_refresh_updates_message_and_emits_session_share_event(self):
        share = SimpleNamespace(
            id="share-1",
            organization_id="org-1",
            status="revoked",
            card_conversation_id="019fcaa1-6666-7666-8666-666666666666",
            card_message_id=88,
            card_message_ref="019fcaa1-3333-7333-8333-333333333333",
            session=SimpleNamespace(title="新任务"),
            owner_user_id="owner-1",
            grantee_user_id="user-2",
            card_contract="session_share_v2",
            card_schema_version=1,
            version=4,
        )
        conversation = SimpleNamespace(id="019fcaa1-6666-7666-8666-666666666666")
        message = SimpleNamespace(
            metadata={"card": {"type": "session_share_v2", "version": 3}},
            save=Mock(),
        )
        enqueue = Mock()

        with (
            patch(
                "apps.tabchat.models.Conversation.objects.filter",
                return_value=SimpleNamespace(first=lambda: conversation),
            ),
            patch(
                "apps.tabchat.models.Message.objects.filter",
                return_value=SimpleNamespace(first=lambda: message),
            ),
            patch(
                "apps.tabchat.services.im_outbox_service.IMOutboxService.enqueue",
                enqueue,
            ),
        ):
            session_share_card_service._refresh_django_share_card(share)

        self.assertEqual(message.metadata["card"]["version"], 4)
        message.save.assert_called_once_with(update_fields=["metadata"])
        enqueue.assert_called_once()
        self.assertEqual(enqueue.call_args.kwargs["event_type"], "im.session_share.update")
        self.assertEqual(enqueue.call_args.kwargs["data"]["share_id"], "share-1")
