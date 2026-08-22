"""
Tests for ``apps.services.agent_execution.context_assembler.sanitize_historical_tool_names``.

历史 tool_name 净化（dogfood P0 修复 2026-04-30）—— 让旧 session 持久化里的
点号工具名（``tabdoc.create_document`` 等）跨轮装填回 LLM 时
不被上游 ``^[a-zA-Z0-9_-]{1,64}$`` 正则拒绝。

与本地 Runtime 的 ``sanitizeHistoricalToolName``（packages/agent-runtime/src/
history/select-recent-history.ts）对称——本测试是 Django 端的对称单元测试。
"""

from __future__ import annotations

import pytest

from apps.services.agent_execution.context_assembler import (
    _sanitize_tool_name,
    sanitize_historical_tool_names,
)


# ─── 单点字符串 sanitize ─────────────────────────────────────────────


class TestSanitizeToolName:
    def test_合法_snake_case_原样返回(self):
        assert _sanitize_tool_name("tabdoc_create_document") == "tabdoc_create_document"
        assert _sanitize_tool_name("file_read") == "file_read"
        assert _sanitize_tool_name("plan_create") == "plan_create"

    def test_退休旧名_收敛为_unknown_tool(self):
        retired_names = [
            "bash",
            "web_fetch",
            "read_file",
            "write_file",
            "delete_file",
            "plan_exit",
            "plan.exit",
        ]
        for name in retired_names:
            assert _sanitize_tool_name(name) == "unknown_tool"

    def test_合法_dashes_原样返回(self):
        assert _sanitize_tool_name("search-web") == "search-web"
        assert _sanitize_tool_name("Tool-123") == "Tool-123"

    def test_点号被替换为下划线(self):
        # 与改名后真实工具名一致 → 跨轮历史能跟当前工具列表配对
        assert _sanitize_tool_name("tabdoc.create_document") == "tabdoc_create_document"
        assert _sanitize_tool_name("plan.create") == "plan_create"
        assert _sanitize_tool_name("tabmail.send_email") == "tabmail_send_email"

    def test_连字符与点号混合(self):
        # `web-scraper.scrape_url` → `web-scraper_scrape_url`（连字符合法保留，
        # 点号替换）。不一定跟当前工具名 `web_scraper_scrape_url` 100% 匹配，
        # 但满足上游正则；这条由下游配对逻辑兜底。
        assert _sanitize_tool_name("web-scraper.scrape_url") == "web-scraper_scrape_url"

    def test_CJK_全部替换(self):
        assert _sanitize_tool_name("读取技能") == "____"
        # 长度仍合法，不至于触发 fallback "unknown_tool"

    def test_空格_被替换(self):
        assert _sanitize_tool_name("my tool") == "my_tool"

    def test_超长截断到_64(self):
        long = "a" * 100
        assert _sanitize_tool_name(long) == "a" * 64

    def test_None_或非字符串_原样返回(self):
        assert _sanitize_tool_name(None) is None
        assert _sanitize_tool_name(123) == 123
        assert _sanitize_tool_name([]) == []

    def test_空字符串_原样返回(self):
        assert _sanitize_tool_name("") == ""

    def test_全非法字符_fallback_unknown_tool(self):
        # 全部被替换成 _ 后保留，不会变空；但极端情况（比如 input 是单个
        # 非法字符）替换后 truthy，仍走正常路径
        assert _sanitize_tool_name("@@@") == "___"
        # 真正空的 fallback：极端构造（被空 regex 替换后返回空串）
        # 实际 re.sub 不会输出空，所以测一下 boundary
        assert _sanitize_tool_name("a") == "a"


# ─── messages 列表 sanitize ──────────────────────────────────────────


class TestSanitizeHistoricalToolNames:
    def test_空列表_原样返回(self):
        assert sanitize_historical_tool_names([]) == []

    def test_None_原样返回(self):
        assert sanitize_historical_tool_names(None) is None

    def test_OpenAI_风格_tool_calls_净化(self):
        messages = [
            {"role": "user", "content": "帮我建个 plan"},
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "plan.create",  # 旧名带点号
                            "arguments": '{"name":"x"}',
                        },
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "ok"},
        ]
        result = sanitize_historical_tool_names(messages)
        assert result[1]["tool_calls"][0]["function"]["name"] == "plan_create"
        # 配对的 tool 消息 tool_call_id 不变（id 跟 name 解耦）
        assert result[2]["tool_call_id"] == "call_1"

    def test_Anthropic_content_blocks_风格_tool_use_净化(self):
        messages = [
            {"role": "user", "content": "查一下"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "好的，我来调"},
                    {
                        "type": "tool_use",
                        "id": "tu_1",
                        "name": "tabdoc.create_document",  # 旧名
                        "input": {"title": "x"},
                    },
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "tu_1", "content": "ok"}
                ],
            },
        ]
        result = sanitize_historical_tool_names(messages)
        asst_blocks = result[1]["content"]
        tool_use_block = next(b for b in asst_blocks if b.get("type") == "tool_use")
        assert tool_use_block["name"] == "tabdoc_create_document"
        # text block 不被动
        text_block = next(b for b in asst_blocks if b.get("type") == "text")
        assert text_block["text"] == "好的，我来调"

    def test_合法_tool_name_不动(self):
        messages = [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "tabdoc_create_document",  # 已合规
                            "arguments": "{}",
                        },
                    }
                ],
            }
        ]
        before_name = messages[0]["tool_calls"][0]["function"]["name"]
        result = sanitize_historical_tool_names(messages)
        assert result[0]["tool_calls"][0]["function"]["name"] == before_name

    def test_role_tool_的_name_字段也净化(self):
        messages = [
            {
                "role": "tool",
                "tool_call_id": "x",
                "name": "tabmail.send_email",  # OpenAI tool 消息可选 name 字段
                "content": "{}",
            }
        ]
        result = sanitize_historical_tool_names(messages)
        assert result[0]["name"] == "tabmail_send_email"

    def test_in_place_修改(self):
        # 函数 in-place 修改 + 返回引用。caller 可任选一种使用方式。
        messages = [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "plan.exit", "arguments": "{}"},
                    }
                ],
            }
        ]
        result = sanitize_historical_tool_names(messages)
        assert result is messages
        assert messages[0]["tool_calls"][0]["function"]["name"] == "unknown_tool"

    def test_混合_OpenAI_和_Anthropic_格式(self):
        # 两种格式同一对话里出现也能各自正确净化
        messages = [
            {
                "role": "assistant",
                "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "tabdoc.create_document"}}
                ],
            },
            {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": "u1", "name": "tabmemo.create_memo"}],
            },
        ]
        sanitize_historical_tool_names(messages)
        assert messages[0]["tool_calls"][0]["function"]["name"] == "tabdoc_create_document"
        assert messages[1]["content"][0]["name"] == "tabmemo_create_memo"

    def test_异常输入_不抛错(self):
        # 防御：messages 含非 dict / tool_calls 非 list 等异常结构应当跳过不抛错
        messages = [
            None,
            "garbage",
            {"role": "assistant", "tool_calls": "not a list"},
            {"role": "assistant", "tool_calls": [None, {}, {"function": "not a dict"}]},
            {"role": "assistant", "content": "string content not list"},
            {"role": "assistant", "content": [None, "garbage", {"type": "text", "text": "ok"}]},
        ]
        # 不抛错就算通过
        result = sanitize_historical_tool_names(messages)
        assert result is messages

    def test_仍存在的历史旧名映射到当前工具名(self):
        legacy_to_current = [
            ("system.relaunch_app", "system_relaunch_app"),
            ("system.clear_os_error_blacklist", "system_clear_os_error_blacklist"),
            ("plan.create", "plan_create"),
            ("plan.update_todos", "plan_update_todos"),
        ]
        for legacy, current in legacy_to_current:
            assert _sanitize_tool_name(legacy) == current, (
                f"{legacy!r} 应净化为 {current!r}（与新工具名一致），"
                f"实际得到 {_sanitize_tool_name(legacy)!r}"
            )

    def test_Django_工具改名后的旧名映射(self):
        # 验证 Django 端 tabdoc/tabmemo/tabvideo/tabwhiteboard/tabsite/tabmail
        # 等改名后旧名能映射到新名
        legacy_to_current = [
            ("tabdoc.create_document", "tabdoc_create_document"),
            ("tabdoc.update_document", "tabdoc_update_document"),
            ("tabmemo.create_memo", "tabmemo_create_memo"),
            ("tabvideo.render_html_clip", "tabvideo_render_html_clip"),
            ("tabwhiteboard.create_canvas", "tabwhiteboard_create_canvas"),
            ("tabsite.publish_site", "tabsite_publish_site"),
            ("tabmail.send_email", "tabmail_send_email"),
            ("tabtin.search", "tabtin_search"),
        ]
        for legacy, current in legacy_to_current:
            assert _sanitize_tool_name(legacy) == current
