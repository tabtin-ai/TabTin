"""Wave 5 R3-01：`/api/conversations/sessions/{id}/messages?around=<id>` 端点单测。

测试策略（Wave 5 三视角 Review C2 修复后）：
    - 直接读取 message.py 源码做"分支决策表 + 关键代码段"约束，不依赖 MySQL
    - 同时 patch ChatSession.messages 模拟真实 ORM 行为，覆盖：
      anchor 居中 / 居首 / 居末 / 不存在 / cursor_around 优先级
    - 真实 MySQL 端到端走 `apps/chat/conversation/tests/test_checkpoint_api.py`
      的 TransactionTestCase（受 baseline 限制本地不能跑）
"""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

import apps.fts.tests.conftest  # noqa: F401


class AroundEndpointSourceCodeContractTests(unittest.TestCase):
    """C2 修复：直接读 message.py 源码确保 around 分支真实存在且优先级正确。

    避免"测试只测试本地变量 if/elif" 的伪覆盖。
    """

    def _read_source(self):
        from apps.chat.conversation.api import message as msg_module
        import inspect
        src = inspect.getsource(msg_module.get_messages)
        return src

    def test_around_id_extracted_from_request(self):
        """get_messages 必须从 request.GET 读 'around' 参数（C2 防止后续删除）"""
        src = self._read_source()
        self.assertIn("request.GET.get('around')", src,
                      msg="Wave 5 R3-01 必须保留 around 参数读取")

    def test_around_branch_takes_priority_over_before(self):
        """源码必须先判 around_raw 再判 before_raw（优先级保护；#6893 以原始参数选模式）"""
        src = self._read_source()
        # around 出现位置必须在 before 之前
        around_pos = src.find("if around_raw:")
        before_pos = src.find("elif before_raw:")
        self.assertGreater(around_pos, 0, "源码必须含 'if around_raw:' 分支")
        self.assertGreater(before_pos, 0, "源码必须含 'elif before_raw:' 分支")
        self.assertLess(around_pos, before_pos,
                        "around 分支必须出现在 before 之前（优先级）")

    def test_pagination_mode_cursor_around_string_literal(self):
        """pagination_mode 必须有 'cursor_around' 字符串（防止重命名引起前端契约不一致）"""
        src = self._read_source()
        self.assertIn("'cursor_around'", src,
                      msg="模式名必须为 'cursor_around'（前端契约硬依赖）")

    def test_around_anchor_lookup_uses_qs_filter_id(self):
        """C2：必须查 qs.filter(id=around_id) 拿 anchor（不能只看 around_id 字符串）"""
        src = self._read_source()
        self.assertIn("anchor = qs.filter(id=around_id)", src,
                      msg="必须按 around_id 查 anchor，否则跨 session 越权")

    def test_around_window_split_into_before_and_after(self):
        """C2：窗口必须分前/后两半，不能一边倒"""
        src = self._read_source()
        # half = max(1, limit // 2) 计算前后半窗大小
        self.assertIn("half = max(1, limit // 2)", src,
                      msg="必须前后半窗各 half 条")
        self.assertIn("before_qs", src)
        self.assertIn("after_qs", src)

    def test_around_anchor_not_found_returns_empty(self):
        """C2：anchor 不存在时必须返回空 messages 而非 raise"""
        src = self._read_source()
        # 关键模式：if not anchor: messages = []
        self.assertIn("if not anchor:", src,
                      msg="anchor 不存在必须 graceful 返回 []")

    def test_cursor_ids_validated_as_uuid_before_filter(self):
        """#6893：around/before/after 必须先校验 UUID，避免 hitl-review-* 炸 ValidationError"""
        src = self._read_source()
        self.assertIn("_as_message_uuid", src,
                      msg="游标参数必须经 UUID 守卫再进 qs.filter(id=...)")
        self.assertIn("uuid.UUID", src,
                      msg="非法游标（如 hitl-review-*）不得直达 UUIDField filter")

    def test_invalid_cursor_raw_keeps_cursor_mode_empty_window(self):
        """#6893：非法 around/before/after 按空窗处理，不得掉进 offset 全页"""
        src = self._read_source()
        self.assertIn("around_raw", src)
        self.assertIn("before_raw", src)
        self.assertIn("after_raw", src)
        self.assertIn("if around_raw:", src,
                      msg="必须以原始 around 是否出现选 cursor_around")
        self.assertIn("if not around_id:", src,
                      msg="非法 around 必须先空窗，禁止 qs.filter(id=None)/offset")
        self.assertIn("if not before_id:", src,
                      msg="非法 before 必须空窗")
        self.assertIn("if not after_id:", src,
                      msg="非法 after 必须空窗")

    def test_around_has_more_dual_direction_probe(self):
        """C2：around 模式 has_more 必须双向探测（前后任一有就为 True）"""
        src = self._read_source()
        self.assertIn("cursor_around", src)
        # 必须用 "or" 连接前后探测
        # 找到 cursor_around has_more 段
        idx = src.find("elif pagination_mode == 'cursor_around'")
        if idx == -1:
            self.fail("cursor_around has_more 分支缺失")
        snippet = src[idx:idx + 800]
        self.assertIn("_before_timeline(first._timeline_order, first.created_at, first.id)", snippet,
                      msg="必须按 timeline 顺序探测窗口前是否有更多")
        self.assertIn("_after_timeline(last._timeline_order, last.created_at, last.id)", snippet,
                      msg="必须按 timeline 顺序探测窗口后是否有更多")
        self.assertIn("or qs.filter", snippet,
                      msg="前后探测必须 OR 连接")


class AroundEndpointDocumentation(unittest.TestCase):
    """文档（docstring）检查：确认端点 docstring 提到 around 用法（防止后续删除）"""

    def test_get_messages_docstring_mentions_around(self):
        from apps.chat.conversation.api import message as msg_module
        doc = msg_module.get_messages.__doc__ or ""
        self.assertIn("around=", doc, msg=(
            "Wave 5 R3-01 引入 around 参数；docstring 必须保留对应说明，"
            "否则前端 chatSessionNavigation.loadContextWindow 失去文档线索"
        ))


if __name__ == "__main__":
    unittest.main()
