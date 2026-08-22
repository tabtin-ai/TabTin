"""UserAssignmentNotifySubscriber 单元测试。"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.tabdata.domain.events import RecordCreated, RecordUpdated
from apps.tabdata.domain.value_objects import FieldChange
from apps.tabdata.subscribers.user_assignment_notify import (
    NOTIFY_TYPE,
    UserAssignmentNotifySubscriber,
    extract_user_ids_from_field_value,
)


class ExtractUserIdsTests(SimpleTestCase):
    def test_extracts_string_and_object_forms(self):
        self.assertEqual(extract_user_ids_from_field_value("u-1"), {"u-1"})
        self.assertEqual(extract_user_ids_from_field_value({"id": "u-2"}), {"u-2"})
        self.assertEqual(
            extract_user_ids_from_field_value([{"id": "u-3"}, "u-4", {"user_id": "u-5"}]),
            {"u-3", "u-4", "u-5"},
        )
        self.assertEqual(extract_user_ids_from_field_value(None), set())
        self.assertEqual(extract_user_ids_from_field_value([]), set())


class UserAssignmentNotifySubscriberTests(SimpleTestCase):
    def setUp(self):
        self.table_id = uuid.uuid4()
        self.record_id = uuid.uuid4()
        self.field_id = str(uuid.uuid4())
        self.org_id = uuid.uuid4()
        self.space_id = uuid.uuid4()
        self.actor_id = str(uuid.uuid4())
        self.assignee_id = str(uuid.uuid4())
        self.subscriber = UserAssignmentNotifySubscriber()
        self.user_field = SimpleNamespace(id=uuid.UUID(self.field_id), name="负责人")
        self.table = SimpleNamespace(
            id=self.table_id,
            name="任务表",
            organization_id=self.org_id,
            space_id=self.space_id,
        )

    def _enter_deps(self, stack: ExitStack):
        field_qs = MagicMock()
        field_qs.filter.return_value.only.return_value = [self.user_field]
        table_qs = MagicMock()
        table_qs.filter.return_value.only.return_value.first.return_value = self.table
        stack.enter_context(
            patch(
                "apps.tabdata.subscribers.user_assignment_notify.run_after_commit",
                side_effect=lambda cb: cb(),
            )
        )
        stack.enter_context(
            patch("apps.tabdata.models.TableField.objects.using", return_value=field_qs)
        )
        stack.enter_context(
            patch("apps.tabdata.models.Table.objects.using", return_value=table_qs)
        )
        mock_notify = stack.enter_context(
            patch(
                "apps.services.notification.services.notification_service.NotificationService.notify",
            )
        )
        stack.enter_context(
            patch.object(
                UserAssignmentNotifySubscriber,
                "_resolve_actor_label",
                return_value="张三",
            )
        )
        return mock_notify

    def test_record_updated_notifies_newly_assigned_users(self):
        event = RecordUpdated(
            event_id=str(uuid.uuid4()),
            table_id=self.table_id,
            occurred_at=datetime.now(timezone.utc),
            triggered_by=self.actor_id,
            record_id=self.record_id,
            before={self.field_id: []},
            after={self.field_id: [self.assignee_id]},
            changes={
                self.field_id: FieldChange(old=[], new=[self.assignee_id]),
            },
            changed_field_ids=frozenset({self.field_id}),
        )

        with ExitStack() as stack:
            mock_notify = self._enter_deps(stack)
            self.subscriber.handle(event)

        mock_notify.assert_called_once()
        kwargs = mock_notify.call_args.kwargs
        self.assertEqual(kwargs["user_id"], self.assignee_id)
        self.assertEqual(kwargs["type"], NOTIFY_TYPE)
        self.assertEqual(kwargs["organization_id"], str(self.org_id))
        self.assertEqual(kwargs["metadata"]["resource_type"], "table")
        self.assertEqual(kwargs["metadata"]["resource_id"], str(self.table_id))
        self.assertEqual(kwargs["metadata"]["action"], "assigned")
        self.assertIn("负责人", kwargs["title"])

    def test_skips_actor_self_assignment(self):
        event = RecordCreated(
            event_id=str(uuid.uuid4()),
            table_id=self.table_id,
            occurred_at=datetime.now(timezone.utc),
            triggered_by=self.actor_id,
            record_id=self.record_id,
            data={self.field_id: self.actor_id},
            after={self.field_id: self.actor_id},
        )

        with ExitStack() as stack:
            mock_notify = self._enter_deps(stack)
            self.subscriber.handle(event)

        mock_notify.assert_not_called()

    def test_skips_unchanged_existing_assignee(self):
        event = RecordUpdated(
            event_id=str(uuid.uuid4()),
            table_id=self.table_id,
            occurred_at=datetime.now(timezone.utc),
            triggered_by=self.actor_id,
            record_id=self.record_id,
            before={self.field_id: [self.assignee_id]},
            after={self.field_id: [self.assignee_id]},
            changes={},
            changed_field_ids=frozenset({self.field_id}),
        )

        with ExitStack() as stack:
            mock_notify = self._enter_deps(stack)
            self.subscriber.handle(event)

        mock_notify.assert_not_called()
