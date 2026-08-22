"""
_extract_rich_user_prompt 单元测试。

覆盖 checkpoint_context 中从 user 消息提取意图文本的核心函数，
包括纯文本、blocks_json fallback、多消息拼接、截断等场景。
"""

from datetime import timedelta
from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase
from django.utils import timezone


class ExtractUserPromptTestCase(SimpleTestCase):

    def setUp(self):
        self.session_id = "test-session-id"
        self.base_time = timezone.now()

    def _fn(self, mock_msgs, before_time=None, **kwargs):
        """调用 _extract_rich_user_prompt，mock ChatMessage 查询返回 mock_msgs。

        mock_msgs: list[dict] — 按 created_at 倒序排列的 values() 结果
        """
        from apps.collab.services.checkpoint_context import _extract_rich_user_prompt

        mock_qs = MagicMock()
        mock_qs.filter.return_value.order_by.return_value.values.return_value.__getitem__ = (
            MagicMock(return_value=mock_msgs)
        )

        with patch("apps.chat.conversation.models.ChatMessage") as MockCM:
            MockCM.objects = mock_qs
            return _extract_rich_user_prompt(
                self.session_id,
                before_time or self.base_time + timedelta(hours=1),
                **kwargs,
            )

    def test_plain_text_content(self):
        """纯文本 content 直接提取。"""
        result = self._fn([{"content": "帮我优化 parser", "blocks_json": []}])
        self.assertEqual(result, '帮我优化 parser')

    def test_attachment_fallback_to_blocks_json(self):
        """content 为占位符时 fallback 到 blocks_json 的 preview。"""
        result = self._fn([{
            "content": "(附件)",
            "blocks_json": [{"type": "doc_selection", "preview": "产品规格文档 第3章"}],
        }])
        self.assertEqual(result, '产品规格文档 第3章')

    def test_mixed_block_types(self):
        """多种 block type 混合：text + doc_selection + table_selection 空格拼接。"""
        result = self._fn([{
            "content": "",
            "blocks_json": [
                {"type": "text", "text": "分析一下"},
                {"type": "doc_selection", "preview": "产品文档"},
                {"type": "table_selection", "preview": "销售数据表"},
            ],
        }])
        self.assertEqual(result, '分析一下 产品文档 销售数据表')

    def test_empty_session(self):
        """空会话：无 user 消息时返回空字符串。"""
        result = self._fn([])
        self.assertEqual(result, '')

    def test_multiple_messages_join_order(self):
        """多条消息按时间正序拼接（reversed 后 — 输入为倒序）。"""
        result = self._fn([
            {"content": "继续", "blocks_json": []},
            {"content": "补充说明", "blocks_json": []},
            {"content": "第一条需求", "blocks_json": []},
        ])
        self.assertEqual(result, '第一条需求\n补充说明\n继续')

    def test_max_chars_truncation(self):
        """超长 content 截断到 max_chars。"""
        long_text = 'A' * 600
        result = self._fn(
            [{"content": long_text, "blocks_json": []}],
            max_chars=500,
        )
        self.assertEqual(len(result), 500)
        self.assertEqual(result, 'A' * 500)
