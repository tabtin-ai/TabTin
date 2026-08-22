from django.test import SimpleTestCase

from apps.chat.conversation.services.block_normalizer import normalize_user_message_for_agent


class BlockNormalizerDocSelectionTest(SimpleTestCase):
    def test_doc_selection_prefers_full_text_over_preview(self):
        text, parts = normalize_user_message_for_agent(
            '',
            [{
                'type': 'doc_selection',
                'doc_id': 'doc-1',
                'preview': '短预览',
                'full_text': '完整文档块内容',
            }],
        )

        self.assertEqual(parts, [])
        self.assertIn('完整文档块内容', text)
        self.assertNotIn('短预览', text)
