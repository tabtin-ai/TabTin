"""TC-36：全文搜索扩展（文件名 + 资源卡元数据）后端测试。

覆盖：search_text 聚合、文件名/资源卡标题/描述可搜、match_types 判定、
sender_type 标识、edit_message 重算 search_text。

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

from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService, _compute_search_text
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type="free",
        defaults={
            "name": "免费版",
            "description": "search metadata tests bootstrap",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
    )


class SearchMetadataTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()
        self.user_a = User.objects.create_user(
            username="sm_a", email="sm_a@test.com", password="pass123", nickname="甲",
        )
        self.user_b = User.objects.create_user(
            username="sm_b", email="sm_b@test.com", password="pass123", nickname="乙",
        )
        self.organization = Organization.objects.create(name="Search Meta Test", owner=self.user_a)
        OrganizationMember.objects.create(organization=self.organization, user=self.user_a, role="owner")
        OrganizationMember.objects.create(organization=self.organization, user=self.user_b, role="editor")
        self.conv = ConversationService.create_dm(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            other_user_id=str(self.user_b.id),
        )

    def test_grouped_search_paginates_conversations_independently(self):
        group = ConversationService.create_group(
            organization_id=str(self.organization.id),
            creator_id=str(self.user_a.id),
            name="分页群",
            member_ids=[str(self.user_b.id)],
        )
        MessageService.send_message(
            str(self.conv.id), str(self.user_a.id), "聚合分页针 私聊",
        )
        MessageService.send_message(
            str(group.id), str(self.user_a.id), "聚合分页针 群聊",
        )

        first_page = MessageService.search_message_groups(
            organization_id=str(self.organization.id),
            user_id=str(self.user_a.id),
            query="聚合分页针",
            group_limit=1,
            per_group_limit=1,
        )
        second_page = MessageService.search_message_groups(
            organization_id=str(self.organization.id),
            user_id=str(self.user_a.id),
            query="聚合分页针",
            group_offset=first_page["next_group_offset"],
            group_limit=1,
            per_group_limit=1,
        )

        self.assertTrue(first_page["has_more"])
        self.assertEqual(first_page["next_group_offset"], 1)
        self.assertEqual(len(first_page["groups"]), 1)
        self.assertFalse(second_page["has_more"])
        self.assertEqual(len(second_page["groups"]), 1)
        self.assertNotEqual(
            first_page["groups"][0]["conversation_id"],
            second_page["groups"][0]["conversation_id"],
        )

    def test_grouped_search_paginates_messages_inside_one_conversation(self):
        sent_ids = []
        for index in range(5):
            message = MessageService.send_message(
                str(self.conv.id),
                str(self.user_a.id),
                f"组内分页针 {index}",
            )
            sent_ids.append(message.id)

        grouped = MessageService.search_message_groups(
            organization_id=str(self.organization.id),
            user_id=str(self.user_a.id),
            query="组内分页针",
            group_limit=1,
            per_group_limit=2,
        )
        result_group = grouped["groups"][0]
        next_messages = MessageService.search_messages(
            organization_id=str(self.organization.id),
            user_id=str(self.user_a.id),
            query="组内分页针",
            conversation_id=str(self.conv.id),
            limit=2,
            offset=result_group["next_message_offset"],
        )

        self.assertEqual(result_group["match_count"], 5)
        self.assertEqual(len(result_group["messages"]), 2)
        self.assertTrue(result_group["messages_has_more"])
        self.assertEqual(result_group["next_message_offset"], 2)
        self.assertEqual(len(next_messages), 2)
        self.assertTrue(
            set(item["id"] for item in result_group["messages"]).isdisjoint(
                item["id"] for item in next_messages
            )
        )
        self.assertTrue(set(item["id"] for item in next_messages).issubset(sent_ids))

    def test_compute_search_text_aggregates_fields(self):
        """_compute_search_text 聚合 content + file_name + card title/desc"""
        text = _compute_search_text("hello", {"file_name": "排期Q3.xlsx"})
        self.assertIn("hello", text)
        self.assertIn("排期Q3.xlsx", text)

        text = _compute_search_text("看这个", {
            "card": {"title": "Q3排期表", "description": "第三季度排期"}
        })
        self.assertIn("看这个", text)
        self.assertIn("Q3排期表", text)
        self.assertIn("第三季度排期", text)

        # 空 metadata 只返回 content
        text = _compute_search_text("only content", None)
        self.assertEqual(text, "only content")

    def test_search_finds_file_name(self):
        """搜文件名能命中文件消息（CJK LIKE 路径）"""
        MessageService.send_message(
            str(self.conv.id), str(self.user_a.id),
            "",  # 文件消息正文为空
            metadata={"file_name": "排期Q3.xlsx", "file_size": 1024},
        )
        results = MessageService.search_messages(
            organization_id=str(self.organization.id),
            user_id=str(self.user_a.id),
            query="排期",
        )
        self.assertTrue(len(results) > 0)
        self.assertIn("file_name", results[0]["match_types"])
        self.assertEqual(results[0]["conversation_type"], self.conv.type)
        self.assertEqual(results[0]["conversation_avatar_url"], self.conv.avatar_url)

    def test_search_finds_card_title(self):
        """搜资源卡标题能命中资源卡消息"""
        # 直接构造 Message 绕过 _validate_card_metadata（需要真实资源），
        # 只验证 search_text 聚合 + 搜索链路
        from apps.tabchat.models import Message
        from apps.tabchat.constants import MessageType
        msg = Message.objects.create(
            conversation=self.conv,
            seq=Message.objects.filter(conversation=self.conv).count() + 1,
            sender_id=str(self.user_a.id),
            sender_type="user",
            content="[表格]",
            message_type=MessageType.TEXT,
            metadata={"card": {"type": "table", "title": "Q3排期表", "description": ""}},
            has_attachment=False,
        )
        # 手动算 search_text + tsvector（模拟 send_message 的路径）
        search_text = _compute_search_text(msg.content, msg.metadata)
        from django.contrib.postgres.search import SearchVector
        Message.objects.filter(pk=msg.pk).update(
            search_text=search_text,
            search_tsvector=SearchVector("search_text", config="simple"),
        )
        results = MessageService.search_messages(
            organization_id=str(self.organization.id),
            user_id=str(self.user_a.id),
            query="排期",
        )
        self.assertTrue(len(results) > 0, "应能搜到资源卡标题")
        matched = [r for r in results if "card_title" in r["match_types"]]
        self.assertTrue(len(matched) > 0, "match_types 应含 card_title")

    def test_search_finds_card_description(self):
        """搜资源卡描述能命中"""
        from apps.tabchat.models import Message
        from apps.tabchat.constants import MessageType
        msg = Message.objects.create(
            conversation=self.conv,
            seq=Message.objects.filter(conversation=self.conv).count() + 1,
            sender_id=str(self.user_a.id),
            sender_type="user",
            content="[文档]",
            message_type=MessageType.TEXT,
            metadata={"card": {"type": "document", "title": "需求", "description": "Q3排期说明文档"}},
            has_attachment=False,
        )
        search_text = _compute_search_text(msg.content, msg.metadata)
        from django.contrib.postgres.search import SearchVector
        Message.objects.filter(pk=msg.pk).update(
            search_text=search_text,
            search_tsvector=SearchVector("search_text", config="simple"),
        )
        results = MessageService.search_messages(
            organization_id=str(self.organization.id),
            user_id=str(self.user_a.id),
            query="排期",
        )
        self.assertTrue(len(results) > 0, "应能搜到资源卡描述")
        matched = [r for r in results if "card_description" in r["match_types"]]
        self.assertTrue(len(matched) > 0, "match_types 应含 card_description")

    def test_search_content_still_works(self):
        """搜正文不回归"""
        MessageService.send_message(
            str(self.conv.id), str(self.user_a.id),
            "明天讨论排期",
        )
        results = MessageService.search_messages(
            organization_id=str(self.organization.id),
            user_id=str(self.user_a.id),
            query="排期",
        )
        self.assertTrue(len(results) > 0)
        self.assertIn("content", results[0]["match_types"])

    def test_search_returns_sender_type(self):
        """结果带 sender_type"""
        MessageService.send_message(
            str(self.conv.id), str(self.user_a.id), "测试消息"
        )
        results = MessageService.search_messages(
            organization_id=str(self.organization.id),
            user_id=str(self.user_a.id),
            query="测试",
        )
        self.assertTrue(len(results) > 0)
        self.assertEqual(results[0]["sender_type"], "user")

    def test_edit_message_recomputes_search_text(self):
        """编辑消息后 search_text 重算，新关键词可搜"""
        msg = MessageService.send_message(
            str(self.conv.id), str(self.user_a.id), "原始内容"
        )
        # 搜「新词」应无结果
        results = MessageService.search_messages(
            str(self.organization.id), str(self.user_a.id), query="新词"
        )
        self.assertEqual(len(results), 0)
        # 编辑加入新词
        MessageService.edit_message(
            str(self.conv.id), msg.id, str(self.user_a.id), "加入新词的内容"
        )
        results = MessageService.search_messages(
            str(self.organization.id), str(self.user_a.id), query="新词"
        )
        self.assertTrue(len(results) > 0)

    def test_search_only_user_conversations(self):
        """只搜用户参与的会话"""
        # user_c 不在 conv 里
        user_c = User.objects.create_user(
            username="sm_c", email="sm_c@test.com", password="pass123", nickname="丙",
        )
        OrganizationMember.objects.create(organization=self.organization, user=user_c, role="editor")
        MessageService.send_message(
            str(self.conv.id), str(self.user_a.id), "排期讨论"
        )
        results = MessageService.search_messages(
            organization_id=str(self.organization.id),
            user_id=str(user_c.id),
            query="排期",
        )
        self.assertEqual(len(results), 0)
