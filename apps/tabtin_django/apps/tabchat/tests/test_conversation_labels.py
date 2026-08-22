"""TC-37：会话 label（per-user, per-organization）后端测试。

覆盖：label 库 CRUD、给会话贴/撕 label、序列化注入（含系统 @me）、按 label 筛选。

对真 PG 跑：USE_SQLITE_FOR_TESTS=0 python -m pytest <path> -p no:cacheprovider --reuse-db
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

from apps.tabchat.models import ConversationLabel, ConversationMember
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.label_service import LabelService, SYSTEM_LABEL_MENTION
from apps.tabchat.services.message_service import MessageService
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type="free",
        defaults={
            "name": "免费版",
            "description": "conversation labels tests bootstrap",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
    )


class LabelCRUDTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(
            username="lb_a", email="lb_a@test.com", password="pass123", nickname="甲",
        )
        self.user_b = User.objects.create_user(
            username="lb_b", email="lb_b@test.com", password="pass123", nickname="乙",
        )
        self.organization = Organization.objects.create(name="Label Test", owner=self.user_a)
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.user_b, role="editor")

    def test_create_label(self):
        label = LabelService.create_label(
            str(self.organization.id), str(self.user_a.id), "客户A", "#FF5733"
        )
        self.assertEqual(label["name"], "客户A")
        self.assertEqual(label["color"], "#ff5733")
        self.assertFalse(label["is_system"])
        self.assertEqual(label["conversation_count"], 0)

    def test_create_label_duplicate_rejected(self):
        LabelService.create_label(str(self.organization.id), str(self.user_a.id), "项目X")
        with self.assertRaises(ValueError):
            LabelService.create_label(str(self.organization.id), str(self.user_a.id), "项目X")

    def test_create_label_invalid_color_falls_back(self):
        label = LabelService.create_label(
            str(self.organization.id), str(self.user_a.id), "测试色", "not-a-hex"
        )
        self.assertEqual(label["color"], "#6b7280")

    def test_create_label_invalid_name_rejected(self):
        with self.assertRaises(ValueError):
            LabelService.create_label(str(self.organization.id), str(self.user_a.id), "")
        with self.assertRaises(ValueError):
            LabelService.create_label(str(self.organization.id), str(self.user_a.id), "x" * 33)

    def test_update_label_name_and_color(self):
        label = LabelService.create_label(
            str(self.organization.id), str(self.user_a.id), "旧名", "#111111"
        )
        updated = LabelService.update_label(
            label["id"], str(self.user_a.id), name="新名", color="#222222"
        )
        self.assertEqual(updated["name"], "新名")
        self.assertEqual(updated["color"], "#222222")

    def test_update_label_duplicate_name_rejected(self):
        LabelService.create_label(str(self.organization.id), str(self.user_a.id), "名1")
        label2 = LabelService.create_label(str(self.organization.id), str(self.user_a.id), "名2")
        with self.assertRaises(ValueError):
            LabelService.update_label(label2["id"], str(self.user_a.id), name="名1")

    def test_delete_label_removes_from_conversations(self):
        conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )
        label = LabelService.create_label(
            str(self.organization.id), str(self.user_a.id), "待删"
        )
        LabelService.add_labels_to_conversation(
            str(conv.id), str(self.user_a.id), [label["id"]]
        )
        affected = LabelService.delete_label(label["id"], str(self.user_a.id))
        self.assertEqual(affected, 1)
        # label 从会话撕掉
        remaining = LabelService.get_conversation_labels_raw(
            str(conv.id), str(self.user_a.id)
        )
        self.assertEqual(remaining, [])
        # label 库里也没了
        self.assertFalse(
            ConversationLabel.objects.filter(id=label["id"]).exists()
        )

    def test_labels_are_per_user(self):
        """A 的 label 库 B 看不到。"""
        LabelService.create_label(str(self.organization.id), str(self.user_a.id), "A的标")
        b_labels = LabelService.list_labels(str(self.organization.id), str(self.user_b.id))
        self.assertEqual(len(b_labels), 0)

    def test_labels_are_per_organization(self):
        """同用户在不同 organization 有独立 label 库。"""
        LabelService.create_label(str(self.organization.id), str(self.user_a.id), "团队1标")
        wt2 = Organization.objects.create(name="Label Test 2", owner=self.user_a)
        OrganizationMember.objects.create(organization=wt2, user=self.user_a, role="owner")
        wt2_labels = LabelService.list_labels(str(wt2.id), str(self.user_a.id))
        self.assertEqual(len(wt2_labels), 0)


class ConversationLabelTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(
            username="cb_a", email="cb_a@test.com", password="pass123", nickname="甲",
        )
        self.user_b = User.objects.create_user(
            username="cb_b", email="cb_b@test.com", password="pass123", nickname="乙",
        )
        self.organization = Organization.objects.create(name="Conv Label Test", owner=self.user_a)
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.user_b, role="editor")
        self.conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )

    def test_add_and_remove_label(self):
        label = LabelService.create_label(
            str(self.organization.id), str(self.user_a.id), "客户A"
        )
        result = LabelService.add_labels_to_conversation(
            str(self.conv.id), str(self.user_a.id), [label["id"]]
        )
        self.assertEqual(len(result["labels"]), 1)
        self.assertEqual(result["labels"][0]["name"], "客户A")

        # 撕掉
        result = LabelService.remove_label_from_conversation(
            str(self.conv.id), str(self.user_a.id), label["id"]
        )
        self.assertEqual(result["labels"], [])

    def test_add_label_from_other_organization_rejected(self):
        """不能给本 organization 会话贴别的 organization 的 label。"""
        wt2 = Organization.objects.create(name="Other WT", owner=self.user_a)
        OrganizationMember.objects.create(organization=wt2, user=self.user_a, role="owner")
        foreign_label = LabelService.create_label(
            str(wt2.id), str(self.user_a.id), "外团标"
        )
        with self.assertRaises(ValueError):
            LabelService.add_labels_to_conversation(
                str(self.conv.id), str(self.user_a.id), [foreign_label["id"]]
            )

    def test_list_conversations_includes_labels(self):
        label = LabelService.create_label(
            str(self.organization.id), str(self.user_a.id), "项目P", "#00aa00"
        )
        LabelService.add_labels_to_conversation(
            str(self.conv.id), str(self.user_a.id), [label["id"]]
        )
        convs = ConversationService.list_conversations(
            str(self.organization.id), str(self.user_a.id)
        )
        target = [c for c in convs if c["id"] == str(self.conv.id)][0]
        self.assertEqual(len(target["labels"]), 1)
        self.assertEqual(target["labels"][0]["name"], "项目P")
        self.assertEqual(target["labels"][0]["color"], "#00aa00")

    def test_system_mention_label_injected(self):
        """被 @ 且未读 → 序列化注入系统 @me label。"""
        # A 给 B 发一条 @ B 的消息
        msg = MessageService.send_message(
            str(self.conv.id), str(self.user_a.id),
            "@乙 看一下",
            metadata={"mentioned_user_ids": [str(self.user_b.id)]},
        )
        # B 视角：会话应有系统 @me label
        convs = ConversationService.list_conversations(
            str(self.organization.id), str(self.user_b.id)
        )
        target = [c for c in convs if c["id"] == str(self.conv.id)][0]
        label_ids = [l["id"] for l in target["labels"]]
        self.assertIn(SYSTEM_LABEL_MENTION, label_ids)
        sys_lbl = next(l for l in target["labels"] if l["id"] == SYSTEM_LABEL_MENTION)
        self.assertTrue(sys_lbl["is_system"])

    def test_system_mention_label_cleared_after_read(self):
        """B 已读后 @me label 消失。"""
        msg = MessageService.send_message(
            str(self.conv.id), str(self.user_a.id),
            "@乙 看一下",
            metadata={"mentioned_user_ids": [str(self.user_b.id)]},
        )
        MessageService.mark_as_read(str(self.conv.id), str(self.user_b.id))
        convs = ConversationService.list_conversations(
            str(self.organization.id), str(self.user_b.id)
        )
        target = [c for c in convs if c["id"] == str(self.conv.id)][0]
        label_ids = [l["id"] for l in target["labels"]]
        self.assertNotIn(SYSTEM_LABEL_MENTION, label_ids)

    def test_filter_conversations_by_label(self):
        """按自定义 label AND 筛选。"""
        conv2 = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name="群2",
            member_ids=[str(self.user_b.id)],
        )
        label1 = LabelService.create_label(
            str(self.organization.id), str(self.user_a.id), "标1"
        )
        label2 = LabelService.create_label(
            str(self.organization.id), str(self.user_a.id), "标2"
        )
        # conv 贴标1，conv2 贴标1+标2
        LabelService.add_labels_to_conversation(
            str(self.conv.id), str(self.user_a.id), [label1["id"]]
        )
        LabelService.add_labels_to_conversation(
            str(conv2.id), str(self.user_a.id), [label1["id"], label2["id"]]
        )
        # 筛选标1 → 两个都返回
        filtered = ConversationService.list_conversations(
            str(self.organization.id), str(self.user_a.id),
            label_ids=[label1["id"]],
        )
        filtered_ids = {c["id"] for c in filtered}
        self.assertEqual(filtered_ids, {str(self.conv.id), str(conv2.id)})
        # 筛选标1 AND 标2 → 只 conv2
        filtered = ConversationService.list_conversations(
            str(self.organization.id), str(self.user_a.id),
            label_ids=[label1["id"], label2["id"]],
        )
        filtered_ids = {c["id"] for c in filtered}
        self.assertEqual(filtered_ids, {str(conv2.id)})

    def test_filter_conversations_by_system_mention_label(self):
        """按系统 @me label 筛选。"""
        # A @ B
        MessageService.send_message(
            str(self.conv.id), str(self.user_a.id),
            "@乙 看一下",
            metadata={"mentioned_user_ids": [str(self.user_b.id)]},
        )
        # B 视角筛 @me → 只 conv
        filtered = ConversationService.list_conversations(
            str(self.organization.id), str(self.user_b.id),
            label_ids=[SYSTEM_LABEL_MENTION],
        )
        filtered_ids = {c["id"] for c in filtered}
        self.assertIn(str(self.conv.id), filtered_ids)

    def test_get_conversation_detail_includes_labels(self):
        label = LabelService.create_label(
            str(self.organization.id), str(self.user_a.id), "详情标"
        )
        LabelService.add_labels_to_conversation(
            str(self.conv.id), str(self.user_a.id), [label["id"]]
        )
        detail = ConversationService.get_conversation_detail(
            str(self.conv.id), str(self.user_a.id)
        )
        self.assertEqual(len(detail["labels"]), 1)
        self.assertEqual(detail["labels"][0]["name"], "详情标")
        self.assertFalse(detail["has_unread_mention"])

    def test_labels_not_shared_between_users(self):
        """A 给会话贴 label，B 看不到该 label。"""
        label = LabelService.create_label(
            str(self.organization.id), str(self.user_a.id), "A的标"
        )
        LabelService.add_labels_to_conversation(
            str(self.conv.id), str(self.user_a.id), [label["id"]]
        )
        convs_b = ConversationService.list_conversations(
            str(self.organization.id), str(self.user_b.id)
        )
        target_b = [c for c in convs_b if c["id"] == str(self.conv.id)][0]
        self.assertEqual(target_b["labels"], [])
