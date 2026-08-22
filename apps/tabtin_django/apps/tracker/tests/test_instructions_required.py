"""#4230 / ：纯 Agent 模式必须有执行指令。"""

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from apps.tracker.services.tracker_service import (
    _extract_tracker_instructions,
    _require_tracker_instructions,
)
from apps.tracker.utils import humanize_failure_message, translate_skill_error


class RequireInstructionsTests(SimpleTestCase):
    def test_extract_handles_null_and_non_dict(self):
        self.assertEqual(_extract_tracker_instructions(None), "")
        self.assertEqual(_extract_tracker_instructions("x"), "")
        self.assertEqual(_extract_tracker_instructions({"instructions": "  做日报  "}), "做日报")

    def test_pure_agent_requires_instructions(self):
        with self.assertRaises(ValidationError) as ctx:
            _require_tracker_instructions(None, skill_key="")
        self.assertIn("执行指令", str(ctx.exception))

        with self.assertRaises(ValidationError):
            _require_tracker_instructions({"instructions": "  "}, skill_key="")

    def test_bound_skill_allows_empty_instructions(self):
        _require_tracker_instructions(None, skill_key="app:tabmemo-operator")
        _require_tracker_instructions({"instructions": ""}, skill_key="research")

    def test_humanize_empty_instructions(self):
        msg = humanize_failure_message(
            "未填写执行指令，无法执行。请编辑任务补上「执行指令」后再试。"
        )
        self.assertIn("执行指令", msg)
        self.assertNotIn("执行没能跑完", msg)

    def test_humanize_missing_system_default_model(self):
        result = translate_skill_error(
            "系统默认模型解析失败，当前没有可路由的聊天模型。请检查模型路由配置后再试。"
        )
        self.assertIn("默认", result["message"])
        self.assertNotIn("Agent 设置", result["message"])
        self.assertTrue(result["recovery_action_items"])
