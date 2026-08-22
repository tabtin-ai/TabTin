"""#6741 / ：title_generation 提示词约束。"""

from pathlib import Path

from django.test import SimpleTestCase

_TITLE_GEN_DIR = (
    Path(__file__).resolve().parents[3]
    / "services"
    / "llm"
    / "scenes"
    / "bundled"
    / "title_generation"
)


class TestTitleGenerationPromptConstraints(SimpleTestCase):
    def test_system_prompt_forbids_meta_titles_and_empty_fallback(self):
        system = (_TITLE_GEN_DIR / "system.md").read_text(encoding="utf-8")
        assert "会话标题生成助手" not in system
        assert "新任务" in system
        assert "元描述" in system
        assert "title generation" in system
        # 空回落不得写成「无法判断主题」——会把短正文吞成「新任务」
        assert "无法判断主题" not in system
        assert "为空或仅空白" in system

    def test_user_prompt_asks_topic_title_with_empty_fallback(self):
        user = (_TITLE_GEN_DIR / "user.md.tmpl").read_text(encoding="utf-8")
        assert "请根据以下对话内容生成一个标题" not in user
        assert "新任务" in user
        assert "用户消息" in user
        assert "助手:" not in user
        assert "无法判断主题" not in user
        # 不特判问候语等业务场景
        assert "问候" not in user
        assert "打招呼" not in user

    def test_system_prompt_user_messages_only(self):
        system = (_TITLE_GEN_DIR / "system.md").read_text(encoding="utf-8")
        assert "只依据用户消息" in system or "忽略助手回复" in system
        assert "问候" not in system
        assert "打招呼" not in system

    def test_system_prompt_any_visible_text_must_summarize(self):
        system = (_TITLE_GEN_DIR / "system.md").read_text(encoding="utf-8")
        assert "可见用户正文" in system
