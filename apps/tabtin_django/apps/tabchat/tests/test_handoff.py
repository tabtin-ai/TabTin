"""IM 上下文交接（handoff）后端测试。

对真 PG 跑：USE_SQLITE_FOR_TESTS=0 python -m pytest <path> -p no:cacheprovider
覆盖：创建/发送、接收者校验、状态机、材料鉴权占位、撤销、卡片防伪造。
"""

import os
import sys


def _ensure_django():
    django_root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, os.pardir)
    )
    if django_root not in sys.path:
        sys.path.insert(0, django_root)
    if "DJANGO_SETTINGS_MODULE" not in os.environ:
        os.environ["DJANGO_SETTINGS_MODULE"] = "tabtin.settings"
    import django
    from django.apps import apps
    if not apps.ready:
        django.setup()


_ensure_django()

from django.contrib.auth import get_user_model
from django.test import TestCase
from unittest.mock import patch

from apps.tabchat.handoff.models import (
    HandoffEvent,
    HandoffPackage,
    HandoffRecipient,
)
from apps.tabchat.handoff.service import HandoffService
from apps.tabchat.models import IMEventOutbox, Message
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type="free",
        defaults={
            "name": "免费版",
            "description": "handoff tests bootstrap",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
    )


class HandoffTestBase(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.alice = User.objects.create_user(
            username="ho_alice", email="ho_alice@test.com", password="pass123", nickname="Alice",
        )
        self.bob = User.objects.create_user(
            username="ho_bob", email="ho_bob@test.com", password="pass123", nickname="Bob",
        )
        self.carol = User.objects.create_user(
            username="ho_carol", email="ho_carol@test.com", password="pass123", nickname="Carol",
        )
        self.outsider = User.objects.create_user(
            username="ho_out", email="ho_out@test.com", password="pass123", nickname="Out",
        )
        self.organization = Organization.objects.create(name="Handoff Test", owner=self.alice)
        for u, role in [(self.alice, "owner"), (self.bob, "editor"), (self.carol, "editor")]:
            OrganizationMember.objects.create(organization=self.organization, user=u, role=role)
        self.conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.alice.id),
            name="Handoff Group",
            member_ids=[str(self.bob.id), str(self.carol.id)],
        )
        self.ref_msg = MessageService.send_message(
            str(self.conv.id), str(self.alice.id), "竞品分析初稿在这里",
        )

    def _create_and_send(self, **overrides) -> HandoffPackage:
        params = dict(
            conversation_id=str(self.conv.id),
            actor_user_id=str(self.alice.id),
            goal="完成竞品分析报告",
            progress=[{"text": "已收集 5 家竞品数据"}],
            next_steps=[{"text": "补充定价对比", "checked": False}],
            risks=[{"text": "数据来源待确认", "high_risk": True}],
            recipients=[str(self.bob.id)],
            references=[{"ref_type": "im_message", "resource_id": str(self.ref_msg.id)}],
        )
        params.update(overrides)
        package = HandoffService.create_package(**params)
        return HandoffService.send_package(
            package_id=str(package.id), actor_user_id=str(self.alice.id),
        )


class HandoffCreateSendTests(HandoffTestBase):
    def test_django_im_ignores_bearer_header_and_projects_card_locally(self):
        package = self._create_and_send(authorization_header="Bearer mobile-token")

        self.assertEqual(package.conversation_id, self.conv.id)
        self.assertIsNotNone(package.card_message_id)
        self.assertIsNone(package.card_message_ref)

    def test_create_and_send_happy_path(self):
        package = self._create_and_send()
        self.assertEqual(package.status, HandoffPackage.Status.SENT)
        self.assertEqual(package.organization_id, str(self.organization.id))
        self.assertIsNotNone(package.card_message_id)

        card_msg = Message.objects.get(pk=package.card_message_id)
        card = card_msg.metadata["card"]
        self.assertEqual(card["type"], "handoff")
        self.assertEqual(card["handoff_id"], str(package.id))
        self.assertEqual(card["goal"], "完成竞品分析报告")
        self.assertEqual(card["initiator_type"], "user")

        recipient = package.recipients.get()
        self.assertEqual(recipient.user_id, str(self.bob.id))
        self.assertEqual(recipient.state, HandoffRecipient.State.SENT)

        event_types = set(package.events.values_list("event_type", flat=True))
        self.assertEqual(event_types, {"created", "sent"})

        self.assertTrue(
            IMEventOutbox.objects.filter(
                event_type="im.handoff.update",
                conversation=self.conv,
            ).exists()
        )

    def test_send_is_idempotent(self):
        package = self._create_and_send()
        again = HandoffService.send_package(
            package_id=str(package.id), actor_user_id=str(self.alice.id),
        )
        self.assertEqual(again.card_message_id, package.card_message_id)
        self.assertEqual(
            Message.objects.filter(
                conversation=self.conv, metadata__card__handoff_id=str(package.id),
            ).count(),
            1,
        )

    def test_send_handoff_grants_document_viewer_access_to_recipient(self):
        from apps.tabdoc.models import Document, DocumentPermission
        from apps.tabdoc.services.document_service import DocumentService

        document = Document.objects.create(
            organization_id=self.organization.id,
            owner_id=self.alice.id,
            title="交接文档",
            description_plaintext="交接后对方应可直接打开",
            is_private=True,
        )
        DocumentPermission.objects.create(
            document=document,
            subject_type="user",
            subject_id=str(self.alice.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.alice.id),
            created_by=self.alice,
        )
        self.assertFalse(
            DocumentService(user=self.bob).check_document_permission(document, required_role="viewer")
        )

        self._create_and_send(
            references=[{"ref_type": "document", "resource_id": str(document.id)}],
        )

        self.assertTrue(
            DocumentService(user=self.bob).check_document_permission(document, required_role="viewer")
        )
        self.assertEqual(
            DocumentPermission.objects.get(
                document=document,
                subject_type="user",
                subject_id=str(self.bob.id),
                is_active=True,
            ).permission,
            "viewer",
        )

    def test_send_handoff_reactivates_document_permission_without_downgrade(self):
        from apps.tabdoc.models import Document, DocumentPermission

        document = Document.objects.create(
            organization_id=self.organization.id,
            owner_id=self.alice.id,
            title="交接文档",
            description_plaintext="保留既有权限强度",
            is_private=True,
        )
        DocumentPermission.objects.create(
            document=document,
            subject_type="user",
            subject_id=str(self.alice.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.alice.id),
            created_by=self.alice,
        )
        DocumentPermission.objects.create(
            document=document,
            subject_type="user",
            subject_id=str(self.bob.id),
            permission="admin",
            is_active=False,
            granted_by=str(self.alice.id),
            created_by=self.alice,
        )

        self._create_and_send(
            references=[{"ref_type": "document", "resource_id": str(document.id)}],
        )

        self.assertEqual(
            DocumentPermission.objects.get(
                document=document,
                subject_type="user",
                subject_id=str(self.bob.id),
                is_active=True,
            ).permission,
            "admin",
        )

    def test_send_handoff_grants_table_viewer_access_to_recipient(self):
        from apps.tabdata.models import Table, TablePermission
        from apps.tabdata.services import TableService

        table = Table.objects.create(
            organization_id=self.organization.id,
            owner_id=self.alice.id,
            name="交接多维表",
        )
        self.assertFalse(
            TableService(user=self.bob).check_table_permission(str(table.id), "viewer")
        )

        self._create_and_send(
            references=[{"ref_type": "table", "resource_id": str(table.id)}],
        )

        self.assertTrue(
            TableService(user=self.bob).check_table_permission(str(table.id), "viewer")
        )
        self.assertEqual(
            TablePermission.objects.get(
                table=table,
                subject_type="user",
                subject_id=str(self.bob.id),
                is_active=True,
            ).permission,
            "viewer",
        )

    def test_send_handoff_reactivates_table_permission_without_downgrade(self):
        from apps.tabdata.models import Table, TablePermission

        table = Table.objects.create(
            organization_id=self.organization.id,
            owner_id=self.alice.id,
            name="交接多维表",
        )
        TablePermission.objects.create(
            table=table,
            subject_type="user",
            subject_id=str(self.bob.id),
            permission="editor",
            is_active=False,
            granted_by=str(self.alice.id),
        )

        self._create_and_send(
            references=[{"ref_type": "table", "resource_id": str(table.id)}],
        )

        self.assertEqual(
            TablePermission.objects.get(
                table=table,
                subject_type="user",
                subject_id=str(self.bob.id),
                is_active=True,
            ).permission,
            "editor",
        )

    def test_send_handoff_can_retry_after_permission_grant_failure(self):
        from apps.tabdoc.models import Document

        document = Document.objects.create(
            organization_id=self.organization.id,
            owner_id=self.alice.id,
            title="交接文档",
            description_plaintext="首次授权失败后应可重试",
            is_private=True,
        )
        package = HandoffService.create_package(
            conversation_id=str(self.conv.id),
            actor_user_id=str(self.alice.id),
            goal="完成竞品分析报告",
            progress=[{"text": "已收集 5 家竞品数据"}],
            next_steps=[{"text": "补充定价对比", "checked": False}],
            risks=[{"text": "数据来源待确认", "high_risk": True}],
            recipients=[str(self.bob.id)],
            references=[{"ref_type": "document", "resource_id": str(document.id)}],
        )

        with patch(
            "apps.tabchat.handoff.service.HandoffService._broadcast_update",
            side_effect=RuntimeError("send failed"),
        ):
            with self.assertRaisesRegex(RuntimeError, "send failed"):
                HandoffService.send_package(
                    package_id=str(package.id),
                    actor_user_id=str(self.alice.id),
                )

        package.refresh_from_db()
        self.assertEqual(package.status, HandoffPackage.Status.DRAFT)
        self.assertEqual(
            Message.objects.filter(
                conversation=self.conv,
                metadata__card__handoff_id=str(package.id),
                is_deleted=False,
            ).count(),
            0,
        )
        self.assertEqual(
            Message.objects.filter(
                conversation=self.conv,
                metadata__card__handoff_id=str(package.id),
                is_deleted=True,
            ).count(),
            1,
        )
        with self.assertRaisesRegex(PermissionError, "尚未发送"):
            HandoffService.get_package(
                package_id=str(package.id),
                viewer_user_id=str(self.bob.id),
            )
        from apps.tabdoc.models import DocumentPermission

        self.assertFalse(
            DocumentPermission.objects.filter(
                document=document,
                subject_type="user",
                subject_id=str(self.bob.id),
            ).exists()
        )
        draft_payload = HandoffService.get_package(
            package_id=str(package.id),
            viewer_user_id=str(self.alice.id),
        )
        self.assertEqual(draft_payload["status"], HandoffPackage.Status.DRAFT)

        sent = HandoffService.send_package(
            package_id=str(package.id),
            actor_user_id=str(self.alice.id),
        )
        self.assertEqual(sent.status, HandoffPackage.Status.SENT)
        self.assertEqual(
            Message.objects.filter(
                conversation=self.conv,
                metadata__card__handoff_id=str(package.id),
                is_deleted=False,
            ).count(),
            1,
        )

    def test_recipient_must_be_conversation_member(self):
        with self.assertRaisesRegex(ValueError, "会话成员"):
            HandoffService.create_package(
                conversation_id=str(self.conv.id),
                actor_user_id=str(self.alice.id),
                goal="目标",
                recipients=[str(self.outsider.id)],
            )

    def test_cannot_handoff_to_self(self):
        with self.assertRaisesRegex(ValueError, "自己"):
            HandoffService.create_package(
                conversation_id=str(self.conv.id),
                actor_user_id=str(self.alice.id),
                goal="目标",
                recipients=[str(self.alice.id)],
            )

    def test_requires_recipient_and_goal(self):
        with self.assertRaisesRegex(ValueError, "接收者"):
            HandoffService.create_package(
                conversation_id=str(self.conv.id),
                actor_user_id=str(self.alice.id),
                goal="目标",
                recipients=[],
            )
        with self.assertRaisesRegex(ValueError, "目标"):
            HandoffService.create_package(
                conversation_id=str(self.conv.id),
                actor_user_id=str(self.alice.id),
                goal="   ",
                recipients=[str(self.bob.id)],
            )

    def test_non_member_cannot_create(self):
        OrganizationMember.objects.create(
            organization=self.organization, user=self.outsider, role="editor",
        )
        with self.assertRaises(PermissionError):
            HandoffService.create_package(
                conversation_id=str(self.conv.id),
                actor_user_id=str(self.outsider.id),
                goal="目标",
                recipients=[str(self.bob.id)],
            )

    def test_reference_message_must_belong_to_conversation(self):
        other_conv = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.alice.id),
            name="Other",
            member_ids=[str(self.bob.id)],
        )
        other_msg = MessageService.send_message(
            str(other_conv.id), str(self.alice.id), "别的会话的消息",
        )
        with self.assertRaisesRegex(ValueError, "消息不存在"):
            HandoffService.create_package(
                conversation_id=str(self.conv.id),
                actor_user_id=str(self.alice.id),
                goal="目标",
                recipients=[str(self.bob.id)],
                references=[{"ref_type": "im_message", "resource_id": str(other_msg.id)}],
            )


class HandoffStateMachineTests(HandoffTestBase):
    def test_recipient_view_marks_viewed(self):
        package = self._create_and_send()
        data = HandoffService.get_package(
            package_id=str(package.id), viewer_user_id=str(self.bob.id),
        )
        self.assertEqual(data["recipients"][0]["state"], "viewed")
        self.assertTrue(
            package.events.filter(
                event_type=HandoffEvent.EventType.VIEWED,
                actor_user_id=str(self.bob.id),
            ).exists()
        )

    def test_non_recipient_view_does_not_change_state(self):
        package = self._create_and_send()
        HandoffService.get_package(
            package_id=str(package.id), viewer_user_id=str(self.carol.id),
        )
        recipient = package.recipients.get()
        self.assertEqual(recipient.state, HandoffRecipient.State.SENT)

    def test_acknowledge_then_upgrade_to_take_over(self):
        package = self._create_and_send()
        data = HandoffService.act(
            package_id=str(package.id),
            actor_user_id=str(self.bob.id),
            action="acknowledge",
        )
        self.assertEqual(data["recipients"][0]["state"], "acknowledged")
        data = HandoffService.act(
            package_id=str(package.id),
            actor_user_id=str(self.bob.id),
            action="take_over",
            note="我来继续",
        )
        self.assertEqual(data["recipients"][0]["state"], "taking_over")
        self.assertEqual(data["recipients"][0]["note"], "我来继续")

    def test_take_over_is_terminal(self):
        package = self._create_and_send()
        HandoffService.act(
            package_id=str(package.id), actor_user_id=str(self.bob.id), action="take_over",
        )
        with self.assertRaisesRegex(ValueError, "不允许"):
            HandoffService.act(
                package_id=str(package.id), actor_user_id=str(self.bob.id), action="acknowledge",
            )

    def test_reject_with_note(self):
        package = self._create_and_send()
        data = HandoffService.act(
            package_id=str(package.id),
            actor_user_id=str(self.bob.id),
            action="reject",
            note="这周没空",
        )
        self.assertEqual(data["recipients"][0]["state"], "rejected")
        self.assertTrue(
            package.events.filter(event_type=HandoffEvent.EventType.REJECTED).exists()
        )

    def test_outsider_cannot_act(self):
        package = self._create_and_send()
        with self.assertRaisesRegex(PermissionError, "无权查看"):
            HandoffService.act(
                package_id=str(package.id), actor_user_id=str(self.outsider.id), action="take_over",
            )

    def test_action_is_idempotent(self):
        package = self._create_and_send()
        HandoffService.act(
            package_id=str(package.id), actor_user_id=str(self.bob.id), action="acknowledge",
        )
        data = HandoffService.act(
            package_id=str(package.id), actor_user_id=str(self.bob.id), action="acknowledge",
        )
        self.assertEqual(data["recipients"][0]["state"], "acknowledged")
        self.assertEqual(
            package.events.filter(event_type=HandoffEvent.EventType.ACKNOWLEDGED).count(),
            1,
        )


class HandoffAccessTests(HandoffTestBase):
    def test_outsider_cannot_view(self):
        package = self._create_and_send()
        with self.assertRaises(PermissionError):
            HandoffService.get_package(
                package_id=str(package.id), viewer_user_id=str(self.outsider.id),
            )

    def test_deleted_reference_message_shows_denied(self):
        package = self._create_and_send()
        Message.objects.filter(pk=self.ref_msg.id).update(is_deleted=True)
        data = HandoffService.get_package(
            package_id=str(package.id), viewer_user_id=str(self.bob.id),
        )
        ref = data["references"][0]
        self.assertFalse(ref["accessible"])
        self.assertEqual(ref["denied_reason"], "deleted")

    def test_reference_accessible_for_member(self):
        package = self._create_and_send()
        data = HandoffService.get_package(
            package_id=str(package.id), viewer_user_id=str(self.bob.id),
        )
        ref = data["references"][0]
        self.assertTrue(ref["accessible"])
        self.assertEqual(ref["source_link"]["message_id"], self.ref_msg.id)


class HandoffRevokeTests(HandoffTestBase):
    def test_initiator_can_revoke_and_materials_invalidated(self):
        package = self._create_and_send()
        HandoffService.revoke(
            package_id=str(package.id), actor_user_id=str(self.alice.id),
        )
        data = HandoffService.get_package(
            package_id=str(package.id), viewer_user_id=str(self.bob.id),
        )
        self.assertEqual(data["status"], "revoked")
        self.assertFalse(data["references"][0]["accessible"])
        self.assertEqual(data["references"][0]["denied_reason"], "revoked")

    def test_non_initiator_cannot_revoke(self):
        package = self._create_and_send()
        with self.assertRaises(PermissionError):
            HandoffService.revoke(
                package_id=str(package.id), actor_user_id=str(self.bob.id),
            )

    def test_cannot_act_on_revoked(self):
        package = self._create_and_send()
        HandoffService.revoke(
            package_id=str(package.id), actor_user_id=str(self.alice.id),
        )
        with self.assertRaisesRegex(ValueError, "已撤销"):
            HandoffService.act(
                package_id=str(package.id), actor_user_id=str(self.bob.id), action="take_over",
            )


class HandoffCardForgeryTests(HandoffTestBase):
    def test_non_initiator_cannot_send_handoff_card(self):
        package = HandoffService.create_package(
            conversation_id=str(self.conv.id),
            actor_user_id=str(self.alice.id),
            goal="目标",
            recipients=[str(self.bob.id)],
        )
        with self.assertRaisesRegex(PermissionError, "发起人"):
            MessageService.send_message(
                str(self.conv.id),
                str(self.bob.id),
                "[交接] 伪造",
                metadata={"card": {"type": "handoff", "handoff_id": str(package.id)}},
            )

    def test_cannot_resend_card_for_sent_package(self):
        package = self._create_and_send()
        with self.assertRaisesRegex(ValueError, "已发送"):
            MessageService.send_message(
                str(self.conv.id),
                str(self.alice.id),
                "[交接] 重发",
                metadata={"card": {"type": "handoff", "handoff_id": str(package.id)}},
            )

    def test_card_snapshot_is_rebuilt_from_db(self):
        package = HandoffService.create_package(
            conversation_id=str(self.conv.id),
            actor_user_id=str(self.alice.id),
            goal="真实目标",
            recipients=[str(self.bob.id)],
        )
        msg = MessageService.send_message(
            str(self.conv.id),
            str(self.alice.id),
            "[交接] x",
            metadata={"card": {
                "type": "handoff",
                "handoff_id": str(package.id),
                "goal": "伪造的目标",
            }},
        )
        self.assertEqual(msg.metadata["card"]["goal"], "真实目标")


class HandoffChatSessionRefTests(HandoffTestBase):
    """chat_session 快照型材料：转发整段 Agent 会话到 IM 交接。"""

    def _make_session(self, owner, *, title="竞品调研会话"):
        from apps.chat.conversation.models import ChatMessage, ChatSession

        session = ChatSession.objects.create(
            user=owner,
            organization_id=str(self.organization.id),
            title=title,
        )
        # 用户提问
        ChatMessage.objects.create(
            session=session, role="user",
            content_blocks_json=[{"type": "text", "text": "帮我调研 5 家竞品定价"}],
        )
        # AI 回复：含 thinking（应被清洗）+ tool_use（只留标签，丢 input）+ text 正文
        ChatMessage.objects.create(
            session=session, role="assistant",
            content_blocks_json=[
                {"type": "thinking", "thinking": "内心独白：先读一下 /Users/secret/pricing.csv"},
                {"type": "tool_use", "name": "read_file",
                 "input": {"path": "/Users/secret/pricing.csv", "token": "sk-DONOTLEAK"}},
                {"type": "text", "text": "已整理出 5 家竞品的定价对比"},
            ],
        )
        # 环境上下文消息：UI 隐藏，应整条跳过
        ChatMessage.objects.create(
            session=session, role="user", message_kind="environment_context",
            content_blocks_json=[{"type": "text", "text": "<context>cwd=/tmp</context>"}],
        )
        return session

    def test_chat_session_reference_freezes_snapshot(self):
        session = self._make_session(self.alice)
        package = self._create_and_send(
            references=[{"ref_type": "chat_session", "resource_id": str(session.id)}],
        )
        ref = package.references.get()
        self.assertEqual(ref.ref_type, "chat_session")
        snap = ref.frozen_snapshot_json
        self.assertEqual(snap["title"], "竞品调研会话")
        # environment_context 被跳过：只剩 user + assistant 两轮
        self.assertEqual(snap["message_count"], 2)
        self.assertEqual(snap["turns"][0]["text"], "帮我调研 5 家竞品定价")
        self.assertEqual(snap["turns"][1]["text"], "已整理出 5 家竞品的定价对比")

    def test_snapshot_strips_thinking_and_tool_args(self):
        session = self._make_session(self.alice)
        package = self._create_and_send(
            references=[{"ref_type": "chat_session", "resource_id": str(session.id)}],
        )
        blob = str(package.references.get().frozen_snapshot_json)
        # 内心独白与原始工具参数（路径 / 密钥）不得出现在冻结快照里
        self.assertNotIn("内心独白", blob)
        self.assertNotIn("/Users/secret/pricing.csv", blob)
        self.assertNotIn("sk-DONOTLEAK", blob)
        # 工具调用只保留人类标签
        tools = package.references.get().frozen_snapshot_json["turns"][1]["tools"]
        self.assertEqual(tools, [{"name": "read_file", "label": "读取文件"}])

    def test_recipient_reads_frozen_snapshot(self):
        session = self._make_session(self.alice)
        package = self._create_and_send(
            references=[{"ref_type": "chat_session", "resource_id": str(session.id)}],
        )
        data = HandoffService.get_package(
            package_id=str(package.id), viewer_user_id=str(self.bob.id),
        )
        ref = data["references"][0]
        self.assertEqual(ref["ref_type"], "chat_session")
        self.assertTrue(ref["accessible"])  # 快照型不回源，直接可读
        self.assertEqual(ref["frozen_snapshot"]["message_count"], 2)

    def test_cannot_forward_others_session(self):
        # bob 的个人会话，alice 无权把它塞进交接包
        others_session = self._make_session(self.bob, title="别人的会话")
        with self.assertRaisesRegex(ValueError, "无权"):
            HandoffService.create_package(
                conversation_id=str(self.conv.id),
                actor_user_id=str(self.alice.id),
                goal="目标",
                recipients=[str(self.bob.id)],
                references=[{"ref_type": "chat_session", "resource_id": str(others_session.id)}],
            )

    def _make_session_with_attachment(self, owner):
        from apps.chat.conversation.models import ChatMessage, ChatSession

        session = ChatSession.objects.create(
            user=owner,
            organization_id=str(self.organization.id),
            title="查看附件内容",
        )
        ChatMessage.objects.create(
            session=session, role="user",
            content_blocks_json=[
                {"type": "text", "text": "看下这个附件"},
                {"type": "file", "file_id": "76090ee0-851e-4319-8e26-ecf176b89d61",
                 "filename": "202605.00197v1.pdf", "mime_type": "application/pdf",
                 "size": 243814,
                 "url": "http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.pdf"},
            ],
        )
        ChatMessage.objects.create(
            session=session, role="assistant",
            content_blocks_json=[{"type": "text", "text": "论文核心命题是……"}],
        )
        return session

    def test_snapshot_keeps_structured_attachment_reference(self):
        session = self._make_session_with_attachment(self.alice)
        package = self._create_and_send(
            references=[{"ref_type": "chat_session", "resource_id": str(session.id)}],
        )
        atts = package.references.get().frozen_snapshot_json["turns"][0]["attachments"]
        self.assertEqual(len(atts), 1)
        self.assertEqual(atts[0]["type"], "file")
        self.assertEqual(atts[0]["filename"], "202605.00197v1.pdf")
        self.assertEqual(atts[0]["file_id"], "76090ee0-851e-4319-8e26-ecf176b89d61")

    def test_full_transcript_enriches_attachment_with_parsed_content(self):
        """被交接人拉完整快照时，file 附件按交接授权回填 DocParse 解析文本。"""
        from unittest.mock import patch

        session = self._make_session_with_attachment(self.alice)
        package = self._create_and_send(
            references=[{"ref_type": "chat_session", "resource_id": str(session.id)}],
        )
        with patch(
            "apps.services.docparse.service.DocParseService.get_summary",
            return_value="这篇论文围绕法律人工智能与律师职业的融合发展……",
        ) as mock_summary:
            data = HandoffService.get_full_transcript(
                package_id=str(package.id), viewer_user_id=str(self.bob.id),
            )
        mock_summary.assert_called_once_with("76090ee0-851e-4319-8e26-ecf176b89d61")
        att = data["turns"][0]["attachments"][0]
        self.assertEqual(att["parsed_content"], "这篇论文围绕法律人工智能与律师职业的融合发展……")
        # 存储的冻结快照本身不被污染（内容只在响应里回填）
        stored = package.references.get().frozen_snapshot_json
        self.assertNotIn("parsed_content", stored["turns"][0]["attachments"][0])

    def test_full_transcript_attachment_enrich_failure_degrades_gracefully(self):
        from unittest.mock import patch

        session = self._make_session_with_attachment(self.alice)
        package = self._create_and_send(
            references=[{"ref_type": "chat_session", "resource_id": str(session.id)}],
        )
        with patch(
            "apps.services.docparse.service.DocParseService.get_summary",
            side_effect=RuntimeError("docparse down"),
        ):
            data = HandoffService.get_full_transcript(
                package_id=str(package.id), viewer_user_id=str(self.bob.id),
            )
        att = data["turns"][0]["attachments"][0]
        self.assertEqual(att["parsed_content"], "")
        self.assertEqual(att["filename"], "202605.00197v1.pdf")

    def test_revoked_chat_session_snapshot_hidden(self):
        session = self._make_session(self.alice)
        package = self._create_and_send(
            references=[{"ref_type": "chat_session", "resource_id": str(session.id)}],
        )
        HandoffService.revoke(
            package_id=str(package.id), actor_user_id=str(self.alice.id),
        )
        data = HandoffService.get_package(
            package_id=str(package.id), viewer_user_id=str(self.bob.id),
        )
        ref = data["references"][0]
        self.assertFalse(ref["accessible"])
        self.assertEqual(ref["denied_reason"], "revoked")


class HandoffListTests(HandoffTestBase):
    def test_list_excludes_drafts(self):
        sent = self._create_and_send()
        HandoffService.create_package(
            conversation_id=str(self.conv.id),
            actor_user_id=str(self.alice.id),
            goal="草稿包",
            recipients=[str(self.bob.id)],
        )
        items = HandoffService.list_packages(
            conversation_id=str(self.conv.id), viewer_user_id=str(self.bob.id),
        )
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], str(sent.id))
