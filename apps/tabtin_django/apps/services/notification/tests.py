"""通知服务测试。"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from django.http import QueryDict
from django.test import RequestFactory, SimpleTestCase, TestCase

from apps.services.notification.api import (
    acknowledge_agent_session,
    list_notifications,
    mark_all_read,
    unread_count,
)
from apps.services.notification.models import Notification
from apps.services.notification.services.notification_service import NotificationService

_fake_user_id = uuid.uuid4()


def _make_fake_user():
    user = MagicMock()
    user.id = _fake_user_id
    user.is_authenticated = True
    user.pk = _fake_user_id
    return user


_fake_user = _make_fake_user()


class NotificationServiceTests(TestCase):
    databases = {"default", "postgresql"}

    @patch(
        "apps.services.notification.services.notification_service.publish_to_user"
    )
    def test_notify_desktop_only_pushes_a_generic_event_without_persisting(
        self,
        mock_publish_to_user,
    ):
        before_count = Notification.objects.count()

        NotificationService.notify_desktop_only(
            user_id="user-1",
            type="tabdata.comment.mention.desktop_only",
            title="你收到一条提及提醒",
            body="你暂时没有访问关联内容的权限。",
            metadata={"source_event_id": "comment-1:mention:user-1"},
            organization_id="org-1",
        )

        self.assertEqual(Notification.objects.count(), before_count)
        mock_publish_to_user.assert_called_once()
        envelope = mock_publish_to_user.call_args.args[1]
        self.assertEqual(envelope["type"], "agent.user.notification.new")
        self.assertEqual(
            envelope["payload"],
            {
                "id": "comment-1:mention:user-1",
                "type": "tabdata.comment.mention.desktop_only",
                "title": "你收到一条提及提醒",
                "body": "你暂时没有访问关联内容的权限。",
                "metadata": {
                    "desktop_only": True,
                    "source_event_id": "comment-1:mention:user-1",
                },
                "organization_id": "org-1",
                "space_id": "",
                "priority": "normal",
                "category": "general",
                "source_extension_id": "",
                "source_event_id": "comment-1:mention:user-1",
                "channels_delivered": [],
                "is_read": True,
                "read_at": None,
                "created_at": None,
            },
        )

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_notify_dedupe_key_is_database_idempotent_per_recipient(self, mock_push_ws):
        metadata = {
            "dedupe_key": "account:org-1:invoice:invoice-1",
            "source_event_id": "account:org-1:invoice:invoice-1",
        }
        first = NotificationService.notify(
            user_id="owner-1",
            type="account.invoice_collection_succeeded",
            title="账单扣款成功",
            metadata=metadata,
            organization_id="org-1",
        )
        second = NotificationService.notify(
            user_id="owner-1",
            type="account.invoice_collection_succeeded",
            title="账单扣款成功",
            metadata=metadata,
            organization_id="org-1",
        )

        self.assertEqual(first.id, second.id)
        self.assertEqual(Notification.objects.filter(user_id="owner-1").count(), 1)
        mock_push_ws.assert_called_once()

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_member_added_legacy_and_admin_keys_share_one_business_fact(self, mock_push_ws):
        member_id = "member-1"
        common = {
            "user_id": "member-user-1",
            "type": "member_added",
            "title": "你已被添加到组织",
            "organization_id": "org-1",
        }

        first = NotificationService.notify(
            **common,
            body="角色: editor",
            metadata={
                "category": "organization",
                "dedupe_key": f"organization:member:added:{member_id}",
                "source_event_id": f"organization:member:added:{member_id}",
            },
        )
        second = NotificationService.notify(
            **common,
            body="",
            metadata={
                "category": "organization",
                "dedupe_key": f"organization:org-1:member_added:{member_id}",
                "source_event_id": f"organization:org-1:member_added:{member_id}",
            },
        )

        self.assertEqual(first.id, second.id)
        self.assertEqual(first.body, "")
        self.assertEqual(
            Notification.objects.filter(user_id="member-user-1", type="member_added").count(),
            1,
        )
        mock_push_ws.assert_called_once()

    def test_center_filters_and_personal_removal_are_server_scoped(self):
        removed = Notification.objects.create(
            user_id="user-1",
            organization_id="former-org",
            type="member_removed",
            title="你已被移出组织",
            category="organization",
        )
        account = Notification.objects.create(
            user_id="user-1",
            organization_id="current-org",
            type="account.balance_low",
            title="账户余额提醒",
            body="请处理",
            category="account",
        )
        Notification.objects.create(
            user_id="user-2",
            organization_id="current-org",
            type="account.balance_low",
            title="不应泄露",
            category="account",
        )

        listed = NotificationService.list_notifications(
            "user-1",
            organization_id="current-org",
            include_personal_invitations=True,
            unread_only=True,
            category="organization",
            search="移出",
        )

        self.assertEqual(listed["total"], 1)
        self.assertEqual(listed["items"][0]["id"], str(removed.id))
        self.assertNotEqual(listed["items"][0]["id"], str(account.id))

    def test_personal_member_added_is_visible_from_current_organization_scope(self):
        added = Notification.objects.create(
            user_id="user-1",
            organization_id="new-org",
            type="member_added",
            title="你已被添加到组织",
            category="organization",
        )
        Notification.objects.create(
            user_id="user-1",
            organization_id="other-org",
            type="agent.task.completed",
            title="不应跨组织显示",
        )

        listed = NotificationService.list_notifications(
            "user-1",
            organization_id="current-org",
            include_personal_invitations=True,
            center_only=True,
        )

        self.assertEqual(listed["total"], 1)
        self.assertEqual(listed["items"][0]["id"], str(added.id))

    def test_center_only_collects_the_four_product_categories(self):
        scenarios = [
            ("tracker.run.completed", {}, "automation"),
            ("system", {"event": "waiting_device"}, "automation"),
            ("resource_shared", {"action": "invited"}, "collaboration"),
            ("resource_shared", {"action": "permission_changed"}, "collaboration"),
            ("member_removed", {}, "organization"),
            ("balance_low", {}, "account"),
        ]
        for index, (event_type, metadata, _category) in enumerate(scenarios):
            Notification.objects.create(
                user_id="user-1",
                organization_id="org-1",
                type=event_type,
                title=f"center-{index}",
                metadata=metadata,
            )

        excluded = [
            ("agent.task.completed", {}),
            ("system", {"event": "system.update"}),
        ]
        for index, (event_type, metadata) in enumerate(excluded):
            Notification.objects.create(
                user_id="user-1",
                organization_id="org-1",
                type=event_type,
                title=f"excluded-{index}",
                metadata=metadata,
            )

        listed = NotificationService.list_notifications(
            "user-1",
            organization_id="org-1",
            center_only=True,
            limit=20,
        )

        self.assertEqual(listed["total"], len(scenarios))
        self.assertEqual(
            {item["center_category"] for item in listed["items"]},
            {"automation", "collaboration", "organization", "account"},
        )
        self.assertFalse(
            {item["title"] for item in listed["items"]}
            & {"excluded-0", "excluded-1", "excluded-2"}
        )

        collaboration = NotificationService.list_notifications(
            "user-1",
            organization_id="org-1",
            center_only=True,
            category="collaboration",
        )
        self.assertEqual(collaboration["total"], 2)
        self.assertTrue(
            all(item["type"] == "resource_shared" for item in collaboration["items"])
        )

        unknown = NotificationService.list_notifications(
            "user-1",
            organization_id="org-1",
            center_only=True,
            category="general",
        )
        self.assertEqual(unknown["total"], 0)

    def test_center_only_unread_and_mark_all_ignore_other_channels(self):
        center = Notification.objects.create(
            user_id="user-1",
            organization_id="org-1",
            type="account.balance_low",
            title="center",
        )
        agent = Notification.objects.create(
            user_id="user-1",
            organization_id="org-1",
            type="agent.task.completed",
            title="agent sidebar",
        )

        self.assertEqual(
            NotificationService.get_unread_count(
                "user-1",
                organization_id="org-1",
                center_only=True,
            ),
            1,
        )
        self.assertEqual(
            NotificationService.mark_all_read(
                "user-1",
                organization_id="org-1",
                center_only=True,
            ),
            1,
        )

        center.refresh_from_db()
        agent.refresh_from_db()
        self.assertTrue(center.is_read)
        self.assertFalse(agent.is_read)

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_notify_maps_space_metadata_to_space_id(self, mock_push_ws):
        notif = NotificationService.notify(
            user_id="user-1",
            type="system",
            title="with space",
            metadata={
                "space_id": "space-1",

                "source_extension_id": "ext-1",
            },
            organization_id="ws-a",
        )

        notif.refresh_from_db()

        self.assertEqual(notif.space_id, "space-1")
        self.assertEqual(notif.organization_id, "ws-a")
        mock_push_ws.assert_called_once()

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_notify_normalizes_null_space_metadata_to_empty_space_id(self, mock_push_ws):
        notif = NotificationService.notify(
            user_id="user-1",
            type="resource_shared",
            title="organization-only resource",
            metadata={"space_id": None},
            organization_id="org-1",
        )

        notif.refresh_from_db()

        self.assertEqual(notif.space_id, "")
        self.assertEqual(notif.organization_id, "org-1")
        mock_push_ws.assert_called_once()

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_notify_compacts_long_source_event_id(self, mock_push_ws):
        raw_source_event_id = "system.event:" + ":".join(str(uuid.uuid4()) for _ in range(4))

        notif = NotificationService.notify(
            user_id="user-1",
            type="system",
            title="with long source event",
            metadata={"source_event_id": raw_source_event_id},
            organization_id="ws-a",
        )

        notif.refresh_from_db()

        self.assertLessEqual(len(notif.source_event_id), 100)
        self.assertIn(":sha256:", notif.source_event_id)
        self.assertEqual(notif.metadata["source_event_id"], notif.source_event_id)
        self.assertEqual(notif.metadata["original_source_event_id"], raw_source_event_id)
        mock_push_ws.assert_called_once()

    def test_unread_count_and_list_exclude_im_notifications(self):
        Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="system",
            title="platform",
            is_read=False,
        )
        Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="im.message",
            title="chat",
            is_read=False,
        )

        self.assertEqual(
            NotificationService.get_unread_count("user-1", organization_id="ws-a"),
            1,
        )
        listed = NotificationService.list_notifications(
            "user-1", organization_id="ws-a", page=1, limit=20,
        )
        self.assertEqual(listed["total"], 1)
        self.assertEqual(listed["items"][0]["type"], "system")

    def test_mark_all_read_scopes_to_organization(self):
        ws_a = "ws-a"
        ws_b = "ws-b"

        target = Notification.objects.create(
            user_id="user-1",
            organization_id=ws_a,
            type="system",
            title="A unread",
        )
        untouched_other_ws = Notification.objects.create(
            user_id="user-1",
            organization_id=ws_b,
            type="system",
            title="B unread",
        )
        untouched_other_user = Notification.objects.create(
            user_id="user-2",
            organization_id=ws_a,
            type="system",
            title="Other user unread",
        )

        count = NotificationService.mark_all_read("user-1", organization_id=ws_a)

        target.refresh_from_db()
        untouched_other_ws.refresh_from_db()
        untouched_other_user.refresh_from_db()

        self.assertEqual(count, 1)
        self.assertTrue(target.is_read)
        self.assertFalse(untouched_other_ws.is_read)
        self.assertFalse(untouched_other_user.is_read)

    def test_scoped_inbox_can_include_personal_invitations_without_leaking_other_notifications(self):
        current = Notification.objects.create(
            user_id="user-1", organization_id="ws-a", type="system", title="current",
        )
        invitation = Notification.objects.create(
            user_id="user-1", organization_id="ws-b", type="organization.invitation", title="invite",
        )
        other = Notification.objects.create(
            user_id="user-1", organization_id="ws-b", type="agent.task.completed", title="other",
        )

        listed = NotificationService.list_notifications(
            "user-1", organization_id="ws-a", include_personal_invitations=True,
        )
        self.assertEqual({item["id"] for item in listed["items"]}, {str(current.id), str(invitation.id)})
        self.assertEqual(
            NotificationService.get_unread_count(
                "user-1", organization_id="ws-a", include_personal_invitations=True,
            ),
            2,
        )

        self.assertEqual(
            NotificationService.mark_all_read(
                "user-1", organization_id="ws-a", include_personal_invitations=True,
            ),
            2,
        )
        invitation.refresh_from_db()
        other.refresh_from_db()
        self.assertTrue(invitation.is_read)
        self.assertFalse(other.is_read)

    def test_mark_all_read_without_organization_marks_all_user_notifications(self):
        first = Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="system",
            title="A unread",
        )
        second = Notification.objects.create(
            user_id="user-1",
            organization_id="ws-b",
            type="system",
            title="B unread",
        )

        count = NotificationService.mark_all_read("user-1")

        first.refresh_from_db()
        second.refresh_from_db()

        self.assertEqual(count, 2)
        self.assertTrue(first.is_read)
        self.assertTrue(second.is_read)

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_mark_balance_low_read_for_organization_marks_unread_and_pushes(self, mock_push_ws):
        unread = Notification.objects.create(
            user_id="owner-1",
            organization_id="org-1",
            type="balance_low",
            title="AI 余额偏低预警",
            is_read=False,
        )
        already_read = Notification.objects.create(
            user_id="owner-1",
            organization_id="org-1",
            type="balance_low",
            title="历史已读",
            is_read=True,
        )
        other_org = Notification.objects.create(
            user_id="owner-2",
            organization_id="org-2",
            type="balance_low",
            title="其他组织",
            is_read=False,
        )
        new_account_type = Notification.objects.create(
            user_id="owner-1",
            organization_id="org-1",
            type="account.balance_low",
            title="新账户通知类型",
            is_read=False,
        )

        marked = NotificationService.mark_balance_low_read_for_organization("org-1")

        unread.refresh_from_db()
        already_read.refresh_from_db()
        other_org.refresh_from_db()

        new_account_type.refresh_from_db()
        self.assertEqual(marked, 2)
        self.assertTrue(unread.is_read)
        self.assertIsNotNone(unread.read_at)
        self.assertTrue(already_read.is_read)
        self.assertFalse(other_org.is_read)
        self.assertTrue(new_account_type.is_read)
        self.assertEqual(mock_push_ws.call_count, 2)
        self.assertTrue(all(call.args[0] == "owner-1" for call in mock_push_ws.call_args_list))
        self.assertTrue(all(call.args[1].is_read for call in mock_push_ws.call_args_list))

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_resolve_resource_access_request_updates_every_matching_card(self, mock_push_ws):
        request_id = str(uuid.uuid4())
        originals = [
            Notification.objects.create(
                user_id="owner-1",
                organization_id="org-1",
                type="resource_access_request",
                title="申请查看资源",
                metadata={
                    "request_id": request_id,
                    "behavior": "action_required",
                },
                is_read=False,
            )
            for _ in range(2)
        ]
        unrelated = Notification.objects.create(
            user_id="owner-1",
            organization_id="org-1",
            type="resource_access_request",
            title="另一条申请",
            metadata={
                "request_id": str(uuid.uuid4()),
                "behavior": "action_required",
            },
            is_read=False,
        )

        resolved = NotificationService.resolve_resource_access_request_notification(
            user_id="owner-1",
            request_id=request_id,
            request_status="approved",
        )

        self.assertIn(resolved.id, {notification.id for notification in originals})
        for notification in originals:
            notification.refresh_from_db()
            self.assertTrue(notification.is_read)
            self.assertIsNotNone(notification.read_at)
            self.assertTrue(notification.metadata.get("resolved"))
            self.assertEqual(notification.metadata.get("request_status"), "approved")
            self.assertEqual(notification.metadata.get("behavior"), "notification_only")
        unrelated.refresh_from_db()
        self.assertFalse(unrelated.is_read)
        self.assertEqual(mock_push_ws.call_count, 2)

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_resolve_invitation_notification_upgrades_in_place(self, mock_push_ws):
        invitation_id = str(uuid.uuid4())
        original = Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="organization.invitation",
            title="邀请加入组织「测试」",
            body="某人邀请你加入",
            metadata={"invitation_id": invitation_id, "organization_name": "测试"},
            is_read=False,
        )

        resolved = NotificationService.resolve_invitation_notification(
            user_id="user-1",
            invitation_id=invitation_id,
            type="organization.invitation.sync",
            title="邀请已接受",
            body="你接受了组织「测试」的邀请",
            metadata={"organization_name": "测试", "accepted": True},
            organization_id="ws-a",
        )

        original.refresh_from_db()
        self.assertEqual(resolved.id, original.id)
        self.assertEqual(original.type, "organization.invitation.sync")
        self.assertEqual(original.title, "加入「测试」的邀请已处理")
        self.assertTrue(original.is_read)
        self.assertTrue(original.metadata.get("resolved"))
        self.assertEqual(original.metadata.get("invitation_id"), invitation_id)
        self.assertEqual(Notification.objects.filter(user_id="user-1").count(), 1)
        mock_push_ws.assert_called_once()

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_resolve_invitation_notification_creates_when_missing(self, mock_push_ws):
        invitation_id = str(uuid.uuid4())

        created = NotificationService.resolve_invitation_notification(
            user_id="user-1",
            invitation_id=invitation_id,
            type="organization.invitation.cancelled",
            title="邀请已取消",
            body="组织邀请已被取消",
            metadata={"organization_name": "测试"},
            organization_id="ws-a",
        )

        self.assertEqual(created.type, "organization.invitation.cancelled")
        self.assertTrue(created.is_read)
        self.assertEqual(created.metadata.get("invitation_id"), invitation_id)
        mock_push_ws.assert_called_once()

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_mark_agent_session_terminal_read_scopes_to_user_and_session(self, mock_push_ws):
        session_a = str(uuid.uuid4())
        session_b = str(uuid.uuid4())
        completed = Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="agent.task.completed",
            title="done",
            metadata={"session_id": session_a},
            is_read=False,
        )
        errored = Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="agent.task.error",
            title="err",
            metadata={"session_id": session_a},
            is_read=False,
        )
        interrupted = Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="agent.task.interrupted",
            title="stop",
            metadata={"session_id": session_a},
            is_read=False,
        )
        other_session = Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="agent.task.completed",
            title="other session",
            metadata={"session_id": session_b},
            is_read=False,
        )
        other_user = Notification.objects.create(
            user_id="user-2",
            organization_id="ws-a",
            type="agent.task.completed",
            title="other user",
            metadata={"session_id": session_a},
            is_read=False,
        )
        hitl_waiting = Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="agent.hitl.waiting",
            title="need approval",
            metadata={"session_id": session_a, "interaction_id": str(uuid.uuid4())},
            is_read=False,
        )

        count = NotificationService.mark_agent_session_terminal_read("user-1", session_a)

        completed.refresh_from_db()
        errored.refresh_from_db()
        interrupted.refresh_from_db()
        other_session.refresh_from_db()
        other_user.refresh_from_db()
        hitl_waiting.refresh_from_db()

        self.assertEqual(count, 3)
        self.assertTrue(completed.is_read)
        self.assertTrue(errored.is_read)
        self.assertTrue(interrupted.is_read)
        self.assertIsNotNone(completed.read_at)
        self.assertFalse(other_session.is_read)
        self.assertFalse(other_user.is_read)
        self.assertFalse(hitl_waiting.is_read)
        self.assertEqual(mock_push_ws.call_count, 3)
        pushed_ids = {call.args[1].id for call in mock_push_ws.call_args_list}
        self.assertEqual(pushed_ids, {completed.id, errored.id, interrupted.id})
        for call in mock_push_ws.call_args_list:
            self.assertEqual(call.args[0], "user-1")
            self.assertTrue(call.args[1].is_read)

        # 幂等：再 ack 不重复推送、计数为 0
        mock_push_ws.reset_mock()
        self.assertEqual(
            NotificationService.mark_agent_session_terminal_read("user-1", session_a),
            0,
        )
        mock_push_ws.assert_not_called()

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_mark_agent_hitl_waiting_read_by_interaction_id_fans_out(self, mock_push_ws):
        interaction_id = str(uuid.uuid4())
        other_interaction = str(uuid.uuid4())
        request_key = f"batch-{uuid.uuid4()}"
        n1 = Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="agent.hitl.waiting",
            title="need approval",
            metadata={
                "interaction_id": interaction_id,
                "request_key": request_key,
                "session_id": str(uuid.uuid4()),
            },
            is_read=False,
        )
        n2 = Notification.objects.create(
            user_id="user-2",
            organization_id="ws-a",
            type="agent.hitl.waiting",
            title="need approval",
            metadata={
                "interaction_id": interaction_id,
                "request_key": request_key,
                "session_id": str(uuid.uuid4()),
            },
            is_read=False,
        )
        other = Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="agent.hitl.waiting",
            title="other",
            metadata={
                "interaction_id": other_interaction,
                "request_key": f"other-{uuid.uuid4()}",
            },
            is_read=False,
        )
        terminal = Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="agent.task.completed",
            title="done",
            metadata={"session_id": str(uuid.uuid4())},
            is_read=False,
        )

        count = NotificationService.mark_agent_hitl_waiting_read(
            interaction_id=interaction_id,
            request_key=request_key,
        )

        n1.refresh_from_db()
        n2.refresh_from_db()
        other.refresh_from_db()
        terminal.refresh_from_db()

        self.assertEqual(count, 2)
        self.assertTrue(n1.is_read)
        self.assertTrue(n2.is_read)
        self.assertFalse(other.is_read)
        self.assertFalse(terminal.is_read)
        self.assertEqual(mock_push_ws.call_count, 2)
        pushed = {(call.args[0], call.args[1].id) for call in mock_push_ws.call_args_list}
        self.assertEqual(pushed, {("user-1", n1.id), ("user-2", n2.id)})

        mock_push_ws.reset_mock()
        self.assertEqual(
            NotificationService.mark_agent_hitl_waiting_read(
                interaction_id=interaction_id,
                request_key=request_key,
            ),
            0,
        )
        mock_push_ws.assert_not_called()

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_mark_agent_hitl_waiting_read_falls_back_to_request_key(self, mock_push_ws):
        request_key = f"batch-{uuid.uuid4()}"
        legacy = Notification.objects.create(
            user_id="user-1",
            organization_id="ws-a",
            type="agent.hitl.waiting",
            title="legacy",
            metadata={"request_key": request_key},
            is_read=False,
        )

        count = NotificationService.mark_agent_hitl_waiting_read(
            interaction_id="",
            request_key=request_key,
        )

        legacy.refresh_from_db()
        self.assertEqual(count, 1)
        self.assertTrue(legacy.is_read)
        mock_push_ws.assert_called_once_with("user-1", legacy)

    @patch("apps.services.notification.services.notification_service.NotificationService._push_ws")
    def test_mark_agent_hitl_waiting_read_noop_when_no_rows(self, mock_push_ws):
        count = NotificationService.mark_agent_hitl_waiting_read(
            interaction_id=str(uuid.uuid4()),
            request_key="missing",
        )
        self.assertEqual(count, 0)
        mock_push_ws.assert_not_called()


class NotificationAPITests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.factory = RequestFactory()

    @patch("apps.services.notification.api.NotificationService.mark_all_read", return_value=3)
    @patch("apps.services.notification.api._user_can_access_organization", return_value=True)
    def test_mark_all_read_forwards_organization_scope(self, _mock_access, mock_mark_all_read):
        request = self.factory.post("/notifications/read-all")
        request.auth = _fake_user
        request.GET = QueryDict("organization_id=ws-1")

        resp = mark_all_read(request)

        self.assertTrue(resp["success"])
        mock_mark_all_read.assert_called_once_with(
            str(_fake_user_id),
            organization_id="ws-1",
            include_personal_invitations=False,
            center_only=False,
        )

    @patch("apps.services.notification.api.NotificationService.list_notifications")
    @patch("apps.services.notification.api._user_can_access_organization", return_value=True)
    def test_list_forwards_center_only_contract(self, _mock_access, mock_list):
        mock_list.return_value = {"items": [], "total": 0, "page": 1, "limit": 20}
        request = self.factory.get(
            "/notifications/?organization_id=ws-1&center_only=true&category=account"
        )
        request.auth = _fake_user

        response = list_notifications(request)

        self.assertTrue(response["success"])
        mock_list.assert_called_once_with(
            user_id=str(_fake_user_id),
            organization_id="ws-1",
            page=1,
            limit=20,
            include_personal_invitations=False,
            unread_only=False,
            category="account",
            search="",
            center_only=True,
        )

    @patch("apps.services.notification.api.NotificationService.get_unread_count", return_value=4)
    @patch("apps.services.notification.api._user_can_access_organization", return_value=True)
    def test_unread_count_forwards_center_only_contract(self, _mock_access, mock_count):
        request = self.factory.get(
            "/notifications/unread-count?organization_id=ws-1&center_only=1"
        )
        request.auth = _fake_user

        response = unread_count(request)

        self.assertEqual(response["data"]["count"], 4)
        mock_count.assert_called_once_with(
            str(_fake_user_id),
            organization_id="ws-1",
            include_personal_invitations=False,
            center_only=True,
        )

    @patch("apps.services.notification.api._user_can_access_organization", return_value=False)
    def test_mark_all_read_rejects_inaccessible_organization(self, _mock_access):
        request = self.factory.post("/notifications/read-all")
        request.auth = _fake_user
        request.GET = QueryDict("organization_id=ws-forbidden")

        status_code, payload = mark_all_read(request)

        self.assertEqual(status_code, 403)
        self.assertEqual(payload["code"], "FORBIDDEN")

    @patch(
        "apps.services.notification.api.NotificationService.mark_agent_session_terminal_read",
        return_value=2,
    )
    def test_acknowledge_agent_session_forwards_user_and_session(self, mock_mark):
        session_id = str(uuid.uuid4())
        request = self.factory.post(f"/notifications/agent-sessions/{session_id}/acknowledge")
        request.auth = _fake_user

        resp = acknowledge_agent_session(request, session_id)

        self.assertTrue(resp["success"])
        self.assertEqual(resp["data"]["count"], 2)
        mock_mark.assert_called_once_with(str(_fake_user_id), session_id)

    def test_acknowledge_agent_session_rejects_blank_session_id(self):
        request = self.factory.post("/notifications/agent-sessions/ /acknowledge")
        request.auth = _fake_user

        status_code, payload = acknowledge_agent_session(request, "   ")

        self.assertEqual(status_code, 400)
        self.assertEqual(payload["code"], "INVALID_SESSION")


class AccountNotificationAdapterTests(SimpleTestCase):
    def test_credit_recharge_business_key_uses_transaction_id(self):
        from apps.services.notification.services.account_notification_adapter import (
            _business_key,
        )

        first = _business_key(
            "org-1",
            "credits_recharged",
            {"amount": "25", "transaction_id": "transaction-1"},
        )
        second = _business_key(
            "org-1",
            "credits_recharged",
            {"amount": "25", "transaction_id": "transaction-2"},
        )

        self.assertNotEqual(first, second)
        self.assertTrue(first.endswith(":transaction-1"))
        self.assertTrue(second.endswith(":transaction-2"))

    def test_account_copy_uses_real_amounts_and_safe_fallbacks(self):
        from apps.services.notification.services.notification_copy import (
            format_account_notification_copy,
        )

        self.assertEqual(
            format_account_notification_copy("credits_recharged", {"amount": "1000"}),
            ("点券充值已到账", "本次到账 +1,000 点券。"),
        )
        self.assertEqual(
            format_account_notification_copy("cash_recharged", {"amount_cny": "100"}),
            ("现金充值已到账", "本次到账 +100.00 元。"),
        )
        title, body = format_account_notification_copy(
            "auto_renew_failed",
            {"tier_name": "专业版", "reason": "internal_exception_name"},
        )
        self.assertEqual(title, "专业版自动续费失败")
        self.assertNotIn("internal_exception_name", body)

    def test_account_copy_formats_balance_storage_and_budget_values(self):
        from apps.services.notification.services.notification_copy import (
            format_account_notification_copy,
        )

        self.assertEqual(
            format_account_notification_copy(
                "balance_low",
                {"level": "warning", "current_balance": "500", "threshold": "1000"},
            ),
            ("点券余额不足", "当前可用 500 点券，已低于预警值 1,000 点券。"),
        )
        self.assertEqual(
            format_account_notification_copy(
                "storage_critical",
                {"used_bytes": 98 * 1024 ** 3, "package_bytes": 100 * 1024 ** 3},
            ),
            ("存储空间严重不足", "已使用 98 GB/100 GB，上传和创建资源可能受到限制。"),
        )
        self.assertEqual(
            format_account_notification_copy(
                "member_budget_warning",
                {"consumed": "900", "limit": "1000"},
            ),
            ("你的预算即将用尽", "已使用 900/1,000 点券，剩余 100 点券。"),
        )

    def test_resource_and_organization_copy_match_product_language(self):
        from apps.services.notification.services.notification_copy import (
            format_notification_copy,
        )

        self.assertEqual(
            format_notification_copy(
                "resource_shared",
                "旧标题",
                "旧详情",
                {
                    "action": "permission_changed",
                    "resource_title": "Q3 销售计划",
                    "permission_from": "viewer",
                    "permission_to": "editor",
                },
            ),
            (
                "「Q3 销售计划」的权限已变更",
                "你的权限已由“可查看”调整为“可编辑”。",
            ),
        )
        self.assertEqual(
            format_notification_copy(
                "resource_shared",
                "旧标题",
                "旧详情",
                {
                    "action": "permission_changed",
                    "resource_title": "Q3 销售计划",
                    "permission_from": "editor",
                    "permission_to": "viewer",
                },
            ),
            (
                "「Q3 销售计划」的权限已变更",
                "你的权限已由“可编辑”调整为“可查看”。",
            ),
        )
        self.assertEqual(
            format_notification_copy(
                "organization.invitation",
                "旧标题",
                "旧详情",
                {
                    "organization_name": "TabTin 产品组",
                    "inviter_name": "周扬",
                    "role": "editor",
                },
            ),
            (
                "你收到来自「TabTin 产品组」的邀请",
                "周扬邀请你以“成员”身份加入该组织。",
            ),
        )
        self.assertEqual(
            format_notification_copy(
                "member_added",
                "你已被添加到组织",
                "角色: editor",
                {},
            ),
            ("你已被添加到组织", ""),
        )
        mention_title, mention_body = format_notification_copy(
            "tabdoc.comment.mention",
            "王莉在「产品需求评审」中提到了你",
            "请确认移动端交互方案。" * 20,
            {},
        )
        self.assertEqual(mention_title, "王莉在「产品需求评审」中提到了你")
        self.assertTrue(mention_body.startswith("评论：“请确认移动端交互方案。"))
        self.assertTrue(mention_body.endswith("…”"))
        self.assertLessEqual(len(mention_body), 126)

    def test_target_event_whitelist_matches_account_scope(self):
        from apps.services.notification.services.account_notification_adapter import (
            EVENT_PRESENTATION,
        )

        self.assertEqual(
            set(EVENT_PRESENTATION),
            {
                "balance_low",
                "budget_warning",
                "budget_critical",
                "billing_blocked",
                "degradation_alert",
                "credits_recharged",
                "cash_recharged",
                "membership_expiring",
                "membership_expired",
                "auto_renew_failed",
                "membership_downgraded_overlimit",
                "invoice_refunded",
                "platform_refund_completed",
                "invoice_collection_succeeded",
                "invoice_collection_failed",
                "platform_refund_failed",
                "refund_partial_failure",
                "storage_warning",
                "storage_critical",
                "storage_package_expiring",
                "storage_auto_renew_failed",
                "member_budget_warning",
                "member_budget_exhausted",
            },
        )

    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value={"affected-user"},
    )
    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
    )
    def test_member_budget_notification_targets_only_resolved_affected_member(
        self,
        mock_notify,
        _mock_recipients,
    ):
        from apps.services.notification.services.account_notification_adapter import (
            persist_account_notification,
        )

        count = persist_account_notification(
            "org-1",
            "member_budget_warning",
            {"user_id": "affected-user", "budget_type": "monthly", "usage_percent": 80},
        )

        self.assertEqual(count, 1)
        mock_notify.assert_called_once()
        self.assertEqual(mock_notify.call_args.kwargs["user_id"], "affected-user")
        self.assertEqual(
            mock_notify.call_args.kwargs["metadata"]["behavior"],
            "action_required",
        )

    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value={"owner-user"},
    )
    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
    )
    def test_critical_balance_uses_distinct_copy(self, mock_notify, _mock_recipients):
        from apps.services.notification.services.account_notification_adapter import (
            persist_account_notification,
        )

        persist_account_notification(
            "org-1",
            "balance_low",
            {"level": "critical", "current_balance": "5", "threshold": "10"},
        )

        kwargs = mock_notify.call_args.kwargs
        self.assertEqual(kwargs["title"], "点券余额严重不足")
        self.assertEqual(kwargs["metadata"]["behavior"], "action_required")

    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value={"owner-user"},
    )
    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
    )
    def test_monthly_budget_critical_enters_account_notification_center(
        self,
        mock_notify,
        _mock_recipients,
    ):
        from apps.services.notification.services.account_notification_adapter import (
            persist_account_notification,
        )

        count = persist_account_notification(
            "org-1",
            "budget_critical",
            {"usage_percent": 100, "budget_limit": 1000},
        )

        self.assertEqual(count, 1)
        kwargs = mock_notify.call_args.kwargs
        self.assertEqual(kwargs["type"], "account.budget_critical")
        self.assertEqual(kwargs["metadata"]["category"], "account")
        self.assertEqual(kwargs["metadata"]["behavior"], "action_required")

    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value={"owner-user"},
    )
    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
    )
    def test_successful_collection_is_center_only(self, mock_notify, _mock_recipients):
        from apps.services.notification.services.account_notification_adapter import (
            persist_account_notification,
        )

        persist_account_notification(
            "org-1",
            "invoice_collection_succeeded",
            {"invoice_id": "invoice-1"},
        )

        metadata = mock_notify.call_args.kwargs["metadata"]
        self.assertEqual(metadata["behavior"], "notification_only")
        self.assertEqual(metadata["desktop_delivery"], "never")

    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
    )
    def test_request_level_shortfall_is_not_persisted_as_organization_block(self, mock_notify):
        from apps.services.notification.services.account_notification_adapter import (
            persist_account_notification,
        )

        count = persist_account_notification(
            "org-1",
            "billing_blocked",
            {"block_type": "request_insufficient_credits"},
        )

        self.assertEqual(count, 0)
        mock_notify.assert_not_called()

    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value={"owner-user"},
    )
    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
    )
    def test_projection_authority_covers_representative_account_events(
        self,
        mock_notify,
        _mock_recipients,
    ):
        from apps.services.notification.services.account_notification_adapter import (
            project_account_notification,
        )

        cases = {
            "billing_blocked": {"block_type": "organization_billing_guard"},
            "platform_refund_failed": {"refund_record_id": "refund-1"},
            "credits_recharged": {"order_id": "order-1"},
            "auto_renew_failed": {"subscription_id": "subscription-renew-1"},
            "membership_expiring": {"subscription_id": "subscription-1"},
            "storage_warning": {"level": "warning"},
            "member_budget_exhausted": {
                "user_id": "owner-user",
                "budget_type": "monthly",
            },
        }

        for event_type, payload in cases.items():
            with self.subTest(event_type=event_type):
                mock_notify.reset_mock()
                result = project_account_notification("org-1", event_type, payload)

                self.assertTrue(result.authoritative)
                self.assertTrue(result.projected)
                self.assertEqual(result.recipient_count, 1)
                self.assertTrue(result.source_event_id.startswith(f"account:org-1:{event_type}:"))
                metadata = mock_notify.call_args.kwargs["metadata"]
                self.assertEqual(metadata["presentation_owner"], "notification_projection")
                self.assertEqual(metadata["toast_policy"], "desktop_fallback")

    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value=set(),
    )
    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
    )
    def test_zero_recipients_is_authoritative_but_not_projected(
        self,
        mock_notify,
        _mock_recipients,
    ):
        from apps.services.notification.services.account_notification_adapter import (
            project_account_notification,
        )

        result = project_account_notification(
            "org-1",
            "credits_recharged",
            {"order_id": "order-1"},
        )

        self.assertTrue(result.authoritative)
        self.assertFalse(result.projected)
        self.assertEqual(result.recipient_count, 0)
        self.assertEqual(result.source_event_id, "account:org-1:credits_recharged:order-1")
        mock_notify.assert_not_called()

    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value={"owner-1", "owner-2"},
    )
    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
        side_effect=[MagicMock(), RuntimeError("second recipient failed")],
    )
    def test_partial_projection_raises_instead_of_claiming_success(
        self,
        mock_notify,
        _mock_recipients,
    ):
        from apps.services.notification.services.account_notification_adapter import (
            project_account_notification,
        )

        with self.assertRaisesRegex(RuntimeError, "second recipient failed"):
            project_account_notification(
                "org-1",
                "storage_warning",
                {"level": "warning"},
            )

        self.assertEqual(mock_notify.call_count, 2)

    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value={"owner-user"},
    )
    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
    )
    def test_cash_recharged_keeps_existing_channel_semantics(
        self,
        mock_notify,
        _mock_recipients,
    ):
        from apps.services.notification.services.account_notification_adapter import (
            project_account_notification,
        )

        result = project_account_notification(
            "org-1",
            "cash_recharged",
            {"order_id": "cash-order-1"},
        )

        self.assertFalse(result.authoritative)
        self.assertFalse(result.projected)
        self.assertEqual(result.recipient_count, 1)
        metadata = mock_notify.call_args.kwargs["metadata"]
        self.assertNotIn("presentation_owner", metadata)
        self.assertNotIn("toast_policy", metadata)
        self.assertEqual(metadata["channels"], ["center"])

    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value={"owner-user"},
    )
    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
    )
    def test_same_business_fact_reuses_notification_dedupe_key(
        self,
        mock_notify,
        _mock_recipients,
    ):
        from apps.services.notification.services.account_notification_adapter import (
            project_account_notification,
        )

        first = project_account_notification(
            "org-1",
            "credits_recharged",
            {"order_id": "same-order"},
        )
        second = project_account_notification(
            "org-1",
            "credits_recharged",
            {"order_id": "same-order"},
        )

        self.assertEqual(first.source_event_id, second.source_event_id)
        self.assertEqual(
            mock_notify.call_args_list[0].kwargs["metadata"]["dedupe_key"],
            mock_notify.call_args_list[1].kwargs["metadata"]["dedupe_key"],
        )
        self.assertEqual(first.source_event_id, "account:org-1:credits_recharged:same-order")

    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value={"owner-user"},
    )
    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
    )
    def test_projection_source_event_id_matches_compacted_storage_key(
        self,
        mock_notify,
        _mock_recipients,
    ):
        from apps.services.notification.services.account_notification_adapter import (
            project_account_notification,
        )
        from apps.services.notification.services.notification_service import (
            compact_notification_source_event_id,
        )

        result = project_account_notification(
            "org-1",
            "credits_recharged",
            {"order_id": f'order-{"x" * 160}'},
        )

        metadata = mock_notify.call_args.kwargs["metadata"]
        expected_stored_key, raw_key = compact_notification_source_event_id(
            metadata["dedupe_key"]
        )
        self.assertEqual(result.source_event_id, expected_stored_key)
        self.assertEqual(metadata["source_event_id"], expected_stored_key)
        self.assertEqual(metadata["original_source_event_id"], raw_key)
        self.assertEqual(metadata["dedupe_key"], raw_key)
        self.assertLessEqual(len(result.source_event_id), 100)

    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
    )
    def test_group_b_toast_only_event_is_not_projected(self, mock_notify):
        from apps.services.notification.services.account_notification_adapter import (
            project_account_notification,
        )

        result = project_account_notification("org-1", "billing_unblocked", {})

        self.assertFalse(result.authoritative)
        self.assertFalse(result.projected)
        self.assertEqual(result.recipient_count, 0)
        mock_notify.assert_not_called()


class AccountNotificationAdapterPersistenceTests(TestCase):
    databases = {"default", "postgresql"}

    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value={"owner-user"},
    )
    @patch(
        "apps.services.notification.services.notification_service.NotificationService._push_ws",
    )
    def test_representative_group_a_business_facts_are_each_persisted_once(
        self,
        mock_push_ws,
        _mock_recipients,
    ):
        from apps.services.notification.services.account_notification_adapter import (
            project_account_notification,
        )

        cases = {
            "billing_blocked": {"block_type": "organization_billing_guard"},
            "credits_recharged": {"order_id": "dedupe-order-1"},
            "auto_renew_failed": {"subscription_id": "dedupe-subscription-1"},
            "storage_warning": {"level": "warning"},
            "platform_refund_failed": {"refund_record_id": "dedupe-refund-1"},
            "member_budget_exhausted": {
                "user_id": "owner-user",
                "budget_type": "monthly",
            },
        }

        for event_type, payload in cases.items():
            with self.subTest(event_type=event_type):
                mock_push_ws.reset_mock()
                before_count = Notification.objects.count()

                first = project_account_notification("org-1", event_type, payload)
                first_notification = Notification.objects.get(
                    user_id="owner-user",
                    organization_id="org-1",
                    type=f"account.{event_type}",
                )
                first_dedupe_key = first_notification.dedupe_key
                second = project_account_notification("org-1", event_type, payload)

                notifications = Notification.objects.filter(
                    user_id="owner-user",
                    organization_id="org-1",
                    type=f"account.{event_type}",
                )
                self.assertEqual(Notification.objects.count(), before_count + 1)
                self.assertEqual(notifications.count(), 1)
                self.assertEqual(first, second)
                self.assertEqual(notifications.get().id, first_notification.id)
                self.assertEqual(first_notification.source_event_id, first.source_event_id)
                self.assertTrue(first_dedupe_key)
                self.assertEqual(notifications.get().dedupe_key, first_dedupe_key)
                self.assertTrue(first.projected)
                self.assertTrue(second.projected)
                mock_push_ws.assert_called_once()

    @patch("apps.services.common.ws.bus.publish_ws_event", return_value=True)
    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value=set(),
    )
    def test_zero_recipient_omits_marker_but_billing_ws_still_publishes(
        self,
        _mock_recipients,
        mock_publish_ws,
    ):
        from apps.services.billing.ws_events import publish_billing_event
        from apps.services.notification.services.account_notification_adapter import (
            project_account_notification,
        )

        projection = project_account_notification(
            "org-zero",
            "storage_warning",
            {"level": "warning"},
        )
        self.assertTrue(projection.authoritative)
        self.assertFalse(projection.projected)
        self.assertEqual(projection.recipient_count, 0)

        self.assertTrue(
            publish_billing_event(
                "org-zero",
                "storage_warning",
                {"level": "warning"},
            )
        )

        self.assertFalse(Notification.objects.filter(organization_id="org-zero").exists())
        envelope = mock_publish_ws.call_args.args[1]
        self.assertNotIn("presentation", envelope)
        self.assertEqual(envelope["type"], "billing.storage_warning")

    @patch("apps.services.common.ws.bus.publish_ws_event", return_value=True)
    def test_partial_recipient_failure_persists_first_recipient_without_marker(
        self,
        mock_publish_ws,
    ):
        from apps.services.billing.ws_events import publish_billing_event

        original_notify = NotificationService.notify

        def notify_until_second_recipient(**kwargs):
            if kwargs["user_id"] == "recipient-b":
                raise RuntimeError("recipient-b persistence failed")
            return original_notify(**kwargs)

        with (
            patch(
                "apps.services.notification.services.account_notification_adapter._recipient_ids",
                return_value=["recipient-a", "recipient-b"],
            ),
            patch(
                "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
                side_effect=notify_until_second_recipient,
            ),
            patch(
                "apps.services.notification.services.notification_service.NotificationService._push_ws",
            ) as mock_notification_push,
        ):
            self.assertTrue(
                publish_billing_event(
                    "org-partial",
                    "storage_warning",
                    {"level": "warning"},
                )
            )

        self.assertEqual(
            Notification.objects.filter(
                organization_id="org-partial",
                user_id="recipient-a",
            ).count(),
            1,
        )
        self.assertFalse(
            Notification.objects.filter(
                organization_id="org-partial",
                user_id="recipient-b",
            ).exists()
        )
        mock_notification_push.assert_called_once()
        envelope = mock_publish_ws.call_args.args[1]
        self.assertNotIn("presentation", envelope)
        self.assertEqual(envelope["type"], "billing.storage_warning")

    @patch("apps.services.common.ws.bus.publish_ws_event", return_value=True)
    @patch(
        "apps.services.notification.services.account_notification_adapter._recipient_ids",
        return_value={"owner-user"},
    )
    @patch(
        "apps.services.notification.services.account_notification_adapter.NotificationService.notify",
        side_effect=RuntimeError("notification persistence unavailable"),
    )
    def test_projection_exception_omits_marker_but_billing_ws_still_publishes(
        self,
        _mock_notify,
        _mock_recipients,
        mock_publish_ws,
    ):
        from apps.services.billing.ws_events import publish_billing_event

        self.assertTrue(
            publish_billing_event(
                "org-exception",
                "platform_refund_failed",
                {"refund_record_id": "refund-exception"},
            )
        )

        self.assertFalse(Notification.objects.filter(organization_id="org-exception").exists())
        envelope = mock_publish_ws.call_args.args[1]
        self.assertNotIn("presentation", envelope)
        self.assertEqual(envelope["type"], "billing.platform_refund_failed")
