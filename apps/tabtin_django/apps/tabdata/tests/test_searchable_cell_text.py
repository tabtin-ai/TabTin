"""#6873 单元格搜索展示文本：不因 UUID id 误命中数字查询。"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.tabdata.utils.searchable_cell_text import (
    build_searchable_cell_sql_expr,
    build_user_reference_match_sql,
    cell_text_matches_search_query,
    extract_searchable_cell_text,
    extract_user_reference_ids,
    user_cell_references_any_id,
)


class SearchableCellTextTests(SimpleTestCase):
    def test_extract_prefers_display_fields(self):
        self.assertEqual(
            extract_searchable_cell_text({
                'id': 'a4b5c6d7-8901-2345-6789-abcdef012345',
                'title': '深圳科技有限公司',
            }),
            '深圳科技有限公司',
        )
        self.assertEqual(
            extract_searchable_cell_text([
                {'id': '11111111-2222-3333-4444-555555555555', 'title': '甲'},
                {'id': 'aaaa4aaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'name': '乙'},
            ]),
            '甲 乙',
        )

    def test_numeric_query_ignores_link_ids(self):
        link_cell = {
            'id': 'a4b5c6d7-8901-2345-6789-abcdef012345',
            'title': '无数字标题',
        }
        self.assertFalse(cell_text_matches_search_query('4', link_cell))
        self.assertTrue(cell_text_matches_search_query('4', '4008001001'))

    def test_sql_expr_uses_display_paths(self):
        expr = build_searchable_cell_sql_expr('fld-demo-id')
        self.assertIn("->>'title'", expr)
        self.assertIn("->>'name'", expr)
        self.assertIn("jsonb_typeof", expr)
        # 不应再裸扫整段 JSON 文本作为唯一路径
        self.assertIn("WHEN 'object'", expr)

    def test_column_sql_expr_wraps_to_jsonb(self):
        from apps.tabdata.utils.searchable_cell_text import build_searchable_column_sql_expr

        expr = build_searchable_column_sql_expr('"abcdef0123456789"')
        self.assertIn('to_jsonb("abcdef0123456789")', expr)
        self.assertIn("->>'title'", expr)

    def test_user_reference_helpers_support_single_object_and_multiple(self):
        self.assertEqual(extract_user_reference_ids('user-a'), ['user-a'])
        self.assertEqual(
            extract_user_reference_ids([
                'user-a',
                {'id': 'user-b'},
                {'user_id': 'user-c'},
            ]),
            ['user-a', 'user-b', 'user-c'],
        )
        self.assertTrue(
            user_cell_references_any_id(
                ['user-a', {'id': 'user-b'}],
                ['user-b'],
            ),
        )
        self.assertFalse(
            user_cell_references_any_id('hidden-user-id', ['user-c']),
        )

    def test_user_reference_sql_supports_all_persisted_shapes(self):
        sql, params = build_user_reference_match_sql(
            'to_jsonb("abcdef0123456789")',
            ['user-a', 'user-b'],
        )
        self.assertIn("WHEN 'string'", sql)
        self.assertIn("WHEN 'object'", sql)
        self.assertIn("WHEN 'array'", sql)
        self.assertIn("jsonb_array_elements", sql)
        self.assertEqual(params, [
            ['user-a', 'user-b'],
            ['user-a', 'user-b'],
            ['user-a', 'user-b'],
        ])

    def test_native_hidden_row_search_resolves_user_display_name(self):
        from apps.tabdata.services.view_grid_service import build_native_search_where

        field = SimpleNamespace(field_type='user')
        qb = SimpleNamespace(
            _resolve_column_ref=lambda _field_ref: '"abcdef0123456789"',
            _get_field_for_ref=lambda _field_ref: field,
        )
        with patch(
            'apps.tabdata.utils.searchable_cell_text.'
            'resolve_organization_user_ids_by_display_name',
            return_value=['user-try-yang'],
        ) as resolve_ids:
            sql, params = build_native_search_where(
                qb=qb,
                all_fields=[SimpleNamespace(id='field-user')],
                search_value='Yang',
                search_field_ids=['field-user'],
                organization_id='organization-1',
            )

        resolve_ids.assert_called_once_with('organization-1', 'Yang')
        self.assertIn('jsonb_array_elements', sql)
        self.assertIn('to_jsonb("abcdef0123456789")', sql)
        self.assertEqual(params[0], '%yang%')
        self.assertEqual(params[1:], [
            ['user-try-yang'],
            ['user-try-yang'],
            ['user-try-yang'],
        ])
