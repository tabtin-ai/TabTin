"""分期 runner：mock TabData 服务，验证 Link 回填与附件开关路径。"""

from __future__ import annotations

import json
import uuid
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from apps.integrations_feishu.client import FeishuAPIError, FeishuAuthError
from apps.integrations_feishu.import_runner import (
    _phase_a_import_table,
    _phase_c_fill_links,
    run_feishu_import,
)
from apps.integrations_feishu.models import (
    FeishuImportJob,
    FeishuOAuthConnection,
    FeishuOAuthProvider,
)
from apps.tabdata.models import LinkRecord, Table, TableField, TableRecord
from apps.tabdata.native.ddl_manager import DDLManager, _ENSURED_SCHEMAS
from apps.tabdata.native.record_io import NativeRecordIO
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.utils.record_data_access import read_data_fresh
from apps.tabtinspace.models import Organization, OrganizationMember

User = get_user_model()


class FakeFeishuClient:
    def __init__(self, *args, **kwargs):
        pass

    def get_valid_access_token(self, connection, *, force_refresh=False):
        return "refreshed-token" if force_refresh else "token"

    def list_tables(self, access_token, app_token):
        return [
            {"table_id": "tblA", "name": "订单"},
            {"table_id": "tblB", "name": "客户"},
        ]

    def list_fields(self, access_token, app_token, table_id):
        if table_id == "tblA":
            return [
                {"field_name": "标题", "type": 1},
                {
                    "field_name": "客户",
                    "type": 18,
                    "property": {"table_id": "tblB"},
                },
                {
                    "field_name": "附件",
                    "type": 17,
                },
            ]
        return [{"field_name": "名称", "type": 1}]

    def iter_records(self, access_token, app_token, table_id, *, max_rows=2000):
        if table_id == "tblA":
            yield {
                "record_id": "recA1",
                "fields": {
                    "标题": "订单1",
                    "客户": {"link_record_ids": ["recB1"]},
                    "附件": [
                        {
                            "file_token": "ftok",
                            "name": "a.png",
                            "tmp_url": "https://example.com/a.png",
                            "type": "image/png",
                        }
                    ],
                },
            }
        else:
            yield {
                "record_id": "recB1",
                "fields": {"名称": "客户1"},
            }

    def download_media(self, access_token, file_token, *, tmp_url=""):
        return b"fake-bytes"


class FieldCompatibilityFeishuClient(FakeFeishuClient):
    def list_fields(self, access_token, app_token, table_id):
        return [
            {
                "field_name": "参与人",
                "type": 11,
                "property": {"multiple": True},
            },
            {"field_name": "订单编号", "type": 1005},
            {
                "field_name": "美元金额",
                "type": 2,
                "ui_type": "Currency",
                "property": {"currency_code": "USD", "formatter": "0.00"},
            },
        ]

    def iter_records(self, access_token, app_token, table_id, *, max_rows=2000):
        yield {
            "record_id": "rec-compatible",
            "fields": {
                "参与人": [
                    {"id": "ou_zhang", "name": "张三"},
                    {"id": "ou_li", "name": "李四"},
                ],
                "订单编号": "PO-0042",
                "美元金额": 12.5,
            },
        }


class DuplexLinkFeishuClient(FakeFeishuClient):
    def list_fields(self, access_token, app_token, table_id):
        if table_id == "tblA":
            return [
                {"field_name": "Order", "type": 1},
                {
                    "field_name": "Customer",
                    "type": 21,
                    "property": {"table_id": "tblB"},
                },
            ]
        return [
            {"field_name": "Customer name", "type": 1},
            {
                "field_name": "Orders",
                "type": 21,
                "property": {"table_id": "tblA"},
            },
        ]

    def iter_records(self, access_token, app_token, table_id, *, max_rows=2000):
        if table_id == "tblA":
            yield {
                "record_id": "recA1",
                "fields": {
                    "Order": "Order 1",
                    "Customer": {"link_record_ids": ["recB1"]},
                },
            }
            return
        yield {
            "record_id": "recB1",
            "fields": {
                "Customer name": "Customer 1",
                "Orders": {"link_record_ids": ["recA1"]},
            },
        }


class UnauthorizedFeishuClient(FakeFeishuClient):
    requested_table_ids: list[str] = []

    def list_fields(self, access_token, app_token, table_id):
        self.requested_table_ids.append(table_id)
        raise FeishuAPIError("access token invalid", status_code=401)


class BusinessCodeUnauthorizedFeishuClient(UnauthorizedFeishuClient):
    def list_fields(self, access_token, app_token, table_id):
        self.requested_table_ids.append(table_id)
        raise FeishuAPIError(
            "user access token invalid",
            code=99991668,
            status_code=200,
        )


class ExpiredTokenFeishuClient(UnauthorizedFeishuClient):
    def list_fields(self, access_token, app_token, table_id):
        self.requested_table_ids.append(table_id)
        if access_token == "token":
            raise FeishuAPIError(
                "user access token expired",
                code=99991677,
                status_code=200,
            )
        return FakeFeishuClient.list_fields(self, access_token, app_token, table_id)


class TablePermissionErrorFeishuClient(FakeFeishuClient):
    requested_table_ids: list[str] = []

    def list_fields(self, access_token, app_token, table_id):
        self.requested_table_ids.append(table_id)
        if table_id == "tblA":
            raise FeishuAPIError(
                "forbidden for this table",
                code=99991679,
                status_code=200,
            )
        return super().list_fields(access_token, app_token, table_id)


class FeishuImportRunnerPhaseTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.feature_gate_patcher = patch(
            "apps.integrations_feishu.import_runner.feishu_import_enabled_for_organization",
            return_value=True,
        )
        self.feature_gate = self.feature_gate_patcher.start()
        self.addCleanup(self.feature_gate_patcher.stop)
        self.user = User.objects.create_user(
            email=f"feishu_run_{uuid.uuid4().hex[:8]}@example.com",
            password="pass12345",
        )
        self.org = Organization.objects.create(name="Feishu Run Org", owner=self.user)
        OrganizationMember.objects.create(
            organization=self.org, user=self.user, role="owner",
        )
        provider = FeishuOAuthProvider.objects.create(
            organization=self.org,
            app_id="customer-app",
            credentials={"app_secret": "customer-secret"},
            secret_fingerprint="test-fingerprint",
            status=FeishuOAuthProvider.Status.ACTIVE,
        )
        FeishuOAuthConnection.objects.create(
            user=self.user,
            organization_id=self.org.id,
            provider=provider,
            credential_version=provider.credential_version,
            tokens={"access_token": "t", "refresh_token": "r"},
            status=FeishuOAuthConnection.Status.CONNECTED,
        )

    def _make_job(self, *, include_attachments: bool = False):
        return FeishuImportJob.objects.create(
            user=self.user,
            organization_id=self.org.id,
            space_id=uuid.uuid4(),
            tables=[
                {"app_token": "app1", "table_id": "tblA", "name": "订单"},
                {"app_token": "app1", "table_id": "tblB", "name": "客户"},
            ],
            status=FeishuImportJob.Status.PENDING,
            result={"include_attachments": include_attachments},
        )

    def test_provider_reauthentication_interruption_is_terminal(self):
        job = self._make_job()
        job.status = FeishuImportJob.Status.FAILED
        job.error = "组织飞书企业应用已重新认证，导入任务已终止"
        job.result = {
            "phase": "interrupted",
            "interrupted_reason": "provider_reauthenticated",
        }
        job.save(update_fields=["status", "error", "result", "updated_at"])

        with patch("apps.integrations_feishu.import_runner.FeishuClient") as client_cls:
            run_feishu_import(str(job.id))

        client_cls.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.FAILED)
        self.assertEqual(job.result["interrupted_reason"], "provider_reauthenticated")
        self.assertIn("企业应用已重新认证", job.error)

    def test_feature_gate_stops_a_queued_import_before_contacting_feishu(self):
        self.feature_gate.return_value = False
        job = self._make_job()

        with patch("apps.integrations_feishu.import_runner.FeishuClient") as client_cls:
            run_feishu_import(str(job.id))

        client_cls.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.FAILED)
        self.assertIn("尚未开放飞书导入", job.error)

    def _run_duplex_import(self):
        schema = DDLManager.schema_name(self.org.id)
        _ENSURED_SCHEMAS.discard(schema)
        self.addCleanup(_ENSURED_SCHEMAS.discard, schema)
        job = self._make_job(include_attachments=False)

        with patch(
            "apps.tabdata.services.table_service.QuotaService.check_quota",
            return_value=None,
        ):
            run_feishu_import(str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.SUCCESS)
        self.assertEqual(job.result.get("issues"), [])

        created = {
            row["table_id"]: Table.objects.get(id=row["tabdata_table_id"])
            for row in job.result["created_tables"]
        }
        table_a = created["tblA"]
        table_b = created["tblB"]
        field_a = TableField.objects.get(
            table_id=table_a.id,
            field_type="link",
            is_deleted=False,
        )
        field_b = TableField.objects.get(
            table_id=table_b.id,
            field_type="link",
            is_deleted=False,
        )
        record_a = TableRecord.objects.get(table_id=table_a.id, is_deleted=False)
        record_b = TableRecord.objects.get(table_id=table_b.id, is_deleted=False)
        return table_a, table_b, field_a, field_b, record_a, record_b

    def _read_native_cell(self, table, record, field):
        row = NativeRecordIO(self.org.id, table.id).read_single(
            record.id,
            field_ids=[str(field.id)],
        )
        self.assertIsNotNone(row)
        value = row[field.id.hex]
        if isinstance(value, str):
            value = json.loads(value)
        return value

    @patch("apps.integrations_feishu.import_runner.RecordService")
    @patch("apps.integrations_feishu.import_runner.TableService")
    @patch("apps.integrations_feishu.import_runner.FeishuClient", FakeFeishuClient)
    def test_two_tables_single_link_updates_record_through_record_service(
        self, MockTableService, MockRecordService,
    ):
        table_a_id = uuid.uuid4()
        table_b_id = uuid.uuid4()
        link_field_id = uuid.uuid4()

        table_a = MagicMock(id=table_a_id)
        table_b = MagicMock(id=table_b_id)

        table_svc = MockTableService.return_value
        # create_table 按调用顺序返回 A 然后 B
        table_svc.create_table.side_effect = [table_a, table_b]

        # bulk_create_fields: Phase A 两次普通字段；Phase B 一次 link
        link_field = MagicMock()
        link_field.id = link_field_id
        link_field.name = "客户"
        link_field.config = {"foreignTableId": str(table_b_id), "isOneWay": True}
        link_field.field_type = "link"

        def bulk_create_fields(table_id, fields, **kwargs):
            if any(f.get("field_type") == "link" for f in fields):
                return [link_field], [], []
            return [MagicMock(name=f["name"]) for f in fields], [], []

        table_svc.bulk_create_fields.side_effect = bulk_create_fields

        record_svc = MockRecordService.return_value

        def bulk_create(table_id, chunk, record_ids=None, **kwargs):
            ids = list(record_ids or [])
            created = []
            for rid in ids:
                m = MagicMock()
                m.id = uuid.UUID(str(rid)) if rid else uuid.uuid4()
                created.append(m)
            return created, []

        record_svc.bulk_create_records.side_effect = bulk_create
        record_svc.update_record.return_value = (MagicMock(), None)

        job = self._make_job(include_attachments=False)

        with patch(
            "apps.integrations_feishu.import_runner.TableField.objects"
        ) as mock_tf_objects:
            # Phase B existing names query
            filter_mock = MagicMock()
            filter_mock.values_list.return_value = []
            mock_tf_objects.using.return_value.filter.return_value = filter_mock

            run_feishu_import(str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.SUCCESS)
        self.assertEqual(len(job.result.get("created_tables") or []), 2)
        record_svc.update_record.assert_called_once()
        updated_record_id, payload = record_svc.update_record.call_args.args
        self.assertIsInstance(updated_record_id, uuid.UUID)
        self.assertEqual(payload.keys(), {str(link_field_id)})
        self.assertEqual(len(payload[str(link_field_id)]), 1)
        # 附件关：不应有 issues 关于附件；附件 spill 不上传
        self.assertFalse(job.result.get("include_attachments"))

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=0)
    @patch(
        "apps.integrations_feishu.import_runner.FeishuClient",
        DuplexLinkFeishuClient,
    )
    def test_duplex_link_import_populates_both_record_caches(self):
        collab_callbacks = []
        with patch(
            "apps.tabdata.services.collab_service.CollabService.push_cells",
        ) as mock_push, patch(
            "apps.tabdata.subscribers.collab_ydoc._should_skip_push",
            return_value=False,
        ), patch(
            "apps.tabdata.subscribers.collab_ydoc.run_after_commit",
            side_effect=collab_callbacks.append,
        ), patch(
            "apps.tabdata.utils.ydoc_sync.run_after_commit",
            side_effect=collab_callbacks.append,
        ):
            (
                table_a,
                table_b,
                field_a,
                field_b,
                record_a,
                record_b,
            ) = self._run_duplex_import()
            mock_push.assert_not_called()
            for callback in collab_callbacks:
                callback()

        expected_a = [{"id": str(record_b.id), "title": "Customer 1"}]
        expected_b = [{"id": str(record_a.id), "title": "Order 1"}]

        self.assertEqual(LinkRecord.objects.filter(link_field=field_a).count(), 1)
        self.assertEqual(LinkRecord.objects.filter(link_field=field_b).count(), 1)
        record_a.refresh_from_db()
        record_b.refresh_from_db()
        self.assertEqual(record_a.data[str(field_a.id)], expected_a)
        self.assertEqual(record_b.data[str(field_b.id)], expected_b)
        self.assertEqual(
            self._read_native_cell(table_a, record_a, field_a),
            expected_a,
        )
        self.assertEqual(
            self._read_native_cell(table_b, record_b, field_b),
            expected_b,
        )
        self.assertEqual(
            read_data_fresh(record_a, table_a)[str(field_a.id)],
            expected_a,
        )
        self.assertEqual(
            read_data_fresh(record_b, table_b)[str(field_b.id)],
            expected_b,
        )

        def pushed_value(table_id, record_id, field_hex):
            for call in mock_push.call_args_list:
                if str(call.kwargs.get("table_id")) != str(table_id):
                    continue
                for change in call.kwargs.get("changes", []):
                    if (
                        change.get("record_id") == str(record_id)
                        and change.get("field_id_hex") == field_hex
                    ):
                        return change.get("value")
            self.fail(
                "未推送关联单元格 "
                f"table={table_id} record={record_id} field={field_hex}"
            )

        self.assertEqual(
            pushed_value(table_a.id, record_a.id, field_a.id.hex),
            expected_a,
        )
        self.assertEqual(
            pushed_value(table_b.id, record_b.id, field_b.id.hex),
            expected_b,
        )

    @patch(
        "apps.integrations_feishu.import_runner.FeishuClient",
        DuplexLinkFeishuClient,
    )
    def test_phase_c_rebuilds_missing_source_cache_without_duplicate_links(self):
        (
            table_a,
            table_b,
            field_a,
            field_b,
            record_a,
            record_b,
        ) = self._run_duplex_import()
        expected_a = [{"id": str(record_b.id), "title": "Customer 1"}]
        expected_b = [{"id": str(record_a.id), "title": "Order 1"}]

        source_data = dict(record_a.data or {})
        source_data.pop(str(field_a.id), None)
        TableRecord.objects.filter(id=record_a.id).update(data=source_data)
        NativeRecordIO(self.org.id, table_a.id).update_record(
            record_a.id,
            {field_a.id.hex: None},
        )
        record_a.refresh_from_db()
        self.assertNotIn(str(field_a.id), record_a.data or {})
        self.assertIsNone(self._read_native_cell(table_a, record_a, field_a))
        self.assertIsNone(
            read_data_fresh(record_a, table_a).get(str(field_a.id)),
        )

        imported = {
            ("app1", "tblA"): {
                "tabdata_table_id": table_a.id,
                "name": "订单",
            },
            ("app1", "tblB"): {
                "tabdata_table_id": table_b.id,
                "name": "客户",
            },
        }
        record_id_maps = {
            ("app1", "tblA"): {"recA1": str(record_a.id)},
            ("app1", "tblB"): {"recB1": str(record_b.id)},
        }
        link_spills = {
            ("app1", "tblA"): {
                "recA1": {"Customer": ["recB1"]},
            },
        }
        link_field_map = {
            ("app1", "tblA"): {"Customer": field_a},
        }

        issues: list[str] = []
        _phase_c_fill_links(
            user=self.user,
            imported=imported,
            record_id_maps=record_id_maps,
            link_spills=link_spills,
            link_field_map=link_field_map,
            issues=issues,
        )
        _phase_c_fill_links(
            user=self.user,
            imported=imported,
            record_id_maps=record_id_maps,
            link_spills=link_spills,
            link_field_map=link_field_map,
            issues=issues,
        )

        self.assertEqual(issues, [])
        self.assertEqual(LinkRecord.objects.filter(link_field=field_a).count(), 1)
        self.assertEqual(LinkRecord.objects.filter(link_field=field_b).count(), 1)
        record_a.refresh_from_db()
        record_b.refresh_from_db()
        self.assertEqual(record_a.data[str(field_a.id)], expected_a)
        self.assertEqual(record_b.data[str(field_b.id)], expected_b)
        self.assertEqual(
            self._read_native_cell(table_a, record_a, field_a),
            expected_a,
        )
        self.assertEqual(
            self._read_native_cell(table_b, record_b, field_b),
            expected_b,
        )
        self.assertEqual(
            read_data_fresh(record_a, table_a)[str(field_a.id)],
            expected_a,
        )
        self.assertEqual(
            read_data_fresh(record_b, table_b)[str(field_b.id)],
            expected_b,
        )

    @patch("apps.integrations_feishu.import_runner.RecordService")
    def test_phase_c_records_returned_errors_and_exceptions_as_issues(
        self,
        MockRecordService,
    ):
        table_a_id = uuid.uuid4()
        table_b_id = uuid.uuid4()
        field = MagicMock(
            id=uuid.uuid4(),
            config={"foreignTableId": str(table_b_id)},
        )
        secondary_field = MagicMock(
            id=uuid.uuid4(),
            config={"foreignTableId": str(table_b_id)},
        )
        record_a1_id = uuid.uuid4()
        record_a2_id = uuid.uuid4()
        record_a3_id = uuid.uuid4()
        record_b_id = uuid.uuid4()
        MockRecordService.return_value.update_record.side_effect = [
            (None, "返回错误"),
            RuntimeError("抛出异常"),
            (MagicMock(), None),
        ]
        issues: list[str] = []

        with self.assertLogs(
            "apps.integrations_feishu.import_runner",
            level="WARNING",
        ) as captured:
            _phase_c_fill_links(
                user=self.user,
                imported={
                    ("app1", "tblA"): {
                        "tabdata_table_id": table_a_id,
                        "name": "订单",
                    },
                    ("app1", "tblB"): {
                        "tabdata_table_id": table_b_id,
                        "name": "客户",
                    },
                },
                record_id_maps={
                    ("app1", "tblA"): {
                        "recA1": str(record_a1_id),
                        "recA2": str(record_a2_id),
                        "recA3": str(record_a3_id),
                    },
                    ("app1", "tblB"): {"recB1": str(record_b_id)},
                },
                link_spills={
                    ("app1", "tblA"): {
                        "recA1": {
                            "Customer": ["recB1"],
                            "Backup customer": ["recB1"],
                        },
                        "recA2": {
                            "Customer": ["recB1"],
                            "Backup customer": ["recB1"],
                        },
                        "recA3": {
                            "Customer": ["recB1"],
                            "Backup customer": ["recB1"],
                        },
                    },
                },
                link_field_map={
                    ("app1", "tblA"): {
                        "Customer": field,
                        "Backup customer": secondary_field,
                    },
                },
                issues=issues,
            )

        self.assertEqual(MockRecordService.return_value.update_record.call_count, 3)
        for call in MockRecordService.return_value.update_record.call_args_list:
            self.assertEqual(
                set(call.args[1]),
                {str(field.id), str(secondary_field.id)},
            )
            self.assertEqual(
                set(call.args[1][str(field.id)]),
                {str(record_b_id)},
            )
            self.assertEqual(
                set(call.args[1][str(secondary_field.id)]),
                {str(record_b_id)},
            )
        self.assertEqual(
            MockRecordService.return_value.update_record.call_args_list[2].args[0],
            record_a3_id,
        )
        self.assertEqual(len(issues), 2)
        self.assertIn("飞书记录 recA1", issues[0])
        self.assertIn("返回错误", issues[0])
        self.assertIn("飞书记录 recA2", issues[1])
        self.assertIn("抛出异常", issues[1])
        self.assertTrue(any("recA1" in line for line in captured.output))
        self.assertTrue(any("recA2" in line for line in captured.output))

    @patch("apps.integrations_feishu.import_runner.RecordService")
    @patch("apps.integrations_feishu.import_runner.TableService")
    @patch("apps.integrations_feishu.import_runner.FeishuClient", FakeFeishuClient)
    def test_attachments_off_leaves_cells_empty(
        self, MockTableService, MockRecordService,
    ):
        table_a = MagicMock(id=uuid.uuid4())
        table_b = MagicMock(id=uuid.uuid4())
        MockTableService.return_value.create_table.side_effect = [table_a, table_b]
        MockTableService.return_value.bulk_create_fields.return_value = ([], [], [])
        MockRecordService.return_value.bulk_create_records.return_value = (
            [MagicMock(id=uuid.uuid4())],
            [],
        )

        job = self._make_job(include_attachments=False)
        with patch(
            "apps.integrations_feishu.import_runner.TableField.objects"
        ) as mock_tf:
            mock_tf.using.return_value.filter.return_value.values_list.return_value = []
            run_feishu_import(str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.SUCCESS)
        # update_record 不应因附件被调用（RecordService 仅用于 bulk_create）
        self.assertFalse(MockRecordService.return_value.update_record.called)

    @patch("apps.integrations_feishu.import_runner.RecordService")
    @patch("apps.integrations_feishu.import_runner.TableService")
    @patch("apps.integrations_feishu.import_runner.FeishuClient", FakeFeishuClient)
    def test_failed_table_does_not_stop_later_tables(
        self, MockTableService, MockRecordService,
    ):
        """单表失败应留下明细并继续导入同批后续表。"""
        successful_table_id = uuid.uuid4()
        successful_table = MagicMock(id=successful_table_id)
        table_service = MockTableService.return_value
        table_service.create_table.side_effect = [
            PermissionError("permission denied for schema as_example"),
            successful_table,
        ]
        table_service.bulk_create_fields.return_value = ([], [], [])
        MockRecordService.return_value.bulk_create_records.return_value = (
            [MagicMock(id=uuid.uuid4())],
            [],
        )

        job = self._make_job(include_attachments=False)
        with patch(
            "apps.integrations_feishu.import_runner.TableField.objects"
        ) as mock_tf:
            mock_tf.using.return_value.filter.return_value.values_list.return_value = []
            run_feishu_import(str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.SUCCESS)
        self.assertEqual(table_service.create_table.call_count, 2)
        self.assertEqual(
            [row["table_id"] for row in job.result.get("created_tables") or []],
            ["tblB"],
        )
        self.assertEqual(
            job.result.get("failed_tables"),
            [
                {
                    "app_token": "app1",
                    "table_id": "tblA",
                    "name": "订单",
                    "error": "资源导入失败，请稍后重试",
                }
            ],
        )
        self.assertEqual(job.result.get("progress"), {"done": 2, "total": 2})

    @patch("apps.integrations_feishu.import_runner.TableService")
    @patch(
        "apps.integrations_feishu.import_runner.FeishuClient",
        UnauthorizedFeishuClient,
    )
    def test_unauthorized_api_error_stops_batch_and_requires_reconnect(
        self,
        MockTableService,
    ):
        """401 是整单授权失效，不得继续请求后续表或把任务记成成功。"""
        UnauthorizedFeishuClient.requested_table_ids = []
        job = self._make_job(include_attachments=False)

        with self.assertRaisesRegex(FeishuAuthError, "重新授权"):
            run_feishu_import(str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.FAILED)
        self.assertIn("重新授权", job.error)
        self.assertEqual(UnauthorizedFeishuClient.requested_table_ids, ["tblA"])
        MockTableService.return_value.create_table.assert_not_called()

    @patch("apps.integrations_feishu.import_runner.TableService")
    @patch(
        "apps.integrations_feishu.import_runner.FeishuClient",
        BusinessCodeUnauthorizedFeishuClient,
    )
    def test_auth_business_code_stops_batch_and_requires_reconnect(
        self,
        MockTableService,
    ):
        """HTTP 200 + 飞书认证业务码同样必须终止整单。"""
        BusinessCodeUnauthorizedFeishuClient.requested_table_ids = []
        job = self._make_job(include_attachments=False)

        with self.assertRaisesRegex(FeishuAuthError, "重新授权"):
            run_feishu_import(str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.FAILED)
        self.assertIn("重新授权", job.error)
        self.assertEqual(
            BusinessCodeUnauthorizedFeishuClient.requested_table_ids,
            ["tblA"],
        )
        MockTableService.return_value.create_table.assert_not_called()

    @patch("apps.integrations_feishu.import_runner.TableService")
    @patch(
        "apps.integrations_feishu.import_runner.FeishuClient",
        ExpiredTokenFeishuClient,
    )
    def test_expired_token_business_code_refreshes_once_and_continues_batch(
        self,
        MockTableService,
    ):
        """长批次中 access token 到期时刷新一次当前资源并继续。"""
        ExpiredTokenFeishuClient.requested_table_ids = []
        job = self._make_job(include_attachments=False)

        with patch(
            "apps.integrations_feishu.import_runner.TableField.objects"
        ) as mock_tf:
            mock_tf.using.return_value.filter.return_value.values_list.return_value = []
            run_feishu_import(str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.SUCCESS)
        self.assertEqual(
            ExpiredTokenFeishuClient.requested_table_ids,
            ["tblA", "tblA", "tblB"],
        )
        self.assertEqual(MockTableService.return_value.create_table.call_count, 2)

    @patch("apps.integrations_feishu.import_runner.RecordService")
    @patch("apps.integrations_feishu.import_runner.TableService")
    @patch(
        "apps.integrations_feishu.import_runner.FeishuClient",
        TablePermissionErrorFeishuClient,
    )
    def test_non_auth_api_error_skips_failed_table_and_continues_batch(
        self,
        MockTableService,
        MockRecordService,
    ):
        """普通表级权限错误只跳过当前表，后续表仍应完成导入。"""
        TablePermissionErrorFeishuClient.requested_table_ids = []
        successful_table = MagicMock(id=uuid.uuid4())
        MockTableService.return_value.create_table.return_value = successful_table
        MockTableService.return_value.bulk_create_fields.return_value = ([], [], [])
        MockRecordService.return_value.bulk_create_records.return_value = (
            [MagicMock(id=uuid.uuid4())],
            [],
        )
        job = self._make_job(include_attachments=False)

        with patch(
            "apps.integrations_feishu.import_runner.TableField.objects"
        ) as mock_tf:
            mock_tf.using.return_value.filter.return_value.values_list.return_value = []
            run_feishu_import(str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.SUCCESS)
        self.assertEqual(
            TablePermissionErrorFeishuClient.requested_table_ids,
            ["tblA", "tblB"],
        )
        self.assertEqual(
            [row["table_id"] for row in job.result.get("failed_tables") or []],
            ["tblA"],
        )
        self.assertEqual(
            [row["table_id"] for row in job.result.get("created_tables") or []],
            ["tblB"],
        )

    def test_single_table_write_failure_rolls_back_created_table(self):
        """建表后的异常必须回滚单表，供外层安全继续下一项。"""
        table_existed_during_write: list[bool] = []
        schema = DDLManager.schema_name(self.org.id)
        _ENSURED_SCHEMAS.discard(schema)
        self.addCleanup(_ENSURED_SCHEMAS.discard, schema)

        def fail_bulk_create(record_service, table_id, *args, **kwargs):
            table_existed_during_write.append(Table.objects.filter(id=table_id).exists())
            raise RuntimeError("simulated record write failure")

        with patch(
            "apps.tabdata.services.table_service.QuotaService.check_quota",
            return_value=None,
        ), patch.object(
            RecordService,
            "bulk_create_records",
            new=fail_bulk_create,
        ):
            with self.assertRaisesRegex(RuntimeError, "simulated record write failure"):
                _phase_a_import_table(
                    client=FakeFeishuClient(),
                    access_token="token",
                    user=self.user,
                    organization_id=self.org.id,
                    collection_id=None,
                    space_id=None,
                    app_token="app1",
                    table_id="tblA",
                    preferred_name="原子回滚测试表",
                )

        self.assertEqual(table_existed_during_write, [True])
        self.assertNotIn(schema, _ENSURED_SCHEMAS)
        self.assertFalse(
            Table.objects.filter(
                organization_id=self.org.id,
                name="原子回滚测试表",
            ).exists(),
        )

        with patch(
            "apps.tabdata.services.table_service.QuotaService.check_quota",
            return_value=None,
        ):
            outcome = _phase_a_import_table(
                client=FakeFeishuClient(),
                access_token="token",
                user=self.user,
                organization_id=self.org.id,
                collection_id=None,
                space_id=None,
                app_token="app1",
                table_id="tblB",
                preferred_name="回滚后的后续表",
            )

        self.assertTrue(Table.objects.filter(id=outcome["tabdata_table_id"]).exists())

    def test_field_contracts_and_source_values_survive_real_import_services(self):
        with patch(
            "apps.tabdata.services.table_service.QuotaService.check_quota",
            return_value=None,
        ):
            outcome = _phase_a_import_table(
                client=FieldCompatibilityFeishuClient(),
                access_token="token",
                user=self.user,
                organization_id=self.org.id,
                collection_id=None,
                space_id=None,
                app_token="app1",
                table_id="tbl-compatible",
                preferred_name="字段兼容性真实链路测试表",
            )

        table = Table.objects.get(id=outcome["tabdata_table_id"])
        fields = {
            field.name: field
            for field in TableField.objects.filter(table_id=table.id, is_deleted=False)
        }
        self.assertEqual(fields["参与人"].field_type, "user")
        self.assertEqual(fields["参与人"].config, {"multiple": True})
        self.assertEqual(fields["订单编号"].field_type, "text")
        self.assertEqual(
            fields["美元金额"].config,
            {"symbol": "$", "precision": 2},
        )

        record = TableRecord.objects.get(table_id=table.id)
        data = read_data_fresh(record, table)
        self.assertEqual(data[str(fields["订单编号"].id)], "PO-0042")
        self.assertEqual(data[str(fields["美元金额"].id)], 12.5)
        self.assertEqual(
            data[str(fields["参与人"].id)],
            [
                {"id": "ou_zhang", "name": "张三"},
                {"id": "ou_li", "name": "李四"},
            ],
        )

    @patch("apps.tabdata.services.attachment_service.AttachmentService")
    @patch("apps.integrations_feishu.import_runner.RecordService")
    @patch("apps.integrations_feishu.import_runner.TableService")
    @patch("apps.integrations_feishu.import_runner.FeishuClient", FakeFeishuClient)
    def test_attachments_on_uploads_and_updates_cell(
        self,
        MockTableService,
        MockRecordService,
        MockAttachmentService,
    ):
        table_a = MagicMock(id=uuid.uuid4())
        table_b = MagicMock(id=uuid.uuid4())
        MockTableService.return_value.create_table.side_effect = [table_a, table_b]

        attach_field = MagicMock()
        attach_field.name = "附件"
        attach_field.field_type = "attachment"
        attach_field.id = uuid.uuid4()

        def bulk_create_fields(table_id, fields, **kwargs):
            created = []
            for f in fields:
                m = MagicMock()
                m.name = f["name"]
                m.field_type = f.get("field_type")
                m.config = f.get("options") or {}
                m.id = uuid.uuid4()
                created.append(m)
            return created, [], []

        MockTableService.return_value.bulk_create_fields.side_effect = bulk_create_fields

        def bulk_create(table_id, chunk, record_ids=None, **kwargs):
            created = []
            for rid in list(record_ids or []):
                m = MagicMock()
                m.id = uuid.UUID(str(rid))
                created.append(m)
            return created, []

        record_svc = MockRecordService.return_value
        record_svc.bulk_create_records.side_effect = bulk_create
        record_svc.update_record.return_value = (MagicMock(), None)
        MockAttachmentService.return_value.sync_record_attachments.return_value = None

        file_record = MagicMock()
        file_record.id = uuid.uuid4()
        file_record.access_url = "https://cdn.example/a.png"

        job = self._make_job(include_attachments=True)

        with patch(
            "apps.integrations_feishu.import_runner.TableField.objects"
        ) as mock_tf, patch(
            "apps.services.oss.services.factory.get_oss_service"
        ) as mock_get_oss, patch(
            "apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file",
            return_value=file_record,
        ) as mock_register:
            filter_chain = MagicMock()
            filter_chain.values_list.return_value = []
            filter_chain.__iter__ = lambda _self: iter([attach_field])
            mock_tf.using.return_value.filter.return_value = filter_chain
            mock_get_oss.return_value.upload_bytes.return_value = True
            mock_get_oss.return_value.set_object_private.return_value = True

            run_feishu_import(str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.SUCCESS)
        self.assertTrue(job.result.get("include_attachments"))
        self.assertTrue(record_svc.update_record.called)
        update_calls = record_svc.update_record.call_args_list
        self.assertTrue(
            any(
                isinstance(call.args[1], dict) and "附件" in call.args[1]
                for call in update_calls
            ),
            update_calls,
        )
        attachment_cells = [
            call.args[1]["附件"]
            for call in update_calls
            if isinstance(call.args[1], dict) and "附件" in call.args[1]
        ]
        self.assertEqual(
            attachment_cells[0][0]["file_id"],
            str(file_record.id),
        )
        self.assertEqual(
            attachment_cells[0][0]["url"],
            "",
        )
        mock_get_oss.return_value.set_object_public_read.assert_not_called()
        mock_get_oss.return_value.set_object_private.assert_called_once()
        mock_get_oss.return_value.generate_presigned_url.assert_not_called()
        mock_register.assert_called()
        self.assertTrue(mock_register.call_args.kwargs.get("is_public") is False)

    @patch("apps.integrations_feishu.import_runner.RecordService")
    @patch("apps.integrations_feishu.import_runner.TableService")
    @patch("apps.integrations_feishu.import_runner.FeishuClient", FakeFeishuClient)
    def test_redelivery_skips_already_created_tables(
        self, MockTableService, MockRecordService,
    ):
        """Celery 重投递不得再次 create_table。"""
        prior_a = str(uuid.uuid4())
        prior_b = str(uuid.uuid4())
        job = FeishuImportJob.objects.create(
            user=self.user,
            organization_id=self.org.id,
            space_id=uuid.uuid4(),
            tables=[
                {"app_token": "app1", "table_id": "tblA", "name": "订单"},
                {"app_token": "app1", "table_id": "tblB", "name": "客户"},
            ],
            status=FeishuImportJob.Status.RUNNING,
            result={
                "include_attachments": False,
                "phase": "phase_a",
                "created_tables": [
                    {
                        "app_token": "app1",
                        "table_id": "tblA",
                        "tabdata_table_id": prior_a,
                        "name": "订单",
                        "row_write_errors": 0,
                    },
                    {
                        "app_token": "app1",
                        "table_id": "tblB",
                        "tabdata_table_id": prior_b,
                        "name": "客户",
                        "row_write_errors": 0,
                    },
                ],
                "started_keys": ["app1:tblA", "app1:tblB"],
                "progress": {"done": 2, "total": 2},
            },
        )

        with patch(
            "apps.integrations_feishu.import_runner.TableField.objects"
        ) as mock_tf:
            mock_tf.using.return_value.filter.return_value.values_list.return_value = []
            run_feishu_import(str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.SUCCESS)
        MockTableService.return_value.create_table.assert_not_called()
        created = job.result.get("created_tables") or []
        self.assertEqual(len(created), 2)
        self.assertEqual(
            {row["tabdata_table_id"] for row in created},
            {prior_a, prior_b},
        )

    @patch("apps.integrations_feishu.import_runner.TableService")
    @patch("apps.integrations_feishu.import_runner.FeishuClient", FakeFeishuClient)
    def test_redelivery_skips_interrupted_started_table(self, MockTableService):
        """started 但未写入 created 的表跳过，避免半成品再造一份。"""
        job = FeishuImportJob.objects.create(
            user=self.user,
            organization_id=self.org.id,
            space_id=uuid.uuid4(),
            tables=[
                {"app_token": "app1", "table_id": "tblA", "name": "订单"},
            ],
            status=FeishuImportJob.Status.RUNNING,
            result={
                "include_attachments": False,
                "created_tables": [],
                "started_keys": ["app1:tblA"],
                "progress": {"done": 0, "total": 1},
            },
        )
        run_feishu_import(str(job.id))
        job.refresh_from_db()
        self.assertEqual(job.status, FeishuImportJob.Status.SUCCESS)
        MockTableService.return_value.create_table.assert_not_called()
        skipped = job.result.get("skipped_tables") or []
        self.assertEqual(len(skipped), 1)
        self.assertTrue(
            any("中断" in issue for issue in (job.result.get("issues") or [])),
        )
