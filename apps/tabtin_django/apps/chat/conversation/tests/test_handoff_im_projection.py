from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.chat.conversation.tasks import refresh_handoff_im_projection


class HandoffIMProjectionTests(SimpleTestCase):
    @patch('apps.tabchat.handoff.service.HandoffService._build_card_snapshot')
    @patch('apps.tabchat.handoff.models.HandoffEvent.objects')
    @patch('apps.chat.conversation.services.im_business_projection_service.refresh_user_business_projection')
    def test_refreshes_original_tencent_card(self, refresh, objects, build_snapshot):
        package = SimpleNamespace(
            organization_id='organization-a',
            card_message_ref='0198-message-ref',
            goal='完成迁移',
        )
        objects.select_related.return_value.filter.return_value.first.return_value = (
            SimpleNamespace(pk=42, package=package)
        )
        build_snapshot.return_value = {'type': 'handoff', 'handoff_id': 'handoff-a'}

        result = refresh_handoff_im_projection.run(42)

        self.assertEqual(result, 1)
        refresh.assert_called_once()
        payload = refresh.call_args.kwargs
        self.assertEqual(payload['message_ref'], '0198-message-ref')
        self.assertEqual(payload['metadata']['card']['handoff_id'], 'handoff-a')
        self.assertTrue(payload['business_projection_revision'])
