"""
_remove_field_from_views が column_meta を正しくクリーンアップするかの単体テスト
"""

import uuid
from unittest.mock import patch, MagicMock
from django.test import TestCase

from apps.tabdata.services.table_service import TableService


def _make_mock_view(
    visible_fields=None,
    field_order=None,
    column_meta=None,
):
    view = MagicMock()
    view.visible_fields = visible_fields or []
    view.field_order = field_order or []
    view.column_meta = column_meta if column_meta is not None else {}
    return view


class RemoveFieldFromViewsColumnMetaTest(TestCase):
    """_remove_field_from_views 对 column_meta 的清理"""

    def setUp(self):
        self.service = TableService()
        self.table_id = uuid.uuid4()
        self.field_id = 'fld_to_delete'

    @patch('apps.tabdata.services.table_service.TableView')
    def test_removes_field_from_column_meta(self, MockTableView):
        """删除字段时应同步从 column_meta 中移除对应键"""
        view = _make_mock_view(
            visible_fields=[self.field_id, 'fld_keep'],
            field_order=[self.field_id, 'fld_keep'],
            column_meta={
                self.field_id: {'order': 0, 'hidden': False, 'width': 200},
                'fld_keep': {'order': 1, 'hidden': False},
            },
        )

        MockTableView.objects.using.return_value.filter.return_value = [view]
        mock_bulk_update = MockTableView.objects.using.return_value.bulk_update

        self.service._remove_field_from_views(self.table_id, self.field_id)

        self.assertNotIn(self.field_id, view.column_meta)
        self.assertIn('fld_keep', view.column_meta)
        self.assertEqual(view.visible_fields, ['fld_keep'])
        self.assertEqual(view.field_order, ['fld_keep'])

        mock_bulk_update.assert_called_once()
        call_args = mock_bulk_update.call_args
        update_fields = set(call_args[0][1])
        self.assertIn('column_meta', update_fields)
        self.assertIn('visible_fields', update_fields)
        self.assertIn('field_order', update_fields)

    @patch('apps.tabdata.services.table_service.TableView')
    def test_no_op_when_field_not_in_any_list(self, MockTableView):
        """字段不在任何列表中时不应触发更新"""
        view = _make_mock_view(
            visible_fields=['fld_a'],
            field_order=['fld_a'],
            column_meta={'fld_a': {'order': 0, 'hidden': False}},
        )

        MockTableView.objects.using.return_value.filter.return_value = [view]
        mock_bulk_update = MockTableView.objects.using.return_value.bulk_update

        self.service._remove_field_from_views(self.table_id, 'fld_nonexistent')

        mock_bulk_update.assert_not_called()

    @patch('apps.tabdata.services.table_service.TableView')
    def test_only_column_meta_contains_field(self, MockTableView):
        """字段仅在 column_meta 中存在时，也应被清理"""
        view = _make_mock_view(
            visible_fields=['fld_a'],
            field_order=['fld_a'],
            column_meta={
                'fld_a': {'order': 0, 'hidden': False},
                self.field_id: {'order': 1, 'hidden': True},
            },
        )

        MockTableView.objects.using.return_value.filter.return_value = [view]
        mock_bulk_update = MockTableView.objects.using.return_value.bulk_update

        self.service._remove_field_from_views(self.table_id, self.field_id)

        self.assertNotIn(self.field_id, view.column_meta)
        self.assertEqual(view.visible_fields, ['fld_a'])
        mock_bulk_update.assert_called_once()

    @patch('apps.tabdata.services.table_service.TableView')
    def test_column_meta_is_none(self, MockTableView):
        """column_meta 为 None 时不应报错"""
        view = _make_mock_view(
            visible_fields=[self.field_id],
            field_order=[self.field_id],
            column_meta=None,
        )

        MockTableView.objects.using.return_value.filter.return_value = [view]
        mock_bulk_update = MockTableView.objects.using.return_value.bulk_update

        self.service._remove_field_from_views(self.table_id, self.field_id)

        self.assertEqual(view.visible_fields, [])
        self.assertEqual(view.field_order, [])
        mock_bulk_update.assert_called_once()

    @patch('apps.tabdata.services.table_service.TableView')
    def test_multiple_views_mixed(self, MockTableView):
        """多个视图混合场景：部分视图有 column_meta，部分没有"""
        view1 = _make_mock_view(
            visible_fields=[self.field_id, 'fld_a'],
            field_order=[self.field_id, 'fld_a'],
            column_meta={
                self.field_id: {'order': 0},
                'fld_a': {'order': 1},
            },
        )
        view2 = _make_mock_view(
            visible_fields=['fld_b'],
            field_order=['fld_b'],
            column_meta={},
        )
        view3 = _make_mock_view(
            visible_fields=['fld_c'],
            field_order=['fld_c'],
            column_meta={self.field_id: {'order': 5, 'hidden': True}},
        )

        MockTableView.objects.using.return_value.filter.return_value = [view1, view2, view3]
        mock_bulk_update = MockTableView.objects.using.return_value.bulk_update

        self.service._remove_field_from_views(self.table_id, self.field_id)

        self.assertNotIn(self.field_id, view1.column_meta)
        self.assertNotIn(self.field_id, view3.column_meta)

        call_args = mock_bulk_update.call_args
        updated_views = call_args[0][0]
        self.assertEqual(len(updated_views), 2)
        self.assertIn(view1, updated_views)
        self.assertIn(view3, updated_views)
        self.assertNotIn(view2, updated_views)
