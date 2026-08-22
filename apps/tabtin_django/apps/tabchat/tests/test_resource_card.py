"""资源卡（metadata.card.type=table|document）后端校验测试（TC-23）。

覆盖 `_validate_card_metadata` 的资源卡契约：
- 跨 organization 分享**不再**被拒（TC-23：卡片是指针，访问控制收口到接收方点开时）；
- 后端以 DB 真实值回填 name/space_id/organization_id（防伪造 + 供接收方跨 organization 跳转）；
- 资源不存在 → ValueError；发送者无 viewer+ 权限 → PermissionError；
- resource_id 缺失/非法 UUID → ValueError。

纯单元（mock 资源 + 权限 + User 查询），不依赖 PG，可在 sqlite/SimpleTestCase 跑。
"""

import os
import sys
from types import SimpleNamespace
from unittest import mock


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
from django.test import SimpleTestCase, TestCase

from apps.tabchat.constants import ConversationType, MemberRole, MessageType
from apps.tabchat.models import Conversation, ConversationMember
from apps.tabchat.services.message_service import _validate_card_metadata

_SENDER = "11111111-1111-1111-1111-111111111111"
_CONV_WT = "22222222-2222-2222-2222-222222222222"   # 会话 organization
_DOC_WT = "33333333-3333-3333-3333-333333333333"    # 资源 organization（故意不同 = 跨团队）
_DOC_ID = "44444444-4444-4444-4444-444444444444"
_DOC_SPACE = "55555555-5555-5555-5555-555555555555"


def _fake_user_model(sender_exists=True):
    """构造一个 get_user_model() 替身：objects.filter(...).first() 返回 sender。"""
    user_cls = mock.MagicMock(name="User")
    sender = object() if sender_exists else None
    user_cls.objects.filter.return_value.first.return_value = sender
    return mock.MagicMock(return_value=user_cls)


def _fake_document(organization_id=_DOC_WT):
    doc = mock.MagicMock(name="Document")
    doc.id = _DOC_ID
    doc.title = "季度预算"
    doc.organization_id = organization_id
    doc.space_id = _DOC_SPACE
    doc.is_private = False
    doc.owner_id = _SENDER
    doc.description_markdown = ""
    doc.description_plaintext = ""
    doc.get_context_preview.return_value = ""
    return doc


def _patch_document(doc, has_permission=True):
    """patch 文档查询 + 权限校验 + User。返回 contextmanagers 的合并 patch。"""
    doc_model = mock.MagicMock(name="DocumentModel")
    doc_model.objects.filter.return_value.first.return_value = doc

    doc_service_cls = mock.MagicMock(name="DocumentService")
    doc_service_cls.return_value.check_document_permission.return_value = has_permission
    doc_service_cls.return_value.compute_user_document_role.return_value = "owner"

    return [
        mock.patch("apps.tabdoc.models.Document", doc_model),
        mock.patch(
            "apps.tabdoc.services.document_service.DocumentService", doc_service_cls
        ),
        mock.patch("django.contrib.auth.get_user_model", _fake_user_model()),
    ]


def _doc_card_metadata():
    return {"card": {"type": "document", "resource_id": _DOC_ID, "name": "客户端伪造名"}}


class ResourceCardValidationTests(SimpleTestCase):
    def _run(self, metadata, patches):
        ctx = []
        try:
            for p in patches:
                ctx.append(p.__enter__())
            return _validate_card_metadata(metadata, _SENDER, _CONV_WT)
        finally:
            for p in reversed(patches):
                p.__exit__(None, None, None)

    def test_cross_organization_document_card_allowed_and_backfilled(self):
        """TC-23：资源 organization ≠ 会话 organization 也放行，并回填真实 organization_id/name。"""
        doc = _fake_document(organization_id=_DOC_WT)  # 跨团队
        doc.description_plaintext = "季度预算正文摘要\n第二段说明"
        doc.get_context_preview.return_value = "季度预算正文摘要"
        result = self._run(_doc_card_metadata(), _patch_document(doc, has_permission=True))
        card = result["card"]
        self.assertEqual(card["type"], "document")
        self.assertEqual(card["resource_id"], _DOC_ID)
        # 跨团队仍回填资源真实 organization_id（供接收方跨 organization 跳转）
        self.assertEqual(card["organization_id"], _DOC_WT)
        self.assertEqual(card["space_id"], _DOC_SPACE)
        # name 以 DB 真实值回填，覆盖客户端伪造
        self.assertEqual(card["name"], "季度预算")
        self.assertEqual(card["description"], "季度预算正文摘要\n第二段说明")
        self.assertEqual(card["hint_carrier_app_id"], "tabdoc")

    def test_same_organization_document_card_allowed(self):
        doc = _fake_document(organization_id=_CONV_WT)  # 同团队
        result = self._run(_doc_card_metadata(), _patch_document(doc, has_permission=True))
        self.assertEqual(result["card"]["organization_id"], _CONV_WT)

    def test_organization_owned_document_keeps_empty_space_id_as_none(self):
        doc = _fake_document(organization_id=_CONV_WT)
        doc.space_id = None
        result = self._run(_doc_card_metadata(), _patch_document(doc, has_permission=True))
        self.assertIsNone(result["card"]["space_id"])

    def test_document_not_found_rejected(self):
        with self.assertRaises(ValueError):
            self._run(_doc_card_metadata(), _patch_document(None, has_permission=True))

    def test_sender_without_permission_rejected(self):
        doc = _fake_document()
        with self.assertRaises(PermissionError):
            self._run(_doc_card_metadata(), _patch_document(doc, has_permission=False))

    def test_missing_resource_id_rejected(self):
        with self.assertRaises(ValueError):
            self._run(
                {"card": {"type": "document"}},
                _patch_document(_fake_document(), has_permission=True),
            )

    def test_invalid_resource_uuid_rejected(self):
        with self.assertRaises(ValueError):
            self._run(
                {"card": {"type": "document", "resource_id": "not-a-uuid"}},
                _patch_document(_fake_document(), has_permission=True),
            )

    # ── resolve_resource_card_preview（按需只读预览，TC-28 polish） ──

    def _run_resolve(self, card_type, resource_id, patches):
        from apps.tabchat.services.message_service import resolve_resource_card_preview
        ctx = []
        try:
            for p in patches:
                ctx.append(p.__enter__())
            return resolve_resource_card_preview(card_type, resource_id, object())
        finally:
            for p in reversed(patches):
                p.__exit__(None, None, None)

    def test_resolve_preview_returns_live_document_content(self):
        doc = _fake_document()
        doc.description_plaintext = "最新正文第一段\n第二段"
        result = self._run_resolve("document", _DOC_ID, _patch_document(doc, has_permission=True))
        self.assertEqual(result["name"], "季度预算")
        self.assertEqual(result["description"], "最新正文第一段\n第二段")
        self.assertIsNone(result["preview_table"])
        self.assertEqual(result["space_id"], _DOC_SPACE)
        self.assertEqual(result["current_user_role"], "owner")

    def test_resolve_preview_prefers_markdown_for_document(self):
        doc = _fake_document()
        doc.description_markdown = "# 关系总览\n\n- 第一点\n- 第二点"
        doc.description_plaintext = "关系总览 第一点 第二点"
        result = self._run_resolve("document", _DOC_ID, _patch_document(doc, has_permission=True))
        self.assertEqual(result["description"], "# 关系总览\n\n- 第一点\n- 第二点")

    def test_resolve_preview_falls_back_to_plaintext_when_markdown_is_html(self):
        doc = _fake_document()
        doc.description_markdown = "<p>关系总览</p><ul><li>第一点</li></ul>"
        doc.description_plaintext = "关系总览\n第一点"
        result = self._run_resolve("document", _DOC_ID, _patch_document(doc, has_permission=True))
        self.assertEqual(result["description"], "关系总览\n第一点")

    def test_resolve_preview_rejects_without_permission(self):
        doc = _fake_document()
        with self.assertRaises(PermissionError):
            self._run_resolve("document", _DOC_ID, _patch_document(doc, has_permission=False))

    def test_resolve_preview_rejects_invalid_uuid(self):
        with self.assertRaises(ValueError):
            self._run_resolve("document", "not-a-uuid", _patch_document(_fake_document(), has_permission=True))

    def test_resolve_preview_rejects_unknown_type(self):
        from apps.tabchat.services.message_service import resolve_resource_card_preview
        with self.assertRaises(ValueError):
            resolve_resource_card_preview("image", _DOC_ID, object())


class ResourceCardAutoGrantTests(SimpleTestCase):
    recipient_id = "66666666-6666-6666-6666-666666666666"

    def _grant_document_card(self, inactive_recipient_ids: list[str]):
        from apps.tabchat.services.message_service import _grant_resource_card_viewer_access

        document = SimpleNamespace(id=_DOC_ID)
        sender = object()
        active_permissions = mock.MagicMock()
        active_permissions.values_list.return_value = []
        inactive_permissions = mock.MagicMock()
        inactive_permissions.values_list.return_value = inactive_recipient_ids

        with (
            mock.patch(
                "apps.tabchat.services.message_service._resource_card_recipient_user_ids",
                return_value=[self.recipient_id],
            ),
            mock.patch("apps.tabchat.services.message_service.User.objects.filter") as user_filter,
            mock.patch("apps.tabdoc.models.Document.objects.filter") as document_filter,
            mock.patch("apps.tabdoc.models.DocumentPermission.objects.filter") as permission_filter,
            mock.patch("apps.tabdoc.services.document_service.DocumentService") as document_service,
            mock.patch("apps.tabdoc.services.share_service.invite_collaborators") as invite,
        ):
            user_filter.return_value.first.return_value = sender
            document_filter.return_value.first.return_value = document
            permission_filter.side_effect = [active_permissions, inactive_permissions]
            document_service.return_value.check_document_permission.return_value = True

            _grant_resource_card_viewer_access(
                {"card": {"type": "document", "resource_id": _DOC_ID}},
                SimpleNamespace(type=ConversationType.DM),
                _SENDER,
            )

        return invite, document, sender

    def test_removed_recipient_is_not_silently_reinvited_by_document_card(self):
        invite, _document, _sender = self._grant_document_card([self.recipient_id])

        invite.assert_not_called()

    def test_new_recipient_receives_viewer_access_from_document_card(self):
        invite, document, sender = self._grant_document_card([])

        invite.assert_called_once_with(
            document.id,
            [self.recipient_id],
            "viewer",
            sender,
            reactivate_inactive=False,
        )

    def _grant_table_card(self, inactive_recipient_ids: list[str]):
        from apps.tabchat.services.message_service import _grant_resource_card_viewer_access

        table = SimpleNamespace(id=_DOC_ID)
        sender = object()
        active_permissions = mock.MagicMock()
        active_permissions.values_list.return_value = []
        inactive_permissions = mock.MagicMock()
        inactive_permissions.values_list.return_value = inactive_recipient_ids
        table_manager = mock.MagicMock()
        table_manager.filter.return_value.first.return_value = table
        permission_manager = mock.MagicMock()
        permission_manager.filter.side_effect = [active_permissions, inactive_permissions]

        with (
            mock.patch(
                "apps.tabchat.services.message_service._resource_card_recipient_user_ids",
                return_value=[self.recipient_id],
            ),
            mock.patch("apps.tabchat.services.message_service.User.objects.filter") as user_filter,
            mock.patch("apps.tabdata.models.Table.objects.using", return_value=table_manager),
            mock.patch(
                "apps.tabdata.models.TablePermission.objects.using",
                return_value=permission_manager,
            ),
            mock.patch("apps.tabdata.services.base.BaseService") as table_service,
            mock.patch("apps.tabdata.services.share_service.invite_collaborators") as invite,
        ):
            user_filter.return_value.first.return_value = sender
            table_service.return_value.check_table_permission.return_value = True

            _grant_resource_card_viewer_access(
                {"card": {"type": "table", "resource_id": _DOC_ID}},
                SimpleNamespace(type=ConversationType.DM),
                _SENDER,
            )

        return invite, table, sender

    def test_removed_recipient_is_not_silently_reinvited_by_table_card(self):
        invite, _table, _sender = self._grant_table_card([self.recipient_id])

        invite.assert_not_called()

    def test_new_recipient_receives_viewer_access_from_table_card(self):
        invite, table, sender = self._grant_table_card([])

        invite.assert_called_once_with(
            table.id,
            [self.recipient_id],
            "viewer",
            sender,
            reactivate_inactive=False,
        )


class ResourceCardMessageGrantTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        from apps.tabtinspace.models import Device, Organization, OrganizationMember, Workspace

        User = get_user_model()
        self.sender = User.objects.create_user(
            username="im_card_sender",
            email="im-card-sender@test.com",
            password="pass123",
        )
        self.recipient = User.objects.create_user(
            username="im_card_recipient",
            email="im-card-recipient@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(name="IM Card Grants", owner=self.sender)
        OrganizationMember.objects.create(organization=self.organization, user=self.sender, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.recipient, role="editor")
        # ：Space 表已 DROP；Document/Table.space_id 语义为 Workspace.id
        device = Device.objects.create(
            organization=self.organization,
            user=self.sender,
            name="im-card-device",
            device_type="electron",
            role="control",
            fingerprint="im-card-grant-fp",
            status="online",
        )
        self.space = Workspace.objects.create(
            organization=self.organization,
            device=device,
            created_by=self.sender,
            name="Sender Space",
            working_dir="/tmp/im-card-grant",
            normalized_working_dir="/tmp/im-card-grant",
            kind=Workspace.Kind.STANDARD,
        )
        self.conversation = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.DM,
            created_by=str(self.sender.id),
            member_count=2,
        )
        ConversationMember.objects.create(
            conversation=self.conversation,
            user_id=str(self.sender.id),
            role=MemberRole.OWNER,
        )
        ConversationMember.objects.create(
            conversation=self.conversation,
            user_id=str(self.recipient.id),
            role=MemberRole.MEMBER,
        )

    def _create_private_document(
        self,
        title: str = "私有云文档",
        *,
        recipient_permission: str | None = "admin",
    ):
        from apps.tabdoc.models import Document, DocumentPermission

        document = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.sender.id,
            title=title,
            description_plaintext="发给好友后应可打开",
            is_private=True,
        )
        DocumentPermission.objects.create(
            document=document,
            subject_type="user",
            subject_id=str(self.sender.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.sender.id),
            created_by=self.sender,
        )
        if recipient_permission:
            DocumentPermission.objects.create(
                document=document,
                subject_type="user",
                subject_id=str(self.recipient.id),
                permission=recipient_permission,
                is_active=False,
                granted_by=str(self.sender.id),
                created_by=self.sender,
            )
        return document

    def test_sending_document_card_does_not_reactivate_removed_recipient(self):
        """被移除的协作者收到 DM 文档卡时不能被静默重新授权。"""
        from apps.tabdoc.models import DocumentPermission
        from apps.tabdoc.services.document_service import DocumentService
        from apps.tabchat.services.message_service import MessageService

        document = self._create_private_document()
        self.assertFalse(
            DocumentService(user=self.recipient).check_document_permission(document, required_role="viewer")
        )

        MessageService.send_message(
            conversation_id=str(self.conversation.id),
            sender_id=str(self.sender.id),
            content="[文档] 私有云文档",
            message_type=MessageType.TEXT,
            metadata={"card": {"type": "document", "resource_id": str(document.id)}},
        )

        self.assertFalse(
            DocumentService(user=self.recipient).check_document_permission(document, required_role="viewer")
        )
        self.assertFalse(
            DocumentPermission.objects.filter(
                document=document,
                subject_type="user",
                subject_id=str(self.recipient.id),
                is_active=True,
            ).exists()
        )

    def test_real_remove_flow_is_not_silently_reinvited_by_document_card(self):
        """真实邀请/移除服务留下的撤权记录也必须阻止 DM 卡片重新授权。"""
        from apps.tabdoc.models import DocumentPermission
        from apps.tabdoc.services.document_service import DocumentService
        from apps.tabdoc.services.share_service import invite_collaborators, remove_collaborator
        from apps.tabchat.services.message_service import MessageService

        document = self._create_private_document(recipient_permission=None)
        invite_collaborators(
            document.id,
            [str(self.recipient.id)],
            "editor",
            self.sender,
        )
        remove_collaborator(document.id, str(self.recipient.id), self.sender)

        self.assertFalse(
            DocumentService(user=self.recipient).check_document_permission(
                document,
                required_role="viewer",
            )
        )

        MessageService.send_message(
            conversation_id=str(self.conversation.id),
            sender_id=str(self.sender.id),
            content="[文档] 真实移除流程",
            message_type=MessageType.TEXT,
            metadata={"card": {"type": "document", "resource_id": str(document.id)}},
        )

        self.assertFalse(
            DocumentPermission.objects.filter(
                document=document,
                subject_type="user",
                subject_id=str(self.recipient.id),
                is_active=True,
            ).exists()
        )

    def test_document_invite_can_refuse_reactivating_removed_recipient(self):
        from apps.tabdoc.models import DocumentPermission
        from apps.tabdoc.services.share_service import invite_collaborators, remove_collaborator

        document = self._create_private_document(recipient_permission=None)
        invite_collaborators(
            document.id,
            [str(self.recipient.id)],
            "editor",
            self.sender,
        )
        remove_collaborator(document.id, str(self.recipient.id), self.sender)

        result = invite_collaborators(
            document.id,
            [str(self.recipient.id)],
            "viewer",
            self.sender,
            reactivate_inactive=False,
        )

        self.assertFalse(
            DocumentPermission.objects.get(
                document=document,
                subject_type="user",
                subject_id=str(self.recipient.id),
            ).is_active
        )
        self.assertEqual(result["notified"], 0)
        self.assertIn(
            {"user_id": str(self.recipient.id), "reason": "previously_removed"},
            result["skipped"],
        )

    def test_table_invite_can_refuse_reactivating_removed_recipient(self):
        from apps.tabdata.models import Table, TablePermission
        from apps.tabdata.services.share_service import invite_collaborators, remove_collaborator

        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.sender.id,
            name="禁止卡片重授的多维表",
        )
        invite_collaborators(
            table.id,
            [str(self.recipient.id)],
            "editor",
            self.sender,
        )
        remove_collaborator(table.id, str(self.recipient.id), self.sender)

        result = invite_collaborators(
            table.id,
            [str(self.recipient.id)],
            "viewer",
            self.sender,
            reactivate_inactive=False,
        )

        self.assertFalse(
            TablePermission.objects.get(
                table=table,
                subject_type="user",
                subject_id=str(self.recipient.id),
            ).is_active
        )
        self.assertEqual(result["notified"], 0)
        self.assertIn(
            {"user_id": str(self.recipient.id), "reason": "previously_removed"},
            result["skipped"],
        )

    def test_sending_document_card_grants_viewer_to_new_recipient(self):
        """此前从未获权的 DM 收件人仍可通过资源卡获得 viewer。"""
        from apps.tabdoc.models import DocumentPermission
        from apps.tabdoc.services.document_service import DocumentService
        from apps.tabchat.services.message_service import MessageService

        document = self._create_private_document(recipient_permission=None)

        MessageService.send_message(
            conversation_id=str(self.conversation.id),
            sender_id=str(self.sender.id),
            content="[文档] 私有云文档",
            message_type=MessageType.TEXT,
            metadata={"card": {"type": "document", "resource_id": str(document.id)}},
        )

        self.assertTrue(
            DocumentService(user=self.recipient).check_document_permission(document, required_role="viewer")
        )
        self.assertEqual(
            DocumentPermission.objects.get(
                document=document,
                subject_type="user",
                subject_id=str(self.recipient.id),
                is_active=True,
            ).permission,
            "viewer",
        )

    def test_dm_card_does_not_emit_invited_notification_after_removal(self):
        """被移除者收到 DM 卡片时不应收到重新分享通知。"""
        from apps.services.notification.models import Notification
        from apps.tabchat.services.message_service import MessageService

        document = self._create_private_document(title="重授权文档")
        with self.captureOnCommitCallbacks(execute=True):
            MessageService.send_message(
                conversation_id=str(self.conversation.id),
                sender_id=str(self.sender.id),
                content="[文档] 重授权文档",
                message_type=MessageType.TEXT,
                metadata={"card": {"type": "document", "resource_id": str(document.id)}},
            )

        invited = Notification.objects.filter(
            user_id=str(self.recipient.id),
            type="resource_shared",
        ).order_by("-created_at")
        self.assertFalse(invited.exists())

    def test_sending_document_card_in_group_does_not_grant_viewer(self):
        """#7987：GROUP 发送资源卡不静默授权，卡片仅作指针。"""
        from apps.tabdoc.models import DocumentPermission
        from apps.tabdoc.services.document_service import DocumentService
        from apps.tabchat.services.message_service import MessageService

        document = self._create_private_document(title="群聊私有文档")
        group = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.GROUP,
            name="资源卡群",
            created_by=str(self.sender.id),
            member_count=2,
        )
        ConversationMember.objects.create(
            conversation=group,
            user_id=str(self.sender.id),
            role=MemberRole.OWNER,
        )
        ConversationMember.objects.create(
            conversation=group,
            user_id=str(self.recipient.id),
            role=MemberRole.MEMBER,
        )
        self.assertFalse(
            DocumentService(user=self.recipient).check_document_permission(document, required_role="viewer")
        )

        MessageService.send_message(
            conversation_id=str(group.id),
            sender_id=str(self.sender.id),
            content="[文档] 群聊私有文档",
            message_type=MessageType.TEXT,
            metadata={"card": {"type": "document", "resource_id": str(document.id)}},
        )

        self.assertFalse(
            DocumentService(user=self.recipient).check_document_permission(document, required_role="viewer")
        )
        self.assertFalse(
            DocumentPermission.objects.filter(
                document=document,
                subject_type="user",
                subject_id=str(self.recipient.id),
                is_active=True,
            ).exists()
        )

    def test_sending_table_card_in_group_does_not_grant_viewer(self):
        """#7987：GROUP 发送表格卡同样不静默授权。"""
        from apps.tabdata.models import Table, TablePermission
        from apps.tabdata.services import TableService
        from apps.tabchat.services.message_service import MessageService

        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.sender.id,
            name="群聊私有表",
        )
        group = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.GROUP,
            name="表格卡群",
            created_by=str(self.sender.id),
            member_count=2,
        )
        ConversationMember.objects.create(
            conversation=group,
            user_id=str(self.sender.id),
            role=MemberRole.OWNER,
        )
        ConversationMember.objects.create(
            conversation=group,
            user_id=str(self.recipient.id),
            role=MemberRole.MEMBER,
        )

        with mock.patch(
            "apps.tabchat.services.message_service._build_table_card_preview_snapshot",
            return_value=None,
        ):
            MessageService.send_message(
                conversation_id=str(group.id),
                sender_id=str(self.sender.id),
                content="[表格] 群聊私有表",
                message_type=MessageType.TEXT,
                metadata={"card": {"type": "table", "resource_id": str(table.id)}},
            )

        self.assertFalse(
            TablePermission.objects.filter(
                table=table,
                subject_type="user",
                subject_id=str(self.recipient.id),
                is_active=True,
            ).exists()
        )
        self.assertFalse(
            TableService(user=self.recipient).check_table_permission(str(table.id), "viewer")
        )

    def test_document_card_keeps_existing_active_permission_when_inactive_history_exists(self):
        from apps.tabdoc.models import Document, DocumentPermission
        from apps.tabchat.services.message_service import MessageService

        document = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.sender.id,
            title="已有协作权限的云文档",
            is_private=True,
        )
        DocumentPermission.objects.create(
            document=document,
            subject_type="user",
            subject_id=str(self.sender.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.sender.id),
            created_by=self.sender,
        )
        DocumentPermission.objects.create(
            document=document,
            subject_type="user",
            subject_id=str(self.recipient.id),
            permission="admin",
            is_active=False,
            granted_by=str(self.sender.id),
            created_by=self.sender,
        )
        DocumentPermission.objects.create(
            document=document,
            subject_type="user",
            subject_id=str(self.recipient.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.sender.id),
            created_by=self.sender,
        )

        MessageService.send_message(
            conversation_id=str(self.conversation.id),
            sender_id=str(self.sender.id),
            content="[文档] 已有协作权限的云文档",
            message_type=MessageType.TEXT,
            metadata={"card": {"type": "document", "resource_id": str(document.id)}},
        )

        active_permissions = DocumentPermission.objects.filter(
            document=document,
            subject_type="user",
            subject_id=str(self.recipient.id),
            is_active=True,
        )
        self.assertEqual(active_permissions.count(), 1)
        self.assertEqual(active_permissions.get().permission, "editor")

    def test_non_manager_sends_document_card_without_granting_access(self):
        """仅有查看权的发送者可以转发卡片，但不能替资源 owner 授权。"""
        from apps.tabdoc.models import DocumentPermission
        from apps.tabchat.services.message_service import MessageService
        from apps.tabtinspace.models import OrganizationMember

        User = get_user_model()
        viewer_sender = User.objects.create_user(
            username="im_card_viewer_sender",
            email="im-card-viewer-sender@test.com",
            password="pass123",
        )
        receiver = User.objects.create_user(
            username="im_card_receiver",
            email="im-card-receiver@test.com",
            password="pass123",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=viewer_sender,
            role="editor",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=receiver,
            role="editor",
        )

        document = self._create_private_document(title="只允许转发的文档")
        DocumentPermission.objects.create(
            document=document,
            subject_type="user",
            subject_id=str(viewer_sender.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.sender.id),
            created_by=self.sender,
        )
        conversation = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.DM,
            created_by=str(viewer_sender.id),
            member_count=2,
        )
        ConversationMember.objects.create(
            conversation=conversation,
            user_id=str(viewer_sender.id),
            role=MemberRole.OWNER,
        )
        ConversationMember.objects.create(
            conversation=conversation,
            user_id=str(receiver.id),
            role=MemberRole.MEMBER,
        )

        MessageService.send_message(
            conversation_id=str(conversation.id),
            sender_id=str(viewer_sender.id),
            content="[文档] 只允许转发的文档",
            message_type=MessageType.TEXT,
            metadata={"card": {"type": "document", "resource_id": str(document.id)}},
        )

        self.assertFalse(
            DocumentPermission.objects.filter(
                document=document,
                subject_type="user",
                subject_id=str(receiver.id),
                is_active=True,
            ).exists()
        )

    def test_sending_table_card_does_not_reactivate_removed_recipient(self):
        """表格同样不得因 DM 卡片静默恢复被移除者的权限。"""
        from apps.tabdata.models import Table, TablePermission
        from apps.tabdata.services import TableService
        from apps.tabchat.services.message_service import MessageService, resolve_resource_card_preview

        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.sender.id,
            name="私有多维表",
        )
        TablePermission.objects.create(
            table=table,
            subject_type="user",
            subject_id=str(self.recipient.id),
            permission="editor",
            is_active=False,
            granted_by=str(self.sender.id),
        )
        self.assertFalse(
            TableService(user=self.recipient).check_table_permission(str(table.id), "viewer")
        )

        from apps.services.notification.models import Notification

        with mock.patch(
            "apps.tabchat.services.message_service._build_table_card_preview_snapshot",
            return_value=None,
        ):
            with self.captureOnCommitCallbacks(execute=True):
                MessageService.send_message(
                    conversation_id=str(self.conversation.id),
                    sender_id=str(self.sender.id),
                    content="[表格] 私有多维表",
                    message_type=MessageType.TEXT,
                    metadata={"card": {"type": "table", "resource_id": str(table.id)}},
                )

        self.assertFalse(
            TableService(user=self.recipient).check_table_permission(str(table.id), "viewer")
        )
        invited = (
            Notification.objects.filter(
                user_id=str(self.recipient.id),
                type="resource_shared",
            )
            .order_by("-created_at")
            .first()
        )
        self.assertIsNone(invited)
        self.assertFalse(
            TablePermission.objects.filter(
                table=table,
                subject_type="user",
                subject_id=str(self.recipient.id),
                is_active=True,
            ).exists()
        )
