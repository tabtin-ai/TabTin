"""
CascadeService 单元测试

测试内容：
1. has_cycle — 循环依赖检测
2. topological_sort_layers — 拓扑排序分层
3. FieldReferenceManager — 依赖边注册/注销
4. CascadeService.get_dependent_fields — 递归 CTE
5. CascadeService.resolve_link_closure — BFS 传播
6. 端到端级联场景
"""

import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, TransactionTestCase

from apps.tabdata.models import (
    FieldReference,
    LinkRecord,
    Table,
    TableField,
    TableRecord,
)
from apps.tabdata.services.cascade_service import (
    CascadeService,
    FieldReferenceManager,
    has_cycle,
    topological_sort_layers,
)

User = get_user_model()


class TestHasCycle(TestCase):
    """has_cycle 循环检测"""

    def test_no_cycle_linear(self):
        edges = [('A', 'B'), ('B', 'C'), ('C', 'D')]
        self.assertFalse(has_cycle(edges))

    def test_no_cycle_diamond(self):
        edges = [('A', 'B'), ('A', 'C'), ('B', 'D'), ('C', 'D')]
        self.assertFalse(has_cycle(edges))

    def test_simple_cycle(self):
        edges = [('A', 'B'), ('B', 'C'), ('C', 'A')]
        self.assertTrue(has_cycle(edges))

    def test_self_loop(self):
        edges = [('A', 'A')]
        self.assertTrue(has_cycle(edges))

    def test_empty_graph(self):
        self.assertFalse(has_cycle([]))

    def test_single_edge(self):
        self.assertFalse(has_cycle([('A', 'B')]))


class TestTopologicalSortLayers(TestCase):
    """topological_sort_layers 拓扑排序"""

    def test_linear_chain(self):
        field_ids = ['A', 'B', 'C']
        edges = [('A', 'B'), ('B', 'C')]
        layers = topological_sort_layers(field_ids, edges)
        self.assertEqual(len(layers), 3)
        self.assertEqual(layers[0], ['A'])
        self.assertEqual(layers[1], ['B'])
        self.assertEqual(layers[2], ['C'])

    def test_diamond(self):
        field_ids = ['A', 'B', 'C', 'D']
        edges = [('A', 'B'), ('A', 'C'), ('B', 'D'), ('C', 'D')]
        layers = topological_sort_layers(field_ids, edges)
        self.assertEqual(layers[0], ['A'])
        self.assertIn('B', layers[1])
        self.assertIn('C', layers[1])
        self.assertEqual(layers[2], ['D'])

    def test_independent_nodes(self):
        field_ids = ['A', 'B', 'C']
        edges = []
        layers = topological_sort_layers(field_ids, edges)
        self.assertEqual(len(layers), 1)
        self.assertEqual(sorted(layers[0]), ['A', 'B', 'C'])

    def test_cycle_fallback(self):
        field_ids = ['A', 'B', 'C']
        edges = [('A', 'B'), ('B', 'C'), ('C', 'A')]
        layers = topological_sort_layers(field_ids, edges)
        # 应该把所有节点放在一个兜底层
        all_fields = set()
        for layer in layers:
            all_fields.update(layer)
        self.assertEqual(all_fields, {'A', 'B', 'C'})


class TestFieldReferenceManager(TransactionTestCase):
    """FieldReferenceManager 边管理"""

    def setUp(self):
        self.user = User.objects.create_user(username='test', password='test')
        # 使用最小化的项目/表结构
        from apps.tabtinspace.models import Space, Organization
        self.organization = Organization.objects.create(name='test-ws', owner=self.user)
        self.space = Space.objects.create(
            name='test-proj', organization=self.organization, owner=self.user,
        )
        self.table = Table.objects.create(
            name='TestTable', project_id=self.space.id, organization_id=self.space.organization_id, owner=self.user,
        )
        self.field_a = TableField.objects.create(
            table=self.table, name='A', field_type='text', order=0,
        )
        self.field_b = TableField.objects.create(
            table=self.table, name='B', field_type='text', order=1,
        )
        self.field_c = TableField.objects.create(
            table=self.table, name='C', field_type='link', order=2,
        )

    def test_register_references(self):
        FieldReferenceManager.register_references(
            to_field_id=str(self.field_c.id),
            from_field_ids=[str(self.field_a.id), str(self.field_b.id)],
        )
        refs = FieldReference.objects.filter(to_field_id=self.field_c.id)
        self.assertEqual(refs.count(), 2)

    def test_register_replaces_old_edges(self):
        FieldReferenceManager.register_references(
            to_field_id=str(self.field_c.id),
            from_field_ids=[str(self.field_a.id)],
        )
        self.assertEqual(
            FieldReference.objects.filter(to_field_id=self.field_c.id).count(), 1,
        )

        # 重新注册，应替换旧边
        FieldReferenceManager.register_references(
            to_field_id=str(self.field_c.id),
            from_field_ids=[str(self.field_b.id)],
        )
        refs = FieldReference.objects.filter(to_field_id=self.field_c.id)
        self.assertEqual(refs.count(), 1)
        self.assertEqual(refs.first().from_field_id, self.field_b.id)

    def test_deregister_field(self):
        FieldReferenceManager.register_references(
            to_field_id=str(self.field_c.id),
            from_field_ids=[str(self.field_a.id)],
        )
        self.assertEqual(FieldReference.objects.count(), 1)

        FieldReferenceManager.deregister_field(str(self.field_c.id))
        self.assertEqual(FieldReference.objects.count(), 0)

    def test_check_cycle_before_add(self):
        # A → C 已存在
        FieldReferenceManager.register_references(
            to_field_id=str(self.field_c.id),
            from_field_ids=[str(self.field_a.id)],
        )
        # 尝试添加 C → A（形成环）
        self.assertTrue(
            FieldReferenceManager.check_cycle_before_add(
                to_field_id=str(self.field_a.id),
                from_field_ids=[str(self.field_c.id)],
            )
        )
        # 无环场景
        self.assertFalse(
            FieldReferenceManager.check_cycle_before_add(
                to_field_id=str(self.field_b.id),
                from_field_ids=[str(self.field_a.id)],
            )
        )


class TestCascadeServiceCTE(TransactionTestCase):
    """CascadeService.get_dependent_fields 递归 CTE"""

    def setUp(self):
        self.user = User.objects.create_user(username='test2', password='test2')
        from apps.tabtinspace.models import Space, Organization
        self.organization = Organization.objects.create(name='test-ws2', owner=self.user)
        self.space = Space.objects.create(
            name='test-proj2', organization=self.organization, owner=self.user,
        )
        # Table A: source
        self.table_a = Table.objects.create(
            name='TableA', project_id=self.space.id, organization_id=self.space.organization_id, owner=self.user,
        )
        self.field_price = TableField.objects.create(
            table=self.table_a, name='Price', field_type='number', order=0,
        )

        # Table B: two link fields used to exercise dependency traversal
        self.table_b = Table.objects.create(
            name='TableB', project_id=self.space.id, organization_id=self.space.organization_id, owner=self.user,
        )
        self.field_link = TableField.objects.create(
            table=self.table_b, name='Product', field_type='link', order=0,
            config={'foreignTableId': str(self.table_a.id)},
        )
        self.field_dependent_link = TableField.objects.create(
            table=self.table_b, name='Dependent Link', field_type='link', order=1,
            config={'foreignTableId': str(self.table_a.id)},
        )

        # Register edges used by the generic dependency graph.
        FieldReference.objects.create(
            from_field=self.field_price, to_field=self.field_dependent_link,
        )
        FieldReference.objects.create(
            from_field=self.field_link, to_field=self.field_dependent_link,
        )

    def test_direct_dependency(self):
        result = CascadeService.get_dependent_fields([str(self.field_price.id)])
        self.assertIn(str(self.table_b.id), result)
        self.assertIn(str(self.field_dependent_link.id), result[str(self.table_b.id)])

    def test_link_change_dependency(self):
        result = CascadeService.get_dependent_fields([str(self.field_link.id)])
        self.assertIn(str(self.table_b.id), result)
        self.assertIn(str(self.field_dependent_link.id), result[str(self.table_b.id)])

    def test_no_dependency(self):
        # A field with no downstream dependents
        orphan = TableField.objects.create(
            table=self.table_a, name='Orphan', field_type='text', order=2,
        )
        result = CascadeService.get_dependent_fields([str(orphan.id)])
        self.assertEqual(result, {})

    def test_transitive_dependency(self):
        """A → B → C 三级级联"""
        # Add Table C with a link depending on Table B's dependent link.
        table_c = Table.objects.create(
            name='TableC', project_id=self.space.id, organization_id=self.space.organization_id, owner=self.user,
        )
        field_link_c = TableField.objects.create(
            table=table_c, name='Order Link', field_type='link', order=0,
            config={'foreignTableId': str(self.table_b.id)},
        )
        field_dependent_link_c = TableField.objects.create(
            table=table_c, name='Nested Link', field_type='link', order=1,
            config={'foreignTableId': str(self.table_b.id)},
        )
        # Register edges
        FieldReference.objects.create(
            from_field=self.field_dependent_link, to_field=field_dependent_link_c,
        )
        FieldReference.objects.create(
            from_field=field_link_c, to_field=field_dependent_link_c,
        )

        # Changing price in table A should cascade to B and C
        result = CascadeService.get_dependent_fields([str(self.field_price.id)])
        self.assertIn(str(self.table_b.id), result)
        self.assertIn(str(table_c.id), result)
        self.assertIn(str(field_dependent_link_c.id), result[str(table_c.id)])
