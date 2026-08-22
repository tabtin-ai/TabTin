from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import TransactionTestCase

from apps.tabdata.models import Table, TableField, TableView
from apps.tabdata.services.table_service import TableService
from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent


class FieldInsertPositionViewSyncTest(TransactionTestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        self._patches = [
            patch.object(TableService, '_native_add_column', return_value=None),
            patch.object(TableService, '_publish_field_event', return_value=None),
            patch.object(TableService, '_trigger_field_version_history', return_value=None),
            patch.object(
                TableService,
                '_get_operation_service',
                return_value=MagicMock(push_create_fields=MagicMock(return_value=None)),
            ),
        ]
        for patcher in self._patches:
            patcher.start()

        fixture = create_test_organization_with_agent(
            prefix='field_insert_position',
            organization_name='FieldInsertPositionOrganization',
            space_name='FieldInsertPositionSpace',
        )
        self.user = fixture['user']
        self.organization = fixture['organization']
        self.space = fixture['space']
        self.service = TableService(user=self.user)

    def tearDown(self):
        for patcher in reversed(self._patches):
            patcher.stop()

    def _create_table_with_fields(self):
        table = Table.objects.create(
            name='字段插入位置测试表',
            space_id=self.space.id,
            organization_id=self.organization.id,
            owner=self.user,
        )
        title = TableField.objects.create(
            table=table,
            name='标题',
            field_type='text',
            is_primary=True,
            order=0,
        )
        status = TableField.objects.create(
            table=table,
            name='状态',
            field_type='text',
            order=1,
        )
        owner = TableField.objects.create(
            table=table,
            name='负责人',
            field_type='text',
            order=2,
        )
        return table, title, status, owner

    def _field_ids_by_view_order(self, view: TableView):
        return [
            field_id
            for field_id, _meta in sorted(
                view.column_meta.items(),
                key=lambda item: item[1].get('order', 0),
            )
        ]

    def test_insert_field_before_reference_keeps_view_order(self):
        table, title, status, owner = self._create_table_with_fields()
        view = TableView.objects.create(
            table=table,
            name='Grid',
            view_type='grid',
            visible_fields=[str(title.id), str(status.id), str(owner.id)],
            field_order=[str(title.id), str(status.id), str(owner.id)],
            column_meta={
                str(title.id): {'order': 0, 'hidden': False},
                str(status.id): {'order': 1, 'hidden': False, 'width': 240},
                str(owner.id): {'order': 2, 'hidden': False},
            },
        )

        inserted = self.service.create_field(
            table.id,
            name='优先级',
            field_type='text',
            insert_position='before',
            reference_field_id=status.id,
        )

        expected = [str(title.id), str(inserted.id), str(status.id), str(owner.id)]
        view.refresh_from_db()
        self.assertEqual(view.visible_fields, expected)
        self.assertEqual(view.field_order, expected)
        self.assertEqual(self._field_ids_by_view_order(view), expected)
        self.assertEqual(view.column_meta[str(status.id)]['width'], 240)

        field_names = list(
            TableField.objects.filter(table=table, is_deleted=False)
            .order_by('order')
            .values_list('name', flat=True)
        )
        self.assertEqual(field_names, ['标题', '优先级', '状态', '负责人'])

    def test_insert_field_after_reference_keeps_view_order_with_empty_column_meta(self):
        table, title, status, owner = self._create_table_with_fields()
        view = TableView.objects.create(
            table=table,
            name='Grid',
            view_type='grid',
            visible_fields=[str(title.id), str(status.id)],
            field_order=[str(title.id), str(status.id), str(owner.id)],
            column_meta={},
        )

        inserted = self.service.create_field(
            table.id,
            name='备注',
            field_type='text',
            insert_position='after',
            reference_field_id=status.id,
        )

        expected_visible = [str(title.id), str(status.id), str(inserted.id)]
        expected_order = [str(title.id), str(status.id), str(inserted.id), str(owner.id)]
        view.refresh_from_db()
        self.assertEqual(view.visible_fields, expected_visible)
        self.assertEqual(view.field_order, expected_order)
        self.assertEqual(self._field_ids_by_view_order(view), expected_order)
        self.assertFalse(view.column_meta[str(inserted.id)]['hidden'])
        self.assertTrue(view.column_meta[str(owner.id)]['hidden'])

        field_names = list(
            TableField.objects.filter(table=table, is_deleted=False)
            .order_by('order')
            .values_list('name', flat=True)
        )
        self.assertEqual(field_names, ['标题', '状态', '备注', '负责人'])

    def test_insert_field_before_reference_when_column_meta_misses_reference(self):
        table, title, status, owner = self._create_table_with_fields()
        view = TableView.objects.create(
            table=table,
            name='Grid',
            view_type='grid',
            visible_fields=[str(title.id), str(status.id), str(owner.id)],
            field_order=[str(title.id), str(status.id), str(owner.id)],
            column_meta={
                str(title.id): {'order': 0, 'hidden': False},
                str(owner.id): {'order': 1, 'hidden': False, 'width': 180},
            },
        )

        inserted = self.service.create_field(
            table.id,
            name='优先级',
            field_type='text',
            insert_position='before',
            reference_field_id=status.id,
        )

        expected = [str(title.id), str(inserted.id), str(status.id), str(owner.id)]
        view.refresh_from_db()
        self.assertEqual(view.visible_fields, expected)
        self.assertEqual(view.field_order, expected)
        self.assertEqual(self._field_ids_by_view_order(view), expected)
        self.assertEqual(view.column_meta[str(owner.id)]['width'], 180)

    def test_create_field_without_insert_position_still_appends_to_view(self):
        table, title, status, owner = self._create_table_with_fields()
        view = TableView.objects.create(
            table=table,
            name='Grid',
            view_type='grid',
            visible_fields=[str(title.id), str(status.id), str(owner.id)],
            field_order=[str(title.id), str(status.id), str(owner.id)],
            column_meta={
                str(title.id): {'order': 0, 'hidden': False},
                str(status.id): {'order': 1, 'hidden': False},
                str(owner.id): {'order': 2, 'hidden': False},
            },
        )

        inserted = self.service.create_field(
            table.id,
            name='备注',
            field_type='text',
        )

        expected = [str(title.id), str(status.id), str(owner.id), str(inserted.id)]
        view.refresh_from_db()
        self.assertEqual(view.visible_fields, expected)
        self.assertEqual(view.field_order, expected)
        self.assertEqual(self._field_ids_by_view_order(view), expected)

    def test_bulk_create_fields_still_appends_to_view(self):
        table, title, status, owner = self._create_table_with_fields()
        view = TableView.objects.create(
            table=table,
            name='Grid',
            view_type='grid',
            visible_fields=[str(title.id), str(status.id), str(owner.id)],
            field_order=[str(title.id), str(status.id), str(owner.id)],
            column_meta={
                str(title.id): {'order': 0, 'hidden': False},
                str(status.id): {'order': 1, 'hidden': False},
                str(owner.id): {'order': 2, 'hidden': False},
            },
        )

        created, errors, _skipped = self.service.bulk_create_fields(
            table.id,
            [
                {'name': '备注', 'field_type': 'text'},
                {'name': '评分', 'field_type': 'number'},
            ],
        )

        self.assertEqual(errors, [])
        expected = [
            str(title.id),
            str(status.id),
            str(owner.id),
            str(created[0].id),
            str(created[1].id),
        ]
        view.refresh_from_db()
        self.assertEqual(view.visible_fields, expected)
        self.assertEqual(view.field_order, expected)
        self.assertEqual(self._field_ids_by_view_order(view), expected)
