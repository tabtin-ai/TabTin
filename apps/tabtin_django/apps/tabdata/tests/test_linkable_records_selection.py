"""
Linkable Records 协议对齐测试

覆盖：
1. 候选模式排除 selected_record_ids
2. only_selected 模式按 selected_record_ids 顺序返回
3. only_selected 模式分页行为
4. 搜索匹配 record id 前缀（主字段为空时 UI 回退展示 id）
5. 全局搜索命中非主字段
6. 短数字搜索命中标题子串，且不被 UUID 误命中污染
7. link 单元格 UUID id 不得被数字查询误命中
"""

import re

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase

from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.services.link_field_service import LinkFieldService
from apps.tabtinspace.models import Organization, Project

User = get_user_model()


def _uuid_search_prefix(record_id) -> str:
    """取适合触发 id 匹配的 UUID 前缀（含字母或连字符，避免纯短数字）。"""
    rid = str(record_id)
    head = rid[:4]
    if re.search(r'[a-fA-F]', head):
        return head
    first_group = rid.split('-', 1)[0]
    if re.search(r'[a-fA-F]', first_group):
        return first_group
    return rid[:13]


class LinkableRecordsSelectionTest(TransactionTestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        self.user = User.objects.create_user(
            username='linkable-selection-user',
            email='linkable-selection@example.com',
            password='testpass123',
        )
        self.organization = Organization.objects.create(
            name='LinkableSelectionOrganization',
            owner=self.user,
        )
        # ：Space 表已 DROP；Table.space_id 可挂 Project.id
        self.project = Project.objects.create(
            name='LinkableSelectionProject',
            organization=self.organization,
        )

        self.source_table = Table.objects.create(
            name='SourceTable',
            space_id=self.project.id,
            organization_id=self.organization.id,
            owner=self.user,
        )
        self.foreign_table = Table.objects.create(
            name='ForeignTable',
            space_id=self.project.id,
            organization_id=self.organization.id,
            owner=self.user,
        )

        self.foreign_primary = TableField.objects.create(
            table=self.foreign_table,
            name='Name',
            field_type='text',
            is_primary=True,
            order=0,
        )
        self.foreign_amount = TableField.objects.create(
            table=self.foreign_table,
            name='Amount',
            field_type='number',
            order=1,
        )

        self.link_field = TableField.objects.create(
            table=self.source_table,
            name='Items',
            field_type='link',
            order=0,
            config={
                'foreignTableId': str(self.foreign_table.id),
                'relationship': 'ManyMany',
                'lookupFieldId': str(self.foreign_primary.id),
            },
        )

        self.record_a = TableRecord.objects.create(
            table=self.foreign_table,
            data={
                str(self.foreign_primary.id): 'A',
                str(self.foreign_amount.id): 10,
            },
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            order=1,
        )
        self.record_b = TableRecord.objects.create(
            table=self.foreign_table,
            data={
                str(self.foreign_primary.id): 'B',
                str(self.foreign_amount.id): 20,
            },
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            order=2,
        )
        self.record_c = TableRecord.objects.create(
            table=self.foreign_table,
            data={
                str(self.foreign_primary.id): 'C',
                str(self.foreign_amount.id): 30,
            },
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            order=3,
        )

    def test_candidate_mode_excludes_selected_record_ids(self):
        records, total = LinkFieldService.get_linkable_records(
            self.link_field,
            selected_record_ids=[str(self.record_a.id), str(self.record_c.id)],
            page=1,
            page_size=50,
        )

        self.assertEqual(total, 1)
        self.assertEqual([item['id'] for item in records], [str(self.record_b.id)])

    def test_only_selected_mode_keeps_selected_order(self):
        selected_ids = [str(self.record_c.id), str(self.record_a.id)]

        records, total = LinkFieldService.get_linkable_records(
            self.link_field,
            selected_record_ids=selected_ids,
            only_selected=True,
            page=1,
            page_size=50,
        )

        self.assertEqual(total, 2)
        self.assertEqual([item['id'] for item in records], selected_ids)

    def test_only_selected_mode_supports_pagination(self):
        selected_ids = [str(self.record_c.id), str(self.record_a.id)]

        first_page, total = LinkFieldService.get_linkable_records(
            self.link_field,
            selected_record_ids=selected_ids,
            only_selected=True,
            page=1,
            page_size=1,
        )
        second_page, _ = LinkFieldService.get_linkable_records(
            self.link_field,
            selected_record_ids=selected_ids,
            only_selected=True,
            page=2,
            page_size=1,
        )

        self.assertEqual(total, 2)
        self.assertEqual([item['id'] for item in first_page], [selected_ids[0]])
        self.assertEqual([item['id'] for item in second_page], [selected_ids[1]])

    def test_search_matches_record_id_prefix_when_title_empty(self):
        """主字段为空时 title 回退为完整 id；按 UUID 前缀搜索应命中。"""
        empty_record = TableRecord.objects.create(
            table=self.foreign_table,
            data={},
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            order=4,
        )
        prefix = _uuid_search_prefix(empty_record.id)

        records, total = LinkFieldService.get_linkable_records(
            self.link_field,
            search=prefix,
            page=1,
            page_size=50,
        )

        found_ids = {item['id'] for item in records}
        self.assertGreaterEqual(total, 1)
        self.assertIn(str(empty_record.id), found_ids)
        self.assertEqual(
            next(item['title'] for item in records if item['id'] == str(empty_record.id)),
            str(empty_record.id),
        )

    def test_global_search_matches_secondary_field(self):
        """未指定 search_field_id 时（全局）应能命中非主字段内容。"""
        records, total = LinkFieldService.get_linkable_records(
            self.link_field,
            search='20',
            page=1,
            page_size=50,
        )

        found_ids = {item['id'] for item in records}
        self.assertGreaterEqual(total, 1)
        self.assertIn(str(self.record_b.id), found_ids)

    def test_field_scoped_search_still_matches_primary(self):
        """指定 search_field_id 时仍按该列模糊匹配。"""
        records, total = LinkFieldService.get_linkable_records(
            self.link_field,
            search='A',
            search_field_id=str(self.foreign_primary.id),
            page=1,
            page_size=50,
        )

        found_ids = {item['id'] for item in records}
        self.assertGreaterEqual(total, 1)
        self.assertIn(str(self.record_a.id), found_ids)

    def test_short_digit_search_matches_title_substring_not_all_uuids(self):
        """短数字搜标题子串（1/2/3/567 → 搜 5/56），且不被 UUID 误命中污染。"""
        titles = {
            '1': TableRecord.objects.create(
                table=self.foreign_table,
                data={str(self.foreign_primary.id): '1'},
                created_by_id=self.user.id,
                updated_by_id=self.user.id,
                order=10,
            ),
            '2': TableRecord.objects.create(
                table=self.foreign_table,
                data={str(self.foreign_primary.id): '2'},
                created_by_id=self.user.id,
                updated_by_id=self.user.id,
                order=11,
            ),
            '3': TableRecord.objects.create(
                table=self.foreign_table,
                data={str(self.foreign_primary.id): '3'},
                created_by_id=self.user.id,
                updated_by_id=self.user.id,
                order=12,
            ),
            '567': TableRecord.objects.create(
                table=self.foreign_table,
                data={str(self.foreign_primary.id): '567'},
                created_by_id=self.user.id,
                updated_by_id=self.user.id,
                order=13,
            ),
        }

        by_five, total_five = LinkFieldService.get_linkable_records(
            self.link_field, search='5', page=1, page_size=50,
        )
        ids_five = {item['id'] for item in by_five}
        self.assertIn(str(titles['567'].id), ids_five)
        self.assertNotIn(str(titles['1'].id), ids_five)
        self.assertNotIn(str(titles['2'].id), ids_five)
        self.assertNotIn(str(titles['3'].id), ids_five)
        # 短数字不得靠 UUID 把整表刷出来
        self.assertLessEqual(total_five, 2)

        by_fifty_six, total_fifty_six = LinkFieldService.get_linkable_records(
            self.link_field, search='56', page=1, page_size=50,
        )
        ids_fifty_six = {item['id'] for item in by_fifty_six}
        self.assertEqual(total_fifty_six, 1)
        self.assertEqual(ids_fifty_six, {str(titles['567'].id)})

    def test_should_match_record_id_heuristics(self):
        self.assertFalse(LinkFieldService._should_match_record_id('5'))
        self.assertFalse(LinkFieldService._should_match_record_id('56'))
        self.assertFalse(LinkFieldService._should_match_record_id('567'))
        self.assertTrue(LinkFieldService._should_match_record_id('ea'))
        self.assertTrue(LinkFieldService._should_match_record_id('eabd0119'))
        self.assertTrue(LinkFieldService._should_match_record_id('eabd0119-9818'))

    def test_search_ignores_link_cell_uuid_for_numeric_query(self):
        """#7120：JSONB 回退只匹配展示名，不因 link cell UUID 含数字误命中。"""
        supplier_field = TableField.objects.create(
            table=self.foreign_table,
            name='供应商',
            field_type='link',
            order=5,
        )
        phone_hit = TableRecord.objects.create(
            table=self.foreign_table,
            data={
                str(self.foreign_primary.id): '400客服',
                str(self.foreign_amount.id): 0,
                str(supplier_field.id): {
                    'id': '11111111-2222-3333-4444-555555555555',
                    'title': '北京创新集团',
                },
            },
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            order=20,
        )
        # 主字段/展示名无「4」，但 link.id 含十六进制数字 4
        uuid_only = TableRecord.objects.create(
            table=self.foreign_table,
            data={
                str(self.foreign_primary.id): '无数字标题',
                str(self.foreign_amount.id): 0,
                str(supplier_field.id): {
                    'id': 'a4b5c6d7-8901-2345-6789-abcdef012345',
                    'title': '深圳科技有限公司',
                },
            },
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            order=21,
        )

        records, total = LinkFieldService.get_linkable_records(
            self.link_field,
            search='4',
            page=1,
            page_size=50,
        )
        found_ids = {item['id'] for item in records}
        self.assertIn(str(phone_hit.id), found_ids)
        self.assertNotIn(str(uuid_only.id), found_ids)
        self.assertLessEqual(total, 3)

    def test_linkable_records_fields_read_hex_keys(self):
        """协作落库只写 hex key 时，fields 仍应按 dashed field.id 返回列值。"""
        text_field = TableField.objects.create(
            table=self.foreign_table,
            name='文本',
            field_type='text',
            order=3,
        )
        hex_record = TableRecord.objects.create(
            table=self.foreign_table,
            data={
                # lookup/主字段用 dashed（title 可读）；多列字段仅 hex（模拟 collab）
                str(self.foreign_primary.id): '产品发布会',
                self.foreign_amount.id.hex: 120,
                text_field.id.hex: '备注应可见',
            },
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            order=30,
        )
        # 显式 visibleFieldIds，确保文本列进入 payload
        self.link_field.config = {
            **(self.link_field.config or {}),
            'visibleFieldIds': [
                str(text_field.id),
                str(self.foreign_primary.id),
                str(self.foreign_amount.id),
            ],
        }
        self.link_field.save(update_fields=['config'])

        records, total = LinkFieldService.get_linkable_records(
            self.link_field,
            page=1,
            page_size=50,
        )
        by_id = {item['id']: item for item in records}
        self.assertIn(str(hex_record.id), by_id)
        item = by_id[str(hex_record.id)]
        self.assertEqual(item['title'], '产品发布会')
        self.assertEqual(item['fields'].get(str(text_field.id)), '备注应可见')
        self.assertEqual(item['fields'].get(str(self.foreign_amount.id)), 120)
        # 输出 key 必须是 dashed，与前端 field.id 对齐
        self.assertNotIn(text_field.id.hex, item['fields'])
