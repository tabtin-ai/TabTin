"""TabData 公开字段创建能力与 UI 的契约回归。"""

import json

from django.test import RequestFactory, SimpleTestCase
from pydantic import ValidationError

from apps.tabdata.api_open_space import get_field_types
from apps.tabdata.schemas import BulkFieldCreateRequest


class FieldCreationContractTest(SimpleTestCase):
    def test_bulk_create_rejects_field_type_not_available_in_ui(self):
        """旧 CLI 请求在进入 bulk 接口前即被契约层拒绝。"""
        with self.assertRaises(ValidationError):
            BulkFieldCreateRequest(fields=[{
                'name': '嵌套表格',
                'field_type': 'nested_list',
                'options': {
                    'nested_schema': {
                        'fields': [{'name': '子项名称', 'field_type': 'text'}],
                    },
                },
            }])

    def test_field_type_discovery_matches_ui_creation_contract(self):
        response = get_field_types(RequestFactory().get('/api/open/v1/field-types'))

        self.assertEqual(response.status_code, 200)
        field_types = json.loads(response.content)['data']['field_types']
        self.assertEqual(len(field_types), 16)
        self.assertIn('percent', field_types)
        self.assertIn('currency', field_types)
        self.assertNotIn('media', field_types)
        for unavailable in ['nested_list', 'lookup', 'formula', 'rollup', 'datetime']:
            self.assertNotIn(unavailable, field_types)

    def test_bulk_create_rejects_retired_media_field(self):
        with self.assertRaises(ValidationError):
            BulkFieldCreateRequest(fields=[{
                'name': '媒体',
                'field_type': 'media',
            }])
