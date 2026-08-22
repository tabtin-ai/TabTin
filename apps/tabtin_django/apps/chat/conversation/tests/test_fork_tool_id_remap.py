"""#7033 fork tool_use id remap 单元测试。"""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

from apps.chat.conversation.services.fork_tool_id_remap import (  # noqa: E402
    TOOL_REF_KEYS,
    TOOL_USE_TYPES,
    ForkToolIdMapper,
    is_tabtin_tool_use_id,
    remap_content_blocks_json,
    remap_messages_json,
    remap_tool_ids_in_value,
)

# 与 TS `FORK_TOOL_USE_TYPES` / `FORK_TOOL_REF_KEYS` 对齐；改一端必须改另一端测试
_TS_TOOL_USE_TYPES = frozenset({
    "tool_use",
    "tool_call",
    "function_call",
    "function",
    "server_tool_use",
    "mcp_tool_use",
})
_TS_TOOL_REF_KEYS = frozenset({"tool_use_id", "tool_call_id", "toolCallId"})


class TestCrossLanguageContract:
    def test_tool_use_types_match_ts(self):
        assert TOOL_USE_TYPES == _TS_TOOL_USE_TYPES

    def test_tool_ref_keys_match_ts(self):
        assert TOOL_REF_KEYS == _TS_TOOL_REF_KEYS



class TestForkToolIdMapper:
    def test_stable_within_mapper(self):
        mapper = ForkToolIdMapper()
        a = mapper.allocate("run_terminal_command_41")
        b = mapper.allocate("run_terminal_command_41")
        assert a == b
        assert is_tabtin_tool_use_id(a)

    def test_independent_mappers_differ(self):
        a = ForkToolIdMapper().allocate("run_terminal_command_41")
        b = ForkToolIdMapper().allocate("run_terminal_command_41")
        assert a != b

    def test_snapshot_and_seed_share_namespace(self):
        cloud = ForkToolIdMapper()
        cloud_id = cloud.allocate("run_terminal_command_41")
        snap = cloud.snapshot()
        local = ForkToolIdMapper()
        local.seed(snap)
        assert local.allocate("run_terminal_command_41") == cloud_id


class TestRemapToolIdsInValue:
    def test_pairs_tool_use_and_result(self):
        mapper = ForkToolIdMapper()
        messages = [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "run_terminal_command_41",
                        "name": "run_terminal_command",
                        "input": {},
                    }
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "run_terminal_command_41",
                        "content": "ok",
                    }
                ],
            },
        ]
        out = remap_messages_json(messages, mapper)
        use_id = out[0]["content"][0]["id"]
        result_id = out[1]["content"][0]["tool_use_id"]
        assert is_tabtin_tool_use_id(use_id)
        assert result_id == use_id
        assert use_id != "run_terminal_command_41"

    def test_content_blocks_json_widget_tool_ref(self):
        mapper = ForkToolIdMapper()
        blocks = [
            {"type": "tool_use", "id": "call_9", "name": "x", "input": {}},
            {
                "type": "widget",
                "payload": {"tool_call_id": "call_9"},
            },
        ]
        out = remap_content_blocks_json(blocks, mapper)
        assert is_tabtin_tool_use_id(out[0]["id"])
        assert out[1]["payload"]["tool_call_id"] == out[0]["id"]

    def test_does_not_touch_text_block_id(self):
        mapper = ForkToolIdMapper()
        out = remap_tool_ids_in_value(
            {"type": "text", "id": "block-1", "text": "hi"},
            mapper,
        )
        assert out["id"] == "block-1"
        assert mapper.size == 0

    def test_does_not_remap_id_function_without_name(self):
        mapper = ForkToolIdMapper()
        out = remap_tool_ids_in_value(
            {"id": "widget-1", "function": {"kind": "not-a-tool"}},
            mapper,
        )
        assert out["id"] == "widget-1"
        assert mapper.size == 0

    def test_openai_conversation_state_tool_calls_paired(self):
        """ConversationState 是 OpenAI 形态：tool_calls[].type=function + tool_call_id。"""
        mapper = ForkToolIdMapper()
        messages = [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "run_terminal_command_41",
                        "type": "function",
                        "function": {
                            "name": "run_terminal_command",
                            "arguments": "{}",
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "run_terminal_command_41",
                "content": "ok",
            },
        ]
        out = remap_messages_json(messages, mapper)
        call_id = out[0]["tool_calls"][0]["id"]
        result_id = out[1]["tool_call_id"]
        assert is_tabtin_tool_use_id(call_id)
        assert result_id == call_id
        assert call_id != "run_terminal_command_41"
