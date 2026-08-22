"""TabData primary field switching API tests."""

import json
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import Client, TestCase

from apps.tabdata.models import Table, TableField
from apps.tabdata.services.table_service import TableService
from apps.tabdata.services.undo_redo_operation_service import (
    UndoRedoOperationName,
    UndoRedoOperationService,
)
from apps.tabtinspace.models import Organization, OrganizationMember

User = get_user_model()


class PrimaryFieldSwitchAPITest(TestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        self.client = Client()
        self.owner = User.objects.db_manager('default').create_user(
            username='primary_owner',
            email='primary-owner@test.com',
            password='testpass123',
        )
        self.viewer = User.objects.db_manager('default').create_user(
            username='primary_viewer',
            email='primary-viewer@test.com',
            password='testpass123',
        )
        self.organization = Organization.objects.create(
            name='主字段切换测试团队',
            owner_id=str(self.owner.id),
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(self.viewer.id),
            role='viewer',
        )
        self.table = Table.objects.create(
            space_id=uuid4(),
            organization_id=self.organization.id,
            name='主字段切换测试表',
            owner=self.owner,
        )
        self.primary_field = TableField.objects.create(
            table=self.table,
            name='标题',
            field_type='text',
            is_primary=True,
            order=0,
        )
        self.client.force_login(self.owner)

    def test_set_primary_switches_old_primary_and_pushes_two_field_snapshots(self):
        field = TableField.objects.create(
            table=self.table,
            name='编号',
            field_type='number',
            order=1,
        )
        self.table.refresh_from_db()
        expected_schema_version = self.table.schema_version

        with patch(
            'apps.tabdata.services.undo_redo_operation_service.'
            'UndoRedoOperationService.push_update_fields'
        ) as mock_push_update_fields:
            response = self.client.put(
                f'/api/tabdata/fields/{field.id}',
                data=json.dumps({
                    'is_primary': True,
                    'expected_schema_version': expected_schema_version,
                }),
                content_type='application/json',
            )

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data['is_primary'])

        self.primary_field.refresh_from_db()
        field.refresh_from_db()
        self.table.refresh_from_db()
        self.assertFalse(self.primary_field.is_primary)
        self.assertTrue(field.is_primary)
        self.assertEqual(self.table.schema_version, expected_schema_version + 1)

        mock_push_update_fields.assert_called_once()
        undo_kwargs = mock_push_update_fields.call_args.kwargs
        self.assertEqual(len(undo_kwargs['old_fields']), 2)
        self.assertEqual(len(undo_kwargs['new_fields']), 2)
        self.assertEqual(undo_kwargs['action_display'], '设为主字段')

    def test_update_fields_undo_redo_replays_primary_switch(self):
        field = TableField.objects.create(
            table=self.table,
            name='编号',
            field_type='number',
            order=1,
        )
        operation_service = UndoRedoOperationService(user=self.owner)
        old_fields = [
            operation_service.serialize_field(self.primary_field),
            operation_service.serialize_field(field),
        ]

        self.primary_field.is_primary = False
        self.primary_field.save(update_fields=['is_primary'])
        field.is_primary = True
        field.save(update_fields=['is_primary'])
        new_fields = [
            operation_service.serialize_field(self.primary_field),
            operation_service.serialize_field(field),
        ]

        operation = operation_service.build_operation(
            name=UndoRedoOperationName.UPDATE_FIELDS,
            table_id=self.table.id,
            action='update',
            action_display='设为主字段',
            result={'old_fields': old_fields, 'new_fields': new_fields},
        )

        success, error, _next_operation = operation_service.execute(
            operation=operation,
            direction='undo',
        )
        self.assertTrue(success, error)
        self.primary_field.refresh_from_db()
        field.refresh_from_db()
        self.assertTrue(self.primary_field.is_primary)
        self.assertFalse(field.is_primary)

        success, error, _next_operation = operation_service.execute(
            operation=operation,
            direction='redo',
        )
        self.assertTrue(success, error)
        self.primary_field.refresh_from_db()
        field.refresh_from_db()
        self.assertFalse(self.primary_field.is_primary)
        self.assertTrue(field.is_primary)

    def test_set_primary_rejects_unsupported_field_type(self):
        field = TableField.objects.create(
            table=self.table,
            name='附件',
            field_type='attachment',
            config={},
            order=1,
        )

        response = self.client.put(
            f'/api/tabdata/fields/{field.id}',
            data=json.dumps({'is_primary': True}),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('不能设为主字段', response.json()['message'])
        self.primary_field.refresh_from_db()
        field.refresh_from_db()
        self.assertTrue(self.primary_field.is_primary)
        self.assertFalse(field.is_primary)

    def test_current_primary_cannot_be_cancelled(self):
        response = self.client.put(
            f'/api/tabdata/fields/{self.primary_field.id}',
            data=json.dumps({'is_primary': False}),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('主字段不可取消', response.json()['message'])

    def test_current_primary_can_be_edited(self):
        updated_field = TableService(user=self.owner).update_field(
            field_id=self.primary_field.id,
            name='重命名标题',
        )

        self.assertIsNotNone(updated_field)
        self.primary_field.refresh_from_db()
        self.assertEqual(self.primary_field.name, '重命名标题')
        self.assertTrue(self.primary_field.is_primary)

    def test_schema_version_conflict_returns_409(self):
        field = TableField.objects.create(
            table=self.table,
            name='编号',
            field_type='number',
            order=1,
        )
        self.table.refresh_from_db()

        response = self.client.put(
            f'/api/tabdata/fields/{field.id}',
            data=json.dumps({
                'is_primary': True,
                'expected_schema_version': self.table.schema_version + 1,
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 409)
        self.assertIn('字段结构已被他人修改', response.json()['message'])

    def test_viewer_cannot_switch_primary_field(self):
        field = TableField.objects.create(
            table=self.table,
            name='编号',
            field_type='number',
            order=1,
        )
        self.client.force_login(self.viewer)

        response = self.client.put(
            f'/api/tabdata/fields/{field.id}',
            data=json.dumps({'is_primary': True}),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 403)

    def test_existing_primary_request_cleans_extra_dirty_primary_fields(self):
        dirty_primary = TableField.objects.create(
            table=self.table,
            name='脏主字段',
            field_type='text',
            is_primary=True,
            order=1,
        )
        self.table.refresh_from_db()
        expected_schema_version = self.table.schema_version

        response = self.client.put(
            f'/api/tabdata/fields/{self.primary_field.id}',
            data=json.dumps({
                'is_primary': True,
                'expected_schema_version': expected_schema_version,
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.primary_field.refresh_from_db()
        dirty_primary.refresh_from_db()
        self.table.refresh_from_db()
        self.assertTrue(self.primary_field.is_primary)
        self.assertFalse(dirty_primary.is_primary)
        self.assertEqual(
            TableField.objects.filter(
                table=self.table,
                is_primary=True,
                is_deleted=False,
            ).count(),
            1,
        )
        self.assertEqual(self.table.schema_version, expected_schema_version + 1)
