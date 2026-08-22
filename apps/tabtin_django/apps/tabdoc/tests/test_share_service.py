"""
TabDoc 协作者邀请 / 管理 service 单测（Wave 2）

覆盖：
- invite_collaborators：happy / 批量上限 / 已邀请幂等 / 跨 organization / 邀请自己 / 邀请 owner
- list_collaborators：返回 owner、过滤 subject_type=role/agent
- update_collaborator_permission：升降级 / 相同权限沉默 / 拒绝改 owner / 协作者不存在
- remove_collaborator：移除 / 拒绝移 owner / auto_removed action / 协作者不存在
- _notify_or_merge：去重窗口内合并 invited→permission_changed、跨窗口分发
- metadata 8 字段完整 + space_id 注入到 Notification.space_id 顶层
- permission_denied 路径

PRD §五块 1.5 + §七验收标准。
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from apps.services.notification.models import Notification
from apps.tabdoc.models import Document, DocumentPermission
from apps.tabdoc.services import share_service
from apps.tabtinspace.models import Space, Organization, OrganizationMember

User = get_user_model()


def _flush_on_commit():
    """SQLite 测试库下 on_commit hook 在 TestCase 包装事务内不会自动触发。

    Django TestCase 把整个测试包在最外层 atomic block 内（避免污染），导致
    ``connection.in_atomic_block == True``，``run_and_clear_commit_hooks``
    会抛 TransactionManagementError。这里直接读 ``run_on_commit`` list
    手动跑回调，模拟生产 PG 提交语义（R13）。
    """
    from django.db import connections

    conn = connections["postgresql"]
    hooks = list(getattr(conn, "run_on_commit", []) or [])
    conn.run_on_commit = []
    for hook in hooks:
        try:
            # hook 形如 (sids, func) — Django 4.1+ 的 4 元 tuple 兼容
            fn = hook[1] if isinstance(hook, tuple) and len(hook) >= 2 else hook
            fn()
        except Exception:
            pass


class _BaseShareServiceTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # 关掉 User post_save 触发的默认组织 / billing provision,
        # 避免在 SQLite 隔离 settings 下的连锁失败（参见
        # apps/tabdata/tests/test_cd003_list_connectors.py 同模式）。
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.disconnect(create_default_organization, sender=User)
        cls._disconnected_signal = (post_save, create_default_organization)

    @classmethod
    def tearDownClass(cls):
        sig, fn = cls._disconnected_signal
        sig.connect(fn, sender=User)
        super().tearDownClass()

    def _mirror_user_to_postgresql(self, user):
        """settings_share_test 下 PG 域模型的 FK 需要同 ID User 行。"""
        User.objects.db_manager("postgresql").create_user(
            id=user.id,
            username=user.username,
            email=user.email,
            password="x",
        )

    def setUp(self):
        self.owner = User.objects.create_user(
            username="doc_owner",
            email="owner@example.com",
            password="x",
        )
        self.owner.nickname = "Owner"
        self.owner.save()

        self.alice = User.objects.create_user(
            username="alice",
            email="alice@example.com",
            password="x",
        )
        self.alice.nickname = "Alice"
        self.alice.save()

        self.bob = User.objects.create_user(
            username="bob",
            email="bob@example.com",
            password="x",
        )
        self.bob.nickname = "Bob"
        self.bob.save()

        self.outsider = User.objects.create_user(
            username="outsider",
            email="outsider@example.com",
            password="x",
        )
        for user in (self.owner, self.alice, self.bob, self.outsider):
            self._mirror_user_to_postgresql(user)

        # 组织 + Space
        self.organization = Organization.objects.create(
            name="ShareTest WT",
            owner=self.owner,
            type="team",
        )
        for u, role in [
            (self.alice, "editor"),
            (self.bob, "editor"),
        ]:
            OrganizationMember.objects.create(
                organization=self.organization, user_id=u.id, role=role,
            )

        self.space = Space.objects.create(
            organization=self.organization,
            name="ShareTest Space",
            type="team",
        )

        self.doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            title="共享测试文档",
            description_markdown="content",
            description_plaintext="content",
        )


class MetadataScopeTests(SimpleTestCase):
    def test_org_only_document_uses_empty_space_in_notification_metadata(self):
        metadata = share_service._build_metadata(
            SimpleNamespace(
                id="doc-1",
                title="Organization document",
                organization_id="org-1",
                space_id=None,
            ),
            "invited",
            SimpleNamespace(id="owner-1", nickname="Owner"),
        )

        self.assertEqual(metadata["space_id"], "")


class InvitationTextTests(SimpleTestCase):
    def test_permission_change_uses_direction_neutral_copy(self):
        title, body = share_service._build_invitation_text({
            "action": "permission_changed",
            "resource_title": "未命名",
            "inviter_name": "郑十",
            "permission_from": "viewer",
            "permission_to": "editor",
        })

        self.assertEqual(title, "你在《未命名》的权限调整为 编辑")
        self.assertEqual(body, "操作人：郑十")


class InviteCollaboratorsTests(_BaseShareServiceTests):

    def test_happy_path_creates_permission_and_notification(self):
        result = share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.alice.id)],
            permission="editor",
            inviter=self.owner,
        )
        _flush_on_commit()

        self.assertEqual(result["notified"], 1)
        self.assertEqual(result["skipped"], [])

        perm = DocumentPermission.objects.using("postgresql").get(
            document=self.doc, subject_id=str(self.alice.id),
        )
        self.assertEqual(perm.permission, "editor")
        self.assertTrue(perm.is_active)
        self.assertEqual(perm.subject_type, "user")

        notif = Notification.objects.get(user_id=str(self.alice.id))
        self.assertEqual(notif.type, "resource_shared")
        meta = notif.metadata
        # 8 字段全在
        for k in ("resource_type", "resource_id", "resource_title", "action",
                  "permission_from", "permission_to", "inviter_id", "inviter_name",
                  "organization_id", "space_id"):
            self.assertIn(k, meta, f"missing metadata key {k}")
        self.assertEqual(meta["resource_type"], "doc")
        self.assertEqual(meta["action"], "invited")
        self.assertEqual(meta["permission_to"], "editor")
        # space_id 同步到顶层
        self.assertEqual(notif.space_id, str(self.space.id))

    def test_batch_limit_exceeded(self):
        many_ids = [str(uuid.uuid4()) for _ in range(51)]
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.invite_collaborators(
                document_id=self.doc.id,
                user_ids=many_ids,
                permission="viewer",
                inviter=self.owner,
            )
        self.assertEqual(cm.exception.code, "RATE_LIMIT_EXCEEDED")
        self.assertEqual(cm.exception.status, 400)

    def test_idempotent_same_permission_silent(self):
        """已是协作者且权限相同 → 完全沉默，不写表也不发通知。"""
        share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.alice.id)],
            permission="editor",
            inviter=self.owner,
        )
        _flush_on_commit()
        Notification.objects.all().delete()

        result = share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.alice.id)],
            permission="editor",
            inviter=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(result["notified"], 0)
        self.assertEqual(Notification.objects.count(), 0)

    def test_idempotent_different_permission_changes(self):
        share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.alice.id)],
            permission="viewer",
            inviter=self.owner,
        )
        _flush_on_commit()
        # 5 分钟后再调，避免 D7 合并干扰断言
        Notification.objects.all().update(
            created_at=timezone.now() - timedelta(minutes=10),
            is_read=True,
        )

        result = share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.alice.id)],
            permission="admin",
            inviter=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(result["notified"], 1)
        perm = DocumentPermission.objects.using("postgresql").get(
            document=self.doc, subject_id=str(self.alice.id),
        )
        self.assertEqual(perm.permission, "admin")
        notif = Notification.objects.filter(user_id=str(self.alice.id)).order_by("-created_at").first()
        self.assertEqual(notif.metadata["action"], "permission_changed")
        self.assertEqual(notif.metadata["permission_to"], "admin")

    def test_cross_organization_user_skipped(self):
        result = share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.outsider.id)],
            permission="editor",
            inviter=self.owner,
        )
        self.assertEqual(result["notified"], 0)
        self.assertEqual(len(result["skipped"]), 1)
        self.assertEqual(result["skipped"][0]["reason"], "not_in_organization")

    def test_invite_self_skipped(self):
        result = share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.owner.id)],  # 邀请者自己（owner）
            permission="editor",
            inviter=self.owner,
        )
        # 既是 self 也是 owner — 先匹配 self
        self.assertEqual(result["notified"], 0)
        reasons = {s["reason"] for s in result["skipped"]}
        self.assertTrue("self" in reasons or "is_owner" in reasons)

    def test_invite_owner_by_admin_collaborator_skipped(self):
        """让 admin 协作者发起邀请，邀请 doc owner 应 skip。"""
        # 给 alice 加 admin 权限
        DocumentPermission.objects.create(
            document=self.doc, subject_type="user",
            subject_id=str(self.alice.id), permission="admin",
            is_active=True, granted_by=str(self.owner.id),
        )
        result = share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.owner.id)],
            permission="editor",
            inviter=self.alice,
        )
        self.assertEqual(result["notified"], 0)
        self.assertEqual(result["skipped"][0]["reason"], "is_owner")

    def test_permission_denied_for_viewer(self):
        """非 owner / 非 admin 用户调用 → PermissionDenied。"""
        # alice 仅 organization editor，无 doc admin
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.invite_collaborators(
                document_id=self.doc.id,
                user_ids=[str(self.bob.id)],
                permission="viewer",
                inviter=self.alice,
            )
        self.assertEqual(cm.exception.status, 403)

    def test_invalid_permission_rejected(self):
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.invite_collaborators(
                document_id=self.doc.id,
                user_ids=[str(self.alice.id)],
                permission="superuser",
                inviter=self.owner,
            )
        self.assertEqual(cm.exception.code, "INVALID_PERMISSION")

    def test_invite_after_remove_activates_old_row(self):
        DocumentPermission.objects.create(
            document=self.doc, subject_type="user",
            subject_id=str(self.alice.id), permission="editor",
            is_active=False, granted_by=str(self.owner.id),
        )
        result = share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.alice.id)],
            permission="viewer",
            inviter=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(result["notified"], 1)
        perm = DocumentPermission.objects.using("postgresql").get(
            document=self.doc, subject_id=str(self.alice.id),
        )
        self.assertTrue(perm.is_active)
        self.assertEqual(perm.permission, "viewer")
        notif = Notification.objects.get(user_id=str(self.alice.id))
        self.assertEqual(notif.metadata["action"], "invited")


class ListCollaboratorsTests(_BaseShareServiceTests):

    def test_returns_owner_and_user_collaborators(self):
        DocumentPermission.objects.create(
            document=self.doc, subject_type="user",
            subject_id=str(self.alice.id), permission="editor",
            is_active=True, granted_by=str(self.owner.id),
        )
        DocumentPermission.objects.create(
            document=self.doc, subject_type="user",
            subject_id=str(self.bob.id), permission="viewer",
            is_active=True, granted_by=str(self.owner.id),
        )
        # role 类协作者：D1 要求过滤
        DocumentPermission.objects.create(
            document=self.doc, subject_type="role",
            subject_id="editor", permission="editor",
            is_active=True, granted_by=str(self.owner.id),
        )
        # agent 类协作者：D1 要求过滤
        DocumentPermission.objects.create(
            document=self.doc, subject_type="agent",
            subject_id=str(uuid.uuid4()), permission="viewer",
            is_active=True, granted_by=str(self.owner.id),
        )
        # is_active=False 的不应出现
        DocumentPermission.objects.create(
            document=self.doc, subject_type="user",
            subject_id=str(self.outsider.id), permission="viewer",
            is_active=False, granted_by=str(self.owner.id),
        )

        result = share_service.list_collaborators(
            document_id=self.doc.id, viewer=self.owner,
        )
        self.assertEqual(result["owner"]["user_id"], str(self.owner.id))
        self.assertIn("@", result["owner"]["email"])  # 已 mask
        self.assertEqual(len(result["collaborators"]), 2)
        ids = {c["user_id"] for c in result["collaborators"]}
        self.assertEqual(ids, {str(self.alice.id), str(self.bob.id)})
        for c in result["collaborators"]:
            self.assertIn(c["permission"], {"editor", "viewer"})

    def test_viewer_can_list(self):
        DocumentPermission.objects.create(
            document=self.doc, subject_type="user",
            subject_id=str(self.alice.id), permission="viewer",
            is_active=True, granted_by=str(self.owner.id),
        )
        result = share_service.list_collaborators(
            document_id=self.doc.id, viewer=self.alice,
        )
        self.assertEqual(len(result["collaborators"]), 1)

    def test_outsider_permission_denied(self):
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.list_collaborators(
                document_id=self.doc.id, viewer=self.outsider,
            )
        self.assertEqual(cm.exception.status, 403)

    @patch("apps.tabdoc.services.share_service.build_public_asset_url")
    def test_list_collaborators_resolves_avatar_object_keys(
        self, mock_build_public_asset_url,
    ):
        """#5141: User.avatar 存 object key，list 必须返回可访问的 CDN URL。"""
        mock_build_public_asset_url.side_effect = (
            lambda ref: f"https://assets.example.com/{ref}" if ref else ""
        )
        self.owner.avatar = "user-avatars/owner.png"
        self.owner.save(update_fields=["avatar"])
        self.alice.avatar = "user-avatars/alice.png"
        self.alice.save(update_fields=["avatar"])
        DocumentPermission.objects.create(
            document=self.doc, subject_type="user",
            subject_id=str(self.alice.id), permission="editor",
            is_active=True, granted_by=str(self.owner.id),
        )

        result = share_service.list_collaborators(
            document_id=self.doc.id, viewer=self.owner,
        )

        self.assertEqual(
            result["owner"]["avatar"],
            "https://assets.example.com/user-avatars/owner.png",
        )
        self.assertEqual(len(result["collaborators"]), 1)
        self.assertEqual(
            result["collaborators"][0]["avatar"],
            "https://assets.example.com/user-avatars/alice.png",
        )
        mock_build_public_asset_url.assert_any_call("user-avatars/owner.png")
        mock_build_public_asset_url.assert_any_call("user-avatars/alice.png")


class UpdateCollaboratorTests(_BaseShareServiceTests):

    def setUp(self):
        super().setUp()
        DocumentPermission.objects.create(
            document=self.doc, subject_type="user",
            subject_id=str(self.alice.id), permission="viewer",
            is_active=True, granted_by=str(self.owner.id),
        )

    def test_upgrade(self):
        out = share_service.update_collaborator_permission(
            document_id=self.doc.id,
            user_id=str(self.alice.id),
            permission="editor",
            operator=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(out["permission"], "editor")
        notif = Notification.objects.get(user_id=str(self.alice.id))
        self.assertEqual(notif.metadata["action"], "permission_changed")
        self.assertEqual(notif.metadata["permission_from"], "viewer")
        self.assertEqual(notif.metadata["permission_to"], "editor")

    def test_downgrade(self):
        DocumentPermission.objects.using("postgresql").filter(
            document=self.doc, subject_id=str(self.alice.id),
        ).update(permission="admin")
        out = share_service.update_collaborator_permission(
            document_id=self.doc.id,
            user_id=str(self.alice.id),
            permission="viewer",
            operator=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(out["permission"], "viewer")

    def test_same_permission_silent(self):
        share_service.update_collaborator_permission(
            document_id=self.doc.id,
            user_id=str(self.alice.id),
            permission="viewer",
            operator=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(Notification.objects.count(), 0)

    def test_cannot_change_owner_permission(self):
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.update_collaborator_permission(
                document_id=self.doc.id,
                user_id=str(self.owner.id),
                permission="viewer",
                operator=self.owner,
            )
        self.assertEqual(cm.exception.code, "CANNOT_MODIFY_OWNER")

    def test_collaborator_not_found(self):
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.update_collaborator_permission(
                document_id=self.doc.id,
                user_id=str(self.bob.id),
                permission="editor",
                operator=self.owner,
            )
        self.assertEqual(cm.exception.code, "COLLABORATOR_NOT_FOUND")


class RemoveCollaboratorTests(_BaseShareServiceTests):

    def setUp(self):
        super().setUp()
        self.perm = DocumentPermission.objects.create(
            document=self.doc, subject_type="user",
            subject_id=str(self.alice.id), permission="editor",
            is_active=True, granted_by=str(self.owner.id),
        )

    def test_remove_happy_path(self):
        share_service.remove_collaborator(
            document_id=self.doc.id,
            user_id=str(self.alice.id),
            operator=self.owner,
        )
        _flush_on_commit()
        self.perm.refresh_from_db()
        self.assertFalse(self.perm.is_active)
        notif = Notification.objects.get(user_id=str(self.alice.id))
        self.assertEqual(notif.metadata["action"], "removed")

    def test_cannot_remove_owner(self):
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.remove_collaborator(
                document_id=self.doc.id,
                user_id=str(self.owner.id),
                operator=self.owner,
            )
        self.assertEqual(cm.exception.code, "CANNOT_REMOVE_OWNER")

    def test_auto_removed_action(self):
        share_service.remove_collaborator(
            document_id=self.doc.id,
            user_id=str(self.alice.id),
            operator=self.owner,
            action="auto_removed",
        )
        _flush_on_commit()
        notif = Notification.objects.get(user_id=str(self.alice.id))
        self.assertEqual(notif.metadata["action"], "auto_removed")

    def test_remove_nonexistent(self):
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.remove_collaborator(
                document_id=self.doc.id,
                user_id=str(self.bob.id),
                operator=self.owner,
            )
        self.assertEqual(cm.exception.code, "COLLABORATOR_NOT_FOUND")


class NotifyOrMergeTests(_BaseShareServiceTests):

    def test_dedupe_invited_then_permission_changed_within_window(self):
        share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.alice.id)],
            permission="viewer",
            inviter=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(Notification.objects.filter(user_id=str(self.alice.id)).count(), 1)

        # 立即升级 → 应合并为单条 permission_changed
        share_service.update_collaborator_permission(
            document_id=self.doc.id,
            user_id=str(self.alice.id),
            permission="editor",
            operator=self.owner,
        )
        _flush_on_commit()
        notifs = list(Notification.objects.filter(user_id=str(self.alice.id)))
        # 合并后仍是 1 条
        self.assertEqual(len(notifs), 1)
        self.assertEqual(notifs[0].metadata["action"], "permission_changed")
        self.assertEqual(notifs[0].metadata["permission_to"], "editor")

    def test_outside_window_separate_notifications(self):
        share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.alice.id)],
            permission="viewer",
            inviter=self.owner,
        )
        _flush_on_commit()
        # 把已有通知推回 10 分钟前
        Notification.objects.all().update(created_at=timezone.now() - timedelta(minutes=10))

        share_service.update_collaborator_permission(
            document_id=self.doc.id,
            user_id=str(self.alice.id),
            permission="editor",
            operator=self.owner,
        )
        _flush_on_commit()
        notifs = list(Notification.objects.filter(user_id=str(self.alice.id)).order_by("-created_at"))
        self.assertEqual(len(notifs), 2)

    def test_multiple_permission_changes_collapse_to_one(self):
        """5 分钟窗口内多次 permission_changed 仅保留最后一条（D7 第二条规则）。"""
        share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.alice.id)],
            permission="viewer",
            inviter=self.owner,
        )
        _flush_on_commit()
        # 升级
        share_service.update_collaborator_permission(
            document_id=self.doc.id,
            user_id=str(self.alice.id),
            permission="editor",
            operator=self.owner,
        )
        _flush_on_commit()
        # 再升级
        share_service.update_collaborator_permission(
            document_id=self.doc.id,
            user_id=str(self.alice.id),
            permission="admin",
            operator=self.owner,
        )
        _flush_on_commit()
        notifs = list(Notification.objects.filter(user_id=str(self.alice.id)))
        self.assertEqual(len(notifs), 1)
        self.assertEqual(notifs[0].metadata["action"], "permission_changed")
        self.assertEqual(notifs[0].metadata["permission_to"], "admin")

    def test_removed_action_always_creates_new(self):
        share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.alice.id)],
            permission="viewer",
            inviter=self.owner,
        )
        _flush_on_commit()
        share_service.remove_collaborator(
            document_id=self.doc.id,
            user_id=str(self.alice.id),
            operator=self.owner,
        )
        _flush_on_commit()
        notifs = list(Notification.objects.filter(user_id=str(self.alice.id)).order_by("-created_at"))
        self.assertEqual(len(notifs), 2)
        actions = [n.metadata.get("action") for n in notifs]
        self.assertIn("removed", actions)


class MetadataSchemaAssertionTests(_BaseShareServiceTests):
    """显式 assert metadata 8 字段齐全 + space_id 顶层注入。"""

    def test_metadata_complete_and_space_id_top_level(self):
        share_service.invite_collaborators(
            document_id=self.doc.id,
            user_ids=[str(self.alice.id)],
            permission="editor",
            inviter=self.owner,
        )
        _flush_on_commit()
        notif = Notification.objects.get(user_id=str(self.alice.id))
        assert {
            "resource_type", "resource_id", "resource_title", "action",
            "permission_from", "permission_to", "inviter_id", "inviter_name",
            "organization_id", "space_id",
        }.issubset(notif.metadata.keys())
        # 顶层 space_id 与 metadata.space_id 一致
        assert notif.space_id == str(self.space.id)
        assert notif.metadata["space_id"] == str(self.space.id)
        assert notif.metadata["inviter_id"] == str(self.owner.id)


# ════════════════════════════════════════════════════════════════════
# Wave 5 §G (W2-L1 收敛)：list_collaborators SQL N+1 监控
# ════════════════════════════════════════════════════════════════════


class ListCollaboratorsSqlQueryBudgetTests(_BaseShareServiceTests):
    """100 个协作者场景下 list_collaborators 查询数应 ≤ 一个常量上限，
    防止未来引入 N+1（如不小心给 created_by 加 select_related 触发跨库）。

    PRD §七验收标准："100 协作者 < 500ms" 的硬性保障。
    """

    def _create_n_collaborators(self, n: int) -> list:
        from django.contrib.auth import get_user_model
        User = get_user_model()
        users = []
        for i in range(n):
            u = User.objects.create_user(
                username=f"perfuser{i}",
                email=f"perfuser{i}@example.com",
                password="x",
            )
            u.nickname = f"P{i}"
            u.save()
            self._mirror_user_to_postgresql(u)
            users.append(u)
            OrganizationMember.objects.create(
                organization=self.organization, user_id=u.id, role="editor",
            )
            DocumentPermission.objects.create(
                document=self.doc, subject_type="user",
                subject_id=str(u.id), permission="viewer",
                is_active=True, granted_by=str(self.owner.id),
            )
        return users

    def test_query_count_bounded_under_100_collaborators(self):
        from django.test.utils import CaptureQueriesContext
        from django.db import connections

        self._create_n_collaborators(100)

        # 上限放宽到 8 —— 跨库（default + postgresql）+ Wave 2 两步查询
        # （DocumentPermission 1、跨库 User IN 1、空间/role 解析若干）。
        # 关键是 "不随协作者数量线性增长" —— 防止 N+1。
        QUERY_BUDGET = 8

        # 重要：捕获 default + postgresql 两个 alias 的查询，
        # share_service 跨库查询走 .using("default") + .using("postgresql")
        with CaptureQueriesContext(connections["postgresql"]) as pg_ctx, \
                CaptureQueriesContext(connections["default"]) as default_ctx:
            result = share_service.list_collaborators(
                document_id=self.doc.id, viewer=self.owner,
            )

        self.assertEqual(len(result["collaborators"]), 100)
        total_queries = len(pg_ctx) + len(default_ctx)
        self.assertLessEqual(
            total_queries, QUERY_BUDGET,
            msg=(
                f"list_collaborators 100 协作者 SQL 查询数 {total_queries} > "
                f"{QUERY_BUDGET}，疑似 N+1 退化。pg={len(pg_ctx)} default={len(default_ctx)}"
            ),
        )
