"""
视图数据服务测试

测试 ViewDataService 的数据查询功能
"""
from datetime import date, timedelta
from typing import Any, Dict, Optional
from unittest import skipUnless
from django.contrib.auth import get_user_model
from django.db import connection
from django.db.models import Max
from django.test import TestCase
from django.utils import timezone

from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent
from apps.tabdata.models import LinkRecord, Table, TableField, TableRecord, TableView
from apps.tabdata.services.view_data_service import ViewDataService
from apps.tabdata.services.view_group_sort_service import apply_view_sorts

User = get_user_model()


class ViewDataServiceTestCase(TestCase):
    """视图数据服务测试用例"""

    databases = ['default', 'postgresql']

    def setUp(self):
        """设置测试数据"""
        # 创建用户
        self.user = User.objects.create_user(
            phone='13800000002',
            nickname='测试用户2'
        )

        ctx = create_test_organization_with_agent(
            owner=self.user,
            organization_name='测试组织2',
            space_name='测试项目2',
            prefix='view_data',
        )
        self.organization = ctx['organization']
        self.agent = ctx['agent']
        self.space = ctx['space']

        # 创建表格
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='测试表格2',
            owner=self.user
        )

        # 创建字段
        self.title_field = TableField.objects.create(
            table=self.table,
            name='任务标题',
            field_type='text',
            is_primary=True,
            order=0
        )

        self.status_field = TableField.objects.create(
            table=self.table,
            name='状态',
            field_type='select',
            config={
                'options': [
                    {'value': '待办', 'label': '待办'},
                    {'value': '进行中', 'label': '进行中'},
                    {'value': '已完成', 'label': '已完成'}
                ]
            },
            order=1
        )

        self.date_field = TableField.objects.create(
            table=self.table,
            name='截止日期',
            field_type='date',
            order=2
        )

        self.hours_field = TableField.objects.create(
            table=self.table,
            name='工时',
            field_type='number',
            order=3
        )

        self.done_field = TableField.objects.create(
            table=self.table,
            name='已完成',
            field_type='checkbox',
            order=4
        )

        self.image_field = TableField.objects.create(
            table=self.table,
            name='图片',
            field_type='attachment',
            order=5
        )

        self.tags_field = TableField.objects.create(
            table=self.table,
            name='标签',
            field_type='multi_select',
            config={
                'options': [
                    {'value': 'A', 'label': 'A'},
                    {'value': 'B', 'label': 'B'},
                    {'value': 'C', 'label': 'C'},
                ]
            },
            order=6
        )

        # 创建测试记录
        today = date.today()
        self.records = []

        for i in range(15):
            status = ['待办', '进行中', '已完成'][i % 3]
            deadline = today + timedelta(days=i)
            tag_pattern = i % 5
            if tag_pattern == 0:
                tags = ['A', 'B']
            elif tag_pattern == 1:
                tags = ['A']
            elif tag_pattern == 2:
                tags = ['B', 'C']
            elif tag_pattern == 3:
                tags = ['C']
            else:
                tags = []

            record = TableRecord.objects.create(
                table=self.table,
                created_by=self.user,
                data={
                    str(self.title_field.id): f'任务{i+1}',
                    str(self.status_field.id): status,
                    str(self.date_field.id): deadline.isoformat(),
                    str(self.hours_field.id): i + 1,
                    str(self.done_field.id): i % 2 == 0,
                    str(self.tags_field.id): tags,
                },
                order=i
            )
            self.records.append(record)

        # 创建服务实例
        self.service = ViewDataService(user=self.user)

    # ==================== 表格视图测试 ====================

    def test_get_grid_view_data(self):
        """测试获取表格视图数据"""
        # 创建表格视图
        view = TableView.objects.create(
            table=self.table,
            name='表格视图',
            view_type='grid',
            created_by=self.user,
            config={}
        )

        # 获取数据
        data = self.service.get_view_records(view.id, page=1, page_size=10)

        self.assertIsNotNone(data)
        self.assertIn('view', data)
        self.assertIn('records', data)
        self.assertIn('total', data)
        self.assertIn('metadata', data)
        self.assertEqual(data['view']['view_type'], 'grid')
        self.assertEqual(data['view']['table_id'], str(self.table.id))
        self.assertEqual(data['total'], 15)
        self.assertEqual(len(data['records']), 10)  # 第一页10条

    @skipUnless(connection.vendor == 'postgresql', 'Requires PostgreSQL (native SQL uses :: cast)')
    def test_grid_sub_record_search_hide_not_match_rows_keeps_parent_chain(self):
        """搜索命中子记录时，隐藏不匹配行应返回命中行和完整父链"""
        parent_field = TableField.objects.create(
            table=self.table,
            name='父记录',
            field_type='link',
            order=20,
            config={
                'foreignTableId': str(self.table.id),
                'relationship': 'ManyOne',
                'isOneWay': True,
                'isSubRecordParentField': True,
            },
        )

        root = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(self.title_field.id): 'Root'},
            order=100,
        )
        parent = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(self.title_field.id): 'Parent'},
            order=101,
        )
        child = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(self.title_field.id): 'Match Child'},
            order=102,
        )
        other = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(self.title_field.id): 'Other'},
            order=103,
        )

        LinkRecord.objects.create(
            link_field=parent_field,
            self_record=parent,
            foreign_record=root,
            order=0,
        )
        LinkRecord.objects.create(
            link_field=parent_field,
            self_record=child,
            foreign_record=parent,
            order=0,
        )

        view = TableView.objects.create(
            table=self.table,
            name='子记录搜索视图',
            view_type='grid',
            created_by=self.user,
            config={'subRecordParentFieldId': str(parent_field.id)},
        )

        data = self.service.get_view_records(
            view.id,
            page=1,
            page_size=50,
            field_key_type='id',
            search='Match',
            search_field_ids=[str(self.title_field.id)],
            search_hide_not_match_rows=True,
        )

        returned_ids = [record['id'] for record in data['records']]
        self.assertEqual(
            returned_ids,
            [str(root.id), str(parent.id), str(child.id)],
        )
        self.assertNotIn(str(other.id), returned_ids)

        sub_records_meta = (data.get('metadata') or {}).get('sub_records') or {}
        tree_data = sub_records_meta.get('tree_data') or {}
        self.assertEqual(tree_data.get(str(root.id), {}).get('depth'), 0)
        self.assertEqual(tree_data.get(str(parent.id), {}).get('depth'), 1)
        self.assertEqual(tree_data.get(str(child.id), {}).get('depth'), 2)

    @skipUnless(connection.vendor == 'postgresql', 'Requires PostgreSQL (native SQL uses :: cast)')
    def test_grid_switches_tree_when_sub_record_parent_field_changes(self):
        """两套父字段各自保存独立 LinkRecord；切换 subRecordParentFieldId 后 tree_data/顺序随之切换"""
        field_a = TableField.objects.create(
            table=self.table,
            name='父记录 A',
            field_type='link',
            order=20,
            config={
                'foreignTableId': str(self.table.id),
                'relationship': 'ManyOne',
                'isOneWay': True,
                'isSubRecordParentField': True,
            },
        )
        field_b = TableField.objects.create(
            table=self.table,
            name='父记录 B',
            field_type='link',
            order=21,
            config={
                'foreignTableId': str(self.table.id),
                'relationship': 'ManyOne',
                'isOneWay': True,
                'isSubRecordParentField': True,
            },
        )

        root_a = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(self.title_field.id): 'RootA'},
            order=200,
        )
        child_a = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(self.title_field.id): 'ChildA'},
            order=201,
        )
        root_b = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(self.title_field.id): 'RootB'},
            order=202,
        )
        child_b = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(self.title_field.id): 'ChildB'},
            order=203,
        )

        LinkRecord.objects.create(
            link_field=field_a,
            self_record=child_a,
            foreign_record=root_a,
            order=0,
        )
        LinkRecord.objects.create(
            link_field=field_b,
            self_record=child_b,
            foreign_record=root_b,
            order=0,
        )

        view = TableView.objects.create(
            table=self.table,
            name='多父字段切换视图',
            view_type='grid',
            created_by=self.user,
            config={'subRecordParentFieldId': str(field_a.id)},
        )

        data_a = self.service.get_view_records(view.id, page=1, page_size=50)
        tree_a = ((data_a.get('metadata') or {}).get('sub_records') or {}).get('tree_data') or {}
        self.assertEqual(tree_a.get(str(root_a.id), {}).get('depth'), 0)
        self.assertEqual(tree_a.get(str(child_a.id), {}).get('depth'), 1)
        self.assertEqual(tree_a.get(str(child_b.id), {}).get('depth'), 0)

        view.config = {'subRecordParentFieldId': str(field_b.id)}
        view.save(update_fields=['config'])

        data_b = self.service.get_view_records(view.id, page=1, page_size=50)
        tree_b = ((data_b.get('metadata') or {}).get('sub_records') or {}).get('tree_data') or {}
        self.assertEqual(tree_b.get(str(root_b.id), {}).get('depth'), 0)
        self.assertEqual(tree_b.get(str(child_b.id), {}).get('depth'), 1)
        self.assertEqual(tree_b.get(str(child_a.id), {}).get('depth'), 0)

        ids_a = [record['id'] for record in data_a['records']]
        ids_b = [record['id'] for record in data_b['records']]
        self.assertLess(ids_a.index(str(root_a.id)), ids_a.index(str(child_a.id)))
        self.assertLess(ids_b.index(str(root_b.id)), ids_b.index(str(child_b.id)))

    def test_grid_view_pagination(self):
        """测试表格视图分页"""
        view = TableView.objects.create(
            table=self.table,
            name='表格视图',
            view_type='grid',
            created_by=self.user,
            config={}
        )

        # 第一页
        data_page1 = self.service.get_view_records(view.id, page=1, page_size=5)
        self.assertEqual(len(data_page1['records']), 5)

        # 第二页
        data_page2 = self.service.get_view_records(view.id, page=2, page_size=5)
        self.assertEqual(len(data_page2['records']), 5)

        # 第三页
        data_page3 = self.service.get_view_records(view.id, page=3, page_size=5)
        self.assertEqual(len(data_page3['records']), 5)

        # 第四页（只有0条）
        data_page4 = self.service.get_view_records(view.id, page=4, page_size=5)
        self.assertEqual(len(data_page4['records']), 0)

    def test_grid_latest_version_uses_monotonic_version_token(self):
        """测试 grid latest_version 使用单调 version token（base + version）"""
        view = TableView.objects.create(
            table=self.table,
            name='表格视图',
            view_type='grid',
            created_by=self.user,
            config={}
        )

        data = self.service.get_view_records(view.id, page=1, page_size=10)
        expected_latest_version = TableRecord.objects.filter(
            table=self.table,
            is_deleted=False
        ).aggregate(max_version=Max('version')).get('max_version')

        self.assertIsNotNone(expected_latest_version)
        expected_token = self.service._encode_monotonic_version_token(int(expected_latest_version))
        self.assertEqual(data['latest_version'], expected_token)

    def test_grid_only_delta_filters_by_version_token(self):
        """测试 grid only_delta 按 version token 过滤增量"""
        view = TableView.objects.create(
            table=self.table,
            name='表格视图',
            view_type='grid',
            created_by=self.user,
            config={}
        )

        initial = self.service.get_view_records(view.id, page=1, page_size=20)
        since_version = initial['latest_version']
        self.assertGreater(since_version, 0)

        target = self.records[0]
        updated_data = dict(target.data or {})
        updated_data[str(self.title_field.id)] = '增量版本更新'
        TableRecord.objects.filter(id=target.id).update(
            data=updated_data,
            version=(target.version or 0) + 1,
            updated_at=timezone.now() + timedelta(seconds=5)
        )

        delta = self.service.get_view_records(
            view.id,
            page=1,
            page_size=20,
            since_version=since_version,
            only_delta=True
        )

        self.assertTrue(delta['has_changes'])
        self.assertEqual(delta['matched_total'], delta['total'])
        self.assertGreaterEqual(delta['delta_total'], 1)
        self.assertGreaterEqual(len(delta['records']), 1)
        delta_ids = {record['id'] for record in delta['records']}
        self.assertIn(str(target.id), delta_ids)
        self.assertGreater(delta['latest_version'], since_version)

    def test_grid_legacy_timestamp_since_version_still_supported(self):
        """测试旧版毫秒时间戳 since_version 仍可兼容判定/过滤。"""
        view = TableView.objects.create(
            table=self.table,
            name='表格视图',
            view_type='grid',
            created_by=self.user,
            config={}
        )

        latest_updated = TableRecord.objects.filter(
            table=self.table,
            is_deleted=False
        ).aggregate(max_updated=Max('updated_at')).get('max_updated')
        self.assertIsNotNone(latest_updated)
        legacy_since_version = int(latest_updated.timestamp() * 1000)

        no_change = self.service.get_view_records(
            view.id,
            page=1,
            page_size=20,
            since_version=legacy_since_version,
            only_delta=True,
        )
        self.assertFalse(no_change['has_changes'])
        self.assertEqual(no_change['matched_total'], no_change['total'])
        self.assertEqual(no_change['delta_total'], 0)
        self.assertEqual(len(no_change['records']), 0)

        target = self.records[1]
        TableRecord.objects.filter(id=target.id).update(
            updated_at=timezone.now() + timedelta(seconds=10)
        )

        legacy_delta = self.service.get_view_records(
            view.id,
            page=1,
            page_size=20,
            since_version=legacy_since_version,
            only_delta=True,
        )
        self.assertTrue(legacy_delta['has_changes'])
        self.assertEqual(legacy_delta['matched_total'], legacy_delta['total'])
        self.assertGreaterEqual(legacy_delta['delta_total'], 1)
        delta_ids = {record['id'] for record in legacy_delta['records']}
        self.assertIn(str(target.id), delta_ids)

    # ==================== 看板视图测试 ====================

    def test_get_kanban_view_data(self):
        """测试获取看板视图数据"""
        view = TableView.objects.create(
            table=self.table,
            name='看板视图',
            view_type='kanban',
            created_by=self.user,
            config={
                'group_by_field': str(self.status_field.id),
                'card_title_field': str(self.title_field.id)
            }
        )

        data = self.service.get_view_records(view.id)

        self.assertIsNotNone(data)
        self.assertEqual(data['metadata']['view_type'], 'kanban')
        self.assertIn('groups', data['metadata'])

        groups = data['metadata']['groups']
        self.assertEqual(len(groups), 3)  # 3个状态分组

        # 验证分组
        group_values = [g['group_value'] for g in groups]
        self.assertIn('待办', group_values)
        self.assertIn('进行中', group_values)
        self.assertIn('已完成', group_values)

        # 验证每个分组的记录数
        for group in groups:
            self.assertGreater(group['count'], 0)
            self.assertIsInstance(group['records'], list)

    def test_kanban_group_counts(self):
        """测试看板视图分组统计"""
        view = TableView.objects.create(
            table=self.table,
            name='看板视图',
            view_type='kanban',
            created_by=self.user,
            config={
                'group_by_field': str(self.status_field.id),
                'card_title_field': str(self.title_field.id)
            }
        )

        data = self.service.get_view_records(view.id)
        groups = data['metadata']['groups']

        # 15条记录，每3条一个状态
        for group in groups:
            if group['group_value'] in ['待办', '进行中', '已完成']:
                self.assertEqual(group['count'], 5)

    def test_kanban_skips_empty_select_options_and_keeps_single_ungrouped_group(self):
        """空 select option 不应在看板里生成多个「未分组」列。"""
        self.status_field.config = {
            'options': [
                {'value': '待办', 'label': '待办'},
                {'value': '', 'label': ''},
                {'value': None, 'label': '空选项'},
                {'label': '缺少 value'},
                {'value': '进行中', 'label': '进行中'},
                {'value': '已完成', 'label': '已完成'},
            ]
        }
        self.status_field.save(update_fields=['config'])
        TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '未设置状态任务',
                str(self.status_field.id): '',
            },
            order=100,
        )
        view = TableView.objects.create(
            table=self.table,
            name='看板视图',
            view_type='kanban',
            created_by=self.user,
            config={
                'group_by_field': str(self.status_field.id),
                'card_title_field': str(self.title_field.id)
            }
        )

        data = self.service.get_view_records(view.id)
        groups = data['metadata']['groups']
        group_values = [group['group_value'] for group in groups]

        self.assertEqual(group_values.count(None), 1)
        self.assertNotIn('', group_values)
        self.assertNotIn('空选项', group_values)
        self.assertNotIn('缺少 value', group_values)
        self.assertEqual(
            set(value for value in group_values if value is not None),
            {'待办', '进行中', '已完成'},
        )
        ungrouped_group = next(group for group in groups if group['group_value'] is None)
        self.assertEqual(ungrouped_group['count'], 1)
        self.assertEqual(ungrouped_group['group_label'], '未分组')

    def test_group_labels_use_choice_value_not_translated_label(self):
        """分组元数据应展示真实 value，不能把 choice label 当作用户数据翻译。"""
        status_field = TableField.objects.create(
            table=self.table,
            name='英文状态',
            field_type='select',
            config={
                'choices': [
                    {'value': 'open', 'label': '打开', 'color': '#48BB78'},
                    {'value': 'closed', 'label': '关闭', 'color': '#F56565'},
                ],
            },
            order=20,
        )
        TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '英文状态任务 1',
                str(status_field.id): 'open',
            },
            order=100,
        )
        TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '英文状态任务 2',
                str(status_field.id): 'closed',
            },
            order=101,
        )

        grid_view = TableView.objects.create(
            table=self.table,
            name='英文状态分组',
            view_type='grid',
            created_by=self.user,
            groups=[{'field_id': str(status_field.id), 'direction': 'asc'}],
        )
        grid_data = self.service.get_view_records(grid_view.id)
        grid_nodes = grid_data['metadata']['groups']['nodes']
        grid_labels = {node['group_value']: node['group_label'] for node in grid_nodes}
        self.assertEqual(grid_labels['open'], 'open')
        self.assertEqual(grid_labels['closed'], 'closed')
        self.assertEqual([node['group_value'] for node in grid_nodes[:2]], ['open', 'closed'])

        kanban_view = TableView.objects.create(
            table=self.table,
            name='英文状态看板',
            view_type='kanban',
            created_by=self.user,
            config={
                'group_by_field': str(status_field.id),
                'card_title_field': str(self.title_field.id),
            },
        )
        kanban_data = self.service.get_view_records(kanban_view.id)
        kanban_groups = kanban_data['metadata']['groups']
        kanban_labels = {
            group['group_value']: group['group_label']
            for group in kanban_groups
        }
        self.assertEqual(kanban_labels['open'], 'open')
        self.assertEqual(kanban_labels['closed'], 'closed')
        self.assertEqual([group['group_value'] for group in kanban_groups[:2]], ['open', 'closed'])
        kanban_colors = {
            group['group_value']: group['color']
            for group in kanban_groups
        }
        self.assertEqual(kanban_colors['open'], '#48BB78')
        self.assertEqual(kanban_colors['closed'], '#F56565')

        legacy_status_field = TableField.objects.create(
            table=self.table,
            name='旧格式英文状态',
            field_type='select',
            config={
                'choices': [
                    {'id': 'open', 'label': '打开'},
                    {'id': 'closed', 'label': '关闭'},
                ],
            },
            order=21,
        )
        open_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '旧格式 open',
                str(legacy_status_field.id): 'open',
            },
            order=201,
        )
        closed_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '旧格式 closed',
                str(legacy_status_field.id): 'closed',
            },
            order=200,
        )
        sort_view = TableView.objects.create(
            table=self.table,
            name='旧格式状态排序',
            view_type='grid',
            created_by=self.user,
            sorts=[{'field_id': str(legacy_status_field.id), 'direction': 'asc'}],
        )
        sorted_ids = list(
            apply_view_sorts(
                sort_view,
                TableRecord.objects.filter(id__in=[open_record.id, closed_record.id]),
            ).values_list('id', flat=True)
        )
        self.assertEqual(sorted_ids, [open_record.id, closed_record.id])

    def test_kanban_since_version_without_changes_keeps_full_payload(self):
        """看板视图在 since_version 未变时仍返回全量 payload。"""
        view = TableView.objects.create(
            table=self.table,
            name='看板视图',
            view_type='kanban',
            created_by=self.user,
            config={
                'group_by_field': str(self.status_field.id),
                'card_title_field': str(self.title_field.id)
            }
        )

        initial = self.service.get_view_records(view.id, page=1, page_size=10)
        no_change = self.service.get_view_records(
            view.id,
            page=1,
            page_size=10,
            since_version=initial['latest_version'],
        )

        self.assertFalse(no_change['has_changes'])
        self.assertEqual(no_change['total'], initial['total'])
        self.assertEqual(no_change['matched_total'], initial['total'])
        self.assertEqual(len(no_change['metadata']['groups']), len(initial['metadata']['groups']))

    # ==================== 日历视图测试 ====================

    def test_get_calendar_view_data(self):
        """测试获取日历视图数据"""
        view = TableView.objects.create(
            table=self.table,
            name='日历视图',
            view_type='calendar',
            created_by=self.user,
            config={
                'date_field': str(self.date_field.id),
                'title_field': str(self.title_field.id),
                'default_view_mode': 'month'
            }
        )

        # 查询本月数据
        today = date.today()
        start_date = date(today.year, today.month, 1)
        if today.month == 12:
            end_date = date(today.year + 1, 1, 1) - timedelta(days=1)
        else:
            end_date = date(today.year, today.month + 1, 1) - timedelta(days=1)

        date_range = f"{start_date.isoformat()},{end_date.isoformat()}"
        data = self.service.get_view_records(view.id, date_range=date_range)

        self.assertIsNotNone(data)
        self.assertEqual(data['metadata']['view_type'], 'calendar')
        self.assertIn('date_range', data['metadata'])
        self.assertGreater(len(data['records']), 0)
        # setUp 造了 today .. today+14，bounds 应覆盖该区间（不受当月 date_range 裁剪）
        bounds = data['metadata'].get('date_bounds')
        self.assertIsNotNone(bounds)
        self.assertEqual(bounds['min'], today.isoformat())
        self.assertEqual(bounds['max'], (today + timedelta(days=14)).isoformat())

    def test_calendar_date_bounds_empty_date_field(self):
        """基准日期列全空时 date_bounds 为 null"""
        TableRecord.objects.filter(table=self.table).delete()
        TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '无日期任务',
                str(self.status_field.id): '待办',
            },
            order=0,
        )
        view = self._make_calendar_view()
        data = self.service.get_view_records(view.id, page=1, page_size=50)
        self.assertIn('date_bounds', data['metadata'])
        self.assertIsNone(data['metadata']['date_bounds'])

    def test_calendar_date_bounds_ignores_date_range_window(self):
        """date_bounds 反映全表最晚日期，不被当前查询月窗口裁剪"""
        TableRecord.objects.filter(table=self.table).delete()
        # 不走 _make_calendar_record：无 native 表时 sync 探测会毒化 PG 事务
        for start, title in (
            (date(2026, 6, 10), '六月事件'),
            (date(2026, 6, 11), '六月事件2'),
        ):
            TableRecord.objects.create(
                table=self.table,
                created_by=self.user,
                data={
                    str(self.title_field.id): title,
                    str(self.date_field.id): start.isoformat(),
                },
                order=1000,
            )
        view = self._make_calendar_view()
        # 故意查 7 月空窗
        data = self.service.get_view_records(
            view.id,
            date_range='2026-07-01,2026-07-31',
            page=1,
            page_size=50,
        )
        self.assertEqual(len(data['records']), 0)
        bounds = data['metadata']['date_bounds']
        self.assertIsNotNone(bounds)
        self.assertEqual(bounds['min'], '2026-06-10')
        self.assertEqual(bounds['max'], '2026-06-11')

    def test_calendar_date_bounds_respects_view_filters(self):
        """带视图筛选时 date_bounds 只反映过滤后集合"""
        TableRecord.objects.filter(table=self.table).delete()
        TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '待办早',
                str(self.date_field.id): '2026-01-05',
                str(self.status_field.id): '待办',
            },
            order=1,
        )
        TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '进行中晚',
                str(self.date_field.id): '2026-06-11',
                str(self.status_field.id): '进行中',
            },
            order=2,
        )

        view = TableView.objects.create(
            table=self.table,
            name='日历筛选视图',
            view_type='calendar',
            created_by=self.user,
            config={
                'date_field': str(self.date_field.id),
                'title_field': str(self.title_field.id),
            },
            filters=[
                {
                    'field_id': str(self.status_field.id),
                    'operator': 'equals',
                    'value': '进行中',
                    'enabled': True,
                }
            ],
        )

        data = self.service.get_view_records(view.id, page=1, page_size=50)
        bounds = data['metadata']['date_bounds']
        self.assertIsNotNone(bounds)
        self.assertEqual(bounds['min'], '2026-06-11')
        self.assertEqual(bounds['max'], '2026-06-11')

    def test_calendar_date_bounds_native_path(self):
        """native 路径也能返回 date_bounds，且不受 date_range 裁剪"""
        TableRecord.objects.filter(table=self.table).delete()
        self._ensure_native_table()
        self._make_calendar_record(start=date(2026, 6, 10), title='六月A')
        self._make_calendar_record(start=date(2026, 6, 11), title='六月B')
        view = self._make_calendar_view()
        data = self.service.get_view_records(
            view.id,
            date_range='2026-07-01,2026-07-31',
            page=1,
            page_size=50,
        )
        self._assert_native_path(data)
        self.assertEqual(len(data['records']), 0)
        bounds = data['metadata']['date_bounds']
        self.assertIsNotNone(bounds)
        self.assertEqual(bounds['min'], '2026-06-10')
        self.assertEqual(bounds['max'], '2026-06-11')

    def _ensure_end_date_field(self):
        """惰性创建 self.end_date_field（仅当测试需要跨天能力时调用）"""
        existing = getattr(self, 'end_date_field', None)
        if existing is not None:
            return existing
        self.end_date_field = TableField.objects.create(
            table=self.table,
            name='结束日期',
            field_type='date',
            order=10,
        )
        return self.end_date_field

    def _ensure_native_table(self):
        """为当前 self.table 构造原生 PG schema + 表 + 所有用户字段列。

        重复调用安全：DDLManager 内部用 IF NOT EXISTS。
        """
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.native.ddl_manager import DDLManager
        from apps.tabdata.native.pg_type_map import is_system_field

        ddl = DDLManager(db_alias=TABDATA_DB_ALIAS)
        ddl.ensure_schema(self.space.id)
        ddl.create_native_table(self.space.id, self.table.id)
        for field in self.table.fields.filter(is_deleted=False):
            if not is_system_field(field.field_type):
                ddl.add_column(
                    self.space.id, self.table.id,
                    field.id, field.field_type, field.config or {},
                )

    def _setup_calendar_native_with_end(self):
        """跨天测试通用前置：建 native 表 + 创建 end_date_field 列。"""
        self._ensure_end_date_field()
        self._ensure_native_table()

    def _make_calendar_view(self, *, with_end_date_field: bool = False, end_field_id_override: Optional[str] = None) -> TableView:
        """构造一个日历视图，可选择是否配置 end_date_field"""
        if with_end_date_field:
            end_field = self._ensure_end_date_field()
            end_id = end_field_id_override or str(end_field.id)
        else:
            end_id = end_field_id_override
        config = {
            'date_field': str(self.date_field.id),
            'title_field': str(self.title_field.id),
        }
        if end_id is not None:
            config['end_date_field'] = end_id
        return TableView.objects.create(
            table=self.table,
            name='日历视图',
            view_type='calendar',
            created_by=self.user,
            config=config,
        )

    def _make_calendar_record(
        self,
        *,
        start: date,
        end: Optional[date] = None,
        title: str = '事件',
        order: int = 1000,
    ) -> TableRecord:
        """构造一条带（可选）结束日期的日历记录。

        如果当前 self.table 已建立 native PG 列存储，会用 NativeRecordIO
        同步写入 native 列，确保 calendar 服务的 native 路径能查到这条记录。
        """
        data: Dict[str, Any] = {
            str(self.title_field.id): title,
            str(self.date_field.id): start.isoformat(),
        }
        if end is not None and getattr(self, 'end_date_field', None) is not None:
            data[str(self.end_date_field.id)] = end.isoformat()
        record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data=data,
            order=order,
        )
        self._sync_record_to_native(record, data)
        return record

    def _sync_record_to_native(self, record: TableRecord, data: Dict[str, Any]) -> None:
        """把 record.data 同步写入 native 列存储（仅当 native 表已建好时）。

        测试默认用 ORM `TableRecord.objects.create` 创建数据，但 calendar
        服务的 native 路径只读 native 列。这个 helper 把 data 翻译成 native
        值并写入，让 native 路径在测试里也能看到数据。
        """
        from apps.tabdata.native.record_io import NativeRecordIO
        from apps.tabdata.native.value_converter import python_to_pg
        from apps.tabdata.native.pg_type_map import is_system_field

        try:
            io = NativeRecordIO(self.space.id, self.table.id)
        except Exception:
            return
        # 探测 native 表是否已建：表不存在时 read_single 会抛 DatabaseError
        try:
            io.read_single(record.id)
        except Exception:
            return

        fields = list(self.table.fields.filter(is_deleted=False))
        field_map = {str(f.id): f for f in fields}
        pg_values: Dict[str, Any] = {}
        for field_id_str, value in data.items():
            field = field_map.get(field_id_str)
            if not field or is_system_field(field.field_type):
                continue
            pg_values[field.id.hex] = python_to_pg(value, field.field_type, field.config)

        io.insert_record(
            record_id=record.id,
            field_values=pg_values,
            system_values={
                '__order': float(record.order or 0),
                '__version': int(record.version or 1),
                '__created_at': record.created_at,
                '__updated_at': record.updated_at,
                '__created_by': record.created_by_id,
            },
        )

    def _assert_native_path(self, data: Dict[str, Any]) -> None:
        """断言 calendar 服务真的走了 native 路径（不是 ORM fallback）"""
        self.assertNotEqual(
            data['metadata'].get('data_source'), 'orm_fallback',
            '该测试期望走 native 路径，但被降级到 ORM fallback；SQL 路径未被验证',
        )

    def _assert_wrapper_shape(self, event: Dict[str, Any]) -> None:
        """断言 wrapper 完整包含新协议字段"""
        for key in (
            'date', 'record', 'is_start', 'is_end',
            'span_total_days', 'occurrence_index', 'dirty', 'truncated',
        ):
            self.assertIn(key, event, f'missing wrapper key: {key}')
        self.assertIsInstance(event['date'], str)
        self.assertIsInstance(event['record'], dict)
        self.assertIsInstance(event['is_start'], bool)
        self.assertIsInstance(event['is_end'], bool)
        self.assertIsInstance(event['span_total_days'], int)
        self.assertIsInstance(event['occurrence_index'], int)
        self.assertIsInstance(event['dirty'], bool)
        self.assertIsInstance(event['truncated'], bool)

    def test_calendar_date_range_filter(self):
        """日历视图日期范围过滤：单字段视图返回新 wrapper 形状且日期落在窗口内"""
        view = self._make_calendar_view()
        today = date.today()
        tomorrow = today + timedelta(days=2)
        date_range = f"{today.isoformat()},{tomorrow.isoformat()}"

        data = self.service.get_view_records(view.id, date_range=date_range)

        events = data['records']
        self.assertGreater(len(events), 0)
        for event in events:
            self._assert_wrapper_shape(event)
            event_date = date.fromisoformat(event['date'])
            self.assertGreaterEqual(event_date, today)
            self.assertLessEqual(event_date, tomorrow)
            self.assertTrue(event['is_start'])
            self.assertTrue(event['is_end'])
            self.assertEqual(event['span_total_days'], 1)
            self.assertEqual(event['occurrence_index'], 0)
            self.assertFalse(event['dirty'])

    def test_calendar_single_field_event_compatibility(self):
        """未配 end_date_field：所有事件退化为单点 wrapper（每条 record 一个 occurrence）"""
        view = self._make_calendar_view(with_end_date_field=False)
        today = date.today()
        date_range = f"{(today - timedelta(days=1)).isoformat()},{(today + timedelta(days=20)).isoformat()}"

        data = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=100)

        events = data['records']
        self.assertEqual(len(events), 15, '单字段日历应为每条 record 返回一个 wrapper')
        for event in events:
            self._assert_wrapper_shape(event)
            self.assertTrue(event['is_start'])
            self.assertTrue(event['is_end'])
            self.assertEqual(event['span_total_days'], 1)
            self.assertEqual(event['occurrence_index'], 0)
            self.assertFalse(event['dirty'])

    def test_calendar_multi_day_event_within_month(self):
        """跨天事件全在查询窗口内：返回 N 个连续 occurrence"""
        self._setup_calendar_native_with_end()
        view = self._make_calendar_view(with_end_date_field=True)
        anchor = date(2026, 4, 9)
        self._make_calendar_record(start=anchor, end=anchor + timedelta(days=4), title='5 天会议')

        date_range = '2026-04-01,2026-04-30'
        data = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=100)
        self._assert_native_path(data)

        events = [e for e in data['records'] if e['record']['data'].get('任务标题') == '5 天会议']
        self.assertEqual(len(events), 5)
        for offset, event in enumerate(events):
            self._assert_wrapper_shape(event)
            self.assertEqual(
                event['date'],
                (anchor + timedelta(days=offset)).isoformat(),
            )
            self.assertEqual(event['span_total_days'], 5)
            self.assertEqual(event['occurrence_index'], offset)
            self.assertFalse(event['dirty'])
            self.assertEqual(event['is_start'], offset == 0)
            self.assertEqual(event['is_end'], offset == 4)

    def test_calendar_multi_day_event_crossing_month_boundary(self):
        """事件起于上月、止于本月：本月查询应只返回本月段，并标注正确的 is_start/is_end/occurrence_index"""
        self._setup_calendar_native_with_end()
        view = self._make_calendar_view(with_end_date_field=True)
        # 事件：3/28 ~ 4/3（共 7 天）
        start = date(2026, 3, 28)
        end = date(2026, 4, 3)
        self._make_calendar_record(start=start, end=end, title='跨月事件')

        date_range = '2026-04-01,2026-04-30'
        data = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=100)
        self._assert_native_path(data)

        events = [e for e in data['records'] if e['record']['data'].get('任务标题') == '跨月事件']
        self.assertEqual(len(events), 3, '4 月段应只有 4/1, 4/2, 4/3 三天')
        expected_dates = ['2026-04-01', '2026-04-02', '2026-04-03']
        actual_dates = [e['date'] for e in events]
        self.assertEqual(actual_dates, expected_dates)
        for event in events:
            self._assert_wrapper_shape(event)
            self.assertEqual(event['span_total_days'], 7)
            self.assertFalse(event['dirty'])
        # 4/1 既不是事件起点也不是终点（occurrence_index 应继承 start=3/28 的偏移 = 4 天）
        self.assertFalse(events[0]['is_start'])
        self.assertEqual(events[0]['occurrence_index'], 4)
        self.assertFalse(events[1]['is_start'])
        self.assertFalse(events[1]['is_end'])
        # 4/3 是事件终点
        self.assertTrue(events[2]['is_end'])
        self.assertEqual(events[2]['occurrence_index'], 6)

    def test_calendar_overlap_query_long_event(self):
        """长事件横跨整个查询区间：SQL 范围重叠必须把它查到，并展开为查询窗口内的全部 occurrence"""
        self._setup_calendar_native_with_end()
        view = self._make_calendar_view(with_end_date_field=True)
        # 事件：3/1 ~ 5/1（远长于查询区间）
        self._make_calendar_record(start=date(2026, 3, 1), end=date(2026, 5, 1), title='长项目')

        date_range = '2026-04-01,2026-04-07'
        data = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=100)

        # 必须真正走 native 范围重叠 SQL（如果降级 ORM，metadata 会显式暴露）
        self.assertNotEqual(
            data['metadata'].get('data_source'), 'orm_fallback',
            'overlap 查询必须由 native 路径覆盖，否则 SQL 范围重叠未被验证',
        )

        events = [e for e in data['records'] if e['record']['data'].get('任务标题') == '长项目']
        self.assertEqual(len(events), 7, '查询窗口 7 天内每天应有 1 个 occurrence')
        expected_dates = [
            '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04',
            '2026-04-05', '2026-04-06', '2026-04-07',
        ]
        self.assertEqual([e['date'] for e in events], expected_dates)
        for event in events:
            # 全部既不是 start 也不是 end（事件起止都在查询窗外）
            self.assertFalse(event['is_start'])
            self.assertFalse(event['is_end'])
            self.assertEqual(event['span_total_days'], 62)
            self.assertFalse(event['dirty'])

    def test_calendar_dirty_data_end_before_start(self):
        """脏数据 end<start：按单点处理，dirty=True，span_total_days=1"""
        self._setup_calendar_native_with_end()
        view = self._make_calendar_view(with_end_date_field=True)
        self._make_calendar_record(start=date(2026, 4, 15), end=date(2026, 4, 10), title='脏数据')

        date_range = '2026-04-01,2026-04-30'
        data = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=100)
        self._assert_native_path(data)

        events = [e for e in data['records'] if e['record']['data'].get('任务标题') == '脏数据']
        self.assertEqual(len(events), 1)
        event = events[0]
        self._assert_wrapper_shape(event)
        self.assertEqual(event['date'], '2026-04-15')
        self.assertTrue(event['is_start'])
        self.assertTrue(event['is_end'])
        self.assertEqual(event['span_total_days'], 1)
        self.assertEqual(event['occurrence_index'], 0)
        self.assertTrue(event['dirty'])

    def test_calendar_dirty_data_window_spans_only_start(self):
        """脏数据 + 查询窗口仅覆盖 start：原 SQL 用 COALESCE(end,start) 会漏行，必须返回单点。"""
        self._setup_calendar_native_with_end()
        view = self._make_calendar_view(with_end_date_field=True)
        # 脏数据 start=4/15, end=4/10。查询窗口 4/14~4/16 不含 end，但应该看见 start 单点。
        self._make_calendar_record(start=date(2026, 4, 15), end=date(2026, 4, 10), title='脏数据-窗口仅含start')

        date_range = '2026-04-14,2026-04-16'
        data = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=100)
        self._assert_native_path(data)

        events = [e for e in data['records'] if e['record']['data'].get('任务标题') == '脏数据-窗口仅含start']
        self.assertEqual(len(events), 1, '脏数据 end<start 时即使查询窗口落在 [end, start] 之外也必须看到 start 单点')
        event = events[0]
        self.assertEqual(event['date'], '2026-04-15')
        self.assertTrue(event['dirty'])
        self.assertTrue(event['is_start'])
        self.assertTrue(event['is_end'])
        self.assertEqual(event['span_total_days'], 1)

    def test_calendar_missing_end_date_in_record(self):
        """配了 end_date_field 但该记录 end 为空：按单点处理，dirty=False"""
        self._setup_calendar_native_with_end()
        view = self._make_calendar_view(with_end_date_field=True)
        self._make_calendar_record(start=date(2026, 4, 9), end=None, title='只配开始')

        date_range = '2026-04-01,2026-04-30'
        data = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=100)
        self._assert_native_path(data)

        events = [e for e in data['records'] if e['record']['data'].get('任务标题') == '只配开始']
        self.assertEqual(len(events), 1)
        event = events[0]
        self._assert_wrapper_shape(event)
        self.assertEqual(event['date'], '2026-04-09')
        self.assertTrue(event['is_start'])
        self.assertTrue(event['is_end'])
        self.assertEqual(event['span_total_days'], 1)
        self.assertEqual(event['occurrence_index'], 0)
        self.assertFalse(event['dirty'])

    def test_calendar_occurrence_metadata(self):
        """occurrence wrapper 元数据校验：is_start/is_end/span_total_days/occurrence_index 必须正确"""
        self._setup_calendar_native_with_end()
        view = self._make_calendar_view(with_end_date_field=True)
        # 事件：4/9 ~ 4/15（共 7 天，全部在查询窗口内）
        start = date(2026, 4, 9)
        end = date(2026, 4, 15)
        self._make_calendar_record(start=start, end=end, title='元数据校验')

        date_range = '2026-04-01,2026-04-30'
        data = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=100)
        self._assert_native_path(data)

        events = [e for e in data['records'] if e['record']['data'].get('任务标题') == '元数据校验']
        self.assertEqual(len(events), 7)
        # 顺序与 occurrence_index
        for offset, event in enumerate(events):
            self._assert_wrapper_shape(event)
            self.assertEqual(event['occurrence_index'], offset)
            self.assertEqual(event['span_total_days'], 7)
            self.assertEqual(event['date'], (start + timedelta(days=offset)).isoformat())
            self.assertFalse(event['dirty'])
        self.assertTrue(events[0]['is_start'])
        self.assertFalse(events[0]['is_end'])
        for mid in events[1:-1]:
            self.assertFalse(mid['is_start'])
            self.assertFalse(mid['is_end'])
        self.assertFalse(events[-1]['is_start'])
        self.assertTrue(events[-1]['is_end'])

    def test_calendar_pagination_metadata_clarifies_units(self):
        """metadata 必须明确分页单位是 record，并暴露 occurrence_count，避免前端踩坑。"""
        self._setup_calendar_native_with_end()
        view = self._make_calendar_view(with_end_date_field=True)
        self._make_calendar_record(
            start=date(2026, 4, 1), end=date(2026, 4, 5), title='元数据校验事件',
        )

        date_range = '2026-04-01,2026-04-30'
        data = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=100)

        meta = data['metadata']
        self.assertEqual(meta['pagination_unit'], 'record')
        self.assertEqual(meta['occurrence_count'], len(data['records']))
        # 单页内 occurrence 数应大于等于 record 数（5 occurrence vs 1 record）
        self.assertGreaterEqual(meta['occurrence_count'], data['total'])

    def test_calendar_event_start_equals_end_single_day(self):
        """start == end：is_start / is_end 都为 True，span=1，不算 dirty。"""
        self._setup_calendar_native_with_end()
        view = self._make_calendar_view(with_end_date_field=True)
        anchor = date(2026, 4, 9)
        self._make_calendar_record(start=anchor, end=anchor, title='当日单点事件')

        date_range = '2026-04-01,2026-04-30'
        data = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=100)
        self._assert_native_path(data)

        events = [e for e in data['records'] if e['record']['data'].get('任务标题') == '当日单点事件']
        self.assertEqual(len(events), 1)
        event = events[0]
        self._assert_wrapper_shape(event)
        self.assertEqual(event['date'], anchor.isoformat())
        self.assertTrue(event['is_start'])
        self.assertTrue(event['is_end'])
        self.assertEqual(event['span_total_days'], 1)
        self.assertEqual(event['occurrence_index'], 0)
        self.assertFalse(event['dirty'])

    def test_calendar_event_crossing_year_boundary(self):
        """跨年事件：12/25 ~ 1/5 在新年月查询里只返回 1 月段。"""
        self._setup_calendar_native_with_end()
        view = self._make_calendar_view(with_end_date_field=True)
        self._make_calendar_record(
            start=date(2025, 12, 25), end=date(2026, 1, 5), title='跨年项目',
        )

        date_range = '2026-01-01,2026-01-31'
        data = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=100)
        self._assert_native_path(data)

        events = [e for e in data['records'] if e['record']['data'].get('任务标题') == '跨年项目']
        self.assertEqual(len(events), 5, '1 月查询应只返回 1/1~1/5 五天')
        expected = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']
        self.assertEqual([e['date'] for e in events], expected)
        # 1/1 不是事件起点（start 在上年），1/5 是事件终点
        self.assertFalse(events[0]['is_start'])
        self.assertTrue(events[-1]['is_end'])
        # span_total_days = 12/25 ~ 1/5 = 12 天
        for event in events:
            self.assertEqual(event['span_total_days'], 12)
            self.assertFalse(event['dirty'])

    def test_calendar_deleted_end_date_field_graceful(self):
        """end_date_field 配的 ID 指向已删除字段：按未配置处理，不报错且退化为单点"""
        # 1. 先创建 end_date_field 并软删除
        end_field = self._ensure_end_date_field()
        end_field_id = str(end_field.id)
        end_field.is_deleted = True
        end_field.save(update_fields=['is_deleted'])

        # 2. 配置 view 使用这个已删除的 end_date_field id
        view = self._make_calendar_view(with_end_date_field=False, end_field_id_override=end_field_id)

        # 3. 写一条本应跨天的记录（end 字段虽已删但 data 里仍可能残留）
        anchor = date(2026, 4, 9)
        TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '已删除字段场景',
                str(self.date_field.id): anchor.isoformat(),
                end_field_id: (anchor + timedelta(days=4)).isoformat(),
            },
            order=2000,
        )

        # 4. 查询不应报错，且事件按单点退化
        date_range = '2026-04-01,2026-04-30'
        data = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=100)

        events = [e for e in data['records'] if e['record']['data'].get('任务标题') == '已删除字段场景']
        self.assertEqual(len(events), 1, '已删除 end_date_field 应触发单点退化')
        event = events[0]
        self._assert_wrapper_shape(event)
        self.assertEqual(event['date'], anchor.isoformat())
        self.assertTrue(event['is_start'])
        self.assertTrue(event['is_end'])
        self.assertEqual(event['span_total_days'], 1)
        self.assertFalse(event['dirty'])
        # metadata 不应暴露 end_date_field（被识别为不可用）
        self.assertNotIn('end_date_field', data['metadata'])

    def test_calendar_since_version_without_changes_keeps_full_payload(self):
        """日历视图在 since_version 未变时仍返回完整日期结果。"""
        view = TableView.objects.create(
            table=self.table,
            name='日历视图',
            view_type='calendar',
            created_by=self.user,
            config={
                'date_field': str(self.date_field.id),
                'title_field': str(self.title_field.id)
            }
        )

        today = date.today()
        tomorrow = today + timedelta(days=2)
        date_range = f"{today.isoformat()},{tomorrow.isoformat()}"
        initial = self.service.get_view_records(view.id, date_range=date_range, page=1, page_size=20)
        no_change = self.service.get_view_records(
            view.id,
            date_range=date_range,
            page=1,
            page_size=20,
            since_version=initial['latest_version'],
        )

        self.assertFalse(no_change['has_changes'])
        self.assertEqual(no_change['total'], initial['total'])
        self.assertEqual(no_change['matched_total'], initial['total'])
        self.assertEqual(len(no_change['records']), len(initial['records']))

    def test_calendar_timezone_consistency_at_local_midnight(self):
        """PG session=UTC 下 TIMESTAMPTZ 列 ::date 必须按 settings.TIME_ZONE 截取。

        生产场景：Django USE_TZ=True 默认把 PG session 时区置为 UTC；
        用户在 Asia/Shanghai 创建 '2026-04-09T00:00:00+08:00' 事件，
        DB 内部存储为 2026-04-08T16:00:00+00。若 SQL 用裸 ::date 截取，
        在 UTC session 下得到 '2026-04-08'，4/9 那格永远查不到事件。

        本测试覆盖 native + Python 端双侧对齐：SQL 必须 AT TIME ZONE
        到 settings.TIME_ZONE 再 ::date；Python 解析 ISO datetime 也必须
        按 settings.TIME_ZONE 转换后取 date。
        """
        from django.conf import settings
        from django.db import connections
        from apps.tabdata.constants import TABDATA_DB_ALIAS

        dt_field = TableField.objects.create(
            table=self.table,
            name='开始时间',
            field_type='date',
            config={'formatting': {'timeZone': 'Asia/Shanghai', 'time': 'HH:mm:ss'}},
            order=20,
        )
        self._ensure_native_table()

        view = TableView.objects.create(
            table=self.table,
            name='日历视图-tz',
            view_type='calendar',
            created_by=self.user,
            config={
                'date_field': str(dt_field.id),
                'title_field': str(self.title_field.id),
            },
        )

        title = 'TZ-边界事件'
        iso_value = '2026-04-09T00:00:00+08:00'
        record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): title,
                str(dt_field.id): iso_value,
            },
            order=3000,
        )
        self._sync_record_to_native(record, {
            str(self.title_field.id): title,
            str(dt_field.id): iso_value,
        })

        conn = connections[TABDATA_DB_ALIAS]
        with conn.cursor() as cur:
            cur.execute("SHOW TIME ZONE")
            original_tz = cur.fetchone()[0]

        data: Optional[Dict[str, Any]] = None
        try:
            with conn.cursor() as cur:
                cur.execute("SET TIME ZONE 'UTC'")
                cur.execute("SHOW TIME ZONE")
                self.assertEqual(
                    cur.fetchone()[0], 'UTC',
                    '本测试需要 PG session=UTC 才能复现 bug',
                )

            date_range = '2026-04-09,2026-04-09'
            data = self.service.get_view_records(
                view.id, date_range=date_range, page=1, page_size=100,
            )
        finally:
            with conn.cursor() as cur:
                cur.execute("SET TIME ZONE %s", [original_tz])

        self.assertIsNotNone(data, 'get_view_records 必须返回结果，空 data 说明上面已抛错被掩盖')
        self._assert_native_path(data)

        events = [
            e for e in data['records']
            if e['record']['data'].get('任务标题') == title
        ]
        self.assertEqual(
            len(events), 1,
            f'PG UTC session 下 TIMESTAMPTZ 列 ::date 必须按 settings.TIME_ZONE'
            f'={settings.TIME_ZONE} 截取，4/9 +08 事件应被查到。当前 events={events}',
        )
        self.assertEqual(events[0]['date'], '2026-04-09')
        self.assertTrue(events[0]['is_start'])
        self.assertTrue(events[0]['is_end'])

    def test_calendar_timezone_consistency_with_timed_date_end_field(self):
        """两侧均为带时间 date + 配 end_date_field 时，native SQL 参数顺序必须严格对齐。

        Wave 1.7 漏点（Wave 1.5 修 PG TZ 时引入的参数错位）：
        当 date_field 和 end_date_field 都是带时间的 `date` 类型时，
        `_local_date_sql` 在 SQL 模板里嵌入了 `AT TIME ZONE %s` 占位符，
        但 `get_calendar_events_native` 把 query_end / query_start 拼到了
        参数列表末尾，没有跟模板内嵌占位符按出现顺序交错绑定。

        结果：query_end 的日期字符串被错位绑到 GREATEST 第一项的 TZ 占位符上
        （触发 PG `time zone "2026-04-15" not recognized` 错误，
        或 `<= %s` 把 'Asia/Shanghai' 当日期解析失败），native 路径抛
        DatabaseError 静默降级 ORM，跨天事件查询走错路径。

        当 date 字段为 `date` 类型时 `start_local_params=[]`，错位被掩盖；
        本测试用两个带时间的 `date` 字段联合复现真实场景下被遗漏的 bug。
        """
        from django.db import connections
        from apps.tabdata.constants import TABDATA_DB_ALIAS

        start_field = TableField.objects.create(
            table=self.table,
            name='开始时间',
            field_type='date',
            config={'formatting': {'timeZone': 'Asia/Shanghai', 'time': 'HH:mm:ss'}},
            order=21,
        )
        end_field = TableField.objects.create(
            table=self.table,
            name='结束时间',
            field_type='date',
            config={'formatting': {'timeZone': 'Asia/Shanghai', 'time': 'HH:mm:ss'}},
            order=22,
        )
        self._ensure_native_table()

        view = TableView.objects.create(
            table=self.table,
            name='日历视图-tz-end',
            view_type='calendar',
            created_by=self.user,
            config={
                'date_field': str(start_field.id),
                'end_date_field': str(end_field.id),
                'title_field': str(self.title_field.id),
            },
        )

        title = 'TZ-跨天-date'
        start_iso = '2026-04-09T00:00:00+08:00'
        end_iso = '2026-04-12T23:59:59+08:00'
        record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): title,
                str(start_field.id): start_iso,
                str(end_field.id): end_iso,
            },
            order=4000,
        )
        self._sync_record_to_native(record, {
            str(self.title_field.id): title,
            str(start_field.id): start_iso,
            str(end_field.id): end_iso,
        })

        conn = connections[TABDATA_DB_ALIAS]
        with conn.cursor() as cur:
            cur.execute("SHOW TIME ZONE")
            original_tz = cur.fetchone()[0]

        data: Optional[Dict[str, Any]] = None
        try:
            with conn.cursor() as cur:
                cur.execute("SET TIME ZONE 'UTC'")
                cur.execute("SHOW TIME ZONE")
                self.assertEqual(
                    cur.fetchone()[0], 'UTC',
                    '本测试需要 PG session=UTC 才能稳定复现 native 路径行为',
                )

            date_range = '2026-04-09,2026-04-15'
            data = self.service.get_view_records(
                view.id, date_range=date_range, page=1, page_size=100,
            )
        finally:
            with conn.cursor() as cur:
                cur.execute("SET TIME ZONE %s", [original_tz])

        self.assertIsNotNone(data, 'get_view_records 必须返回结果')
        # 关键断言：bug 存在时 native 路径会抛 DatabaseError 降级到 ORM；
        # 这里强制要求走 native 路径，从而暴露参数错位。
        self._assert_native_path(data)

        events = [
            e for e in data['records']
            if e['record']['data'].get('任务标题') == title
        ]
        # 4/9 +08 ~ 4/12 +08 跨 4 天（每天一个 occurrence wrapper）
        dates = sorted(e['date'] for e in events)
        self.assertEqual(
            dates,
            ['2026-04-09', '2026-04-10', '2026-04-11', '2026-04-12'],
            f'datetime + end_date_field 跨 4 天事件应展开为 4 个 occurrence，得到 dates={dates}',
        )
        first = next(e for e in events if e['date'] == '2026-04-09')
        last = next(e for e in events if e['date'] == '2026-04-12')
        self.assertTrue(first['is_start'])
        self.assertFalse(first['is_end'])
        self.assertFalse(last['is_start'])
        self.assertTrue(last['is_end'])
        for e in events:
            self.assertEqual(e['span_total_days'], 4)
            self.assertFalse(e['dirty'])

    def test_calendar_orm_fallback_search_parity(self):
        """native 路径失败降级 ORM 时，search 行为必须与 native 等价。

        Wave 1 漏点：get_calendar_events_orm 缺 search/search_field_ids 参数，
        get_calendar_data 降级时也没传，导致用户搜索结果在降级后变成全量。
        本测试 mock 让 native 抛 DatabaseError，验证 ORM 路径仍按 search 过滤。
        """
        from unittest.mock import patch
        from django.db import DatabaseError

        self._setup_calendar_native_with_end()
        view = self._make_calendar_view(with_end_date_field=True)
        self._make_calendar_record(start=date(2026, 4, 9), title='财务会议', order=100)
        self._make_calendar_record(start=date(2026, 4, 10), title='市场会议', order=101)
        self._make_calendar_record(start=date(2026, 4, 11), title='研发周会', order=102)

        date_range = '2026-04-01,2026-04-30'
        with patch(
            'apps.tabdata.services.view_calendar_service.get_calendar_events_native',
            side_effect=DatabaseError('forced fallback to test ORM search parity'),
        ):
            data = self.service.get_view_records(
                view.id,
                date_range=date_range,
                page=1,
                page_size=100,
                search='财务',
                search_hide_not_match_rows=True,
            )

        self.assertEqual(
            data['metadata'].get('data_source'), 'orm_fallback',
            '本测试需要 ORM fallback 实际生效，否则 search parity 未被覆盖',
        )

        events = data['records']
        titles = [e['record']['data'].get('任务标题') for e in events]
        self.assertEqual(
            titles, ['财务会议'],
            f'ORM fallback 应只返回 search 命中的 record，得到 titles={titles}',
        )
        self.assertEqual(data['total'], 1, 'total 应反映过滤后的 record 数')

        # 额外断言：search_field_ids 全无效时，ORM 与 native 一致地返回空集合
        # （native 的 build_native_search_where 在 conditions 为空时返回 ('FALSE', [])）
        with patch(
            'apps.tabdata.services.view_calendar_service.get_calendar_events_native',
            side_effect=DatabaseError('forced fallback for invalid search_field_ids'),
        ):
            data_invalid = self.service.get_view_records(
                view.id,
                date_range=date_range,
                page=1,
                page_size=100,
                search='财务',
                search_field_ids=['00000000-0000-0000-0000-000000000000'],
                search_hide_not_match_rows=True,
            )
        self.assertEqual(
            data_invalid['metadata'].get('data_source'), 'orm_fallback',
        )
        self.assertEqual(
            data_invalid['records'], [],
            'search_field_ids 全无法解析时，ORM 应与 native 对齐返回空集合',
        )
        self.assertEqual(data_invalid['total'], 0)

    def test_calendar_event_truncated_at_max_span(self):
        """超过 _MAX_OCCURRENCE_SPAN_DAYS 的事件按上限截断后，wrapper 必须 truncated=True。

        Wave 1 漏点：截断后无可观测标记，前端无法显示「事件实际更长」提示。
        """
        from apps.tabdata.services.view_calendar_service import _MAX_OCCURRENCE_SPAN_DAYS

        self._setup_calendar_native_with_end()
        view = self._make_calendar_view(with_end_date_field=True)
        # 事件：2026-01-01 ~ 2027-12-31（约 730 天），远超 366 天上限
        self._make_calendar_record(
            start=date(2026, 1, 1),
            end=date(2027, 12, 31),
            title='超长项目',
        )

        # 查询窗口完整覆盖事件，便于看到截断后的所有 occurrence
        date_range = '2026-01-01,2027-12-31'
        data = self.service.get_view_records(
            view.id, date_range=date_range, page=1, page_size=2000,
        )
        self._assert_native_path(data)

        events = [
            e for e in data['records']
            if e['record']['data'].get('任务标题') == '超长项目'
        ]
        self.assertEqual(
            len(events), _MAX_OCCURRENCE_SPAN_DAYS,
            f'实际展开应被截断到 {_MAX_OCCURRENCE_SPAN_DAYS} 天，得到 {len(events)} 个 occurrence',
        )
        for event in events:
            self._assert_wrapper_shape(event)
            self.assertTrue(
                event['truncated'],
                f'被截断的事件 wrapper 必须 truncated=True，event={event}',
            )
            self.assertEqual(event['span_total_days'], _MAX_OCCURRENCE_SPAN_DAYS)
            self.assertFalse(event['dirty'], 'truncated 与 dirty 是独立标记')

        # 确认未截断的普通事件 truncated=False（防止把标记永远设成 True）
        self._make_calendar_record(
            start=date(2027, 6, 1),
            end=date(2027, 6, 5),
            title='正常 5 天事件',
            order=2000,
        )
        normal_data = self.service.get_view_records(
            view.id, date_range='2027-06-01,2027-06-30', page=1, page_size=100,
        )
        normal_events = [
            e for e in normal_data['records']
            if e['record']['data'].get('任务标题') == '正常 5 天事件'
        ]
        self.assertEqual(len(normal_events), 5)
        for event in normal_events:
            self.assertFalse(
                event['truncated'],
                f'未截断事件 wrapper 必须 truncated=False，event={event}',
            )

    # ==================== 画廊视图测试 ====================

    def test_get_gallery_view_data(self):
        """测试获取画廊视图数据"""
        view = TableView.objects.create(
            table=self.table,
            name='画廊视图',
            view_type='gallery',
            created_by=self.user,
            config={
                'title_field': str(self.title_field.id),
                'cover_field': str(self.image_field.id),
                'card_size': 'medium',
                'cards_per_row': 4
            }
        )

        data = self.service.get_view_records(view.id)

        self.assertIsNotNone(data)
        self.assertEqual(data['metadata']['view_type'], 'gallery')
        self.assertIn('grid_layout', data['metadata'])
        self.assertEqual(data['metadata']['grid_layout']['columns'], 4)
        self.assertEqual(data['metadata']['card_size'], 'medium')

    def test_gallery_grid_layout(self):
        """测试画廊视图网格布局计算"""
        view = TableView.objects.create(
            table=self.table,
            name='画廊视图',
            view_type='gallery',
            created_by=self.user,
            config={
                'title_field': str(self.title_field.id),
                'cards_per_row': 3
            }
        )

        data = self.service.get_view_records(view.id, page=1, page_size=10)

        # 10条记录，每行3个，应该是4行
        columns = data['metadata']['grid_layout']['columns']
        rows = data['metadata']['grid_layout']['rows']

        self.assertEqual(columns, 3)
        self.assertEqual(rows, 4)  # (10 + 3 - 1) // 3 = 4

    def test_gallery_since_version_without_changes_keeps_full_payload(self):
        """画廊视图在 since_version 未变时仍返回完整分页结果。"""
        view = TableView.objects.create(
            table=self.table,
            name='画廊视图',
            view_type='gallery',
            created_by=self.user,
            config={
                'title_field': str(self.title_field.id),
                'cards_per_row': 3
            }
        )

        initial = self.service.get_view_records(view.id, page=1, page_size=10)
        no_change = self.service.get_view_records(
            view.id,
            page=1,
            page_size=10,
            since_version=initial['latest_version'],
        )

        self.assertFalse(no_change['has_changes'])
        self.assertEqual(no_change['total'], initial['total'])
        self.assertEqual(no_change['matched_total'], initial['total'])
        self.assertEqual(len(no_change['records']), len(initial['records']))

    # ==================== 筛选与分组扩展测试 ====================

    def test_grid_filters_with_field_id(self):
        """测试使用 field_id 的筛选规则"""
        view = TableView.objects.create(
            table=self.table,
            name='筛选视图',
            view_type='grid',
            created_by=self.user,
            filters=[
                {
                    'field_id': str(self.status_field.id),
                    'operator': 'equals',
                    'value': '待办',
                    'enabled': True,
                },
                {
                    'field_id': str(self.status_field.id),
                    'operator': 'equals',
                    'value': '不存在',
                    'enabled': False,
                }
            ],
            config={'filter_logic': 'and'}
        )

        data = self.service.get_view_records(view.id, page=1, page_size=20)
        self.assertEqual(data['total'], 5)
        self.assertEqual(len(data['records']), 5)

    def test_timed_date_filters_match_the_selected_display_day(self):
        """带时间的日期筛选按展示日匹配，不要求时分秒完全一致。"""
        submitted_at_field = TableField.objects.create(
            table=self.table,
            name='提交时间',
            field_type='date',
            config={
                'formatting': {
                    'date': 'YYYY-MM-DD',
                    'time': 'HH:mm:ss',
                    'timeZone': 'Asia/Shanghai',
                },
            },
            order=10,
        )
        same_display_day = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '同一展示日',
                str(submitted_at_field.id): '2026-08-14T05:10:00.000Z',
            },
            order=100,
        )
        next_display_day = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '下一展示日',
                str(submitted_at_field.id): '2026-08-14T16:30:00.000Z',
            },
            order=101,
        )
        view = TableView.objects.create(
            table=self.table,
            name='日期时间筛选视图',
            view_type='grid',
            created_by=self.user,
            config={},
        )

        filter_cases = [
            ('equals', '2026-08-14'),
            ('equals', '2026-08-14T03:20:18.000Z'),
            ('equals', {
                'mode': 'exactDate',
                'exactDate': '2026-08-14',
                'timeZone': 'Asia/Shanghai',
            }),
            ('is_within', {
                'mode': 'exactDate',
                'exactDate': '2026-08-14',
                'timeZone': 'Asia/Shanghai',
            }),
        ]
        for operator, selected_value in filter_cases:
            with self.subTest(operator=operator, selected_value=selected_value):
                data = self.service.get_view_records(
                    view.id,
                    page=1,
                    page_size=50,
                    filters=[
                        {
                            'field_id': str(submitted_at_field.id),
                            'operator': operator,
                            'value': selected_value,
                            'enabled': True,
                        },
                    ],
                    filter_logic='and',
                )

                returned_ids = {record['id'] for record in data['records']}
                self.assertEqual(returned_ids, {str(same_display_day.id)})
                self.assertNotIn(str(next_display_day.id), returned_ids)

    def test_datetime_filters_still_work_in_orm_fallback(self):
        """强制 native 退回 ORM 时，日期筛选仍应按展示日命中。"""
        from django.db import DatabaseError
        from unittest.mock import patch

        submitted_at_field = self.date_field
        same_day = self.records[0]
        next_day = self.records[1]
        view = TableView.objects.create(
            table=self.table,
            name='datetime fallback filter',
            view_type='grid',
            created_by=self.user,
            config={},
        )

        with patch(
            'apps.tabdata.services.view_grid_service.get_grid_data_native',
            side_effect=DatabaseError('forced fallback to test ORM date parity'),
        ):
            data = self.service.get_view_records(
                view.id,
                page=1,
                page_size=50,
                filters=[
                    {
                        'field_id': str(submitted_at_field.id),
                        'operator': 'equals',
                        'value': {
                            'mode': 'exactDate',
                            'exactDate': date.today().isoformat(),
                            'timeZone': 'Asia/Shanghai',
                        },
                        'enabled': True,
                    },
                ],
                filter_logic='and',
            )

        returned_ids = {record['id'] for record in data['records']}
        self.assertEqual(data['metadata'].get('data_source'), 'orm_fallback')
        self.assertEqual(returned_ids, {str(same_day.id)})
        self.assertNotIn(str(next_day.id), returned_ids)

    def test_relative_date_presets_match_expected_windows_in_orm_fallback(self):
        from datetime import datetime as dt
        from django.db import DatabaseError
        from unittest.mock import MagicMock, patch
        from zoneinfo import ZoneInfo

        date_field = TableField.objects.create(
            table=self.table,
            name='preset date',
            field_type='date',
            config={'formatting': {'timeZone': 'Asia/Shanghai', 'time': 'None'}},
            order=20,
        )
        today_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(date_field.id): '2026-08-15'},
            order=200,
        )
        same_week_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(date_field.id): '2026-08-16'},
            order=201,
        )
        same_month_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(date_field.id): '2026-08-20'},
            order=202,
        )
        outside_month_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(date_field.id): '2026-09-01'},
            order=203,
        )
        view = TableView.objects.create(
            table=self.table,
            name='relative date preset filter',
            view_type='grid',
            created_by=self.user,
            config={},
        )

        mock_datetime = MagicMock()
        mock_datetime.now.return_value = dt(2026, 8, 15, 12, 0, tzinfo=ZoneInfo('Asia/Shanghai'))
        mock_datetime.combine = dt.combine

        cases = [
            ('today object', {'mode': 'today', 'timeZone': 'Asia/Shanghai'}, {str(today_record.id)}),
            ('today string', 'today', {str(today_record.id)}),
            (
                'thisWeek object',
                {'mode': 'thisWeek', 'timeZone': 'Asia/Shanghai'},
                {str(today_record.id), str(same_week_record.id)},
            ),
            ('thisWeek string', 'thisWeek', {str(today_record.id), str(same_week_record.id)}),
            (
                'thisMonth object',
                {'mode': 'thisMonth', 'timeZone': 'Asia/Shanghai'},
                {str(today_record.id), str(same_week_record.id), str(same_month_record.id)},
            ),
            (
                'thisMonth string',
                'thisMonth',
                {str(today_record.id), str(same_week_record.id), str(same_month_record.id)},
            ),
        ]

        with patch(
            'apps.tabdata.services.view_grid_service.get_grid_data_native',
            side_effect=DatabaseError('forced fallback to test relative date presets'),
        ), patch('apps.tabdata.services.view_filter_service.datetime', mock_datetime):
            for label, value, expected_ids in cases:
                with self.subTest(label=label):
                    data = self.service.get_view_records(
                        view.id,
                        page=1,
                        page_size=50,
                        filters=[
                            {
                                'field_id': str(date_field.id),
                                'operator': 'equals',
                                'value': value,
                                'enabled': True,
                            },
                        ],
                        filter_logic='and',
                    )

                    returned_ids = {record['id'] for record in data['records']}
                    self.assertEqual(data['metadata'].get('data_source'), 'orm_fallback')
                    self.assertEqual(returned_ids, expected_ids)
                    self.assertNotIn(str(outside_month_record.id), returned_ids)

    def test_timed_date_preset_filters_match_timestamp_boundaries_in_orm_fallback(self):
        from datetime import datetime as dt
        from django.db import DatabaseError
        from unittest.mock import MagicMock, patch
        from zoneinfo import ZoneInfo

        submitted_at_field = TableField.objects.create(
            table=self.table,
            name='鎻愪氦鏃堕棿',
            field_type='date',
            config={'formatting': {'timeZone': 'Asia/Shanghai', 'time': 'HH:mm:ss'}},
            order=20,
        )
        today_early = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(submitted_at_field.id): '2026-08-15T00:00:00+08:00'},
            order=210,
        )
        today_late = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(submitted_at_field.id): '2026-08-15T23:59:59+08:00'},
            order=211,
        )
        this_week = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(submitted_at_field.id): '2026-08-16T12:00:00+08:00'},
            order=212,
        )
        next_week = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(submitted_at_field.id): '2026-08-17T00:00:00+08:00'},
            order=213,
        )
        next_month = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={str(submitted_at_field.id): '2026-09-01T00:00:00+08:00'},
            order=214,
        )
        view = TableView.objects.create(
            table=self.table,
            name='datetime timestamp preset filter',
            view_type='grid',
            created_by=self.user,
            config={},
        )

        mock_datetime = MagicMock()
        mock_datetime.now.return_value = dt(2026, 8, 15, 12, 0, tzinfo=ZoneInfo('Asia/Shanghai'))
        mock_datetime.combine = dt.combine

        cases = [
            ('today string', 'today', {str(today_early.id), str(today_late.id)}),
            (
                'thisWeek string',
                'thisWeek',
                {str(today_early.id), str(today_late.id), str(this_week.id)},
            ),
            (
                'thisMonth string',
                'thisMonth',
                {
                    str(today_early.id),
                    str(today_late.id),
                    str(this_week.id),
                    str(next_week.id),
                },
            ),
            (
                'today object',
                {'mode': 'today', 'timeZone': 'Asia/Shanghai'},
                {str(today_early.id), str(today_late.id)},
            ),
        ]

        with patch(
            'apps.tabdata.services.view_grid_service.get_grid_data_native',
            side_effect=DatabaseError('forced fallback to test ORM datetime parity'),
        ), patch('apps.tabdata.services.view_filter_service.datetime', mock_datetime):
            for label, value, expected_ids in cases:
                with self.subTest(label=label):
                    data = self.service.get_view_records(
                        view.id,
                        page=1,
                        page_size=50,
                        filters=[
                            {
                                'field_id': str(submitted_at_field.id),
                                'operator': 'equals',
                                'value': value,
                                'enabled': True,
                            },
                        ],
                        filter_logic='and',
                    )

                    returned_ids = {record['id'] for record in data['records']}
                    self.assertEqual(data['metadata'].get('data_source'), 'orm_fallback')
                    self.assertEqual(returned_ids, expected_ids)
                    self.assertNotIn(str(next_month.id), returned_ids)

    def test_filters_logic_or(self):
        """测试 OR 逻辑筛选"""
        view = TableView.objects.create(
            table=self.table,
            name='筛选视图 OR',
            view_type='grid',
            created_by=self.user,
            filters=[],
            config={}
        )

        filters = [
            {
                'field_id': str(self.status_field.id),
                'operator': 'equals',
                'value': '待办',
                'enabled': True,
            },
            {
                'field_id': str(self.status_field.id),
                'operator': 'equals',
                'value': '进行中',
                'enabled': True,
            }
        ]

        data = self.service.get_view_records(view.id, filters=filters, filter_logic='or')
        self.assertEqual(data['total'], 10)

    def test_operator_alias_on_single_select(self):
        """测试单选字段算子别名（isAnyOf）"""
        view = TableView.objects.create(
            table=self.table,
            name='单选别名筛选',
            view_type='grid',
            created_by=self.user,
            filters=[],
            config={}
        )

        data = self.service.get_view_records(
            view.id,
            filters=[
                {
                    'field_id': str(self.status_field.id),
                    'operator': 'isAnyOf',
                    'value': ['待办', '进行中'],
                    'enabled': True,
                }
            ],
            filter_logic='and',
        )

        self.assertEqual(data['total'], 10)

    def test_multi_select_operators(self):
        """测试多选字段算子语义"""
        view = TableView.objects.create(
            table=self.table,
            name='多选语义筛选',
            view_type='grid',
            created_by=self.user,
            filters=[],
            config={}
        )

        has_any = self.service.get_view_records(
            view.id,
            filters=[
                {
                    'field_id': str(self.tags_field.id),
                    'operator': 'hasAnyOf',
                    'value': ['A'],
                    'enabled': True,
                }
            ],
            filter_logic='and',
        )
        self.assertEqual(has_any['total'], 6)

        has_all = self.service.get_view_records(
            view.id,
            filters=[
                {
                    'field_id': str(self.tags_field.id),
                    'operator': 'hasAllOf',
                    'value': ['A', 'B'],
                    'enabled': True,
                }
            ],
            filter_logic='and',
        )
        self.assertEqual(has_all['total'], 3)

        is_exactly = self.service.get_view_records(
            view.id,
            filters=[
                {
                    'field_id': str(self.tags_field.id),
                    'operator': 'isExactly',
                    'value': ['A', 'B'],
                    'enabled': True,
                }
            ],
            filter_logic='and',
        )
        self.assertEqual(is_exactly['total'], 3)

        is_not_exactly = self.service.get_view_records(
            view.id,
            filters=[
                {
                    'field_id': str(self.tags_field.id),
                    'operator': 'isNotExactly',
                    'value': ['A', 'B'],
                    'enabled': True,
                }
            ],
            filter_logic='and',
        )
        self.assertEqual(is_not_exactly['total'], 12)

        has_none = self.service.get_view_records(
            view.id,
            filters=[
                {
                    'field_id': str(self.tags_field.id),
                    'operator': 'hasNoneOf',
                    'value': ['A'],
                    'enabled': True,
                }
            ],
            filter_logic='and',
        )
        self.assertEqual(has_none['total'], 9)

    def test_checkbox_unchecked_filter_matches_false_null_and_missing(self):
        """测试复选字段筛选未选时，匹配 false、null 与缺失值"""
        view = TableView.objects.create(
            table=self.table,
            name='复选未选筛选',
            view_type='grid',
            created_by=self.user,
            filters=[],
            config={}
        )

        missing_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '缺失复选',
                str(self.status_field.id): '待办',
            },
            order=100
        )
        null_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '空值复选',
                str(self.status_field.id): '待办',
                str(self.done_field.id): None,
            },
            order=101
        )
        false_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '显式未选',
                str(self.status_field.id): '待办',
                str(self.done_field.id): False,
            },
            order=102
        )
        string_false_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '字符串未选',
                str(self.status_field.id): '待办',
                str(self.done_field.id): 'false',
            },
            order=103
        )
        number_zero_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '数字未选',
                str(self.status_field.id): '待办',
                str(self.done_field.id): 0,
            },
            order=104
        )
        empty_string_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '空串未选',
                str(self.status_field.id): '待办',
                str(self.done_field.id): '',
            },
            order=105
        )
        conflict_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '冲突双写',
                str(self.status_field.id): '待办',
                str(self.done_field.id): False,
                self.done_field.name: True,
            },
            order=106
        )
        alias_true_record = TableRecord.objects.create(
            table=self.table,
            created_by=self.user,
            data={
                str(self.title_field.id): '名称键已选',
                str(self.status_field.id): '待办',
                self.done_field.name: True,
            },
            order=107
        )

        unchecked_false = self.service.get_view_records(
            view.id,
            filters=[
                {
                    'field_id': str(self.done_field.id),
                    'operator': 'equals',
                    'value': False,
                    'enabled': True,
                }
            ],
            filter_logic='and',
        )
        self.assertEqual(unchecked_false['total'], 14)
        unchecked_false_ids = {record['id'] for record in unchecked_false['records']}
        self.assertIn(str(missing_record.id), unchecked_false_ids)
        self.assertIn(str(null_record.id), unchecked_false_ids)
        self.assertIn(str(false_record.id), unchecked_false_ids)
        self.assertIn(str(string_false_record.id), unchecked_false_ids)
        self.assertIn(str(number_zero_record.id), unchecked_false_ids)
        self.assertIn(str(empty_string_record.id), unchecked_false_ids)
        self.assertIn(str(conflict_record.id), unchecked_false_ids)
        self.assertNotIn(str(alias_true_record.id), unchecked_false_ids)

        unchecked_null = self.service.get_view_records(
            view.id,
            filters=[
                {
                    'field_id': str(self.done_field.id),
                    'operator': 'equals',
                    'value': None,
                    'enabled': True,
                }
            ],
            filter_logic='and',
        )
        self.assertEqual(unchecked_null['total'], 14)

        checked_only = self.service.get_view_records(
            view.id,
            filters=[
                {
                    'field_id': str(self.done_field.id),
                    'operator': 'not_equals',
                    'value': False,
                    'enabled': True,
                }
            ],
            filter_logic='and',
        )
        self.assertEqual(checked_only['total'], 9)
        checked_only_ids = {record['id'] for record in checked_only['records']}
        self.assertNotIn(str(missing_record.id), checked_only_ids)
        self.assertNotIn(str(null_record.id), checked_only_ids)
        self.assertNotIn(str(false_record.id), checked_only_ids)
        self.assertNotIn(str(string_false_record.id), checked_only_ids)
        self.assertNotIn(str(number_zero_record.id), checked_only_ids)
        self.assertNotIn(str(empty_string_record.id), checked_only_ids)
        self.assertNotIn(str(conflict_record.id), checked_only_ids)
        self.assertIn(str(alias_true_record.id), checked_only_ids)

    def test_grid_group_metadata(self):
        """测试表格视图分组元数据"""
        view = TableView.objects.create(
            table=self.table,
            name='分组视图',
            view_type='grid',
            created_by=self.user,
            filters=[],
            groups=[
                {'field_id': str(self.status_field.id), 'direction': 'asc'}
            ],
            config={}
        )

        data = self.service.get_view_records(view.id)
        metadata = data.get('metadata', {})
        groups = metadata.get('groups')
        self.assertIsInstance(groups, dict)
        self.assertIn('fields', groups)
        self.assertIn('nodes', groups)
        nodes = groups['nodes']
        self.assertEqual(len(nodes), 3)

        counts = {node['group_value']: node['count'] for node in nodes}
        self.assertEqual(counts.get('待办'), 5)
        self.assertEqual(counts.get('进行中'), 5)
        self.assertEqual(counts.get('已完成'), 5)

    def test_get_view_column_statistics(self):
        """测试视图列统计"""
        view = TableView.objects.create(
            table=self.table,
            name='统计视图',
            view_type='grid',
            created_by=self.user,
            config={
                'column_statistic_funcs': {
                    str(self.hours_field.id): 'sum',
                    str(self.done_field.id): 'checked',
                    str(self.status_field.id): 'percent_empty',
                    str(self.date_field.id): 'date_range_days',
                }
            }
        )

        data = self.service.get_view_column_statistics(view.id)

        self.assertEqual(data['total_records'], 15)
        stat_map = {item['field_id']: item for item in data['column_statistics']}

        hours_stat = stat_map[str(self.hours_field.id)]
        self.assertEqual(hours_stat['agg_func'], 'sum')
        self.assertEqual(hours_stat['value'], 120)

        done_stat = stat_map[str(self.done_field.id)]
        self.assertEqual(done_stat['agg_func'], 'checked')
        self.assertEqual(done_stat['value'], 8)

        status_stat = stat_map[str(self.status_field.id)]
        self.assertEqual(status_stat['agg_func'], 'percent_empty')
        self.assertEqual(status_stat['value'], '0%')

        date_stat = stat_map[str(self.date_field.id)]
        self.assertEqual(date_stat['agg_func'], 'date_range_days')
        self.assertEqual(date_stat['value'], 14)

    def test_view_column_statistics_with_filters(self):
        """测试列统计支持过滤条件覆盖"""
        view = TableView.objects.create(
            table=self.table,
            name='统计筛选视图',
            view_type='grid',
            created_by=self.user,
            config={
                'column_statistic_funcs': {
                    str(self.hours_field.id): 'sum',
                    str(self.done_field.id): 'percent_checked',
                }
            }
        )

        data = self.service.get_view_column_statistics(
            view.id,
            filters=[
                {
                    'field_id': str(self.status_field.id),
                    'operator': 'equals',
                    'value': '待办',
                    'enabled': True,
                }
            ],
            filter_logic='and',
        )

        self.assertEqual(data['total_records'], 5)
        stat_map = {item['field_id']: item for item in data['column_statistics']}

        hours_stat = stat_map[str(self.hours_field.id)]
        self.assertEqual(hours_stat['value'], 35)

        done_stat = stat_map[str(self.done_field.id)]
        self.assertEqual(done_stat['value'], '60%')

    # ==================== 权限测试 ====================

    def test_permission_denied(self):
        """测试无权限访问视图数据"""
        # 创建另一个用户
        other_user = User.objects.create_user(
            phone='13800000003',
            nickname='其他用户'
        )

        view = TableView.objects.create(
            table=self.table,
            name='测试视图',
            view_type='grid',
            created_by=self.user,
            config={}
        )

        # 使用其他用户的服务实例
        other_service = ViewDataService(user=other_user)

        # 应该抛出权限错误
        with self.assertRaises(PermissionError):
            other_service.get_view_records(view.id)

    # ==================== 异常处理测试 ====================

    def test_missing_required_config(self):
        """测试缺少必需配置"""
        # 创建看板视图但不提供 group_by_field
        view = TableView.objects.create(
            table=self.table,
            name='无效看板',
            view_type='kanban',
            created_by=self.user,
            config={
                'card_title_field': str(self.title_field.id)
            }
        )

        # 当前语义：返回空结构 + needs_configuration 元信息（不抛异常）
        data = self.service.get_view_records(view.id)
        self.assertEqual(data['total'], 0)
        self.assertEqual(data['records'], [])
        metadata = data.get('metadata', {})
        self.assertTrue(metadata.get('needs_configuration'))
        self.assertIn('group_by_field', metadata.get('missing_fields', []))

    def test_invalid_field_id(self):
        """测试无效的字段ID"""
        view = TableView.objects.create(
            table=self.table,
            name='无效字段',
            view_type='kanban',
            created_by=self.user,
            config={
                'group_by_field': 'invalid-field-id',
                'card_title_field': str(self.title_field.id)
            }
        )

        # 应该抛出异常
        with self.assertRaises(Exception):
            self.service.get_view_records(view.id)
