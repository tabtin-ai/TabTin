"""#9513：用户字段分组——成员按 id，未匹配导入按 name:展示名（同名可拆两组）。"""
from __future__ import annotations

from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.tabdata.services.view_group_sort_service import (
    _merge_group_tree_node,
    compare_group_values,
    normalize_group_key,
)


def _user_field(field_type: str = 'user'):
    return SimpleNamespace(field_type=field_type, config={})


class NormalizeGroupKeyUserFieldTests(SimpleTestCase):
    def test_imported_same_name_shares_name_key(self):
        field = _user_field()
        a = {'id': 'ou_1', 'name': '张三', 'avatar': 'https://a.example/1.png'}
        b = {'user_id': 'ou_2', 'display_name': '张三', 'avatar_url': 'https://b.example/2.png'}
        self.assertEqual(normalize_group_key(a, field), 'user:["name:张三"]')
        self.assertEqual(normalize_group_key(a, field), normalize_group_key(b, field))

    def test_member_uuid_and_imported_same_name_are_different_groups(self):
        field = _user_field()
        member_id = '634e1f02-0f40-426e-84cd-655335b5d247'
        member = {'id': member_id, 'name': '张三'}
        imported = {'id': 'ou_feishu_xxx', 'name': '张三'}
        member_key = normalize_group_key(member, field)
        imported_key = normalize_group_key(imported, field)
        self.assertEqual(member_key, f'user:["{member_id}"]')
        self.assertEqual(imported_key, 'user:["name:张三"]')
        self.assertNotEqual(member_key, imported_key)

    def test_known_member_ids_override_non_uuid(self):
        field = _user_field()
        known = {'custom_member_1'}
        value = {'id': 'custom_member_1', 'name': '张三'}
        self.assertEqual(
            normalize_group_key(value, field, known_member_ids=known),
            'user:["custom_member_1"]',
        )

    def test_empty_shapes_map_to_empty_bucket(self):
        field = _user_field()
        self.assertEqual(normalize_group_key(None, field), '__empty__')
        self.assertEqual(normalize_group_key('', field), '__empty__')
        self.assertEqual(normalize_group_key([], field), '__empty__')

    def test_multi_user_is_an_order_independent_set(self):
        field = _user_field()
        value = [
            {'id': 'ou_a', 'name': 'A'},
            {'open_id': 'ou_b', 'name': 'B'},
        ]
        self.assertEqual(normalize_group_key(value, field), 'user:["name:A","name:B"]')
        self.assertEqual(normalize_group_key(value, field), normalize_group_key(list(reversed(value)), field))

    def test_multi_select_is_an_order_independent_set(self):
        field = SimpleNamespace(field_type='multi_select', config={})
        self.assertEqual(normalize_group_key(['B', 'A'], field), 'A|B')
        self.assertEqual(normalize_group_key(['A', 'B'], field), 'A|B')

    def test_non_user_field_keeps_legacy_list_join(self):
        field = SimpleNamespace(field_type='select', config={})
        self.assertEqual(normalize_group_key(['x', 'y'], field), 'x|y')

    def test_created_by_uuid_uses_member_id(self):
        member_id = '634e1f02-0f40-426e-84cd-655335b5d247'
        value = {'id': member_id, 'name': 'Bob'}
        self.assertEqual(
            normalize_group_key(value, _user_field('created_by')),
            f'user:["{member_id}"]',
        )


class MergeGroupTreeNodeTests(SimpleTestCase):
    def test_merge_counts_for_same_imported_name(self):
        field = _user_field()
        root: dict = {}
        shape_a = {'id': 'ou_1', 'name': 'Alice', 'avatar': 'a'}
        shape_b = {'id': 'ou_2', 'name': 'Alice', 'avatar': 'b'}
        key = normalize_group_key(shape_a, field)
        self.assertEqual(key, normalize_group_key(shape_b, field))

        _merge_group_tree_node(root, key, shape_a, 3, field)
        _merge_group_tree_node(root, key, shape_b, 2, field)

        self.assertEqual(len(root), 1)
        node = root[key]
        self.assertEqual(node['count'], 5)
        self.assertEqual(node['value'][0]['name'], 'Alice')
        self.assertEqual(node['value'][0]['avatar_url'], 'a')

    def test_empty_and_null_share_empty_bucket(self):
        field = _user_field()
        root: dict = {}
        _merge_group_tree_node(root, '__empty__', None, 1, field)
        _merge_group_tree_node(root, '__empty__', [], 4, field)
        self.assertEqual(root['__empty__']['count'], 5)
        self.assertIsNone(root['__empty__']['value'])


class CompareGroupValuesTests(SimpleTestCase):
    def test_empty_is_last_in_both_directions(self):
        field = SimpleNamespace(field_type='text', config={})
        self.assertGreater(compare_group_values(None, 'A', field, 'asc'), 0)
        self.assertGreater(compare_group_values(None, 'A', field, 'desc'), 0)

    def test_choice_order_and_natural_text_order(self):
        choice_field = SimpleNamespace(
            field_type='select',
            config={'choices': [{'value': 'Todo'}, {'value': 'Doing'}, {'value': 'Done'}]},
        )
        self.assertLess(compare_group_values('Doing', 'Done', choice_field), 0)
        text_field = SimpleNamespace(field_type='text', config={})
        self.assertLess(compare_group_values('Task 2', 'Task 10', text_field), 0)

    def test_multi_select_unknown_choices_keep_set_semantics(self):
        field = SimpleNamespace(
            field_type='multi_select',
            config={'choices': [{'value': 'Known'}]},
        )
        left = ['Unknown 10', 'Unknown 2', 'Unknown 2']
        right = ['Unknown 2', 'Unknown 10']
        self.assertEqual(compare_group_values(left, right, field), 0)

    def test_user_order_uses_display_name_then_stable_identity(self):
        field = _user_field()
        alice = [{'id': '634e1f02-0f40-426e-84cd-655335b5d247', 'name': 'Alice'}]
        bob = [{'id': '734e1f02-0f40-426e-84cd-655335b5d248', 'name': 'Bob'}]
        self.assertLess(compare_group_values(alice, bob, field), 0)
