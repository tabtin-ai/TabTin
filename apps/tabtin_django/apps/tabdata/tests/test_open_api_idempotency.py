import json
import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import OperationalError
from django.test import Client, TestCase

from apps.tabdata.models import Table, TableField
from apps.tabdata.models_token import TableApiToken
from apps.tabtinspace.models import Organization, OrganizationMember, Project, ProjectMembership
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': 'Open API 幂等测试自动初始化',
            'max_tables': -1,
            'max_records_per_table': -1,
            'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1,
            'features': {},
            'sort_order': 0,
            'is_active': True,
        }
    )


class OpenApiIdempotencyTestCase(TestCase):
    databases = {'default', 'postgresql'}

    def setUp(self):
        cache.clear()
        _ensure_free_tier()
        self.client = Client()
        self.user = User.objects.db_manager('default').create_user(
            username='open_api_idem_user',
            email='open_api_idem_user@example.com',
            password='testpass123',
        )
        self.organization = Organization.objects.create(
            name='Open API Idempotency Organization',
            owner_id=str(self.user.id),
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=str(self.user.id),
            role='owner',
        )
        self.space = Project.objects.create(
            organization=self.organization,
            name='Open API Idempotency Space',
        )
        ProjectMembership.objects.create(
            project=self.space,
            user=self.user,
            role='owner',
        )
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.organization.id,
            name='Open API Idempotency Table',
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
            name='idempotency-test-token',
            scopes=['record:create', 'record:delete'],
            space_ids=[str(self.space.id)],
            table_ids=[str(self.table.id)],
            rate_limit=600,
        )
        self.auth_headers = {
            'HTTP_AUTHORIZATION': f'Bearer {plain_token}',
        }

    def test_batch_create_replays_cached_response_without_duplicate_records(self):
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/records/batch-create'
        idem_key = f'chg_test_{uuid.uuid4()}'
        payload = {
            'records': [
                {
                    'fields': {
                        str(self.primary_field.id): '只创建一次',
                    }
                }
            ],
            'field_key_type': 'id',
        }
        with patch(
            'apps.tabdata.api_open_impl.record_impl.RecordService.bulk_create_records',
            return_value=([object()], []),
        ) as mock_bulk_create:
            response1 = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                HTTP_IDEMPOTENCY_KEY=idem_key,
                **self.auth_headers,
            )
            response2 = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                HTTP_IDEMPOTENCY_KEY=idem_key,
                **self.auth_headers,
            )

        self.assertEqual(response1.status_code, 201)
        self.assertEqual(response2.status_code, 201)
        self.assertEqual(response1.json()['data']['created_count'], 1)
        self.assertEqual(response2.json()['data']['created_count'], 1)
        self.assertEqual(response2['X-Idempotent-Replayed'], 'true')
        self.assertEqual(mock_bulk_create.call_count, 1)

    def test_batch_delete_replays_cached_response_without_duplicate_service_calls(self):
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/records/batch-delete'
        idem_key = f'chg_test_{uuid.uuid4()}'
        payload = {
            'record_ids': [str(uuid.uuid4())],
        }
        with patch(
            'apps.tabdata.api_open_impl.record_impl.RecordService.bulk_delete_records',
            return_value=(1, [], ['rid-1'], []),
        ) as mock_bulk_delete:
            response1 = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                HTTP_IDEMPOTENCY_KEY=idem_key,
                **self.auth_headers,
            )
            response2 = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                HTTP_IDEMPOTENCY_KEY=idem_key,
                **self.auth_headers,
            )

        self.assertEqual(response1.status_code, 200)
        self.assertEqual(response2.status_code, 200)
        self.assertEqual(response1.json()['data']['deleted_count'], 1)
        self.assertEqual(response2.json()['data']['deleted_count'], 1)
        self.assertEqual(response2['X-Idempotent-Replayed'], 'true')
        self.assertEqual(mock_bulk_delete.call_count, 1)

    def test_batch_delete_does_not_cache_retryable_service_unavailable_response(self):
        url = f'/api/open/v1/spaces/{self.space.id}/data/tables/{self.table.id}/records/batch-delete'
        idem_key = f'chg_test_{uuid.uuid4()}'
        payload = {
            'record_ids': [str(uuid.uuid4())],
        }
        db_cause = RuntimeError('canceling statement due to lock timeout')
        db_cause.pgcode = '55P03'
        lock_error = OperationalError('table lock unavailable')
        lock_error.__cause__ = db_cause

        with patch(
            'apps.tabdata.api_open_impl.record_impl.RecordService.bulk_delete_records',
            side_effect=[lock_error, (1, [], ['rid-1'], [])],
        ) as mock_bulk_delete:
            response1 = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                HTTP_IDEMPOTENCY_KEY=idem_key,
                **self.auth_headers,
            )
            response2 = self.client.post(
                url,
                data=json.dumps(payload),
                content_type='application/json',
                HTTP_IDEMPOTENCY_KEY=idem_key,
                **self.auth_headers,
            )

        self.assertEqual(response1.status_code, 503)
        self.assertEqual(response1.json()['code'], 'SAVE_BUSY')
        self.assertEqual(response2.status_code, 200)
        self.assertEqual(response2.json()['data']['deleted_count'], 1)
        self.assertIsNone(response2.get('X-Idempotent-Replayed'))
        self.assertEqual(mock_bulk_delete.call_count, 2)
