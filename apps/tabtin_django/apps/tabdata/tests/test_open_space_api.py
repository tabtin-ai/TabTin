import json
from unittest.mock import patch, MagicMock
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import Client, RequestFactory, TestCase

from django.conf import settings as django_settings
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.models_token import TableApiToken, VALID_SCOPES
from apps.tabdata.models_webhook import TableWebhook
from apps.users.membership.models import MembershipTier

_TD_DB = getattr(django_settings, 'TABDATA_DB', 'postgresql')
from apps.tabtinspace.models import (
    Agent,
    Space,
    SpaceMembership,
    Organization,
    OrganizationMember,
)

User = get_user_model()


class OpenSpaceApiTestCase(TestCase):
    databases = {'default', 'postgresql'}

    def setUp(self):
        self.client = Client()
        self.factory = RequestFactory()
        self.user = User.objects.db_manager('default').create_user(
            username='open_space_api_user',
            email='open_space_api_user@example.com',
            password='testpass123',
        )

        self.organization = Organization.objects.create(
            name='Open Space API Organization',
            owner_id=str(self.user.id),
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(self.user.id),
            role='owner',
        )

        self.space = Space.objects.create(
            organization=self.organization,
            name='客户数据库',
        )
        self.other_space = Space.objects.create(
            organization=self.organization,
            name='归档数据库',
        )

        self.agent, _ = Agent.objects.get_or_create(
            organization=self.organization,
            user=self.user,
            defaults={
                'name': 'Open Space API Agent',
                'type': 'human',
                'is_active': True,
            },
        )

        SpaceMembership.objects.update_or_create(
            workspace=self.space,
            agent=self.agent,
            defaults={'role': 'owner', 'is_active': True},
        )
        SpaceMembership.objects.update_or_create(
            workspace=self.other_space,
            agent=self.agent,
            defaults={'role': 'owner', 'is_active': True},
        )

        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.organization.id,
            name='客户表',
            owner_id=str(self.user.id),
        )
        self.same_space_other_table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.organization.id,
            name='订单表',
            owner_id=str(self.user.id),
        )
        self.other_table = Table.objects.create(
            space_id=self.other_space.id,
            organization_id=self.organization.id,
            name='历史表',
            owner_id=str(self.user.id),
        )

        self.api_token, plain_token = TableApiToken.create_token(
            user=self.user,
            name='open-space-api-token',
            scopes=['table:read', 'db_connection:manage', 'sql:query'],
            space_ids=[str(self.space.id)],
            rate_limit=600,
        )
        self.auth_headers = {
            'HTTP_AUTHORIZATION': f'Bearer {plain_token}',
        }

    def test_list_spaces_uses_space_as_primary_entry(self):
        response = self.client.get(
            '/api/open/v1/spaces',
            **self.auth_headers,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()['data']
        self.assertEqual(payload['total'], 1)
        self.assertEqual(payload['spaces'][0]['id'], str(self.space.id))
        self.assertEqual(
            payload['spaces'][0]['developer_entry']['data_path'],
            f'/api/open/v1/spaces/{self.space.id}/data',
        )

    def test_get_space_data_home_returns_database_modeling(self):
        response = self.client.get(
            f'/api/open/v1/spaces/{self.space.id}/data',
            **self.auth_headers,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()['data']
        self.assertEqual(payload['space']['id'], str(self.space.id))
        self.assertEqual(payload['database']['table_count'], 2)
        self.assertEqual(payload['modeling']['database'], 'space')
        self.assertEqual(
            payload['entrypoints']['tables_path'],
            f'/api/open/v1/spaces/{self.space.id}/data/tables',
        )

    def test_get_space_db_info_uses_nested_data_route(self):
        response = self.client.get(
            f'/api/open/v1/spaces/{self.space.id}/data/db-info',
            **self.auth_headers,
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()['data']
        self.assertIn('schema_name', payload)
        self.assertGreaterEqual(len(payload['tables']), 2)
        table_ids = {t['id'] for t in payload['tables']}
        self.assertIn(str(self.table.id), table_ids)
        self.assertIn(str(self.same_space_other_table.id), table_ids)

    @patch('apps.tabdata.api_agent_sql.get_resolver')
    def test_get_space_sql_catalog_returns_success(self, mock_get_resolver):
        from apps.tabdata.api_open_space import get_space_data_sql_catalog

        mock_get_resolver.return_value.build_catalog.return_value = {
            'tables': [
                {
                    'id': str(self.table.id),
                    'name': self.table.name,
                    'fields': [],
                }
            ]
        }

        request = self.factory.get(
            f'/api/open/v1/spaces/{self.space.id}/data/sql/catalog',
        )
        request.auth = self.user
        request.api_token = self.api_token

        response = get_space_data_sql_catalog(request, self.space.id)

        self.assertTrue(response['success'])
        self.assertEqual(response['data']['tables'][0]['id'], str(self.table.id))

    def test_query_space_sql_returns_success(self):
        from apps.tabdata.api_open_space import query_space_data_sql
        from apps.tabdata.schemas import AgentSQLQueryRequest

        request = self.factory.post(
            f'/api/open/v1/spaces/{self.space.id}/data/sql/query',
        )
        request.auth = self.user
        request.api_token = self.api_token

        with patch(
            'apps.tabdata.api_agent_sql.RLSContext.from_request',
            return_value=MagicMock(),
        ), patch('apps.tabdata.api_agent_sql.AgentSQLExecutor') as mock_executor:
            mock_executor.return_value.execute_read.return_value = {
                'columns': ['value'],
                'rows': [[1]],
                'row_count': 1,
            }

            response = query_space_data_sql(
                request,
                self.space.id,
                AgentSQLQueryRequest(sql='SELECT 1 AS value', params=[]),
            )

        self.assertTrue(response['success'])
        self.assertEqual(response['data']['row_count'], 1)
        mock_executor.return_value.execute_read.assert_called_once_with('SELECT 1 AS value', [])

    def test_execute_space_sql_returns_success(self):
        from apps.tabdata.api_open_space import execute_space_data_sql
        from apps.tabdata.schemas import AgentSQLExecuteRequest

        execute_token, _ = TableApiToken.create_token(
            user=self.user,
            name='open-space-sql-exec-token',
            scopes=['sql:query', 'sql:execute'],
            space_ids=[str(self.space.id)],
            rate_limit=600,
        )
        request = self.factory.post(
            f'/api/open/v1/spaces/{self.space.id}/data/sql/execute',
        )
        request.auth = self.user
        request.api_token = execute_token

        with patch(
            'apps.tabdata.api_agent_sql.RLSContext.from_request',
            return_value=MagicMock(),
        ), patch('apps.tabdata.api_agent_sql.AgentSQLExecutor') as mock_executor:
            mock_executor.return_value.execute_write.return_value = {
                'affected_rows': 1,
                'operation': 'update',
            }

            response = execute_space_data_sql(
                request,
                self.space.id,
                AgentSQLExecuteRequest(
                    sql='UPDATE "客户表" SET "状态" = %s',
                    params=['active'],
                    allow_delete=False,
                ),
            )

        self.assertTrue(response['success'])
        self.assertEqual(response['data']['affected_rows'], 1)
        mock_executor.return_value.execute_write.assert_called_once_with(
            'UPDATE "客户表" SET "状态" = %s',
            ['active'],
            allow_delete=False,
        )

    def test_list_available_scopes_declares_forbidden_response(self):
        from apps.tabdata.api_token import router as token_router

        operation = token_router.path_operations['/tokens/scopes/available'].operations[0]

        self.assertIn(200, operation.response_models)
        self.assertIn(403, operation.response_models)
        self.assertIn(429, operation.response_models)

    def test_sql_routes_declare_expected_error_statuses(self):
        from apps.tabdata.api_agent_sql import router as sql_router
        from apps.tabdata.api_open_space import router as space_router

        raw_query = sql_router.path_operations['/spaces/{space_id}/sql/query'].operations[0]
        raw_execute = sql_router.path_operations['/spaces/{space_id}/sql/execute'].operations[0]
        raw_catalog = sql_router.path_operations['/spaces/{space_id}/sql/catalog'].operations[0]
        space_query = space_router.path_operations['/spaces/{space_id}/data/sql/query'].operations[0]
        space_execute = space_router.path_operations['/spaces/{space_id}/data/sql/execute'].operations[0]
        space_catalog = space_router.path_operations['/spaces/{space_id}/data/sql/catalog'].operations[0]

        self.assertIn(404, raw_query.response_models)
        self.assertIn(404, raw_execute.response_models)
        self.assertIn(404, raw_catalog.response_models)
        self.assertIn(429, raw_query.response_models)
        self.assertIn(429, raw_execute.response_models)
        self.assertIn(429, raw_catalog.response_models)
        self.assertIn(400, space_query.response_models)
        self.assertIn(400, space_execute.response_models)
        self.assertIn(429, space_query.response_models)
        self.assertIn(429, space_execute.response_models)
        self.assertIn(429, space_catalog.response_models)

    def test_space_scoped_table_route_rejects_table_from_other_space(self):
        response = self.client.get(
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.other_table.id}',
            **self.auth_headers,
        )

        self.assertEqual(response.status_code, 404)
        payload = json.loads(response.content)
        self.assertFalse(payload['success'])

    def test_table_scoped_token_cannot_access_other_table_in_same_space(self):
        _, plain_token = TableApiToken.create_token(
            user=self.user,
            name='table-scoped-token',
            scopes=['table:read', 'field:read', 'record:read'],
            table_ids=[str(self.table.id)],
            rate_limit=600,
        )

        response = self.client.get(
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.same_space_other_table.id}',
            HTTP_AUTHORIZATION=f'Bearer {plain_token}',
        )

        self.assertEqual(response.status_code, 403)
        payload = response.json()
        self.assertFalse(payload['success'])

    def test_table_scoped_token_cannot_access_space_level_db_connection(self):
        _, plain_token = TableApiToken.create_token(
            user=self.user,
            name='table-scoped-db-token',
            scopes=['db_connection:manage', 'table:read'],
            table_ids=[str(self.table.id)],
            rate_limit=600,
        )

        response = self.client.get(
            f'/api/open/v1/spaces/{self.space.id}/data/db-connection',
            HTTP_AUTHORIZATION=f'Bearer {plain_token}',
        )

        self.assertEqual(response.status_code, 403)
        payload = response.json()
        self.assertFalse(payload['success'])

    def test_table_scoped_token_cannot_access_space_level_db_info(self):
        _, plain_token = TableApiToken.create_token(
            user=self.user,
            name='table-scoped-db-info-token',
            scopes=['db_connection:manage', 'table:read'],
            table_ids=[str(self.table.id)],
            rate_limit=600,
        )

        response = self.client.get(
            f'/api/open/v1/spaces/{self.space.id}/data/db-info',
            HTTP_AUTHORIZATION=f'Bearer {plain_token}',
        )

        self.assertEqual(response.status_code, 403)
        payload = response.json()
        self.assertFalse(payload['success'])

    def test_table_scoped_token_filters_table_list(self):
        _, plain_token = TableApiToken.create_token(
            user=self.user,
            name='table-scoped-list-token',
            scopes=['table:read'],
            table_ids=[str(self.table.id)],
            rate_limit=600,
        )

        response = self.client.get(
            f'/api/open/v1/spaces/{self.space.id}/data/tables',
            HTTP_AUTHORIZATION=f'Bearer {plain_token}',
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()['data']
        self.assertEqual(payload['total'], 1)
        self.assertEqual(payload['tables'][0]['id'], str(self.table.id))

    def test_table_scoped_token_cannot_create_table(self):
        _, plain_token = TableApiToken.create_token(
            user=self.user,
            name='table-scoped-create-token',
            scopes=['table:create'],
            table_ids=[str(self.table.id)],
            rate_limit=600,
        )

        response = self.client.post(
            f'/api/open/v1/spaces/{self.space.id}/data/tables',
            data=json.dumps({
                'name': '新建表',
                'use_default_fields': True,
            }),
            content_type='application/json',
            HTTP_AUTHORIZATION=f'Bearer {plain_token}',
        )

        self.assertEqual(response.status_code, 403)
        payload = response.json()
        self.assertFalse(payload['success'])

    def test_table_routes_return_404_for_missing_table(self):
        fake_table_id = uuid4()
        response = self.client.get(
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{fake_table_id}/fields',
            **self.auth_headers,
        )

        self.assertIn(response.status_code, (403, 404))
        payload = response.json()
        self.assertFalse(payload['success'])

    def test_viewer_scoped_token_cannot_manage_db_connection(self):
        viewer = User.objects.db_manager('default').create_user(
            username='open_space_viewer',
            email='open_space_viewer@example.com',
            password='testpass123',
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(viewer.id),
            role='viewer',
        )
        viewer_agent, _ = Agent.objects.get_or_create(
            organization=self.organization,
            user=viewer,
            defaults={
                'name': 'Open Space Viewer Agent',
                'type': 'human',
                'is_active': True,
            },
        )
        SpaceMembership.objects.update_or_create(
            workspace=self.space,
            agent=viewer_agent,
            defaults={'role': 'viewer', 'is_active': True},
        )
        _, viewer_token = TableApiToken.create_token(
            user=viewer,
            name='viewer-db-token',
            scopes=['db_connection:manage'],
            space_ids=[str(self.space.id)],
            rate_limit=600,
        )

        response = self.client.post(
            f'/api/open/v1/spaces/{self.space.id}/data/db-connection',
            data='{}',
            content_type='application/json',
            HTTP_AUTHORIZATION=f'Bearer {viewer_token}',
        )

        self.assertEqual(response.status_code, 403)
        payload = response.json()
        self.assertFalse(payload['success'])

        get_response = self.client.get(
            f'/api/open/v1/spaces/{self.space.id}/data/db-connection',
            HTTP_AUTHORIZATION=f'Bearer {viewer_token}',
        )

        self.assertEqual(get_response.status_code, 403)
        get_payload = get_response.json()
        self.assertFalse(get_payload['success'])


class ExtendedOpenSpaceApiTestCase(OpenSpaceApiTestCase):
    """覆盖 Space 级路由中的字段、记录、视图、聚合与安全性。"""

    databases = {'default', 'postgresql'}

    def setUp(self):
        super().setUp()

        MembershipTier.objects.get_or_create(
            tier_type='free',
            defaults={
                'name': 'Free',
                'max_tables': -1,
                'max_records_per_table': -1,
                'max_api_calls_per_day': -1,
                'max_crawl_tasks_per_day': -1,
            },
        )

        self._patchers = []
        for target in [
            'apps.tabdata.services.record_service.NativeRecordIO',
            'apps.tabdata.services.table_service.DDLManager',
        ]:
            p = patch(target, return_value=MagicMock())
            p.start()
            self._patchers.append(p)

        mock_qb_instance = MagicMock()
        mock_qb_instance.build_aggregate_sql.return_value = ('SELECT COUNT(*) AS "count" FROM "mock_table"', [])
        mock_qb_instance.qualified_name = '"mock_schema"."mock_table"'
        mock_qb_instance.build_where_clause.return_value = None
        p = patch('apps.tabdata.native.query_builder.NativeQueryBuilder', return_value=mock_qb_instance)
        p.start()
        self._patchers.append(p)

        self._mock_qb_instance = mock_qb_instance

        _, full_plain = TableApiToken.create_token(
            user=self.user,
            name='full-scope-token',
            scopes=list(VALID_SCOPES),
            space_ids=[str(self.space.id)],
            rate_limit=600,
        )
        self.full_token_headers = {
            'HTTP_AUTHORIZATION': f'Bearer {full_plain}',
        }

        _, viewer_plain = TableApiToken.create_token(
            user=self.user,
            name='viewer-only-token',
            scopes=['table:read', 'field:read', 'record:read', 'view:read'],
            space_ids=[str(self.space.id)],
            rate_limit=600,
        )
        self.viewer_headers = {
            'HTTP_AUTHORIZATION': f'Bearer {viewer_plain}',
        }

        self.field_a = TableField.objects.using(_TD_DB).create(
            table=self.table,
            name='姓名',
            field_type='text',
            order=0,
        )
        self.field_b = TableField.objects.using(_TD_DB).create(
            table=self.table,
            name='年龄',
            field_type='number',
            order=1,
        )
        self.record_a = TableRecord.objects.using(_TD_DB).create(
            table=self.table,
        )
        self.record_b = TableRecord.objects.using(_TD_DB).create(
            table=self.table,
        )

    def tearDown(self):
        for p in self._patchers:
            p.stop()
        super().tearDown()


    # ── 字段 CRUD ──────────────────────────────────────

    def test_create_field_in_space_table(self):
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/fields'
        resp = self.client.post(
            url,
            data=json.dumps({'name': '新字段', 'type': 'text'}),
            content_type='application/json',
            **self.full_token_headers,
        )
        self.assertEqual(resp.status_code, 201)
        payload = resp.json()
        self.assertTrue(payload['success'])

    def test_update_field_in_space_table(self):
        url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}'
            f'/fields/{self.field_a.id}'
        )
        resp = self.client.patch(
            url,
            data=json.dumps({'name': '客户姓名'}),
            content_type='application/json',
            **self.full_token_headers,
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()['success'])

    def test_delete_field_in_space_table(self):
        victim = TableField.objects.using(_TD_DB).create(
            table=self.table,
            name='待删字段',
            field_type='text',
            order=99,
        )
        url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}'
            f'/fields/{victim.id}'
        )
        resp = self.client.delete(url, **self.full_token_headers)
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()['success'])

    def test_get_field_map(self):
        url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}'
            f'/field-map'
        )
        resp = self.client.get(url, **self.full_token_headers)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()['data']
        self.assertIn('field_map', data)

    # ── 记录操作 ───────────────────────────────────────

    def test_update_record_in_space_table(self):
        url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}'
            f'/records/{self.record_a.id}'
        )
        resp = self.client.patch(
            url,
            data=json.dumps({'fields': {'姓名': '张三'}, 'field_key_type': 'name'}),
            content_type='application/json',
            **self.full_token_headers,
        )
        self.assertIn(resp.status_code, (200, 201))
        self.assertTrue(resp.json()['success'])

    def test_delete_record_in_space_table(self):
        victim = TableRecord.objects.using(_TD_DB).create(table=self.table)
        url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}'
            f'/records/{victim.id}'
        )
        resp = self.client.delete(url, **self.full_token_headers)
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()['success'])

    def test_batch_create_records(self):
        url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}'
            f'/records/batch-create'
        )
        resp = self.client.post(
            url,
            data=json.dumps({
                'records': [
                    {'fields': {'姓名': '李四'}},
                    {'fields': {'姓名': '王五'}},
                ],
                'field_key_type': 'name',
            }),
            content_type='application/json',
            **self.full_token_headers,
        )
        self.assertEqual(resp.status_code, 201)
        self.assertTrue(resp.json()['success'])

    def test_batch_delete_records(self):
        r1 = TableRecord.objects.using(_TD_DB).create(table=self.table)
        r2 = TableRecord.objects.using(_TD_DB).create(table=self.table)
        url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}'
            f'/records/batch-delete'
        )
        resp = self.client.post(
            url,
            data=json.dumps({'record_ids': [str(r1.id), str(r2.id)]}),
            content_type='application/json',
            **self.full_token_headers,
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()['success'])

    def test_upsert_records(self):
        url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}'
            f'/records/upsert'
        )
        resp = self.client.post(
            url,
            data=json.dumps({
                'records': [{'fields': {'姓名': '赵六'}}],
                'upsert_on': ['姓名'],
                'field_key_type': 'name',
            }),
            content_type='application/json',
            **self.full_token_headers,
        )
        self.assertIn(resp.status_code, (200, 201))
        self.assertTrue(resp.json()['success'])

    # ── 视图 ──────────────────────────────────────────

    def test_list_views_in_space_table(self):
        url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}'
            f'/views'
        )
        resp = self.client.get(url, **self.full_token_headers)
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()['success'])

    def test_create_and_delete_view(self):
        base_url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}'
            f'/views'
        )
        create_resp = self.client.post(
            base_url,
            data=json.dumps({'name': '测试视图', 'type': 'grid'}),
            content_type='application/json',
            **self.full_token_headers,
        )
        self.assertEqual(create_resp.status_code, 201)
        view_id = create_resp.json()['data']['id']

        delete_resp = self.client.delete(
            f'{base_url}/{view_id}',
            **self.full_token_headers,
        )
        self.assertEqual(delete_resp.status_code, 200)
        self.assertTrue(delete_resp.json()['success'])

    # ── 聚合 ──────────────────────────────────────────

    @patch('apps.tabdata.api_open_space.aggregate_records_impl')
    def test_aggregation(self, mock_agg):
        from django.http import JsonResponse as _JR
        mock_agg.return_value = _JR(
            {'success': True, 'data': {'results': {'count': 2}, 'total_records': 2}},
            status=200,
        )
        url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}'
            f'/aggregation'
        )
        resp = self.client.post(
            url,
            data=json.dumps({
                'aggregations': [{'function': 'count'}],
            }),
            content_type='application/json',
            **self.full_token_headers,
        )
        self.assertEqual(resp.status_code, 200)
        mock_agg.assert_called_once()
        self.assertTrue(resp.json()['success'])

    # ── 安全性 ────────────────────────────────────────

    def test_table_from_other_space_rejected_for_field_ops(self):
        url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.other_table.id}'
            f'/fields'
        )
        resp = self.client.get(url, **self.full_token_headers)
        self.assertEqual(resp.status_code, 404)
        self.assertFalse(resp.json()['success'])

    def test_insufficient_scope_rejected(self):
        url = (
            f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}'
            f'/fields'
        )
        resp = self.client.post(
            url,
            data=json.dumps({'name': '非法字段', 'type': 'text'}),
            content_type='application/json',
            **self.viewer_headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_webhook_from_other_space_rejected(self):
        _, other_token_plain = TableApiToken.create_token(
            user=self.user,
            name='other-space-webhook-token',
            scopes=list(VALID_SCOPES),
            space_ids=[str(self.other_space.id)],
            rate_limit=600,
        )
        other_headers = {
            'HTTP_AUTHORIZATION': f'Bearer {other_token_plain}',
        }
        create_resp = self.client.post(
            f'/api/open/v1/spaces/{self.other_space.id}/data/webhooks',
            data=json.dumps({
                'space_id': str(self.other_space.id),
                'url': 'https://example.com/hook',
                'events': ['record.created'],
            }),
            content_type='application/json',
            **other_headers,
        )
        self.assertEqual(create_resp.status_code, 201)
        webhook_id = create_resp.json()['data']['id']

        update_resp = self.client.patch(
            f'/api/open/v1/spaces/{self.space.id}/data/webhooks/{webhook_id}',
            data=json.dumps({'url': 'https://evil.com/hook'}),
            content_type='application/json',
            **self.full_token_headers,
        )
        self.assertEqual(update_resp.status_code, 404)
        self.assertFalse(update_resp.json()['success'])

class RoundTwoQualityTestCase(TestCase):
    """第二轮质量提升相关测试：字段校验、batch IDs、聚合 key、主字段删除等。

    使用 RequestFactory 直接调用 impl 函数，绕过 test_urls 路由问题。
    """

    databases = {'default', 'postgresql'}

    def setUp(self):
        self.factory = RequestFactory()
        self.user = User.objects.db_manager('default').create_user(
            username='r2_test_user',
            email='r2_test@example.com',
            password='testpass123',
        )

        self.organization = Organization.objects.create(
            name='R2 Organization',
            owner_id=str(self.user.id),
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(self.user.id),
            role='owner',
        )

        MembershipTier.objects.get_or_create(
            tier_type='free',
            defaults={
                'name': 'Free',
                'max_tables': -1,
                'max_records_per_table': -1,
                'max_api_calls_per_day': -1,
                'max_crawl_tasks_per_day': -1,
            },
        )

        self.space = Space.objects.create(
            organization=self.organization,
            name='R2测试库',
        )

        self.agent, _ = Agent.objects.get_or_create(
            organization=self.organization,
            user=self.user,
            defaults={'name': 'R2 Agent', 'type': 'human', 'is_active': True},
        )
        SpaceMembership.objects.update_or_create(
            workspace=self.space,
            agent=self.agent,
            defaults={'role': 'owner', 'is_active': True},
        )

        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.organization.id,
            name='R2测试表',
            owner_id=str(self.user.id),
        )

        self.field_name = TableField.objects.using(_TD_DB).create(
            table=self.table, name='姓名', field_type='text', order=0,
        )
        self.field_age = TableField.objects.using(_TD_DB).create(
            table=self.table, name='年龄', field_type='number', order=1,
        )
        self.primary_field = TableField.objects.using(_TD_DB).create(
            table=self.table, name='主键字段', field_type='text', order=-1,
            is_primary=True,
        )

        self._patchers = []
        for target in [
            'apps.tabdata.services.record_service.NativeRecordIO',
            'apps.tabdata.services.table_service.DDLManager',
        ]:
            p = patch(target, return_value=MagicMock())
            p.start()
            self._patchers.append(p)

    def tearDown(self):
        for p in self._patchers:
            p.stop()

    def _make_request(self, method='POST', path='/fake'):
        fn = getattr(self.factory, method.lower())
        request = fn(path)
        request.auth = self.user
        request.api_token = None
        return request

    # ── 1.1 未知字段过滤工具函数 ─────────────────────────

    def test_strip_unknown_fields_filters_correctly(self):
        from apps.tabdata.api_utils import _build_valid_field_keys, strip_unknown_fields

        valid_keys = _build_valid_field_keys(self.table.id)
        self.assertIn('姓名', valid_keys)
        self.assertIn('年龄', valid_keys)
        self.assertIn(str(self.field_name.id), valid_keys)

        cleaned, unknown = strip_unknown_fields(
            {'姓名': '张三', '不存在字段': '值', '年龄': 25},
            valid_keys,
        )
        self.assertEqual(cleaned, {'姓名': '张三', '年龄': 25})
        self.assertEqual(unknown, ['不存在字段'])

    def test_create_record_impl_adds_warnings_for_unknown_fields(self):
        from apps.tabdata.api_open import create_record_impl, OpenCreateRecordBody

        body = OpenCreateRecordBody(
            fields={'姓名': '张三', '不存在字段': '某值'},
            field_key_type='name',
        )
        request = self._make_request()
        resp = create_record_impl(request, self.table.id, body)

        data = json.loads(resp.content)
        self.assertTrue(data['success'])
        inner = data.get('data', {})
        warnings = inner.get('warnings', [])
        self.assertTrue(
            any('不存在字段' in w for w in warnings),
            f"Expected unknown field warning, got: {warnings}",
        )

    def test_batch_create_impl_filters_unknown_fields(self):
        from apps.tabdata.api_open import batch_create_records_impl, BulkCreateBody

        body = BulkCreateBody(
            records=[
                {'fields': {'姓名': '李四', '幽灵字段': '值'}},
                {'fields': {'姓名': '王五'}},
            ],
            field_key_type='name',
        )
        request = self._make_request()
        resp = batch_create_records_impl(request, self.table.id, body)

        data = json.loads(resp.content)
        self.assertTrue(data['success'])
        inner = data.get('data', {})
        warnings = inner.get('warnings', [])
        self.assertTrue(
            any('幽灵字段' in w for w in warnings),
            f"Expected unknown field warning in batch-create, got: {warnings}",
        )

    # ── batch-create 空数组返回 400 ──────────────────────

    def test_batch_create_empty_records_returns_400(self):
        from apps.tabdata.api_open import batch_create_records_impl, BulkCreateBody

        body = BulkCreateBody(records=[], field_key_type='name')
        request = self._make_request()
        resp = batch_create_records_impl(request, self.table.id, body)

        self.assertEqual(resp.status_code, 400)
        data = json.loads(resp.content)
        self.assertFalse(data['success'])

    # ── 2.2 batch-create 返回 record IDs ────────────────

    def test_batch_create_returns_record_ids(self):
        from apps.tabdata.api_open import batch_create_records_impl, BulkCreateBody

        body = BulkCreateBody(
            records=[
                {'fields': {'姓名': 'ID测试1'}},
                {'fields': {'姓名': 'ID测试2'}},
            ],
            field_key_type='name',
        )
        request = self._make_request()
        resp = batch_create_records_impl(request, self.table.id, body)

        self.assertEqual(resp.status_code, 201)
        data = json.loads(resp.content)['data']
        self.assertIn('records', data)
        self.assertEqual(len(data['records']), data['created_count'])
        for r in data['records']:
            self.assertIn('id', r)

    # ── 2.1 创建字段 field_type 别名 ────────────────────

    def test_create_field_with_field_type_alias(self):
        from apps.tabdata.api_open import open_create_field_impl, OpenCreateFieldBody

        body = OpenCreateFieldBody(name='别名字段', field_type='text')
        request = self._make_request()
        resp = open_create_field_impl(request, self.table.id, body)

        self.assertEqual(resp.status_code, 201)
        data = json.loads(resp.content)
        self.assertTrue(data['success'])

    def test_create_field_without_type_returns_400(self):
        from apps.tabdata.api_open import open_create_field_impl, OpenCreateFieldBody

        body = OpenCreateFieldBody(name='无类型字段')
        request = self._make_request()
        resp = open_create_field_impl(request, self.table.id, body)

        self.assertEqual(resp.status_code, 400)
        data = json.loads(resp.content)
        self.assertFalse(data['success'])

    # ── 2.4 DELETE 已删除字段返回 404 ────────────────────

    def test_delete_already_deleted_field_returns_404(self):
        from apps.tabdata.api_open import open_delete_field_impl

        victim = TableField.objects.using(_TD_DB).create(
            table=self.table, name='已删字段', field_type='text',
            order=100, is_deleted=True,
        )
        request = self._make_request(method='DELETE')
        resp = open_delete_field_impl(request, self.table.id, victim.id)

        self.assertEqual(resp.status_code, 404)
        data = json.loads(resp.content)
        self.assertFalse(data['success'])

    # ── 2.5 DELETE 主字段返回明确拒绝 ────────────────────

    def test_delete_primary_field_returns_400(self):
        from apps.tabdata.api_open import open_delete_field_impl

        request = self._make_request(method='DELETE')
        resp = open_delete_field_impl(request, self.table.id, self.primary_field.id)

        self.assertEqual(resp.status_code, 400)
        data = json.loads(resp.content)
        self.assertFalse(data['success'])
        self.assertEqual(data['code'], 'PRIMARY_FIELD_DELETE_DENIED')

    # ── 1.2 聚合 __count__ 不再返回 ?column? ────────────

    def test_build_aggregate_sql_count_uses_total_count_alias(self):
        from apps.tabdata.native.query_builder import NativeQueryBuilder

        fields = list(
            TableField.objects.using(_TD_DB).filter(
                table_id=self.table.id, is_deleted=False,
            )
        )
        qb = NativeQueryBuilder(self.space.id, self.table.id, fields)
        sql, params = qb.build_aggregate_sql({'__count__': 'count'})

        self.assertIn('total_count', sql)
        self.assertNotIn('?column?', sql)
        self.assertIn('COUNT(*)', sql)

    # ── 2.3 Webhook body space_id 可为 Optional ─────────

    def test_webhook_create_body_accepts_no_space_id(self):
        from apps.tabdata.api_open import WebhookCreateBody

        body = WebhookCreateBody(
            url='https://example.com/hook',
            events=['record.created'],
        )
        self.assertIsNone(body.space_id)

    def test_webhook_create_impl_rejects_missing_space_id(self):
        from apps.tabdata.api_open import create_webhook_impl, WebhookCreateBody

        body = WebhookCreateBody(
            url='https://example.com/hook',
            events=['record.created'],
        )
        request = self._make_request()
        resp = create_webhook_impl(request, body)

        self.assertEqual(resp.status_code, 400)
        data = json.loads(resp.content)
        self.assertIn('space_id', data.get('message', ''))


class RoundThreeFeatureTestCase(TestCase):
    """第三轮新功能测试：OpenAPI spec、一步建表、Rate Limit headers、Batch 结构化错误、Field Types。

    使用 RequestFactory + self.client 混合方式覆盖。
    """

    databases = {'default', 'postgresql'}

    def setUp(self):
        self.factory = RequestFactory()
        self.client = Client()
        self.user = User.objects.db_manager('default').create_user(
            username='r3_test_user',
            email='r3_test@example.com',
            password='testpass123',
        )

        self.organization = Organization.objects.create(
            name='R3 Organization',
            owner_id=str(self.user.id),
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(self.user.id),
            role='owner',
        )

        MembershipTier.objects.get_or_create(
            tier_type='free',
            defaults={
                'name': 'Free',
                'max_tables': -1,
                'max_records_per_table': -1,
                'max_api_calls_per_day': -1,
                'max_crawl_tasks_per_day': -1,
            },
        )

        self.space = Space.objects.create(
            organization=self.organization,
            name='R3测试库',
        )

        self.agent, _ = Agent.objects.get_or_create(
            organization=self.organization,
            user=self.user,
            defaults={'name': 'R3 Agent', 'type': 'human', 'is_active': True},
        )
        SpaceMembership.objects.update_or_create(
            workspace=self.space,
            agent=self.agent,
            defaults={'role': 'owner', 'is_active': True},
        )

        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.organization.id,
            name='R3测试表',
            owner_id=str(self.user.id),
        )

        self.field_name = TableField.objects.using(_TD_DB).create(
            table=self.table, name='姓名', field_type='text', order=0,
        )

        self._patchers = []
        for target in [
            'apps.tabdata.services.record_service.NativeRecordIO',
            'apps.tabdata.services.table_service.DDLManager',
        ]:
            p = patch(target, return_value=MagicMock())
            p.start()
            self._patchers.append(p)

        _, plain_token = TableApiToken.create_token(
            user=self.user,
            name='r3-full-token',
            scopes=list(VALID_SCOPES),
            space_ids=[str(self.space.id)],
            rate_limit=600,
        )
        self.auth_headers = {
            'HTTP_AUTHORIZATION': f'Bearer {plain_token}',
        }

    def tearDown(self):
        for p in self._patchers:
            p.stop()

    def _make_request(self, method='POST', path='/fake'):
        fn = getattr(self.factory, method.lower())
        request = fn(path)
        request.auth = self.user
        request.api_token = None
        return request

    # ── OpenAPI spec ──────────────────────────────────

    def test_openapi_spec_returns_valid_format(self):
        from apps.tabdata.api_open_space import _get_open_api_spec, _openapi_spec_cache
        import apps.tabdata.api_open_space as space_mod
        space_mod._openapi_spec_cache = None

        spec = _get_open_api_spec()

        self.assertIn('openapi', spec)
        self.assertIn('info', spec)
        self.assertIn('paths', spec)
        self.assertEqual(spec['info']['title'], 'TabTin Developer Open API')
        self.assertEqual(spec['info']['version'], '1.0.0')
        for path_key in spec['paths']:
            self.assertTrue(
                path_key.startswith('/api/open/v1/'),
                f"Unexpected path prefix: {path_key}",
            )
        space_mod._openapi_spec_cache = None

    def test_openapi_spec_endpoint_via_client(self):
        response = self.client.get(
            '/api/open/v1/openapi.json',
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn('openapi', data)
        self.assertIn('paths', data)

    # ── Field Types ───────────────────────────────────

    def test_field_types_returns_ui_creatable_types_only(self):
        response = self.client.get(
            '/api/open/v1/field-types',
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload['success'])
        field_types = payload['data']['field_types']
        self.assertEqual(len(field_types), 17)
        for ft_key, ft_val in field_types.items():
            self.assertIn('label', ft_val, f"Field type '{ft_key}' missing 'label'")
            self.assertIn('options_schema', ft_val, f"Field type '{ft_key}' missing 'options_schema'")
        for unavailable in ['nested_list', 'lookup', 'formula', 'rollup', 'datetime']:
            self.assertNotIn(unavailable, field_types)

    def test_field_types_contains_core_types(self):
        response = self.client.get(
            '/api/open/v1/field-types',
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 200)
        field_types = response.json()['data']['field_types']
        for expected in ['text', 'number', 'select', 'date', 'checkbox', 'url', 'attachment']:
            self.assertIn(expected, field_types, f"Missing core field type: {expected}")

    # ── 一步建表 + inline fields ──────────────────────

    def test_one_step_create_table_with_fields(self):
        response = self.client.post(
            f'/api/open/v1/spaces/{self.space.id}/data/tables',
            data=json.dumps({
                'name': '一步建表测试',
                'fields': [
                    {'name': '标题', 'field_type': 'text'},
                    {'name': '数量', 'field_type': 'number'},
                ],
            }),
            content_type='application/json',
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload['success'])
        data = payload['data']
        self.assertIn('fields', data)
        self.assertEqual(len(data['fields']), 2)
        field_names = {f['name'] for f in data['fields']}
        self.assertEqual(field_names, {'标题', '数量'})

    def test_one_step_create_table_without_fields(self):
        response = self.client.post(
            f'/api/open/v1/spaces/{self.space.id}/data/tables',
            data=json.dumps({
                'name': '无字段建表',
                'use_default_fields': True,
            }),
            content_type='application/json',
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload['success'])

    def test_one_step_create_table_field_failure_rolls_back(self):
        with patch('apps.tabdata.services.table_service.TableService.create_field', side_effect=Exception('模拟字段创建失败')):
            response = self.client.post(
                f'/api/open/v1/spaces/{self.space.id}/data/tables',
                data=json.dumps({
                    'name': '回滚测试表',
                    'fields': [
                        {'name': '会失败的字段', 'field_type': 'text'},
                    ],
                }),
                content_type='application/json',
                **self.auth_headers,
            )
        self.assertEqual(response.status_code, 400)
        payload = response.json()
        self.assertFalse(payload['success'])
        self.assertIn('回滚', payload.get('message', ''))

    # ── _structurize_batch_errors ─────────────────────

    def test_structurize_batch_errors_with_index(self):
        from apps.tabdata.api_open import _structurize_batch_errors

        errors = ['第1条: 字段缺失', '第3条：数据类型错误']
        result = _structurize_batch_errors(errors)

        self.assertEqual(len(result), 2)
        self.assertEqual(result[0], {'index': 0, 'message': '字段缺失'})
        self.assertEqual(result[1], {'index': 2, 'message': '数据类型错误'})

    def test_structurize_batch_errors_without_index(self):
        from apps.tabdata.api_open import _structurize_batch_errors

        errors = ['通用错误信息', '另一个错误']
        result = _structurize_batch_errors(errors)

        self.assertEqual(len(result), 2)
        self.assertEqual(result[0], {'index': -1, 'message': '通用错误信息'})
        self.assertEqual(result[1], {'index': -1, 'message': '另一个错误'})

    def test_structurize_batch_errors_mixed(self):
        from apps.tabdata.api_open import _structurize_batch_errors

        errors = ['第2条: 重复值', '未知错误', '第5条：格式不正确']
        result = _structurize_batch_errors(errors)

        self.assertEqual(len(result), 3)
        self.assertEqual(result[0], {'index': 1, 'message': '重复值'})
        self.assertEqual(result[1], {'index': -1, 'message': '未知错误'})
        self.assertEqual(result[2], {'index': 4, 'message': '格式不正确'})

    def test_structurize_batch_errors_empty(self):
        from apps.tabdata.api_open import _structurize_batch_errors

        result = _structurize_batch_errors([])
        self.assertEqual(result, [])

    # ── Rate Limit Headers ────────────────────────────

    def test_rate_limit_headers_in_successful_response(self):
        from apps.tabdata.api_helpers import _maybe_inject_rate_limit_headers
        from django.http import JsonResponse

        request = self._make_request('GET')
        request._rate_limit_info = {'limit': 600, 'remaining': 599, 'reset': 1700000000}

        response = JsonResponse({'success': True}, status=200)
        result = _maybe_inject_rate_limit_headers(request, response)

        self.assertEqual(result['X-RateLimit-Limit'], '600')
        self.assertEqual(result['X-RateLimit-Remaining'], '599')
        self.assertEqual(result['X-RateLimit-Reset'], '1700000000')

    def test_rate_limit_headers_not_injected_without_info(self):
        from apps.tabdata.api_helpers import _maybe_inject_rate_limit_headers
        from django.http import JsonResponse

        request = self._make_request('GET')
        response = JsonResponse({'success': True}, status=200)
        result = _maybe_inject_rate_limit_headers(request, response)

        self.assertNotIn('X-RateLimit-Limit', dict(result.items()))

    def test_rate_limit_headers_in_real_endpoint(self):
        rate_info = {'limit': 600, 'remaining': 598, 'reset': 1700000099}
        with patch(
            'apps.tabdata.auth_open_api._check_rate_limit',
            return_value=(None, rate_info),
        ):
            response = self.client.get(
                f'/api/open/v1/spaces/{self.space.id}/data/tables',
                **self.auth_headers,
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get('X-RateLimit-Limit'), '600')
        self.assertEqual(response.get('X-RateLimit-Remaining'), '598')

    # ── InlineFieldDefinition Schema 统一 ─────────────

    def test_inline_field_definition_is_same_class_in_both_modules(self):
        from apps.tabdata.api_open import InlineFieldDefinition as FromOpen
        from apps.tabdata.api_open_space import InlineFieldDefinition as FromSpace

        self.assertIs(FromOpen, FromSpace)
