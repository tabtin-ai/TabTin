"""
Wave 5 §7 / §H — OrganizationMember 离队级联失活的 service 测试。

覆盖：
- 失活 user 在该 organization 下所有 Document / Table 的 active permission
- 给离队用户本人逐条 auto_removed 通知
- 按 owner_id 分组发汇总通知给 doc/table owner
- 跨 owner 的资源分别通知到各 owner
- 离队用户自己拥有的资源不触发通知给自己
- organization 之外的 Permission 不受影响
"""
from __future__ import annotations

import uuid

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.services.notification.models import Notification
from apps.tabdoc.models import Document, DocumentPermission
from apps.tabdata.models import Table, TablePermission
from apps.tabtinspace.models import Device, Organization, OrganizationMember, Workspace
from apps.tabtinspace.services.cascade_service import (
    cascade_deactivate_resource_permissions,
    cascade_reassign_owned_resources,
    _notify_org_owner_reassign_summary,
)


User = get_user_model()


class _BaseCascadeTests(TestCase):
    # settings_cascade_pg_test：postgresql 是 default 的 MIRROR，声明 default 即可。
    databases = {"default"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # 关掉 User post_save 触发的默认组织创建链路（同 share_service 测试）。
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
        self.doc_owner = User.objects.create_user(
            username="doc_owner", email="docowner@example.com", password="x",
        )
        self.doc_owner.nickname = "DocOwner"
        self.doc_owner.save()

        self.table_owner = User.objects.create_user(
            username="table_owner", email="tableowner@example.com", password="x",
        )
        self.table_owner.nickname = "TableOwner"
        self.table_owner.save()

        self.carol = User.objects.create_user(
            username="carol", email="carol@example.com", password="x",
        )
        self.carol.nickname = "Carol"
        self.carol.save()

        # organization + 2 个 space（doc 和 table 可以同 space 或不同；这里同一个）
        self.organization = Organization.objects.create(
            name="Cascade WT", owner=self.doc_owner, type="team",
        )
        for u, role in [
            (self.table_owner, "editor"),
            (self.carol, "editor"),
        ]:
            OrganizationMember.objects.create(
                organization=self.organization, user_id=u.id, role=role,
            )

        self.device = Device.objects.create(
            organization=self.organization,
            user=self.doc_owner,
            name="Cascade device",
            device_type="electron",
            role="control",
            fingerprint=f"cascade-{uuid.uuid4().hex[:10]}",
            status="online",
        )
        wd = f"/tmp/cascade-wt-{uuid.uuid4().hex[:8]}"
        self.space = Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            created_by=self.doc_owner,
            name="Cascade Workspace",
            working_dir=wd,
            normalized_working_dir=wd,
        )

        # Doc A、Doc B（doc_owner 拥有）+ Table C（table_owner 拥有）
        self.doc_a = Document.objects.create(
            organization_id=self.organization.id, space_id=self.space.id,
            owner_id=self.doc_owner.id, title="Doc A",
            description_markdown="a", description_plaintext="a",
        )
        self.doc_b = Document.objects.create(
            organization_id=self.organization.id, space_id=self.space.id,
            owner_id=self.doc_owner.id, title="Doc B",
            description_markdown="b", description_plaintext="b",
        )
        self.table_c = Table.objects.create(
            organization_id=self.organization.id, space_id=self.space.id,
            owner_id=self.table_owner.id, name="Table C",
        )

        # Carol 是三个资源的协作者
        for doc, perm in [(self.doc_a, "editor"), (self.doc_b, "viewer")]:
            DocumentPermission.objects.create(
                document=doc, subject_type="user",
                subject_id=str(self.carol.id), permission=perm,
                is_active=True, granted_by=str(self.doc_owner.id),
            )
        TablePermission.objects.create(
            table=self.table_c, subject_type="user",
            subject_id=str(self.carol.id), permission="editor",
            is_active=True, granted_by=str(self.table_owner.id),
        )


class CascadeDeactivateTests(_BaseCascadeTests):

    def test_deactivates_all_doc_and_table_permissions(self):
        out = cascade_deactivate_resource_permissions(
            organization_id=str(self.organization.id),
            user_id=str(self.carol.id),
            user_name="Carol",
        )
        self.assertEqual(out["deactivated_docs"], 2)
        self.assertEqual(out["deactivated_tables"], 1)

        # 数据库层面：Carol 在该 organization 下的所有 active permission 都失活
        self.assertEqual(
            DocumentPermission.objects.filter(
                subject_id=str(self.carol.id), is_active=True,
            ).count(),
            0,
        )
        self.assertEqual(
            TablePermission.objects.filter(
                subject_id=str(self.carol.id), is_active=True,
            ).count(),
            0,
        )

    def test_carol_receives_auto_removed_notifications(self):
        cascade_deactivate_resource_permissions(
            organization_id=str(self.organization.id),
            user_id=str(self.carol.id),
            user_name="Carol",
        )
        carol_notifs = list(
            Notification.objects.filter(
                user_id=str(self.carol.id),
                type="resource_shared",
            ).order_by("created_at")
        )
        # 3 条 auto_removed（doc_a / doc_b / table_c），无 D7 合并（auto_removed 不合并）
        self.assertEqual(len(carol_notifs), 3)
        for n in carol_notifs:
            self.assertEqual(n.metadata.get("action"), "auto_removed")
            self.assertEqual(n.metadata.get("organization_id"), str(self.organization.id))

        resource_ids = {n.metadata.get("resource_id") for n in carol_notifs}
        self.assertEqual(
            resource_ids,
            {str(self.doc_a.id), str(self.doc_b.id), str(self.table_c.id)},
        )

    def test_doc_owner_receives_summary_with_two_doc_titles(self):
        cascade_deactivate_resource_permissions(
            organization_id=str(self.organization.id),
            user_id=str(self.carol.id),
            user_name="Carol",
        )
        owner_notifs = list(
            Notification.objects.filter(
                user_id=str(self.doc_owner.id),
                type="resource_shared",
                metadata__action="auto_removed_summary",
            )
        )
        self.assertEqual(len(owner_notifs), 1)
        notif = owner_notifs[0]
        self.assertIn("Carol", notif.title)
        self.assertEqual(notif.title, "已清理Carol的资源协作关系")
        self.assertEqual(notif.body, "系统已从 2 个资源中移除该成员的协作权限。")
        self.assertEqual(notif.metadata.get("total_removed"), 2)
        self.assertEqual(notif.metadata.get("removed_user_id"), str(self.carol.id))

    def test_table_owner_receives_summary_with_one_title(self):
        cascade_deactivate_resource_permissions(
            organization_id=str(self.organization.id),
            user_id=str(self.carol.id),
            user_name="Carol",
        )
        owner_notifs = list(
            Notification.objects.filter(
                user_id=str(self.table_owner.id),
                type="resource_shared",
                metadata__action="auto_removed_summary",
            )
        )
        self.assertEqual(len(owner_notifs), 1)
        notif = owner_notifs[0]
        self.assertEqual(notif.metadata.get("total_removed"), 1)
        self.assertEqual(notif.body, "系统已从 1 个资源中移除该成员的协作权限。")

    def test_owner_does_not_notify_self_for_resources_they_own(self):
        """离队用户自己拥有的资源不会给自己额外发汇总通知。"""
        # 给 carol 一个她自己拥有的 doc，再做 cascade
        carol_doc = Document.objects.create(
            organization_id=self.organization.id, space_id=self.space.id,
            owner_id=self.carol.id, title="Carol's own doc",
            description_markdown="x", description_plaintext="x",
        )
        # 但 Carol 必须有一条 active permission 才会被 cascade 扫到
        DocumentPermission.objects.create(
            document=carol_doc, subject_type="user",
            subject_id=str(self.carol.id), permission="admin",
            is_active=True, granted_by=str(self.carol.id),
        )

        cascade_deactivate_resource_permissions(
            organization_id=str(self.organization.id),
            user_id=str(self.carol.id),
            user_name="Carol",
        )

        # Carol 的 auto_removed_summary 通知数应为 0（owner == removed_user → 跳过）
        self_summary = Notification.objects.filter(
            user_id=str(self.carol.id),
            type="resource_shared",
            metadata__action="auto_removed_summary",
        ).count()
        self.assertEqual(self_summary, 0)

    def test_inactive_permissions_not_affected(self):
        """已经 is_active=False 的 permission 不会被再失活，也不触发通知。"""
        DocumentPermission.objects.filter(
            document=self.doc_b, subject_id=str(self.carol.id),
        ).update(is_active=False)

        out = cascade_deactivate_resource_permissions(
            organization_id=str(self.organization.id),
            user_id=str(self.carol.id),
            user_name="Carol",
        )
        # 只剩 doc_a 一个 active doc permission
        self.assertEqual(out["deactivated_docs"], 1)

        # Carol 收到 2 条 auto_removed（doc_a + table_c），不再有 doc_b
        carol_notifs = Notification.objects.filter(
            user_id=str(self.carol.id),
            type="resource_shared",
            metadata__action="auto_removed",
        )
        resource_ids = {n.metadata.get("resource_id") for n in carol_notifs}
        self.assertEqual(
            resource_ids,
            {str(self.doc_a.id), str(self.table_c.id)},
        )

    def test_other_organization_permissions_untouched(self):
        """跨 organization 隔离：另一个 organization 下的 Carol 协作 permission 不受影响。"""
        other_owner = User.objects.create_user(
            username="other_owner", email="other@example.com", password="x",
        )
        other_wt = Organization.objects.create(
            name="Other WT", owner=other_owner, type="team",
        )
        other_device = Device.objects.create(
            organization=other_wt,
            user=other_owner,
            name="Other device",
            device_type="electron",
            role="control",
            fingerprint=f"cascade-other-{uuid.uuid4().hex[:10]}",
            status="online",
        )
        other_wd = f"/tmp/cascade-other-{uuid.uuid4().hex[:8]}"
        other_space = Workspace.objects.create(
            organization=other_wt,
            device=other_device,
            created_by=other_owner,
            name="Other Workspace",
            working_dir=other_wd,
            normalized_working_dir=other_wd,
        )
        OrganizationMember.objects.create(
            organization=other_wt, user_id=self.carol.id, role="editor",
        )
        other_doc = Document.objects.create(
            organization_id=other_wt.id, space_id=other_space.id,
            owner_id=other_owner.id, title="Other Doc",
            description_markdown="o", description_plaintext="o",
        )
        DocumentPermission.objects.create(
            document=other_doc, subject_type="user",
            subject_id=str(self.carol.id), permission="editor",
            is_active=True, granted_by=str(other_owner.id),
        )

        # 仅对 self.organization 做 cascade
        cascade_deactivate_resource_permissions(
            organization_id=str(self.organization.id),
            user_id=str(self.carol.id),
            user_name="Carol",
        )

        # other_doc 的 permission 仍 active
        self.assertTrue(
            DocumentPermission.objects.get(
                document=other_doc, subject_id=str(self.carol.id),
            ).is_active
        )

    def test_no_active_permissions_no_op(self):
        """没有 active permission 时整个函数静默返回。"""
        # 把 Carol 三条 permission 全部失活
        DocumentPermission.objects.filter(
            subject_id=str(self.carol.id),
        ).update(is_active=False)
        TablePermission.objects.filter(
            subject_id=str(self.carol.id),
        ).update(is_active=False)

        out = cascade_deactivate_resource_permissions(
            organization_id=str(self.organization.id),
            user_id=str(self.carol.id),
            user_name="Carol",
        )

        self.assertEqual(out["deactivated_docs"], 0)
        self.assertEqual(out["deactivated_tables"], 0)
        self.assertEqual(out["user_notified"], 0)
        self.assertEqual(out["owner_notified"], 0)

    def test_missing_user_name_falls_back_to_user_lookup(self):
        """不传 user_name 时从 default 库读 nickname。"""
        cascade_deactivate_resource_permissions(
            organization_id=str(self.organization.id),
            user_id=str(self.carol.id),
            # user_name 不传
        )
        notif = Notification.objects.filter(
            user_id=str(self.doc_owner.id),
            type="resource_shared",
            metadata__action="auto_removed_summary",
        ).first()
        self.assertIsNotNone(notif)
        # Carol.nickname='Carol'，应被回填到通知文案
        self.assertIn("Carol", notif.title)


class CascadeReassignOwnedResourcesTests(_BaseCascadeTests):
    """#4370：离队时将离队者拥有的组织云资源转交组织 Owner。"""

    def test_reassigns_docs_and_tables_to_org_owner(self):
        carol_doc = Document.objects.create(
            organization_id=self.organization.id, space_id=self.space.id,
            owner_id=self.carol.id, title="Carol Doc",
            description_markdown="c", description_plaintext="c",
        )
        carol_table = Table.objects.create(
            organization_id=self.organization.id, space_id=self.space.id,
            owner_id=self.carol.id, name="Carol Table",
        )

        out = cascade_reassign_owned_resources(
            organization_id=str(self.organization.id),
            user_id=str(self.carol.id),
            org_owner_id=str(self.doc_owner.id),
            user_name="Carol",
        )

        self.assertEqual(out["reassigned"], 2)
        self.assertEqual(out["by_type"].get("doc"), 1)
        self.assertEqual(out["by_type"].get("table"), 1)
        self.assertEqual(out["owner_notified"], 1)

        carol_doc.refresh_from_db()
        carol_table.refresh_from_db()
        self.assertEqual(str(carol_doc.owner_id), str(self.doc_owner.id))
        self.assertEqual(str(carol_table.owner_id), str(self.doc_owner.id))

        # 他人资源不受影响
        self.doc_a.refresh_from_db()
        self.assertEqual(str(self.doc_a.owner_id), str(self.doc_owner.id))
        self.table_c.refresh_from_db()
        self.assertEqual(str(self.table_c.owner_id), str(self.table_owner.id))

    def test_org_owner_receives_feishu_style_summary(self):
        Document.objects.create(
            organization_id=self.organization.id, space_id=self.space.id,
            owner_id=self.carol.id, title="Handoff Doc",
            description_markdown="h", description_plaintext="h",
        )
        Table.objects.create(
            organization_id=self.organization.id, space_id=self.space.id,
            owner_id=self.carol.id, name="Handoff Table",
        )

        cascade_reassign_owned_resources(
            organization_id=str(self.organization.id),
            user_id=str(self.carol.id),
            org_owner_id=str(self.doc_owner.id),
            user_name="Carol",
        )

        notifs = list(
            Notification.objects.filter(
                user_id=str(self.doc_owner.id),
                type="resource_shared",
                metadata__action="owner_reassigned_summary",
            )
        )
        self.assertEqual(len(notifs), 1)
        notif = notifs[0]
        self.assertEqual(
            notif.title,
            "Carol创建的资源已完成转交",
        )
        self.assertNotIn("管理员已将", notif.title)
        self.assertEqual(notif.metadata.get("total_reassigned"), 2)
        self.assertEqual(notif.metadata.get("reassigned_user_id"), str(self.carol.id))
        self.assertEqual(notif.metadata.get("new_owner_id"), str(self.doc_owner.id))
        self.assertEqual(notif.metadata.get("organization_name"), self.organization.name)
        self.assertEqual(notif.body, "2 个资源已转交给组织所有者。")

    def test_no_owned_resources_is_noop(self):
        out = cascade_reassign_owned_resources(
            organization_id=str(self.organization.id),
            user_id=str(self.carol.id),
            org_owner_id=str(self.doc_owner.id),
            user_name="Carol",
        )
        self.assertEqual(out["reassigned"], 0)
        self.assertEqual(out["owner_notified"], 0)
        self.assertFalse(
            Notification.objects.filter(
                metadata__action="owner_reassigned_summary",
            ).exists()
        )

    def test_skip_when_leaving_user_is_org_owner(self):
        """防御：若误传 org owner 为离队者，直接 no-op。"""
        out = cascade_reassign_owned_resources(
            organization_id=str(self.organization.id),
            user_id=str(self.doc_owner.id),
            org_owner_id=str(self.doc_owner.id),
            user_name="DocOwner",
        )
        self.assertEqual(out["reassigned"], 0)
        self.doc_a.refresh_from_db()
        self.assertEqual(str(self.doc_a.owner_id), str(self.doc_owner.id))


class NotifyOrgOwnerReassignSummaryCopyTests(TestCase):
    """资源转交通知应直接说明成员资源已完成转交。"""

    databases = {"default"}

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
            username="reassign_owner", email="reassign-owner@example.com", password="x",
        )
        self.organization = Organization.objects.create(
            name="通知文案组织", owner=self.owner, type="team",
        )

    def test_title_mentions_member_removed_from_organization(self):
        notified = _notify_org_owner_reassign_summary(
            organization_id=str(self.organization.id),
            leaving_user_id=str(uuid.uuid4()),
            org_owner_id=str(self.owner.id),
            user_name="殷玉蒙",
            items=[{
                "resource_type": "doc",
                "resource_id": str(uuid.uuid4()),
                "resource_title": "交接文档",
            }],
        )
        self.assertEqual(notified, 1)
        notif = Notification.objects.get(
            user_id=str(self.owner.id),
            metadata__action="owner_reassigned_summary",
        )
        self.assertEqual(
            notif.title,
            "殷玉蒙创建的资源已完成转交",
        )
        self.assertEqual(notif.body, "1 个资源已转交给组织所有者。")
        self.assertEqual(notif.metadata.get("organization_name"), "通知文案组织")
