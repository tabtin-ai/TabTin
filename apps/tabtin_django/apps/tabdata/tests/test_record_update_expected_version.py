"""PUT /records/{id} 可选 expected_version 的 PostgreSQL 契约回归。"""
from __future__ import annotations

import copy
import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.native.record_io import NativeRecordIO
from apps.tabdata.services.record_service import RecordService
from apps.tabtinspace.models import Organization, OrganizationMember

User = get_user_model()


class RecordUpdateExpectedVersionTests(TestCase):
    """真实 ORM + native PG 投影，覆盖旧请求与 CAS 更新契约。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="record-version-owner@example.com",
            password="test-password",
            nickname="record-version-owner",
        )
        self.organization = Organization.objects.create(
            name="Record version contract",
            owner=self.user,
        )
        OrganizationMember.objects.get_or_create(
            organization=self.organization,
            user=self.user,
            defaults={"role": "owner"},
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            name="Versioned records",
            owner=self.user,
        )
        self.title_field = TableField.objects.create(
            table=self.table,
            name="标题",
            field_type="text",
            is_primary=True,
            order=0,
        )
        self.status_field = TableField.objects.create(
            table=self.table,
            name="状态",
            field_type="select",
            order=1,
            config={
                "choices": [
                    {
                        "value": "待办",
                        "label": "待办",
                        "color": "#3B82F6",
                    },
                ],
            },
        )
        ddl = DDLManager(db_alias=TABDATA_DB_ALIAS)
        ddl.ensure_schema(self.organization.id)
        ddl.create_native_table(self.organization.id, self.table.id)
        ddl.add_column(
            self.organization.id,
            self.table.id,
            self.title_field.id,
            self.title_field.field_type,
            self.title_field.config,
        )
        ddl.add_column(
            self.organization.id,
            self.table.id,
            self.status_field.id,
            self.status_field.field_type,
            self.status_field.config,
        )
        self.native_io = NativeRecordIO(
            self.organization.id,
            self.table.id,
            db_alias=TABDATA_DB_ALIAS,
        )
        with patch.object(RecordService, "_check_record_quota"):
            self.record, error = RecordService(user=self.user).create_record(
                self.table.id,
                {"标题": "before", "状态": "待办"},
            )
        self.assertIsNone(error)
        self.assertIsNotNone(self.record)

        self.auth_patcher = patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=self.user,
        )
        self.auth_patcher.start()
        self.addCleanup(self.auth_patcher.stop)
        self.invite_patcher = patch(
            "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
            return_value=True,
        )
        self.invite_patcher.start()
        self.addCleanup(self.invite_patcher.stop)

    def _put(self, payload: dict):
        return self.client.put(
            f"/api/tabdata/records/{self.record.id}",
            data=json.dumps(payload),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer expected-version-test",
        )

    def _assert_persisted(self, *, title: str, version: int) -> None:
        record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=self.record.id)
        native_row = self.native_io.read_single(
            self.record.id,
            field_ids=[str(self.title_field.id)],
        )
        self.assertEqual(record.data[str(self.title_field.id)], title)
        self.assertEqual(record.version, version)
        self.assertEqual(native_row[self.title_field.id.hex], title)
        self.assertEqual(native_row["__version"], version)

    def test_legacy_request_without_expected_version_still_succeeds(self):
        response = self._put({"data": {"标题": "legacy update"}})

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["data"]["标题"], "legacy update")
        self.assertGreater(body["data"]["version"], self.record.version)
        self._assert_persisted(
            title="legacy update",
            version=body["data"]["version"],
        )

    def test_matching_expected_version_succeeds(self):
        response = self._put({
            "data": {"标题": "matched update", "状态": "进行中"},
            "expected_version": self.record.version,
        })

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["data"]["标题"], "matched update")
        self.assertGreater(body["data"]["version"], self.record.version)
        self._assert_persisted(
            title="matched update",
            version=body["data"]["version"],
        )
        self.status_field.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(
            [choice["value"] for choice in self.status_field.config["choices"]],
            ["待办", "进行中"],
        )

    def test_stale_expected_version_returns_409_without_writing(self):
        original_version = self.record.version
        self.table.refresh_from_db(using=TABDATA_DB_ALIAS)
        original_table_version = self.table.record_version_seq

        response = self._put({
            "data": {"标题": "must not persist"},
            "expected_version": original_version - 1,
        })

        self.assertEqual(response.status_code, 409)
        body = response.json()
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "VERSION_CONFLICT")
        self.assertEqual(
            body["data"],
            {"retryable": False, "refresh_required": True},
        )
        self._assert_persisted(title="before", version=original_version)
        self.table.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(self.table.record_version_seq, original_table_version)

    def test_stale_select_update_does_not_pollute_field_choices(self):
        original_config = copy.deepcopy(self.status_field.config)

        response = self._put({
            "data": {"状态": "不得写入的选项"},
            "expected_version": self.record.version - 1,
        })

        self.assertEqual(response.status_code, 409)
        self.status_field.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertEqual(self.status_field.config, original_config)
        record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=self.record.id)
        self.assertEqual(record.data[str(self.status_field.id)], "待办")
        native_row = self.native_io.read_single(
            self.record.id,
            field_ids=[str(self.status_field.id)],
        )
        self.assertEqual(native_row[self.status_field.id.hex], "待办")
