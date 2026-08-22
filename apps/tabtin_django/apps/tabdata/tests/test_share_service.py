"""
TabData 协作者邀请 / 管理 service 单测（Wave 2，与 TabDoc 对称）

覆盖：
- invite_collaborators：happy / 批量上限 / 已邀请幂等 / 跨 organization / 邀请自己 / 邀请 owner
- list_collaborators：返回 owner、过滤 subject_type=role/agent
- update_collaborator_permission：升降级 / 相同权限沉默 / 拒绝改 owner / 协作者不存在
- remove_collaborator：移除 / 拒绝移 owner / auto_removed action / 协作者不存在
- _notify_or_merge：去重窗口内合并、跨窗口分发
- metadata 8 字段完整 + space_id 顶层注入
- W1-L1 BaseService.check_table_permission 读 TablePermission
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
from apps.tabdata.models import Table, TablePermission
# 避开 apps.tabdata.services.__init__（会拉 attachment_service → billing 链），
# 直接 import 子模块。
import apps.tabdata.services.share_service as share_service
from apps.tabdata.api_table import _batch_compute_roles_safe, _compute_user_table_role_safe
from apps.tabdata.services.base import BaseService
from apps.tabtinspace.models import Agent, Space, Organization, OrganizationMember

User = get_user_model()


def _flush_on_commit():
    """同 TabDoc 版本——TestCase 外层 atomic 阻止 run_and_clear_commit_hooks，
    直接读 hooks list 手动跑（R13）。"""
    from django.db import connections

    conn = connections["postgresql"]
    hooks = list(getattr(conn, "run_on_commit", []) or [])
    conn.run_on_commit = []
    for hook in hooks:
        try:
            fn = hook[1] if isinstance(hook, tuple) and len(hook) >= 2 else hook
            fn()
        except Exception:
            pass


class _BaseShareServiceTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.disconnect(create_default_organization, sender=User)
        cls._disconnected_signal = (post_save, create_default_organization)

    @classmethod
    def tearDownClass(cls):
        sig, fn = cls._disconnected_signal
        sig.connect(fn, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.owner = User.objects.create_user(
            username="tbl_owner", email="towner@example.com", password="x",
        )
        self.owner.nickname = "TableOwner"
        self.owner.save()

        self.alice = User.objects.create_user(
            username="tbl_alice", email="talice@example.com", password="x",
        )
        self.alice.nickname = "Alice"
        self.alice.save()

        self.bob = User.objects.create_user(
            username="tbl_bob", email="tbob@example.com", password="x",
        )
        self.bob.nickname = "Bob"
        self.bob.save()

        self.outsider = User.objects.create_user(
            username="tbl_outsider", email="touter@example.com", password="x",
        )

        self.organization = Organization.objects.create(
            name="TableShare WT", owner=self.owner, type="team",
        )
        for u, role in [
            (self.alice, "editor"),
            (self.bob, "editor"),
        ]:
            OrganizationMember.objects.create(
                organization=self.organization, user_id=u.id, role=role,
            )

        self.space = Space.objects.create(
            organization=self.organization, name="TableShare Space",
            type="team",
        )

        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            name="共享测试表格",
        )


class MetadataScopeTests(SimpleTestCase):
    def test_org_only_table_keeps_null_space_in_notification_metadata(self):
        metadata = share_service._build_metadata(
            SimpleNamespace(
                id="table-1",
                name="Organization table",
                organization_id="org-1",
                space_id=None,
            ),
            "invited",
            SimpleNamespace(id="owner-1", nickname="Owner"),
        )

        self.assertIsNone(metadata["space_id"])


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
            table_id=self.table.id,
            user_ids=[str(self.alice.id)],
            permission="editor",
            inviter=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(result["notified"], 1)
        self.assertEqual(result["skipped"], [])

        perm = TablePermission.objects.using("postgresql").get(
            table=self.table, subject_id=str(self.alice.id),
        )
        self.assertEqual(perm.permission, "editor")
        self.assertTrue(perm.is_active)
        self.assertEqual(perm.subject_type, "user")

        notif = Notification.objects.get(user_id=str(self.alice.id))
        self.assertEqual(notif.type, "resource_shared")
        meta = notif.metadata
        for k in ("resource_type", "resource_id", "resource_title", "action",
                  "permission_from", "permission_to", "inviter_id", "inviter_name",
                  "organization_id", "space_id"):
            self.assertIn(k, meta)
        self.assertEqual(meta["resource_type"], "table")
        self.assertEqual(meta["action"], "invited")
        self.assertEqual(meta["permission_to"], "editor")
        self.assertEqual(notif.space_id, str(self.space.id))

    def test_batch_limit_exceeded(self):
        many_ids = [str(uuid.uuid4()) for _ in range(51)]
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.invite_collaborators(
                table_id=self.table.id,
                user_ids=many_ids,
                permission="viewer",
                inviter=self.owner,
            )
        self.assertEqual(cm.exception.code, "RATE_LIMIT_EXCEEDED")

    def test_idempotent_same_permission_silent(self):
        share_service.invite_collaborators(
            table_id=self.table.id,
            user_ids=[str(self.alice.id)],
            permission="editor",
            inviter=self.owner,
        )
        _flush_on_commit()
        Notification.objects.all().delete()

        result = share_service.invite_collaborators(
            table_id=self.table.id,
            user_ids=[str(self.alice.id)],
            permission="editor",
            inviter=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(result["notified"], 0)
        self.assertEqual(Notification.objects.count(), 0)

    def test_idempotent_different_permission_changes(self):
        share_service.invite_collaborators(
            table_id=self.table.id,
            user_ids=[str(self.alice.id)],
            permission="viewer",
            inviter=self.owner,
        )
        _flush_on_commit()
        Notification.objects.all().update(
            created_at=timezone.now() - timedelta(minutes=10),
            is_read=True,
        )

        result = share_service.invite_collaborators(
            table_id=self.table.id,
            user_ids=[str(self.alice.id)],
            permission="admin",
            inviter=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(result["notified"], 1)
        notif = Notification.objects.filter(user_id=str(self.alice.id)).order_by("-created_at").first()
        self.assertEqual(notif.metadata["action"], "permission_changed")

    def test_cross_organization_user_skipped(self):
        result = share_service.invite_collaborators(
            table_id=self.table.id,
            user_ids=[str(self.outsider.id)],
            permission="editor",
            inviter=self.owner,
        )
        self.assertEqual(result["notified"], 0)
        self.assertEqual(result["skipped"][0]["reason"], "not_in_organization")

    def test_invite_self_skipped(self):
        result = share_service.invite_collaborators(
            table_id=self.table.id,
            user_ids=[str(self.owner.id)],
            permission="editor",
            inviter=self.owner,
        )
        self.assertEqual(result["notified"], 0)
        reasons = {s["reason"] for s in result["skipped"]}
        self.assertTrue("self" in reasons or "is_owner" in reasons)

    def test_invite_owner_by_admin_collaborator_skipped(self):
        TablePermission.objects.create(
            table=self.table, subject_type="user",
            subject_id=str(self.alice.id), permission="admin",
            is_active=True, granted_by=str(self.owner.id),
        )
        result = share_service.invite_collaborators(
            table_id=self.table.id,
            user_ids=[str(self.owner.id)],
            permission="editor",
            inviter=self.alice,
        )
        self.assertEqual(result["notified"], 0)
        self.assertEqual(result["skipped"][0]["reason"], "is_owner")

    def test_permission_denied_for_viewer(self):
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.invite_collaborators(
                table_id=self.table.id,
                user_ids=[str(self.bob.id)],
                permission="viewer",
                inviter=self.alice,
            )
        self.assertEqual(cm.exception.status, 403)

    def test_invalid_permission_rejected(self):
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.invite_collaborators(
                table_id=self.table.id,
                user_ids=[str(self.alice.id)],
                permission="superuser",
                inviter=self.owner,
            )
        self.assertEqual(cm.exception.code, "INVALID_PERMISSION")

    def test_invite_after_remove_activates_old_row(self):
        TablePermission.objects.create(
            table=self.table, subject_type="user",
            subject_id=str(self.alice.id), permission="editor",
            is_active=False, granted_by=str(self.owner.id),
        )
        result = share_service.invite_collaborators(
            table_id=self.table.id,
            user_ids=[str(self.alice.id)],
            permission="viewer",
            inviter=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(result["notified"], 1)
        perm = TablePermission.objects.using("postgresql").get(
            table=self.table, subject_id=str(self.alice.id),
        )
        self.assertTrue(perm.is_active)
        self.assertEqual(perm.permission, "viewer")
        notif = Notification.objects.get(user_id=str(self.alice.id))
        self.assertEqual(notif.metadata["action"], "invited")


class ListCollaboratorsTests(_BaseShareServiceTests):

    def test_returns_owner_and_filters_subject_type(self):
        TablePermission.objects.create(
            table=self.table, subject_type="user",
            subject_id=str(self.alice.id), permission="editor",
            is_active=True, granted_by=str(self.owner.id),
        )
        TablePermission.objects.create(
            table=self.table, subject_type="user",
            subject_id=str(self.bob.id), permission="viewer",
            is_active=True, granted_by=str(self.owner.id),
        )
        TablePermission.objects.create(
            table=self.table, subject_type="role",
            subject_id="editor", permission="editor",
            is_active=True, granted_by=str(self.owner.id),
        )
        TablePermission.objects.create(
            table=self.table, subject_type="agent",
            subject_id=str(uuid.uuid4()), permission="viewer",
            is_active=True, granted_by=str(self.owner.id),
        )
        TablePermission.objects.create(
            table=self.table, subject_type="user",
            subject_id=str(self.outsider.id), permission="viewer",
            is_active=False, granted_by=str(self.owner.id),
        )

        result = share_service.list_collaborators(
            table_id=self.table.id, viewer=self.owner,
        )
        self.assertEqual(result["owner"]["user_id"], str(self.owner.id))
        self.assertEqual(len(result["collaborators"]), 2)
        ids = {c["user_id"] for c in result["collaborators"]}
        self.assertEqual(ids, {str(self.alice.id), str(self.bob.id)})

    def test_viewer_can_list(self):
        TablePermission.objects.create(
            table=self.table, subject_type="user",
            subject_id=str(self.alice.id), permission="viewer",
            is_active=True, granted_by=str(self.owner.id),
        )
        result = share_service.list_collaborators(
            table_id=self.table.id, viewer=self.alice,
        )
        self.assertEqual(len(result["collaborators"]), 1)

    def test_outsider_permission_denied(self):
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.list_collaborators(
                table_id=self.table.id, viewer=self.outsider,
            )
        self.assertEqual(cm.exception.status, 403)

    @patch("apps.tabdata.services.share_service.build_public_asset_url")
    def test_list_collaborators_resolves_avatar_object_keys(
        self, mock_build_public_asset_url,
    ):
        """#5141: TabData 与 TabDoc 对称——object key 必须转成 CDN URL。"""
        mock_build_public_asset_url.side_effect = (
            lambda ref: f"https://assets.example.com/{ref}" if ref else ""
        )
        self.owner.avatar = "user-avatars/owner.png"
        self.owner.save(update_fields=["avatar"])
        self.alice.avatar = "user-avatars/alice.png"
        self.alice.save(update_fields=["avatar"])
        TablePermission.objects.create(
            table=self.table, subject_type="user",
            subject_id=str(self.alice.id), permission="editor",
            is_active=True, granted_by=str(self.owner.id),
        )

        result = share_service.list_collaborators(
            table_id=self.table.id, viewer=self.owner,
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
        TablePermission.objects.create(
            table=self.table, subject_type="user",
            subject_id=str(self.alice.id), permission="viewer",
            is_active=True, granted_by=str(self.owner.id),
        )

    def test_upgrade(self):
        out = share_service.update_collaborator_permission(
            table_id=self.table.id,
            user_id=str(self.alice.id),
            permission="editor",
            operator=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(out["permission"], "editor")
        notif = Notification.objects.get(user_id=str(self.alice.id))
        self.assertEqual(notif.metadata["permission_from"], "viewer")
        self.assertEqual(notif.metadata["permission_to"], "editor")

    def test_downgrade(self):
        TablePermission.objects.using("postgresql").filter(
            table=self.table, subject_id=str(self.alice.id),
        ).update(permission="admin")
        out = share_service.update_collaborator_permission(
            table_id=self.table.id,
            user_id=str(self.alice.id),
            permission="viewer",
            operator=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(out["permission"], "viewer")

    def test_same_permission_silent(self):
        share_service.update_collaborator_permission(
            table_id=self.table.id,
            user_id=str(self.alice.id),
            permission="viewer",
            operator=self.owner,
        )
        _flush_on_commit()
        self.assertEqual(Notification.objects.count(), 0)

    def test_cannot_change_owner_permission(self):
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.update_collaborator_permission(
                table_id=self.table.id,
                user_id=str(self.owner.id),
                permission="viewer",
                operator=self.owner,
            )
        self.assertEqual(cm.exception.code, "CANNOT_MODIFY_OWNER")

    def test_collaborator_not_found(self):
        with self.assertRaises(share_service.CollaboratorError) as cm:
            share_service.update_collaborator_permission(
                table_id=self.table.id,
                user_id=str(self.bob.id),
                permission="editor",
                operator=self.owner,
            )
        self.assertEqual(cm.exception.code, "COLLABORATOR_NOT_FOUND")


class RemoveCollaboratorTests(_BaseShareServiceTests):

    def setUp(self):
        super().setUp()
        self.perm = TablePermission.objects.create(
            table=self.table, subject_type="user",
            subject_id=str(self.alice.id), permission="editor",
            is_active=True, granted_by=str(self.owner.id),
        )

    def test_remove_happy_path(self):
        share_service.remove_collaborator(
            table_id=self.table.id,
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
                table_id=self.table.id,
                user_id=str(self.owner.id),
                operator=self.owner,
            )
        self.assertEqual(cm.exception.code, "CANNOT_REMOVE_OWNER")

    def test_auto_removed_action(self):
        share_service.remove_collaborator(
            table_id=self.table.id,
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
                table_id=self.table.id,
                user_id=str(self.bob.id),
                operator=self.owner,
            )
        self.assertEqual(cm.exception.code, "COLLABORATOR_NOT_FOUND")


class NotifyOrMergeTests(_BaseShareServiceTests):

    def test_dedupe_invited_then_permission_changed_within_window(self):
        share_service.invite_collaborators(
            table_id=self.table.id,
            user_ids=[str(self.alice.id)],
            permission="viewer",
            inviter=self.owner,
        )
        _flush_on_commit()
        share_service.update_collaborator_permission(
            table_id=self.table.id,
            user_id=str(self.alice.id),
            permission="editor",
            operator=self.owner,
        )
        _flush_on_commit()
        notifs = list(Notification.objects.filter(user_id=str(self.alice.id)))
        self.assertEqual(len(notifs), 1)
        self.assertEqual(notifs[0].metadata["action"], "permission_changed")
        self.assertEqual(notifs[0].metadata["permission_to"], "editor")

    def test_outside_window_separate_notifications(self):
        share_service.invite_collaborators(
            table_id=self.table.id,
            user_ids=[str(self.alice.id)],
            permission="viewer",
            inviter=self.owner,
        )
        _flush_on_commit()
        Notification.objects.all().update(created_at=timezone.now() - timedelta(minutes=10))

        share_service.update_collaborator_permission(
            table_id=self.table.id,
            user_id=str(self.alice.id),
            permission="editor",
            operator=self.owner,
        )
        _flush_on_commit()
        notifs = list(Notification.objects.filter(user_id=str(self.alice.id)).order_by("-created_at"))
        self.assertEqual(len(notifs), 2)

    def test_multiple_permission_changes_collapse_to_one(self):
        share_service.invite_collaborators(
            table_id=self.table.id,
            user_ids=[str(self.alice.id)],
            permission="viewer",
            inviter=self.owner,
        )
        _flush_on_commit()
        share_service.update_collaborator_permission(
            table_id=self.table.id,
            user_id=str(self.alice.id),
            permission="editor",
            operator=self.owner,
        )
        _flush_on_commit()
        share_service.update_collaborator_permission(
            table_id=self.table.id,
            user_id=str(self.alice.id),
            permission="admin",
            operator=self.owner,
        )
        _flush_on_commit()
        notifs = list(Notification.objects.filter(user_id=str(self.alice.id)))
        self.assertEqual(len(notifs), 1)
        self.assertEqual(notifs[0].metadata["permission_to"], "admin")

    def test_removed_action_always_creates_new(self):
        share_service.invite_collaborators(
            table_id=self.table.id,
            user_ids=[str(self.alice.id)],
            permission="viewer",
            inviter=self.owner,
        )
        _flush_on_commit()
        share_service.remove_collaborator(
            table_id=self.table.id,
            user_id=str(self.alice.id),
            operator=self.owner,
        )
        _flush_on_commit()
        notifs = list(Notification.objects.filter(user_id=str(self.alice.id)).order_by("-created_at"))
        self.assertEqual(len(notifs), 2)


class MetadataSchemaAssertionTests(_BaseShareServiceTests):

    def test_metadata_complete_and_space_id_top_level(self):
        share_service.invite_collaborators(
            table_id=self.table.id,
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
        assert notif.space_id == str(self.space.id)
        assert notif.metadata["space_id"] == str(self.space.id)
        assert notif.metadata["inviter_id"] == str(self.owner.id)


class W1L1CheckTablePermissionTests(_BaseShareServiceTests):
    """W1-L1 修复回归：BaseService.check_table_permission 必须读 TablePermission。"""

    def test_owner_passes(self):
        svc = BaseService(user=self.owner)
        self.assertTrue(svc.check_table_permission(str(self.table.id), "admin"))

    def test_user_with_table_permission_passes_at_their_level(self):
        TablePermission.objects.create(
            table=self.table, subject_type="user",
            subject_id=str(self.bob.id), permission="editor",
            is_active=True, granted_by=str(self.owner.id),
        )
        svc = BaseService(user=self.bob)
        # bob 在 Organization 里是 editor，但通过 TablePermission(editor) 也应通过
        self.assertTrue(svc.check_table_permission(str(self.table.id), "viewer"))
        self.assertTrue(svc.check_table_permission(str(self.table.id), "editor"))

    def test_user_without_table_permission_fallbacks_to_organization(self):
        # bob 在 Organization 是 editor，应通过 viewer/editor 检查（fallback 路径）
        svc = BaseService(user=self.bob)
        self.assertTrue(svc.check_table_permission(str(self.table.id), "viewer"))

    def test_user_with_lower_table_permission_does_not_fallback_to_organization(self):
        """显式 viewer 权限不足时不再按 Organization editor 取宽。"""
        TablePermission.objects.create(
            table=self.table, subject_type="user",
            subject_id=str(self.bob.id), permission="viewer",
            is_active=True, granted_by=str(self.owner.id),
        )
        svc = BaseService(user=self.bob)
        # bob 在 Organization 是 editor，但显式资源权限 viewer 是上限。
        self.assertTrue(svc.check_table_permission(str(self.table.id), "viewer"))
        self.assertFalse(svc.check_table_permission(str(self.table.id), "editor"))
        self.assertEqual(_compute_user_table_role_safe(self.bob, self.table), "viewer")

    def test_bot_space_viewer_permission_does_not_fallback_to_organization_editor(self):
        """私有 Agent 表格的显式 viewer 不能被 Organization editor 放大成可编辑。"""
        agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            user=None,
            name="私有 Agent",
            type="bot",
            is_active=True,
        )
        bot_space = Space.objects.create(
            organization=self.organization,
            agent=agent,
            type=Space.SpaceType.WORKSPACE,
            name="私有 Agent Space",
        )
        bot_table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=bot_space.id,
            owner_id=self.owner.id,
            name="私有 Agent 表格",
        )
        TablePermission.objects.create(
            table=bot_table, subject_type="user",
            subject_id=str(self.bob.id), permission="viewer",
            is_active=True, granted_by=str(self.owner.id),
        )

        svc = BaseService(user=self.bob)
        self.assertTrue(svc.check_table_permission(str(bot_table.id), "viewer"))
        self.assertFalse(svc.check_table_permission(str(bot_table.id), "editor"))
        self.assertEqual(_compute_user_table_role_safe(self.bob, bot_table), "viewer")

    def test_bot_space_without_permission_has_no_organization_role(self):
        """私有 Agent 表格没有显式授权时不按 Organization editor 回填角色。"""
        agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            user=None,
            name="私有 Agent No Perm",
            type="bot",
            is_active=True,
        )
        bot_space = Space.objects.create(
            organization=self.organization,
            agent=agent,
            type=Space.SpaceType.WORKSPACE,
            name="私有 Agent No Perm Space",
        )
        bot_table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=bot_space.id,
            owner_id=self.owner.id,
            name="私有 Agent 未授权表格",
        )

        svc = BaseService(user=self.bob)
        self.assertFalse(svc.check_table_permission(str(bot_table.id), "viewer"))
        self.assertIsNone(_compute_user_table_role_safe(self.bob, bot_table))
        role_map = _batch_compute_roles_safe(self.bob, [bot_table])
        self.assertIsNone(role_map[str(bot_table.id)])

    def test_bot_space_explicit_editor_still_can_edit(self):
        """私有 Agent 表格仍接受显式 editor 资源授权。"""
        agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            user=None,
            name="私有 Agent Editor",
            type="bot",
            is_active=True,
        )
        bot_space = Space.objects.create(
            organization=self.organization,
            agent=agent,
            type=Space.SpaceType.WORKSPACE,
            name="私有 Agent Editor Space",
        )
        bot_table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=bot_space.id,
            owner_id=self.owner.id,
            name="私有 Agent 可编辑表格",
        )
        TablePermission.objects.create(
            table=bot_table, subject_type="user",
            subject_id=str(self.bob.id), permission="editor",
            is_active=True, granted_by=str(self.owner.id),
        )

        svc = BaseService(user=self.bob)
        self.assertTrue(svc.check_table_permission(str(bot_table.id), "editor"))

    def test_outsider_denied(self):
        svc = BaseService(user=self.outsider)
        self.assertFalse(svc.check_table_permission(str(self.table.id), "viewer"))

    def test_inactive_table_permission_ignored(self):
        TablePermission.objects.create(
            table=self.table, subject_type="user",
            subject_id=str(self.outsider.id), permission="admin",
            is_active=False, granted_by=str(self.owner.id),
        )
        svc = BaseService(user=self.outsider)
        # outsider 不在 organization，is_active=False 不应授权
        self.assertFalse(svc.check_table_permission(str(self.table.id), "viewer"))


# ════════════════════════════════════════════════════════════════════
# Wave 5 §G (W2-L1 收敛)：list_collaborators SQL N+1 监控
# ════════════════════════════════════════════════════════════════════


class ListCollaboratorsSqlQueryBudgetTests(_BaseShareServiceTests):
    """TabData 端 100 协作者 list_collaborators 查询数 ≤ 上限。

    与 TabDoc 端同标准 —— 防止 select_related/created_by 引入跨库 N+1。
    """

    def _create_n_collaborators(self, n: int) -> list:
        users = []
        for i in range(n):
            u = User.objects.create_user(
                username=f"tperfuser{i}",
                email=f"tperfuser{i}@example.com",
                password="x",
            )
            u.nickname = f"TP{i}"
            u.save()
            users.append(u)
            OrganizationMember.objects.create(
                organization=self.organization, user_id=u.id, role="editor",
            )
            TablePermission.objects.create(
                table=self.table, subject_type="user",
                subject_id=str(u.id), permission="viewer",
                is_active=True, granted_by=str(self.owner.id),
            )
        return users

    def test_query_count_bounded_under_100_collaborators(self):
        from django.test.utils import CaptureQueriesContext
        from django.db import connections

        self._create_n_collaborators(100)

        QUERY_BUDGET = 8

        with CaptureQueriesContext(connections["postgresql"]) as pg_ctx, \
                CaptureQueriesContext(connections["default"]) as default_ctx:
            result = share_service.list_collaborators(
                table_id=self.table.id, viewer=self.owner,
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
