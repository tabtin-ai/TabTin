"""commit_message_generation 轻量单测。"""

from unittest.mock import patch

from django.test import SimpleTestCase

from apps.chat.conversation.services.commit_message_generator import (
    clean_commit_message,
    generate_commit_message,
)


class CleanCommitMessageTests(SimpleTestCase):
    def test_takes_first_non_empty_line(self):
        self.assertEqual(
            clean_commit_message("feat(tabcode): add ai commit\n\nextra body"),
            "feat(tabcode): add ai commit",
        )

    def test_strips_quotes_and_meta(self):
        self.assertEqual(
            clean_commit_message('Commit message:\n"fix: handle empty staged"'),
            "fix: handle empty staged",
        )

    def test_rejects_empty(self):
        self.assertIsNone(clean_commit_message("   \n  "))


class GenerateCommitMessageTests(SimpleTestCase):
    @patch("apps.services.llm.services.chat.unified_llm_call")
    def test_calls_scene_and_cleans(self, mock_call):
        mock_call.return_value.content = "feat(api): generate commit message\n"
        result = generate_commit_message(
            files=["apps/foo.py"],
            diff_excerpt="diff --git a/apps/foo.py",
            truncated=False,
            user_id="u1",
            organization_id="o1",
        )
        self.assertEqual(result, "feat(api): generate commit message")
        kwargs = mock_call.call_args.kwargs
        self.assertEqual(kwargs["scene_key"], "commit_message_generation")
        self.assertEqual(kwargs["organization_id"], "o1")
        self.assertEqual(kwargs["variables"]["files"], ["apps/foo.py"])

    @patch("apps.services.llm.services.chat.unified_llm_call")
    def test_forwards_resolved_default_model(self, mock_call):
        mock_call.return_value.content = "fix(api): use selected model"

        result = generate_commit_message(
            files=["apps/foo.py"],
            diff_excerpt="diff --git a/apps/foo.py",
            truncated=False,
            user_id="u1",
            organization_id="o1",
            selected_model_id="model-byok",
        )

        self.assertEqual(result, "fix(api): use selected model")
        self.assertEqual(
            mock_call.call_args.kwargs["selected_model_id"],
            "model-byok",
        )


class CommitMessageModelSelectionTests(SimpleTestCase):
    def test_user_default_model_wins_over_organization_default(self):
        from apps.chat.conversation.api.git import _resolve_commit_message_model_id

        with (
            patch(
                "apps.chat.conversation.api.git._read_user_default_model_id",
                return_value="user-byok",
            ),
            patch(
                "apps.chat.conversation.api.git._get_organization_default_model_id",
                return_value="organization-official",
            ),
        ):
            selected = _resolve_commit_message_model_id("user-1", "org-1")

        self.assertEqual(selected, "user-byok")

    def test_organization_default_is_used_when_user_has_no_default(self):
        from apps.chat.conversation.api.git import _resolve_commit_message_model_id

        with (
            patch(
                "apps.chat.conversation.api.git._read_user_default_model_id",
                return_value="",
            ),
            patch(
                "apps.chat.conversation.api.git._get_organization_default_model_id",
                return_value="organization-official",
            ),
        ):
            selected = _resolve_commit_message_model_id("user-1", "org-1")

        self.assertEqual(selected, "organization-official")
