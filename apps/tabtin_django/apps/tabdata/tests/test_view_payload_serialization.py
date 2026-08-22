import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')

import django

django.setup()

from apps.tabdata.api_utils import serialize_view_payload
from apps.tabdata.utils.view_serializers import build_view_column_meta_payload


class ViewPayloadSerializationTestCase(unittest.TestCase):
    def test_build_view_column_meta_payload_outputs_snake_case_and_legacy_alias(self):
        expected = {
            'fld_title': {'order': 0, 'width': 240},
            'fld_status': {'order': 1, 'hidden': True},
        }

        with patch(
            'apps.tabdata.utils.view_serializers.build_view_column_meta',
            return_value=expected,
        ) as mocked_build:
            payload = build_view_column_meta_payload(SimpleNamespace())

        mocked_build.assert_called_once()
        self.assertEqual(payload['column_meta'], expected)
        self.assertEqual(payload['columnMeta'], expected)

    def test_serialize_view_payload_uses_shared_column_meta_helper(self):
        shared_column_meta_payload = {
            'column_meta': {'fld_title': {'order': 0}},
            'columnMeta': {'fld_title': {'order': 0}},
        }
        view = SimpleNamespace(
            id='view-1',
            table=SimpleNamespace(id='table-1'),
            name='Grid',
            view_type='grid',
            description='',
            created_by=SimpleNamespace(id='user-1'),
            filter=None,
            filters=[],
            sorts=[],
            groups=[],
            visible_fields=[],
            field_order=[],
            config={},
            is_shared=False,
            is_locked=False,
            order=0,
            created_at=None,
            updated_at=None,
        )

        with patch(
            'apps.tabdata.api_utils.build_view_column_meta_payload',
            return_value=shared_column_meta_payload,
        ) as mocked_build:
            payload = serialize_view_payload(view)

        mocked_build.assert_called_once_with(view)
        self.assertEqual(payload['column_meta'], shared_column_meta_payload['column_meta'])
        self.assertEqual(payload['columnMeta'], shared_column_meta_payload['columnMeta'])
        self.assertEqual(payload['table_id'], 'table-1')
        self.assertEqual(payload['created_by_id'], 'user-1')


if __name__ == '__main__':
    unittest.main()
