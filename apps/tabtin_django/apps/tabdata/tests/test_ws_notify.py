from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import transaction
from django.test import TestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.utils.ws_notify import publish_table_record_event
from apps.tabtinspace.models import Space, Organization


User = get_user_model()


class PublishTableRecordEventTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        self.user = User.objects.create_user(
            username="ws_notify_user",
            email="ws_notify_user@example.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="WS Notify Organization",
            owner=self.user,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="WS Notify Space",
            type="team",
        )
        self.table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="WS 通知表",
            owner=self.user,
            rls_enabled=False,
        )
        self.field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="标题",
            field_type="text",
            order=0,
        )
        self.record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            data={str(self.field.id): "增量通知"},
            version=7,
        )

    def test_publish_record_event_includes_inline_records_and_version(self):
        with (
            patch(
                "apps.tabdata.services.table_event_service.table_event_service.publish_table_update",
            ) as mock_publish,
            patch(
                "apps.tabdata.tasks.webhook_tasks.deliver_webhook_event.delay",
            ) as mock_webhook,
            patch("apps.tabdata.utils.ws_notify.logger.warning") as mock_warning,
        ):
            with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=False) as callbacks:
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    publish_table_record_event(
                        table_id=self.table.id,
                        record_ids=[str(self.record.id)],
                        action="update_record",
                        records=[self.record],
                        user_id=str(self.user.id),
                    )
                    self.assertFalse(mock_publish.called)

            self.assertEqual(len(callbacks), 1)
            callbacks[0]()

        mock_publish.assert_called_once()
        kwargs = mock_publish.call_args.kwargs
        self.assertEqual(kwargs["record_ids"], [str(self.record.id)])
        self.assertEqual(kwargs["latest_version"], 4_000_000_000_007)
        self.assertIsInstance(kwargs["records"], list)
        self.assertEqual(str(kwargs["records"][0]["id"]), str(self.record.id))
        self.assertTrue(mock_webhook.called)
        mock_warning.assert_not_called()
