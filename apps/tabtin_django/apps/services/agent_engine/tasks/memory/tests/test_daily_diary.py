from django.test import SimpleTestCase

from apps.services.agent_engine.tasks.memory.daily_diary import (
    _json_from_llm,
    _render_diary_markdown,
)


class DailyDiaryHelpersTests(SimpleTestCase):

    def test_json_from_llm_strips_code_fence(self):
        data = _json_from_llm(
            """```json
{"title":"今日工作日记","diary":"我完成了记忆链路整理。","highlights":["补了 diary"],"open_items":[]}
```"""
        )
        self.assertEqual(data["title"], "今日工作日记")

    def test_render_diary_markdown_includes_sections(self):
        markdown = _render_diary_markdown({
            "diary": "我完成了记忆链路整理。",
            "highlights": ["补了 Agent 日记"],
            "open_items": ["继续验证前端"],
        })
        self.assertIn("我完成了记忆链路整理。", markdown)
        self.assertIn("关键进展", markdown)
        self.assertIn("未完事项", markdown)
