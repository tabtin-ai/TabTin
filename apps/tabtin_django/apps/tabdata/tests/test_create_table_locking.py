"""建表组织锁的 PostgreSQL 并发回归测试。"""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.db import OperationalError, close_old_connections, connections, transaction
from django.test import TransactionTestCase

from apps.services.billing.models import OrganizationStorageUsage
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.services.table_service import TableService
from apps.tabtinspace.models import Organization, OrganizationMember

User = get_user_model()


class CreateTableOrganizationLockTests(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            username="create-table-lock-user",
            email="create-table-lock@example.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Create table lock organization",
            owner=self.user,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.user,
            role="owner",
        )

    def test_open_table_creation_does_not_block_organization_fk_insert(self):
        """长事务导入建表期间，附件计费外键写入不应被阻塞。"""
        table_created = Event()
        release_table_transaction = Event()

        def create_table_in_open_transaction():
            close_old_connections()
            try:
                user = User.objects.get(pk=self.user.pk)
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    table = TableService(user=user).create_table(
                        organization_id=self.organization.pk,
                        name="Imported table",
                        use_default_fields=False,
                    )
                    table_created.set()
                    if not release_table_transaction.wait(timeout=10):
                        raise TimeoutError("table transaction was not released")
                return table.pk
            finally:
                close_old_connections()

        def create_storage_usage():
            close_old_connections()
            try:
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    with connections[TABDATA_DB_ALIAS].cursor() as cursor:
                        cursor.execute("SET LOCAL lock_timeout = '1s'")
                    usage = OrganizationStorageUsage.objects.using(TABDATA_DB_ALIAS).create(
                        organization_id=self.organization.pk,
                    )
                return usage.pk
            finally:
                close_old_connections()

        with (
            patch(
                "apps.tabdata.services.table_service.QuotaService",
                MagicMock(return_value=MagicMock(check_quota=MagicMock())),
            ),
            patch.object(TableService, "_native_ensure_table", return_value=None),
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            table_future = executor.submit(create_table_in_open_transaction)
            self.assertTrue(table_created.wait(timeout=10))
            storage_future = executor.submit(create_storage_usage)
            try:
                storage_usage_id = storage_future.result(timeout=5)
            finally:
                release_table_transaction.set()
            table_id = table_future.result(timeout=10)

        self.assertIsNotNone(table_id)
        self.assertTrue(
            OrganizationStorageUsage.objects.filter(pk=storage_usage_id).exists()
        )

    def test_open_table_creation_still_serializes_another_table_creation(self):
        first_table_created = Event()
        release_first_transaction = Event()

        def create_first_table():
            close_old_connections()
            try:
                user = User.objects.get(pk=self.user.pk)
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    table = TableService(user=user).create_table(
                        organization_id=self.organization.pk,
                        name="First imported table",
                        use_default_fields=False,
                    )
                    first_table_created.set()
                    if not release_first_transaction.wait(timeout=10):
                        raise TimeoutError("first table transaction was not released")
                return table.pk
            finally:
                close_old_connections()

        def create_second_table():
            close_old_connections()
            try:
                user = User.objects.get(pk=self.user.pk)
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    with connections[TABDATA_DB_ALIAS].cursor() as cursor:
                        cursor.execute("SET LOCAL lock_timeout = '1s'")
                    return TableService(user=user).create_table(
                        organization_id=self.organization.pk,
                        name="Concurrent imported table",
                        use_default_fields=False,
                    )
            finally:
                close_old_connections()

        with (
            patch(
                "apps.tabdata.services.table_service.QuotaService",
                MagicMock(return_value=MagicMock(check_quota=MagicMock())),
            ),
            patch.object(TableService, "_native_ensure_table", return_value=None),
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            first_future = executor.submit(create_first_table)
            self.assertTrue(first_table_created.wait(timeout=10))
            second_future = executor.submit(create_second_table)
            try:
                with self.assertRaises(OperationalError) as raised:
                    second_future.result(timeout=5)
            finally:
                release_first_transaction.set()
            first_table_id = first_future.result(timeout=10)

        self.assertIsNotNone(first_table_id)
        self.assertIn("lock timeout", str(raised.exception))
