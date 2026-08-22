"""POST /records/bulk-update 的 base_snapshot advisory 冲突契约回归。

桌面端 grid 与移动端原生 TabData 都依赖这条通道做并发写入：写入永不被拒，
仅在响应里附带字段级冲突提示。这里锁住三条关键语义：

1. 冲突是 advisory 的——报告冲突时数据仍然落库；
2. `base_snapshot` 的 key 必须是 field id，用 field name 会误报（见 ）；
3. 只有同时出现在 `data` 与 `base_snapshot` 里的字段才参与比对。
"""
from __future__ import annotations

import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.services.record_service import RecordService
from apps.tabtinspace.models import Organization, OrganizationMember

User = get_user_model()


class BulkUpdateConflictContractTests(TestCase):
    """真实 ORM + native PG 投影，覆盖 base_snapshot 冲突检测契约。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="bulk-conflict-owner@example.com",
            password="test-password",
            nickname="bulk-conflict-owner",
        )
        self.organization = Organization.objects.create(
            name="Bulk update conflict contract",
            owner=self.user,
        )
        OrganizationMember.objects.get_or_create(
            organization=self.organization,
            user=self.user,
            defaults={"role": "owner"},
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            name="Concurrent records",
            owner=self.user,
        )
        self.title_field = TableField.objects.create(
            table=self.table,
            name="标题",
            field_type="text",
            is_primary=True,
            order=0,
        )
        self.note_field = TableField.objects.create(
            table=self.table,
            name="备注",
            field_type="text",
            order=1,
        )
        ddl = DDLManager(db_alias=TABDATA_DB_ALIAS)
        ddl.ensure_schema(self.organization.id)
        ddl.create_native_table(self.organization.id, self.table.id)
        for field in (self.title_field, self.note_field):
            ddl.add_column(
                self.organization.id,
                self.table.id,
                field.id,
                field.field_type,
                field.config,
            )

        with patch.object(RecordService, "_check_record_quota"):
            self.record, error = RecordService(user=self.user).create_record(
                self.table.id,
                {"标题": "原标题", "备注": "原备注"},
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

    @property
    def title_key(self) -> str:
        return str(self.title_field.id)

    @property
    def note_key(self) -> str:
        return str(self.note_field.id)

    def _bulk_update(self, *, data: dict, base_snapshot: dict | None = None):
        item: dict = {"record_id": str(self.record.id), "data": data}
        if base_snapshot is not None:
            item["base_snapshot"] = base_snapshot
        return self.client.post(
            "/api/tabdata/records/bulk-update?field_key_type=id",
            data=json.dumps({"updates": [item]}),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer bulk-conflict-test",
        )

    def _stored_value(self, field: TableField) -> object:
        record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=self.record.id)
        return record.data.get(str(field.id))

    def test_no_expected_version_needed_and_write_succeeds(self):
        """不带 expected_version 也能写入——这是桌面端一直在走的路径。"""
        response = self._bulk_update(data={self.title_key: "新标题"})

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["success_count"], 1)
        self.assertEqual(body["data"]["conflicts"], [])
        self.assertEqual(self._stored_value(self.title_field), "新标题")

    def test_matching_snapshot_reports_no_conflict(self):
        """快照与服务端现值一致：无冲突。"""
        response = self._bulk_update(
            data={self.title_key: "新标题"},
            base_snapshot={self.title_key: "原标题"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["conflicts"], [])
        self.assertEqual(self._stored_value(self.title_field), "新标题")

    def test_stale_snapshot_reports_conflict_but_still_writes(self):
        """他人已改过该字段：报告冲突，但写入照常成功（advisory 语义）。

        这条是移动端去掉 CAS 的前提——不能因为有冲突就拒绝写入。
        """
        response = self._bulk_update(
            data={self.title_key: "我的新值"},
            base_snapshot={self.title_key: "我以为的旧值"},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        conflicts = body["data"]["conflicts"]
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["record_id"], str(self.record.id))
        self.assertEqual(conflicts[0]["field_id"], self.title_key)
        self.assertEqual(conflicts[0]["your_value"], "我的新值")
        self.assertEqual(conflicts[0]["server_value"], "原标题")
        self.assertEqual(body["data"]["success_count"], 1)
        self.assertEqual(self._stored_value(self.title_field), "我的新值")

    def test_only_fields_present_in_data_participate_in_comparison(self):
        """快照里有、但本次没提交的字段不参与比对，不会产生噪声冲突。"""
        response = self._bulk_update(
            data={self.title_key: "新标题"},
            base_snapshot={
                self.title_key: "原标题",
                self.note_key: "我以为的旧备注",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["conflicts"], [])

    def test_field_name_keyed_snapshot_falsely_reports_conflict(self):
        """用 field name 作为 key 会误报冲突——移动端必须转成 field id。

        冲突检测读的是原始请求 data 与存储态 pre_data，而 pre_data 的 key 恒为
        field id，所以 name key 取不到值，恒与快照不等。写入本身仍然正确
        （写入路径会做 key 归一化），只有冲突提示是假的。见 。
        """
        response = self._bulk_update(
            data={"标题": "新标题"},
            base_snapshot={"标题": "原标题"},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        conflicts = body["data"]["conflicts"]
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["field_id"], "标题")
        self.assertIsNone(conflicts[0]["server_value"])
        # 写入路径做了 key 归一化，所以数据本身是对的，假的只是冲突提示。
        self.assertEqual(self._stored_value(self.title_field), "新标题")
