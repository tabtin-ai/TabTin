from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.services.search_index_service import SearchIndexService
from apps.tabtinspace.models import Organization, OrganizationMember, Project

User = get_user_model()


class SearchIndexServiceTestCase(TestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        self.user = User.objects.db_manager('default').create_user(
            username='search_index_owner',
            email='search_index_owner@example.com',
            password='testpass123',
        )

        self.organization = Organization.objects.create(
            name='Search Index Organization',
            owner=self.user,
        )
        # ：Space 表已 DROP；Table.space_id 挂 Project.id
        self.project = Project.objects.create(
            name='Search Index Project',
            organization=self.organization,
        )
        self.table = Table.objects.create(
            space_id=self.project.id,
            organization_id=self.organization.id,
            name='Search Index Table',
            owner=self.user,
        )
        self.field = TableField.objects.create(
            table=self.table,
            name='标题',
            field_type='text',
            order=0,
            is_primary=True,
        )

        self.service = SearchIndexService(user=self.user)

    def test_get_status_for_unsupported_database(self):
        with patch.object(
            SearchIndexService,
            '_get_connection',
            return_value=SimpleNamespace(vendor='sqlite'),
        ):
            status = self.service.get_search_index_status(self.table.id)

        self.assertFalse(status['supported'])
        self.assertFalse(status['enabled'])
        self.assertEqual(status['type'], 'search')
        self.assertEqual(status['reason'], 'unsupported_database')

    def test_toggle_search_index_enable(self):
        with patch.object(
            SearchIndexService,
            '_get_connection',
            return_value=SimpleNamespace(vendor='postgresql'),
        ), patch.object(
            SearchIndexService,
            '_fetch_existing_indexes',
            return_value={},
        ), patch.object(
            SearchIndexService,
            '_ensure_pg_trgm_extension',
        ) as mock_ensure_extension, patch.object(
            SearchIndexService,
            '_create_single_index',
        ) as mock_create_index, patch.object(
            SearchIndexService,
            'get_search_index_status',
            return_value={'enabled': True},
        ):
            result = self.service.toggle_search_index(self.table.id, enabled=True)

        mock_ensure_extension.assert_called_once()
        mock_create_index.assert_called_once_with(self.table.id, self.field.id)
        self.assertTrue(result['enabled'])

    def test_toggle_search_index_disable(self):
        with patch.object(
            SearchIndexService,
            '_get_connection',
            return_value=SimpleNamespace(vendor='postgresql'),
        ), patch.object(
            SearchIndexService,
            '_fetch_existing_indexes',
            return_value={'idx_tt_s_abcd_efgh': 'create index ...'},
        ), patch.object(
            SearchIndexService,
            '_drop_index',
        ) as mock_drop_index, patch.object(
            SearchIndexService,
            'get_search_index_status',
            return_value={'enabled': False},
        ):
            result = self.service.toggle_search_index(self.table.id, enabled=False)

        mock_drop_index.assert_called_once_with('idx_tt_s_abcd_efgh')
        self.assertFalse(result['enabled'])

    def test_repair_search_index(self):
        with patch.object(
            SearchIndexService,
            '_get_connection',
            return_value=SimpleNamespace(vendor='postgresql'),
        ), patch.object(
            SearchIndexService,
            '_fetch_existing_indexes',
            return_value={'idx_tt_s_abcd_efgh': 'create index ...'},
        ), patch.object(
            SearchIndexService,
            '_collect_abnormal_indexes',
            return_value=[
                {'issue': 'redundant', 'index_name': 'idx_tt_s_abcd_efgh'},
                {'issue': 'missing', 'field_id': str(self.field.id)},
            ],
        ), patch.object(
            SearchIndexService,
            '_ensure_pg_trgm_extension',
        ) as mock_ensure_extension, patch.object(
            SearchIndexService,
            '_drop_index',
        ) as mock_drop_index, patch.object(
            SearchIndexService,
            '_create_single_index',
        ) as mock_create_index, patch.object(
            SearchIndexService,
            'get_search_index_status',
            return_value={'enabled': True},
        ):
            result = self.service.repair_search_index(self.table.id)

        mock_ensure_extension.assert_called_once()
        mock_drop_index.assert_called_once_with('idx_tt_s_abcd_efgh')
        mock_create_index.assert_called_once_with(self.table.id, self.field.id)
        self.assertTrue(result['enabled'])

    def test_search_records_ignores_link_cell_ids_for_numeric_query(self):
        """#6873：数字搜索只匹配展示名，不命中 link cell 的 UUID id。"""
        link_field = TableField.objects.create(
            table=self.table,
            name='供应商',
            field_type='link',
            order=1,
        )
        phone_field = TableField.objects.create(
            table=self.table,
            name='客服电话',
            field_type='text',
            order=2,
        )
        TableRecord.objects.create(
            table=self.table,
            created_by_id=str(self.user.id),
            data={
                str(self.field.id): '产品A',
                str(link_field.id): {
                    'id': 'a4b5c6d7-8901-2345-6789-abcdef012345',
                    'title': '深圳科技有限公司',
                },
                str(phone_field.id): '4008001001',
            },
            order=1,
        )
        TableRecord.objects.create(
            table=self.table,
            created_by_id=str(self.user.id),
            data={
                str(self.field.id): '产品B',
                str(link_field.id): {
                    'id': '11111111-2222-3333-4444-555555555555',
                    'title': '北京创新集团',
                },
                str(phone_field.id): '8001234567',
            },
            order=2,
        )

        hits = self.service.search_records(
            table_id=self.table.id,
            search_value='4',
            take=100,
        )
        self.assertIsNotNone(hits)
        field_hits = [
            item for item in hits
            if isinstance(item, dict) and not item.get('__meta')
        ]
        hit_field_ids = {item['fieldId'] for item in field_hits}
        self.assertIn(str(phone_field.id), hit_field_ids)
        self.assertNotIn(str(link_field.id), hit_field_ids)

    def test_user_fields_match_organization_member_display_name(self):
        member_user = User.objects.db_manager('default').create_user(
            username='try_yang_login',
            nickname='TryYang',
            email='try_yang@example.com',
            password='testpass123',
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=member_user,
            role='editor',
        )
        other_owner = User.objects.db_manager('default').create_user(
            username='other_owner',
            email='other_owner@example.com',
            password='testpass123',
        )
        other_user = User.objects.db_manager('default').create_user(
            username='cross_yang_login',
            nickname='CrossYang',
            email='cross_yang@example.com',
            password='testpass123',
        )
        other_organization = Organization.objects.create(
            name='Other Search Organization',
            owner=other_owner,
        )
        OrganizationMember.objects.create(
            organization=other_organization,
            user=other_user,
            role='editor',
        )

        user_field = TableField.objects.create(
            table=self.table,
            name='负责人',
            field_type='user',
            order=1,
        )
        created_by_field = TableField.objects.create(
            table=self.table,
            name='创建者',
            field_type='created_by',
            order=2,
        )
        scalar_record = TableRecord.objects.create(
            table=self.table,
            created_by_id=str(self.user.id),
            data={
                str(self.field.id): '单选用户',
                str(user_field.id): str(member_user.id),
            },
            order=1,
        )
        multiple_record = TableRecord.objects.create(
            table=self.table,
            created_by_id=str(self.user.id),
            data={
                str(self.field.id): '多人用户',
                str(user_field.id): [
                    {'id': str(member_user.id)},
                    {'id': str(other_user.id)},
                ],
            },
            order=2,
        )
        TableRecord.objects.create(
            table=self.table,
            created_by_id=str(self.user.id),
            data={
                str(self.field.id): '跨组织用户',
                str(user_field.id): str(other_user.id),
            },
            order=3,
        )
        system_user_record = TableRecord.objects.create(
            table=self.table,
            created_by_id=str(member_user.id),
            data={
                str(self.field.id): '系统用户字段',
            },
            order=4,
        )

        hits = self.service.search_records(
            table_id=self.table.id,
            search_value='Yang',
            field_id=str(user_field.id),
            take=100,
        )
        self.assertIsNotNone(hits)
        field_hits = [
            item for item in hits
            if isinstance(item, dict) and not item.get('__meta')
        ]
        self.assertEqual(
            {item['recordId'] for item in field_hits},
            {str(scalar_record.id), str(multiple_record.id)},
        )
        self.assertEqual(
            self.service.search_count(
                table_id=self.table.id,
                search_value='yang',
                field_id=str(user_field.id),
            ),
            2,
        )

        hidden_hits = self.service.search_records(
            table_id=self.table.id,
            search_value='Yang',
            field_id=str(user_field.id),
            hide_not_match_row=True,
            take=100,
        )
        self.assertIsNotNone(hidden_hits)
        hidden_field_hits = [
            item for item in hidden_hits
            if isinstance(item, dict) and not item.get('__meta')
        ]
        self.assertEqual(len(hidden_field_hits), 2)

        system_user_hits = self.service.search_records(
            table_id=self.table.id,
            search_value='Yang',
            field_id=str(created_by_field.id),
            take=100,
        )
        self.assertIsNotNone(system_user_hits)
        self.assertEqual(
            {
                item['recordId']
                for item in system_user_hits
                if isinstance(item, dict) and not item.get('__meta')
            },
            {str(system_user_record.id)},
        )

        self.assertIsNone(
            self.service.search_records(
                table_id=self.table.id,
                search_value='CrossYang',
                field_id=str(user_field.id),
                take=100,
            ),
        )
