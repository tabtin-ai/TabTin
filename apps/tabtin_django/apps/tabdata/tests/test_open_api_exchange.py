import base64
import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import Client, TestCase

from apps.tabdata.models import Table, TableField
from apps.tabdata.models_token import TableApiToken
from apps.tabtinspace.models import (
    Agent,
    Space,
    SpaceMembership,
    Organization,
    OrganizationMember,
)
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': 'Open API exchange tests bootstrap tier',
            'max_tables': -1,
            'max_records_per_table': -1,
            'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1,
            'features': {},
            'sort_order': 0,
            'is_active': True,
        },
    )


class OpenApiExchangeTestCase(TestCase):
    databases = {'default', 'postgresql'}

    def setUp(self):
        _ensure_free_tier()
        self.client = Client()
        self.user = User.objects.db_manager('default').create_user(
            username='open_api_exchange_user',
            email='open_api_exchange_user@example.com',
            password='testpass123',
        )
        self.organization = Organization.objects.create(
            name='Open API Exchange Organization',
            owner_id=str(self.user.id),
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(self.user.id),
            role='owner',
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name='Open API Exchange Space',
        )
        self.agent, _ = Agent.objects.get_or_create(
            organization=self.organization,
            user=self.user,
            defaults={
                'name': 'Open API Exchange Agent',
                'type': 'human',
                'is_active': True,
            },
        )
        SpaceMembership.objects.update_or_create(
            workspace=self.space,
            agent=self.agent,
            defaults={
                'role': 'owner',
                'is_active': True,
            },
        )
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.organization.id,
            name='Open API Exchange Table',
            owner_id=str(self.user.id),
        )
        self.primary_field = TableField.objects.create(
            table=self.table,
            name='标题',
            field_type='text',
            is_primary=True,
            order=0,
        )
        _, plain_token = TableApiToken.create_token(
            user=self.user,
            name='open-api-exchange-token',
            scopes=['import:write', 'export:read'],
            table_ids=[str(self.table.id)],
            rate_limit=600,
        )
        self.auth_headers = {
            'HTTP_AUTHORIZATION': f'Bearer {plain_token}',
        }

    def test_import_json_is_available_via_open_api_token(self):
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/import/json'
        payload = {
            'json_content': json.dumps([{'标题': '来自 Open API 的记录'}], ensure_ascii=False),
            'update_existing': True,
            'primary_key_field': '标题',
            'auto_create_missing_fields': False,
        }

        with patch(
            'apps.tabdata.api_open_impl.exchange_impl.ImportService.import_from_json',
            return_value=(1, 1, []),
        ) as mock_import:
            response = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                **self.auth_headers,
            )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()['data']
        self.assertEqual(response_data['created_count'], 1)
        self.assertEqual(response_data['updated_count'], 1)
        self.assertEqual(response_data['skipped_count'], 0)
        self.assertEqual(response_data['errors'], [])
        mock_import.assert_called_once_with(
            table_id=self.table.id,
            json_content=payload['json_content'],
            skip_errors=False,
            update_existing=True,
            primary_key_field='标题',
            auto_create_missing_fields=False,
        )

    def test_import_csv_is_available_via_open_api_token(self):
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/import/csv'
        payload = {
            'csv_content': '标题\nCSV 导入\n',
            'skip_errors': True,
        }

        with patch(
            'apps.tabdata.api_open_impl.exchange_impl.ImportService.import_from_csv',
            return_value=(1, 0, []),
        ) as mock_import:
            response = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                **self.auth_headers,
            )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()['data']
        self.assertEqual(response_data['created_count'], 1)
        self.assertEqual(response_data['updated_count'], 0)
        mock_import.assert_called_once_with(
            table_id=self.table.id,
            file_content='标题\nCSV 导入\n',
            skip_errors=True,
            update_existing=False,
            primary_key_field=None,
            auto_create_missing_fields=True,
        )

    def test_import_preview_is_available_via_open_api_token(self):
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/import/preview'
        payload = {
            'file_type': 'csv',
            'file_content': '标题,状态\n预览记录,处理中\n',
            'preview_rows': 5,
        }
        preview_result = {
            'preview_data': [{'标题': '预览记录', '状态': '处理中'}],
            'field_mapping': [
                {
                    'source': '标题',
                    'target': str(self.primary_field.id),
                    'target_name': '标题',
                    'confidence': 1.0,
                    'inferred_type': 'text',
                }
            ],
            'validation_issues': [],
            'stats': {
                'total_rows': 1,
                'preview_rows': 1,
                'field_count': 2,
                'total_validation_issues': 0,
            },
        }

        with patch(
            'apps.tabdata.api_open_impl.exchange_impl.ImportService.preview_import',
            return_value=preview_result,
        ) as mock_preview:
            response = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                **self.auth_headers,
            )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()['data']
        self.assertEqual(response_data['stats']['total_rows'], 1)
        self.assertEqual(response_data['preview_data'][0]['标题'], '预览记录')
        mock_preview.assert_called_once_with(
            table_id=self.table.id,
            file_content=payload['file_content'],
            file_type='csv',
            preview_rows=5,
            sheet_name=None,
        )

    def test_import_excel_preview_is_available_via_open_api_token(self):
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/import/preview'
        file_bytes = b'fake-excel-preview'
        payload = {
            'file_type': 'excel',
            'file_base64': base64.b64encode(file_bytes).decode('ascii'),
            'sheet_name': 'Orders',
            'preview_rows': 8,
        }
        preview_result = {
            'preview_data': [{'标题': 'Excel 预览'}],
            'field_mapping': [],
            'validation_issues': [],
            'stats': {
                'total_rows': 1,
                'preview_rows': 1,
                'field_count': 1,
                'total_validation_issues': 0,
            },
        }

        with patch(
            'apps.tabdata.api_open_impl.exchange_impl.ImportService.preview_import',
            return_value=preview_result,
        ) as mock_preview:
            response = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                **self.auth_headers,
            )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()['data']
        self.assertEqual(response_data['preview_data'][0]['标题'], 'Excel 预览')
        mock_preview.assert_called_once_with(
            table_id=self.table.id,
            file_content=file_bytes,
            file_type='excel',
            preview_rows=8,
            sheet_name='Orders',
        )

    def test_import_excel_is_available_via_open_api_token(self):
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/import/excel'
        file_bytes = b'fake-excel-binary'
        payload = {
            'file_base64': base64.b64encode(file_bytes).decode('ascii'),
            'update_existing': True,
            'primary_key_field': '标题',
            'sheet_name': 'Orders',
            'auto_create_missing_fields': False,
        }

        with patch(
            'apps.tabdata.api_open_impl.exchange_impl.ImportService.import_from_excel',
            return_value=(2, 1, []),
        ) as mock_import:
            response = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                **self.auth_headers,
            )

        self.assertEqual(response.status_code, 200)
        response_data = response.json()['data']
        self.assertEqual(response_data['created_count'], 2)
        self.assertEqual(response_data['updated_count'], 1)
        mock_import.assert_called_once_with(
            table_id=self.table.id,
            file_bytes=file_bytes,
            skip_errors=False,
            update_existing=True,
            primary_key_field='标题',
            sheet_name='Orders',
            auto_create_missing_fields=False,
        )

    def test_import_template_impl(self):
        from apps.tabdata.api_open import get_open_import_template
        from django.test import RequestFactory

        factory = RequestFactory()
        request = factory.get('/fake')
        request.auth = self.user
        request.api_token = None
        template = '标题,状态\r\n'

        with patch(
            'apps.tabdata.api_open_impl.exchange_impl.ImportService.get_import_template',
            return_value=template,
        ) as mock_template:
            response = get_open_import_template(request, self.table.id)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response['Content-Disposition'],
            f'attachment; filename="import_template_{self.table.id}.csv"',
        )
        self.assertEqual(response.content.decode('utf-8'), template)
        mock_template.assert_called_once_with(self.table.id)

    def test_export_json_streaming_is_available_via_open_api_token(self):
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/export/json'
        payload = {
            'format_type': 'array',
        }

        with patch(
            'apps.tabdata.api_open_impl.exchange_impl.ExportService.export_to_json_streaming',
            return_value=iter(['[', '{"标题":"已导出"}', ']']),
        ) as mock_export:
            response = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                **self.auth_headers,
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response['Content-Disposition'],
            f'attachment; filename="export_{self.table.id}.json"',
        )
        self.assertEqual(
            b''.join(response.streaming_content).decode('utf-8'),
            '[{"标题":"已导出"}]',
        )
        mock_export.assert_called_once_with(
            table_id=self.table.id,
            field_ids=None,
            record_ids=None,
            view_id=None,
        )

    def test_export_excel_is_available_via_open_api_token(self):
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/export/excel'
        payload = {
            'include_headers': False,
            'sheet_name': 'Orders',
        }
        excel_bytes = b'fake-excel'

        with patch(
            'apps.tabdata.api_open_impl.exchange_impl.ExportService.export_to_excel',
            return_value=excel_bytes,
        ) as mock_export:
            response = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                **self.auth_headers,
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response['Content-Disposition'],
            f'attachment; filename="export_{self.table.id}.xlsx"',
        )
        self.assertEqual(response.content, excel_bytes)
        mock_export.assert_called_once_with(
            table_id=self.table.id,
            field_ids=None,
            record_ids=None,
            view_id=None,
            include_headers=False,
            sheet_name='Orders',
        )

    def test_export_pdf_impl(self):
        from apps.tabdata.api_open import export_table_to_pdf
        from apps.tabdata.api_open_schemas import OpenExportPDFBody
        from django.test import RequestFactory

        factory = RequestFactory()
        request = factory.post('/fake')
        request.auth = self.user
        request.api_token = None
        pdf_bytes = b'%PDF-1.7'

        body = OpenExportPDFBody(orientation='portrait', title='Orders Snapshot')

        with patch(
            'apps.tabdata.api_open_impl.exchange_impl.ExportService.export_to_pdf',
            return_value=pdf_bytes,
        ) as mock_export:
            response = export_table_to_pdf(request, self.table.id, body)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response['Content-Disposition'],
            f'attachment; filename="export_{self.table.id}.pdf"',
        )
        self.assertEqual(response.content, pdf_bytes)
        mock_export.assert_called_once_with(
            table_id=self.table.id,
            field_ids=None,
            record_ids=None,
            view_id=None,
            orientation='portrait',
            title='Orders Snapshot',
        )

    def test_developer_contract_build_function(self):
        from apps.tabdata.api_open import _build_table_developer_contract

        payload = _build_table_developer_contract(self.table.id, self.table.name, space_id=self.space.id)

        self.assertEqual(payload['table_id'], str(self.table.id))
        self.assertEqual(payload['table_name'], self.table.name)
        self.assertEqual(payload['auth']['api_token_prefix'], 'ttn_')
        self.assertEqual(payload['error_envelope']['canonical_code_field'], 'code')
        self.assertEqual(payload['error_envelope']['legacy_code_field'], 'error_code')
        self.assertTrue(
            any(
                item['code'] == 'RATE_LIMIT_EXCEEDED'
                for item in payload['error_codes']
            )
        )
        self.assertTrue(
            any(
                item['path'].endswith('/records/upsert')
                for item in payload['endpoint_catalog']['records']
            )
        )
        self.assertTrue(
            any(
                item['operation_id'] == 'upsertRecords' and item['group'] == 'records'
                for item in payload['endpoint_catalog']['records']
            )
        )

    def test_openapi_spec_build_function(self):
        from apps.tabdata.api_open import _build_table_openapi_spec

        payload = _build_table_openapi_spec(self.table.id, self.table.name, space_id=self.space.id)

        self.assertEqual(payload['openapi'], '3.1.0')
        self.assertEqual(payload['info']['title'], f'TabData Open API · {self.table.name}')
        self.assertEqual(payload['x-tabtin-table-id'], str(self.table.id))
        self.assertIn('/tables/{table_id}/records/upsert', payload['paths'])
        self.assertEqual(
            payload['paths']['/tables/{table_id}/records/upsert']['post']['operationId'],
            'upsertRecords',
        )
        self.assertEqual(
            payload['paths']['/tables/{table_id}/records/upsert']['post']['tags'],
            ['records'],
        )
        self.assertEqual(
            payload['paths']['/tables/{table_id}/records/upsert']['post']['x-tabtin-required-scopes'],
            ['record:create'],
        )

    def test_insufficient_scope_uses_canonical_code_field(self):
        _, export_only_token = TableApiToken.create_token(
            user=self.user,
            name='export-only',
            scopes=['export:read'],
            table_ids=[str(self.table.id)],
            rate_limit=600,
        )
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/import/json'

        response = self.client.post(
            url,
            data=json.dumps({'json_content': '[]'}),
            content_type='application/json',
            HTTP_AUTHORIZATION=f'Bearer {export_only_token}',
        )

        self.assertEqual(response.status_code, 403)
        payload = response.json()
        self.assertEqual(payload['code'], 'INSUFFICIENT_SCOPE')
        self.assertEqual(payload['error_code'], 'INSUFFICIENT_SCOPE')
        self.assertEqual(payload['required_scopes'], ['import:write'])

    def test_rate_limit_error_keeps_code_and_error_code(self):
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/export/json'

        with patch(
            'apps.tabdata.auth_open_api._check_rate_limit',
            return_value=(
                {
                    'success': False,
                    'code': 'RATE_LIMIT_EXCEEDED',
                    'error_code': 'RATE_LIMIT_EXCEEDED',
                    'message': '请求频率超限（1 次/分钟），请稍后重试',
                    'retry_after': 12,
                },
                {'limit': 1, 'remaining': 0, 'reset': 12},
            ),
        ):
            response = self.client.post(
                url,
                data=json.dumps({'format_type': 'array'}),
                content_type='application/json',
                **self.auth_headers,
            )

        self.assertEqual(response.status_code, 429)
        self.assertEqual(response['Retry-After'], '12')
        payload = response.json()
        self.assertEqual(payload['code'], 'RATE_LIMIT_EXCEEDED')
        self.assertEqual(payload['error_code'], 'RATE_LIMIT_EXCEEDED')
