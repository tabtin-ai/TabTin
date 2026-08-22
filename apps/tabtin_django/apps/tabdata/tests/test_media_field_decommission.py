"""媒体字段下架后的单一附件契约。"""

import importlib

from django.test import SimpleTestCase

from apps.tabdata.constants import FILE_BASED_FIELD_TYPES
from apps.tabdata.models import TableField
from apps.tabdata.utils.field_types import get_field_type


class MediaFieldDecommissionTest(SimpleTestCase):
    def test_runtime_contract_only_exposes_attachment(self):
        choices = dict(TableField.FIELD_TYPE_CHOICES)

        self.assertEqual(FILE_BASED_FIELD_TYPES, frozenset({'attachment'}))
        self.assertIn('attachment', choices)
        self.assertNotIn('media', choices)
        self.assertIsNotNone(get_field_type('attachment'))
        self.assertIsNone(get_field_type('media'))

    def test_migration_converts_nested_media_fields_and_drops_restrictions(self):
        migration = importlib.import_module(
            'apps.tabdata.migrations.0055_decommission_media_field'
        )

        converted = migration._convert_nested_field_types(
            {
                'allowed_types': ['image'],
                'nested_schema': {
                    'fields': [{
                        'name': '图片',
                        'field_type': 'media',
                        'allowed_types': ['image', 'video'],
                    }],
                },
            },
            remove_allowed_types=True,
        )

        self.assertEqual(converted, {
            'nested_schema': {
                'fields': [{
                    'name': '图片',
                    'field_type': 'attachment',
                }],
            },
        })

    def test_migration_preserves_unrelated_allowed_types_config(self):
        migration = importlib.import_module(
            'apps.tabdata.migrations.0055_decommission_media_field'
        )

        converted = migration._convert_nested_field_types({
            'allowed_types': ['custom'],
            'field_type': 'text',
        })

        self.assertEqual(converted, {
            'allowed_types': ['custom'],
            'field_type': 'text',
        })
