from importlib import import_module
from types import SimpleNamespace

from django.test import SimpleTestCase

_migration = import_module('apps.tabdata.migrations.0039_backfill_tableview_column_meta')


class ColumnMetaBackfillMigrationTestCase(SimpleTestCase):
    def test_build_column_meta_for_grid_view(self):
        fields = [
            {'id': 'fld_title', 'name': 'Title'},
            {'id': 'fld_status', 'name': 'Status'},
            {'id': 'fld_owner', 'name': 'Owner'},
        ]
        view = SimpleNamespace(
            view_type='grid',
            visible_fields=['fld_title', 'fld_owner'],
            field_order=['fld_owner', 'Status', 'fld_title'],
            config={
                'column_widths': {'Title': 220},
                'column_meta_ext': {
                    'fld_owner': {'statisticFunc': 'count'},
                    'Status': {'customFlag': True, 'order': 999},
                },
            },
        )

        column_meta = _migration._build_column_meta(view, fields)

        self.assertEqual(list(column_meta.keys()), ['fld_owner', 'fld_status', 'fld_title'])
        self.assertEqual(column_meta['fld_owner']['order'], 0)
        self.assertEqual(column_meta['fld_owner']['statisticFunc'], 'count')
        self.assertEqual(column_meta['fld_status'], {'order': 1, 'hidden': True, 'customFlag': True})
        self.assertEqual(column_meta['fld_title'], {'order': 2, 'width': 220})

    def test_build_column_meta_for_visible_semantic_view(self):
        fields = [
            {'id': 'fld_title', 'name': 'Title'},
            {'id': 'fld_status', 'name': 'Status'},
            {'id': 'fld_owner', 'name': 'Owner'},
        ]
        view = SimpleNamespace(
            view_type='kanban',
            visible_fields=['fld_title'],
            field_order=['fld_title', 'fld_status', 'fld_owner'],
            config={},
        )

        column_meta = _migration._build_column_meta(view, fields)

        self.assertEqual(column_meta['fld_title'], {'order': 0, 'visible': True})
        self.assertEqual(column_meta['fld_status'], {'order': 1, 'visible': False})
        self.assertEqual(column_meta['fld_owner'], {'order': 2, 'visible': False})
