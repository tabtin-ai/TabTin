from django.test import SimpleTestCase

from apps.tabchat.constants import ConversationType, MessageType
from apps.tabchat.services.mention_markdown import format_mention_display_text
from apps.tabchat.services.message_service import _build_preview


class MentionMarkdownPreviewTests(SimpleTestCase):
    def test_format_mention_display_text_hides_href(self):
        self.assertEqual(
            format_mention_display_text(
                "user_0941: [@小Tin](mention:agent/d16b77ff-aaaa) 看下",
            ),
            "user_0941: @小Tin 看下",
        )
        self.assertNotIn(
            "mention:",
            format_mention_display_text("[@所有人](mention:all) 集合"),
        )

    def test_build_preview_strips_mention_markdown(self):
        preview = _build_preview(
            MessageType.TEXT,
            "[@小Tin](mention:agent/d16b77ff-aaaa-bbbb-cccc-ddddeeeeffff) 看下",
            None,
        )
        self.assertEqual(preview, "@小Tin 看下")
        self.assertNotIn("mention:", preview)

    def test_group_preview_strips_mention_markdown_after_sender_prefix(self):
        preview = _build_preview(
            MessageType.TEXT,
            "[@王五](mention:user/user-a) 在吗",
            None,
            conv_type=ConversationType.GROUP,
            sender_name="赵六",
        )
        self.assertEqual(preview, "赵六: @王五 在吗")
        self.assertNotIn("mention:", preview)
