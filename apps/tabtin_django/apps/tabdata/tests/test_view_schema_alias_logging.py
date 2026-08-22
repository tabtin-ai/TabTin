import os
import unittest
from unittest.mock import patch

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')

import django

django.setup()

from apps.tabdata.schemas import (
    TableViewCreate,
    TableViewUpdate,
    TableViewColumnMetaUpdate,
)
from apps.tabdata.view_column_meta_compat import (
    get_legacy_view_column_meta_alias_log_count,
    get_view_column_meta_compat_summary,
    get_view_column_meta_compat_usage_total,
    reset_legacy_view_column_meta_alias_log_counts,
)


class ViewSchemaAliasLoggingTestCase(unittest.TestCase):
    def setUp(self):
        reset_legacy_view_column_meta_alias_log_counts()

    def test_create_logs_legacy_column_meta_alias(self):
        with patch('apps.tabdata.view_column_meta_compat._compat_logger.warning') as mocked_warning:
            payload = TableViewCreate.model_validate({
                'table_id': '00000000-0000-0000-0000-000000000001',
                'name': 'Grid',
                'view_type': 'grid',
                'columnMeta': {
                    'fld_title': {'width': 220},
                },
            })

        self.assertEqual(payload.column_meta, {'fld_title': {'width': 220}})
        mocked_warning.assert_called_once()
        self.assertEqual(mocked_warning.call_args.kwargs['extra']['event'], 'view_column_meta_legacy_alias')
        self.assertEqual(mocked_warning.call_args.kwargs['extra']['compat_source'], 'TableViewCreate.columnMeta')

    def test_create_does_not_log_for_canonical_column_meta(self):
        with patch('apps.tabdata.view_column_meta_compat._compat_logger.warning') as mocked_warning:
            payload = TableViewCreate.model_validate({
                'table_id': '00000000-0000-0000-0000-000000000001',
                'name': 'Grid',
                'view_type': 'grid',
                'column_meta': {
                    'fld_title': {'width': 220},
                },
            })

        self.assertEqual(payload.column_meta, {'fld_title': {'width': 220}})
        mocked_warning.assert_not_called()

    def test_column_meta_update_logs_wrapped_legacy_alias(self):
        with patch('apps.tabdata.view_column_meta_compat._compat_logger.warning') as mocked_warning:
            payload = TableViewColumnMetaUpdate.model_validate({
                'columnMeta': {
                    'fld_title': {'width': 260},
                },
            })

        self.assertEqual(payload.to_column_meta_map(), {'fld_title': {'width': 260}})
        mocked_warning.assert_called_once()

    def test_alias_warning_is_throttled_per_source(self):
        with patch('apps.tabdata.view_column_meta_compat._compat_logger.warning') as mocked_warning:
            for _ in range(6):
                TableViewUpdate.model_validate({
                    'columnMeta': {
                        'fld_title': {'width': 180},
                    },
                })

        self.assertEqual(mocked_warning.call_count, 5)
        self.assertEqual(
            get_legacy_view_column_meta_alias_log_count('TableViewUpdate.columnMeta'),
            6,
        )

    def test_metric_increments_for_legacy_alias_usage(self):
        before = get_view_column_meta_compat_usage_total(
            'TableViewCreate.columnMeta',
            'map',
        )

        with patch('apps.tabdata.view_column_meta_compat._compat_logger.warning'):
            TableViewCreate.model_validate({
                'table_id': '00000000-0000-0000-0000-000000000001',
                'name': 'Grid',
                'view_type': 'grid',
                'columnMeta': {
                    'fld_title': {'width': 220},
                },
            })

        after = get_view_column_meta_compat_usage_total(
            'TableViewCreate.columnMeta',
            'map',
        )
        self.assertEqual(after, before + 1)

    def test_summary_contains_source_breakdown(self):
        with patch('apps.tabdata.view_column_meta_compat._compat_logger.warning'):
            TableViewCreate.model_validate({
                'table_id': '00000000-0000-0000-0000-000000000001',
                'name': 'Grid',
                'view_type': 'grid',
                'columnMeta': {
                    'fld_title': {'width': 220},
                },
            })
            TableViewColumnMetaUpdate.model_validate([
                {
                    'field_id': 'fld_title',
                    'column_meta': {'width': 300},
                },
            ])

        summary = get_view_column_meta_compat_summary()
        self.assertTrue(summary['process_local'])
        self.assertEqual(summary['prometheus_metric'], 'tabtin_view_column_meta_compat_usage_total')
        self.assertEqual(summary['total_legacy_alias_usages'], 2)
        self.assertEqual(
            summary['sources'][0],
            {
                'source': 'TableViewColumnMetaUpdate.columnMetaRo',
                'shape': 'direct-array',
                'count': 1,
            },
        )

    def test_direct_array_shape_logs_once_without_nested_alias_noise(self):
        with patch('apps.tabdata.view_column_meta_compat._compat_logger.warning') as mocked_warning:
            payload = TableViewColumnMetaUpdate.model_validate([
                {
                    'field_id': 'fld_title',
                    'column_meta': {'width': 300},
                },
            ])

        self.assertEqual(payload.to_column_meta_map(), {'fld_title': {'width': 300}})
        mocked_warning.assert_called_once()


if __name__ == '__main__':
    unittest.main()
