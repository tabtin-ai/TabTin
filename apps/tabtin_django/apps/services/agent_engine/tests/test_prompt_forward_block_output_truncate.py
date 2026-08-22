"""#10610 canonical result 契约：转发层 tool_call output 截断的单边界回归。

截断只发生在执行端装填历史时（共享包 TOOL_RESULT_MAX_CHARS=40_000 截一次）；
Django 转发层不改内容，只保留 400K 灾难保护。本测试锁定该契约，防止阈值
回调（如改回 5000/40_000）复活双重截断——「截后 + 说明」超过执行端阈值会
被再截一次、第一层说明被切掉。
"""

from django.test import SimpleTestCase

from apps.services.agent_engine.services.prompt_forward_service import (
    _BLOCK_OUTPUT_PRE_TRUNCATE_CHARS,
    _truncate_block_outputs,
)


def _tool_call_block(output: str) -> dict:
    return {
        "type": "tool_call",
        "tool_call_id": "tc-1",
        "tool_name": "run_terminal_command",
        "input": {"command": "rg -n pattern"},
        "output": output,
    }


class BlockOutputTruncateTests(SimpleTestCase):
    def test_threshold_is_disaster_level_not_fill_level(self):
        # 单边界前提：本阈值必须显著大于执行端装填上限（40_000）与终端
        # canonical envelope 上限（150K），正常路径不触发。
        self.assertEqual(_BLOCK_OUTPUT_PRE_TRUNCATE_CHARS, 400_000)

    def test_terminal_canonical_envelope_passes_through_unchanged(self):
        # 终端 canonical envelope 最大 ~150K：必须原样透传（字节不变）。
        output = "E" * 150_000
        result = _truncate_block_outputs([_tool_call_block(output)])
        self.assertEqual(result[0]["output"], output)

    def test_exactly_at_threshold_passes_through_unchanged(self):
        output = "X" * _BLOCK_OUTPUT_PRE_TRUNCATE_CHARS
        result = _truncate_block_outputs([_tool_call_block(output)])
        self.assertEqual(result[0]["output"], output)

    def test_over_threshold_triggers_disaster_truncation(self):
        output = "H" * (_BLOCK_OUTPUT_PRE_TRUNCATE_CHARS + 1)
        result = _truncate_block_outputs([_tool_call_block(output)])
        truncated = result[0]["output"]
        self.assertNotEqual(truncated, output)
        self.assertTrue(truncated.startswith("H" * 1000))
        self.assertIn("pre-truncated", truncated)

    def test_input_blocks_not_mutated_in_place(self):
        output = "M" * (_BLOCK_OUTPUT_PRE_TRUNCATE_CHARS + 1)
        original = _tool_call_block(output)
        _truncate_block_outputs([original])
        self.assertEqual(original["output"], output)
