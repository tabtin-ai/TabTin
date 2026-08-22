"""ResourceAccessRequest 创建 / 批准 API 测试。

对真 PG 跑：
USE_SQLITE_FOR_TESTS=0 python manage.py test apps.tabchat.tests.test_resource_access_request

覆盖：
- 群聊、私信资源卡都可创建申请
- 创建申请幂等（同资源同申请人仅一个 pending）
- 非会话成员拒绝创建
- 非 owner 拒绝批准
- 并发批准仅一人成功、二次调用幂等
- 资源失效（进回收站）批准失败并标记 superseded
- 创建成功后发 resource_access_request 通知（正文使用规范化权限文案）
"""

from __future__ import annotations

import os
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
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
from django.db import close_old_connections
from django.test import TestCase, TransactionTestCase
from django.utils import timezone

from apps.services.notification.models import Notification
from apps.tabchat.constants import ConversationType, MemberRole, MessageType
from apps.tabchat.models import Conversation, ConversationMember, Message, ResourceAccessRequest
from apps.services.common.resource_access.api import (
    CreateResourceAccessRequest,
    approve_resource_access_request,
    create_resource_access_request,
)
from apps.services.common.resource_access.service import (
    ResourceAccessRequestError,
    ResourceAccessRequestService,
)
from apps.tabdoc.models import Document, DocumentPermission
from apps.tabdoc.services.document_service import DocumentService
from apps.tabtinspace.models import Device, Organization, OrganizationMember, Workspace

User = get_user_model()


def _make_workspace(organization, user, name="RAR Workspace", fingerprint=None):
    fp = fingerprint or f"rar-{organization.id}-{user.id}"
    device = Device.objects.create(
        organization=organization,
        user=user,
        name=f"{name} Device",
        device_type="electron",
        role="control",
        fingerprint=fp,
        status="online",
    )
    return Workspace.objects.create(
        organization=organization,
        device=device,
        created_by=user,
        name=name,
        working_dir=f"/tmp/{fp}",
        normalized_working_dir=f"/tmp/{fp}",
        kind=Workspace.Kind.STANDARD,
    )


class ResourceAccessRequestTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        self.owner = User.objects.create_user(
            username="rar_owner",
            email="rar-owner@test.com",
            password="pass123",
            nickname="Owner",
        )
        self.member = User.objects.create_user(
            username="rar_member",
            email="rar-member@test.com",
            password="pass123",
            nickname="Member",
        )
        self.outsider = User.objects.create_user(
            username="rar_outsider",
            email="rar-outsider@test.com",
            password="pass123",
            nickname="Outsider",
        )
        self.organization = Organization.objects.create(
            name="RAR Org",
            owner=self.owner,
        )
        for u, role in [
            (self.owner, "owner"),
            (self.member, "editor"),
            (self.outsider, "editor"),
        ]:
            OrganizationMember.objects.create(
                organization=self.organization,
                user=u,
                role=role,
            )
        self.workspace = _make_workspace(self.organization, self.owner)
        self.group = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.GROUP,
            name="产品群",
            created_by=str(self.owner.id),
            member_count=2,
        )
        ConversationMember.objects.create(
            conversation=self.group,
            user_id=str(self.owner.id),
            role=MemberRole.OWNER,
        )
        ConversationMember.objects.create(
            conversation=self.group,
            user_id=str(self.member.id),
            role=MemberRole.MEMBER,
        )
        self.document = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.workspace.id,
            owner_id=self.owner.id,
            title="私有预算表",
            description_plaintext="仅 owner 可读",
            is_private=True,
        )
        DocumentPermission.objects.create(
            document=self.document,
            subject_type="user",
            subject_id=str(self.owner.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        self.message = Message.objects.create(
            conversation=self.group,
            sender_id=str(self.owner.id),
            seq=1,
            content="[文档] 私有预算表",
            message_type=MessageType.TEXT,
            metadata={
                "card": {
                    "type": "document",
                    "resource_id": str(self.document.id),
                    "name": "私有预算表",
                }
            },
        )
        self.group.latest_message_seq = 1
        self.group.save(update_fields=["latest_message_seq"])

    def _create_payload(self, **overrides) -> CreateResourceAccessRequest:
        data = dict(
            source_conversation_id=str(self.group.id),
            source_message_id=self.message.id,
            resource_type="document",
            resource_id=str(self.document.id),
        )
        data.update(overrides)
        return CreateResourceAccessRequest(**data)

    def _api_request(self, user, authorization=""):
        return SimpleNamespace(
            auth=user,
            META={"HTTP_AUTHORIZATION": authorization},
        )

    def test_create_request_idempotent_and_notifies_owner(self):
        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            first = ResourceAccessRequestService.create_request(
                requester=self.member,
                source_conversation_id=str(self.group.id),
                source_message_id=self.message.id,
                resource_type="document",
                resource_id=str(self.document.id),
            )
            second = ResourceAccessRequestService.create_request(
                requester=self.member,
                source_conversation_id=str(self.group.id),
                source_message_id=self.message.id,
                resource_type="document",
                resource_id=str(self.document.id),
            )

        self.assertEqual(first["id"], second["id"])
        self.assertEqual(first["status"], "pending")
        self.assertEqual(first["role"], "viewer")
        self.assertEqual(
            ResourceAccessRequest.objects.filter(
                resource_type="document",
                resource_id=self.document.id,
                requester_id=str(self.member.id),
                status="pending",
            ).count(),
            1,
        )
        notif = Notification.objects.get(
            user_id=str(self.owner.id),
            type="resource_access_request",
        )
        self.assertIn("申请“可查看”权限", notif.body)
        self.assertEqual(notif.metadata.get("request_id"), first["id"])
        self.assertEqual(notif.metadata.get("role"), "viewer")

    def test_create_request_from_dm_resource_card(self):
        """被撤权用户可以从旧私信卡片向资源 owner 申请 viewer。"""
        dm = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.DM,
            created_by=str(self.owner.id),
            member_count=2,
        )
        ConversationMember.objects.create(
            conversation=dm,
            user_id=str(self.owner.id),
            role=MemberRole.OWNER,
        )
        ConversationMember.objects.create(
            conversation=dm,
            user_id=str(self.member.id),
            role=MemberRole.MEMBER,
        )
        message = Message.objects.create(
            conversation=dm,
            sender_id=str(self.owner.id),
            seq=1,
            content="[文档] 私有预算表",
            message_type=MessageType.TEXT,
            metadata={
                "card": {
                    "type": "document",
                    "resource_id": str(self.document.id),
                    "name": "私有预算表",
                }
            },
        )

        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            created = ResourceAccessRequestService.create_request(
                requester=self.member,
                source_conversation_id=str(dm.id),
                source_message_id=message.id,
                resource_type="document",
                resource_id=str(self.document.id),
            )

        self.assertEqual(created["status"], "pending")
        self.assertEqual(created["source_conversation_id"], str(dm.id))

    def test_create_request_from_tencent_native_resource_card(self):
        """腾讯消息无需本地 Message 行，稳定 message_ref 只记录来源。"""
        source_message_ref = str(uuid.uuid4())

        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            created = ResourceAccessRequestService.create_request(
                requester=self.member,
                source_conversation_id=str(self.group.id),
                # 腾讯消息 id=会话 seq；这个数字不是 Django Message.id。
                source_message_id=6,
                source_message_ref=source_message_ref,
                resource_type="document",
                resource_id=str(self.document.id),
            )

        self.assertEqual(created["status"], "pending")
        self.assertEqual(created["source_message_id"], 6)
        self.assertEqual(created["source_message_ref"], source_message_ref)

    def test_create_request_does_not_validate_numeric_message_id(self):
        """旧客户端只传供应商消息序号时，不查询或要求 Django Message 行。"""
        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            created = ResourceAccessRequestService.create_request(
                requester=self.member,
                source_conversation_id=str(self.group.id),
                source_message_id=987654321,
                resource_type="document",
                resource_id=str(self.document.id),
            )

        self.assertEqual(created["status"], "pending")
        self.assertEqual(created["source_message_id"], 987654321)
        self.assertIsNone(created["source_message_ref"])

    def test_non_member_cannot_create(self):
        with self.assertRaises(ResourceAccessRequestError) as ctx:
            ResourceAccessRequestService.create_request(
                requester=self.outsider,
                source_conversation_id=str(self.group.id),
                source_message_id=self.message.id,
                resource_type="document",
                resource_id=str(self.document.id),
            )
        self.assertEqual(ctx.exception.code, "NOT_CONVERSATION_MEMBER")
        self.assertEqual(ctx.exception.status, 403)

    def test_non_owner_cannot_approve(self):
        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            created = ResourceAccessRequestService.create_request(
                requester=self.member,
                source_conversation_id=str(self.group.id),
                source_message_id=self.message.id,
                resource_type="document",
                resource_id=str(self.document.id),
            )
        with self.assertRaises(ResourceAccessRequestError) as ctx:
            ResourceAccessRequestService.approve_request(
                actor=self.member,
                request_id=created["id"],
            )
        self.assertEqual(ctx.exception.code, "NOT_RESOURCE_OWNER")
        self.assertEqual(ctx.exception.status, 403)

    def test_approve_grants_viewer_and_is_idempotent(self):
        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            created = ResourceAccessRequestService.create_request(
                requester=self.member,
                source_conversation_id=str(self.group.id),
                source_message_id=self.message.id,
                resource_type="document",
                resource_id=str(self.document.id),
            )
        self.assertFalse(
            DocumentService(user=self.member).check_document_permission(
                self.document, required_role="viewer"
            )
        )

        with self.captureOnCommitCallbacks(execute=True), mock.patch(
            "apps.tabdoc.services.share_service._schedule_notify"
        ), mock.patch(
            "apps.tabdoc.services.share_service._schedule_document_collab_revoke"
        ), mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            approved = ResourceAccessRequestService.approve_request(
                actor=self.owner,
                request_id=created["id"],
            )
            again = ResourceAccessRequestService.approve_request(
                actor=self.owner,
                request_id=created["id"],
            )

        self.assertEqual(approved["status"], "approved")
        self.assertEqual(again["status"], "approved")
        self.assertEqual(approved["id"], again["id"])
        self.assertTrue(
            DocumentService(user=self.member).check_document_permission(
                self.document, required_role="viewer"
            )
        )
        notification = Notification.objects.get(
            user_id=str(self.owner.id),
            type="resource_access_request",
            metadata__request_id=created["id"],
        )
        self.assertTrue(notification.is_read)
        self.assertTrue(notification.metadata.get("resolved"))
        self.assertEqual(notification.metadata.get("request_status"), "approved")
        self.assertEqual(notification.metadata.get("behavior"), "notification_only")

    def test_approve_marks_superseded_when_resource_trashed(self):
        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            created = ResourceAccessRequestService.create_request(
                requester=self.member,
                source_conversation_id=str(self.group.id),
                source_message_id=self.message.id,
                resource_type="document",
                resource_id=str(self.document.id),
            )
        self.document.trashed_at = timezone.now()
        self.document.save(update_fields=["trashed_at"])

        with self.assertRaises(ResourceAccessRequestError) as ctx:
            ResourceAccessRequestService.approve_request(
                actor=self.owner,
                request_id=created["id"],
            )
        self.assertEqual(ctx.exception.code, "RESOURCE_NOT_FOUND")
        req = ResourceAccessRequest.objects.get(id=created["id"])
        self.assertEqual(req.status, ResourceAccessRequest.Status.SUPERSEDED)

    def test_api_create_and_approve_happy_path(self):
        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ), mock.patch(
            "apps.tabdoc.services.share_service._schedule_notify"
        ), mock.patch(
            "apps.tabdoc.services.share_service._schedule_document_collab_revoke"
        ):
            create_resp = create_resource_access_request(
                self._api_request(self.member),
                self._create_payload(),
            )
            self.assertTrue(create_resp.success)
            request_id = create_resp.data["id"]

            approve_resp = approve_resource_access_request(
                self._api_request(self.owner),
                request_id,
            )
            self.assertTrue(approve_resp.success)
            self.assertEqual(approve_resp.data["status"], "approved")

        self.assertTrue(
            DocumentService(user=self.member).check_document_permission(
                self.document, required_role="viewer"
            )
        )

    def test_notification_type_choice_registered(self):
        self.assertIn(
            ("resource_access_request", "资源访问申请"),
            Notification.TYPE_CHOICES,
        )

    def test_toolbar_request_editor_without_source(self):
        """已有 viewer 可从工具栏无会话来源申请 editor。"""
        DocumentPermission.objects.create(
            document=self.document,
            subject_type="user",
            subject_id=str(self.member.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )

        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            created = ResourceAccessRequestService.create_request(
                requester=self.member,
                resource_type="document",
                resource_id=str(self.document.id),
                role="editor",
            )

        self.assertEqual(created["status"], "pending")
        self.assertEqual(created["role"], "editor")
        self.assertEqual(created["source_conversation_id"], "")
        notif = Notification.objects.get(
            user_id=str(self.owner.id),
            type="resource_access_request",
        )
        self.assertIn("申请“可编辑”权限", notif.body)
        self.assertEqual(notif.metadata.get("role"), "editor")

        with mock.patch(
            "apps.tabdoc.services.share_service._schedule_notify"
        ), mock.patch(
            "apps.tabdoc.services.share_service._schedule_document_collab_revoke"
        ):
            approved = ResourceAccessRequestService.approve_request(
                actor=self.owner,
                request_id=created["id"],
            )

        self.assertEqual(approved["status"], "approved")
        self.assertEqual(approved["role"], "editor")
        self.assertTrue(
            DocumentService(user=self.member).check_document_permission(
                self.document, required_role="editor"
            )
        )

    def test_toolbar_request_editor_requires_viewer(self):
        with self.assertRaises(ResourceAccessRequestError) as ctx:
            ResourceAccessRequestService.create_request(
                requester=self.member,
                resource_type="document",
                resource_id=str(self.document.id),
                role="editor",
            )
        self.assertEqual(ctx.exception.code, "VIEWER_REQUIRED")
        self.assertEqual(ctx.exception.status, 403)

    def test_permission_denied_surface_requests_viewer_and_can_upgrade_to_editor(self):
        """无权空状态可直接申请查看，并沿同一 pending 升级为编辑。"""
        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            viewer_request = ResourceAccessRequestService.create_request(
                requester=self.member,
                resource_type="document",
                resource_id=str(self.document.id),
                role="viewer",
                source_surface="permission_denied",
            )
            editor_request = ResourceAccessRequestService.create_request(
                requester=self.member,
                resource_type="document",
                resource_id=str(self.document.id),
                role="editor",
                source_surface="permission_denied",
            )

        self.assertEqual(viewer_request["id"], editor_request["id"])
        self.assertEqual(viewer_request["role"], "viewer")
        self.assertEqual(editor_request["role"], "editor")
        self.assertEqual(editor_request["source_conversation_id"], "")

    def test_permission_denied_surface_requires_resource_organization_membership(self):
        OrganizationMember.objects.filter(
            organization=self.organization,
            user=self.member,
        ).delete()

        with self.assertRaises(ResourceAccessRequestError) as ctx:
            ResourceAccessRequestService.create_request(
                requester=self.member,
                resource_type="document",
                resource_id=str(self.document.id),
                role="viewer",
                source_surface="permission_denied",
            )

        self.assertEqual(ctx.exception.code, "NOT_ORGANIZATION_MEMBER")
        self.assertEqual(ctx.exception.status, 403)

    def test_approve_supersedes_request_when_requester_left_organization(self):
        """申请后离队时，批准不能假成功，也不能重新授予资源权限。"""
        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            created = ResourceAccessRequestService.create_request(
                requester=self.member,
                resource_type="document",
                resource_id=str(self.document.id),
                role="viewer",
                source_surface="permission_denied",
            )

        OrganizationMember.objects.filter(
            organization=self.organization,
            user=self.member,
        ).delete()

        with self.assertRaises(ResourceAccessRequestError) as ctx:
            ResourceAccessRequestService.approve_request(
                actor=self.owner,
                request_id=created["id"],
            )

        self.assertEqual(ctx.exception.code, "NOT_ORGANIZATION_MEMBER")
        self.assertEqual(ctx.exception.status, 403)
        req = ResourceAccessRequest.objects.get(id=created["id"])
        self.assertEqual(req.status, ResourceAccessRequest.Status.SUPERSEDED)
        self.assertFalse(
            DocumentService(user=self.member).check_document_permission(
                self.document, required_role="viewer"
            )
        )

    def test_pending_viewer_upgrades_to_editor(self):
        """同资源同人仅一条 pending：viewer pending 可升格为 editor。"""
        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            viewer_req = ResourceAccessRequestService.create_request(
                requester=self.member,
                source_conversation_id=str(self.group.id),
                source_message_id=self.message.id,
                resource_type="document",
                resource_id=str(self.document.id),
            )
            upgraded = ResourceAccessRequestService.create_request(
                requester=self.member,
                source_conversation_id=str(self.group.id),
                source_message_id=self.message.id,
                resource_type="document",
                resource_id=str(self.document.id),
                role="editor",
            )

        self.assertEqual(viewer_req["id"], upgraded["id"])
        self.assertEqual(viewer_req["role"], "viewer")
        self.assertEqual(upgraded["role"], "editor")
        req = ResourceAccessRequest.objects.get(id=viewer_req["id"])
        self.assertEqual(req.role, "editor")
        self.assertEqual(req.status, "pending")
        self.assertEqual(
            Notification.objects.filter(
                user_id=str(self.owner.id),
                type="resource_access_request",
            ).count(),
            2,
        )


class ResourceAccessRequestConcurrentTests(TransactionTestCase):
    """并发批准需要真实提交，故用 TransactionTestCase。"""

    databases = ["default", "postgresql"]

    def setUp(self):
        self.owner = User.objects.create_user(
            username="rar_conc_owner",
            email="rar-conc-owner@test.com",
            password="pass123",
            nickname="Owner",
        )
        self.member = User.objects.create_user(
            username="rar_conc_member",
            email="rar-conc-member@test.com",
            password="pass123",
            nickname="Member",
        )
        self.organization = Organization.objects.create(
            name="RAR Conc Org",
            owner=self.owner,
        )
        for u, role in [(self.owner, "owner"), (self.member, "editor")]:
            OrganizationMember.objects.create(
                organization=self.organization,
                user=u,
                role=role,
            )
        self.workspace = _make_workspace(
            self.organization,
            self.owner,
            fingerprint=f"rar-conc-{self.owner.id}",
        )
        self.group = Conversation.objects.create(
            organization_id=str(self.organization.id),
            type=ConversationType.GROUP,
            name="并发群",
            created_by=str(self.owner.id),
            member_count=2,
        )
        ConversationMember.objects.create(
            conversation=self.group,
            user_id=str(self.owner.id),
            role=MemberRole.OWNER,
        )
        ConversationMember.objects.create(
            conversation=self.group,
            user_id=str(self.member.id),
            role=MemberRole.MEMBER,
        )
        self.document = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.workspace.id,
            owner_id=self.owner.id,
            title="并发文档",
            is_private=True,
        )
        DocumentPermission.objects.create(
            document=self.document,
            subject_type="user",
            subject_id=str(self.owner.id),
            permission="owner",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        self.message = Message.objects.create(
            conversation=self.group,
            sender_id=str(self.owner.id),
            seq=1,
            content="[文档] 并发文档",
            message_type=MessageType.TEXT,
            metadata={
                "card": {
                    "type": "document",
                    "resource_id": str(self.document.id),
                }
            },
        )

    def test_concurrent_approve_only_one_grant_path(self):
        with mock.patch(
            "apps.services.notification.services.notification_service.NotificationService._push_ws"
        ):
            created = ResourceAccessRequestService.create_request(
                requester=self.member,
                source_conversation_id=str(self.group.id),
                source_message_id=self.message.id,
                resource_type="document",
                resource_id=str(self.document.id),
            )
        request_id = created["id"]

        results = []
        errors = []

        def _approve():
            close_old_connections()
            try:
                with mock.patch(
                    "apps.tabdoc.services.share_service._schedule_notify"
                ), mock.patch(
                    "apps.tabdoc.services.share_service._schedule_document_collab_revoke"
                ):
                    results.append(
                        ResourceAccessRequestService.approve_request(
                            actor=self.owner,
                            request_id=request_id,
                        )
                    )
            except Exception as exc:  # pragma: no cover - 收集并发异常
                errors.append(exc)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(_approve) for _ in range(2)]
            for fut in futures:
                fut.result()

        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertTrue(all(r["status"] == "approved" for r in results))
        self.assertEqual(
            ResourceAccessRequest.objects.get(id=request_id).status,
            ResourceAccessRequest.Status.APPROVED,
        )
        self.assertTrue(
            DocumentService(user=self.member).check_document_permission(
                self.document, required_role="viewer"
            )
        )
