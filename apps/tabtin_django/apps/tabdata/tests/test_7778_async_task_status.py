"""#7778 W3：异步导入/导出的 HTTP 轮询闭环。

覆盖三件事：
1. ``describe_task`` 把 Celery state + 任务返回体归一成 pending/success/failure；
2. ``GET /api/tabdata/tasks/{task_id}`` 的鉴权边界（发起人 / 表 editor / 其他人 / 未登记）；
3. ``GET /api/tabdata/exports/{file_id}/download?redirect=false`` 返回签名 URL JSON
   （CLI 不跟随 302），以及 ``POST /api/tabdata/import/file-base64`` 的 JSON 通道。
"""
from __future__ import annotations

import base64
import json
from datetime import timedelta
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db.models.signals import post_save
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from apps.tabdata.models import Table, TablePermission
from apps.tabdata.services.async_task_registry import (
    KIND_EXPORT,
    KIND_IMPORT,
    describe_task,
    get_task_meta,
    register_task,
)
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.tabtinspace.signals import create_default_organization
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token
from apps.users.membership.models import MembershipTier

User = get_user_model()

_SESSION_COUNTER = 0

_REGISTRY_MODULE = "apps.tabdata.services.async_task_registry"


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type="free",
        defaults={
            "name": "免费版",
            "description": "#7778 W3 测试",
            "max_tables": -1,
            "max_records_per_table": -1,
            "max_api_calls_per_day": -1,
            "max_crawl_tasks_per_day": -1,
            "features": {},
            "sort_order": 0,
            "is_active": True,
        },
    )


def _auth_header(user) -> dict:
    """构造带有效 UserSession 的 JWT（JWTAuth 强制 sid 绑定）。"""
    global _SESSION_COUNTER
    _SESSION_COUNTER += 1
    raw_key = f"i7778_session_{_SESSION_COUNTER:040d}"
    UserSession.objects.get_or_create(
        session_key=SessionManager.hash_session_key(raw_key),
        defaults={
            "user": user,
            "session_type": "web",
            "ip_address": "127.0.0.1",
            "user_agent": "i7778-test",
            "expires_at": timezone.now() + timedelta(hours=2),
        },
    )
    token = generate_jwt_token(
        user, expire_hours=1, token_type="access", session_key=raw_key,
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


def _celery_result(state: str, result=None) -> MagicMock:
    fake = MagicMock()
    fake.state = state
    fake.result = result
    return fake


class AsyncTaskRegistryNormalizationTests(TestCase):
    """describe_task 的状态归一——纯函数逻辑，不碰 DB / HTTP。"""

    def setUp(self):
        cache.clear()

    def _meta(self, kind=KIND_EXPORT):
        return {"kind": kind, "user_id": "u1", "table_id": "t1"}

    def test_pending_state_is_not_ready(self):
        with patch(f"{_REGISTRY_MODULE}.AsyncResult", return_value=_celery_result("PENDING")):
            payload = describe_task("task-1", self._meta())
        self.assertEqual(payload["status"], "pending")
        self.assertFalse(payload["ready"])
        self.assertEqual(payload["celery_state"], "PENDING")

    def test_started_state_still_pending(self):
        """STARTED 是执行中，对轮询方仍是 pending——只有终态才停止轮询。"""
        with patch(f"{_REGISTRY_MODULE}.AsyncResult", return_value=_celery_result("STARTED")):
            payload = describe_task("task-1", self._meta())
        self.assertEqual(payload["status"], "pending")
        self.assertFalse(payload["ready"])

    def test_success_export_hoists_file_id(self):
        result = {"status": "success", "file_id": "file-123", "file_name": "export.csv"}
        with patch(f"{_REGISTRY_MODULE}.AsyncResult", return_value=_celery_result("SUCCESS", result)):
            payload = describe_task("task-1", self._meta())
        self.assertEqual(payload["status"], "success")
        self.assertTrue(payload["ready"])
        self.assertEqual(payload["file_id"], "file-123")
        self.assertEqual(payload["file_name"], "export.csv")
        self.assertEqual(payload["result"], result)

    def test_success_import_keeps_counts(self):
        result = {"status": "success", "created_count": 12, "updated_count": 3}
        with patch(f"{_REGISTRY_MODULE}.AsyncResult", return_value=_celery_result("SUCCESS", result)):
            payload = describe_task("task-1", self._meta(KIND_IMPORT))
        self.assertEqual(payload["status"], "success")
        self.assertEqual(payload["result"]["created_count"], 12)
        self.assertNotIn("file_id", payload)

    def test_task_returned_error_maps_to_failure(self):
        """任务体捕获异常后返回 status=error，Celery 仍是 SUCCESS——必须判为业务失败。"""
        result = {"status": "error", "message": "导出文件上传 OSS 失败，请稍后重试"}
        with patch(f"{_REGISTRY_MODULE}.AsyncResult", return_value=_celery_result("SUCCESS", result)):
            payload = describe_task("task-1", self._meta())
        self.assertEqual(payload["status"], "failure")
        self.assertTrue(payload["ready"])
        self.assertEqual(payload["error"], "导出文件上传 OSS 失败，请稍后重试")

    def test_celery_failure_does_not_leak_exception_detail(self):
        exc = RuntimeError("psycopg2 connection to 10.0.0.5:5432 failed: password authentication")
        with patch(f"{_REGISTRY_MODULE}.AsyncResult", return_value=_celery_result("FAILURE", exc)):
            payload = describe_task("task-1", self._meta())
        self.assertEqual(payload["status"], "failure")
        self.assertTrue(payload["ready"])
        self.assertNotIn("password", payload["error"])
        self.assertNotIn("psycopg2", payload["error"])

    def test_register_and_read_back_meta(self):
        register_task("task-9", kind=KIND_EXPORT, user_id="u-1", table_id="t-1")
        self.assertEqual(
            get_task_meta("task-9"),
            {"kind": KIND_EXPORT, "user_id": "u-1", "table_id": "t-1"},
        )

    def test_unregistered_task_meta_is_none(self):
        self.assertIsNone(get_task_meta("never-dispatched"))


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class AsyncTaskStatusEndpointTests(TestCase):
    """GET /api/tabdata/tasks/{task_id} 的鉴权与响应形状。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        cache.clear()
        _ensure_free_tier()
        self.client = Client()

        self.owner = User.objects.create_user(
            username="i7778-owner", email="i7778-owner@example.com", password="x",
        )
        self.editor = User.objects.create_user(
            username="i7778-editor", email="i7778-editor@example.com", password="x",
        )
        self.outsider = User.objects.create_user(
            username="i7778-outsider", email="i7778-outsider@example.com", password="x",
        )

        self.organization = Organization.objects.create(
            name="I7778 Org", owner_id=self.owner.id, is_default=False,
        )
        for user, role in ((self.owner, "owner"), (self.editor, "editor")):
            OrganizationMember.objects.create(
                organization=self.organization, user=user, role=role,
            )

        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner=self.owner,
            name="I7778 导出表",
        )
        TablePermission.objects.create(
            table=self.table,
            subject_type="user",
            subject_id=str(self.editor.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.owner.id),
        )

    def _get_status(self, user, task_id: str):
        return self.client.get(f"/api/tabdata/tasks/{task_id}", **_auth_header(user))

    def _register(self, task_id: str, *, kind=KIND_EXPORT):
        register_task(
            task_id, kind=kind, user_id=str(self.owner.id), table_id=str(self.table.id),
        )

    def test_unregistered_task_returns_404(self):
        """未登记的 task_id 一律 404——不回退到无鉴权的 Celery 查询。"""
        response = self._get_status(self.owner, "00000000-dead-beef-0000-000000000000")
        self.assertEqual(response.status_code, 404, response.content)

    def test_initiator_can_poll(self):
        self._register("task-owner-1")
        with patch(f"{_REGISTRY_MODULE}.AsyncResult", return_value=_celery_result("PENDING")):
            response = self._get_status(self.owner, "task-owner-1")
        self.assertEqual(response.status_code, 200, response.content)
        data = json.loads(response.content)["data"]
        self.assertEqual(data["status"], "pending")
        self.assertEqual(data["kind"], KIND_EXPORT)
        self.assertEqual(data["table_id"], str(self.table.id))

    def test_table_editor_can_poll_others_task(self):
        """非发起人但对目标表有 editor 权限——放行（协作场景下另一端要看进度）。"""
        self._register("task-owner-2")
        with patch(f"{_REGISTRY_MODULE}.AsyncResult", return_value=_celery_result("PENDING")):
            response = self._get_status(self.editor, "task-owner-2")
        self.assertEqual(response.status_code, 200, response.content)

    def test_outsider_is_denied(self):
        self._register("task-owner-3")
        with patch(f"{_REGISTRY_MODULE}.AsyncResult", return_value=_celery_result("PENDING")):
            response = self._get_status(self.outsider, "task-owner-3")
        self.assertEqual(response.status_code, 403, response.content)

    def test_success_payload_exposes_file_id_for_download(self):
        self._register("task-owner-4")
        result = {"status": "success", "file_id": "f-1", "file_name": "export_abc.csv"}
        with patch(f"{_REGISTRY_MODULE}.AsyncResult", return_value=_celery_result("SUCCESS", result)):
            response = self._get_status(self.owner, "task-owner-4")
        self.assertEqual(response.status_code, 200, response.content)
        data = json.loads(response.content)["data"]
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["file_id"], "f-1")

    def test_oversized_task_id_rejected(self):
        response = self._get_status(self.owner, "x" * 300)
        self.assertEqual(response.status_code, 400, response.content)


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class AsyncExportDispatchRegistersInitiatorTests(TestCase):
    """异步导出派发时必须登记发起人，否则轮询接口永远 404。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        cache.clear()
        _ensure_free_tier()
        self.client = Client()
        self.owner = User.objects.create_user(
            username="i7778-dispatch", email="i7778-dispatch@example.com", password="x",
        )
        self.organization = Organization.objects.create(
            name="I7778 Dispatch Org", owner_id=self.owner.id, is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.owner, role="owner",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner=self.owner,
            name="I7778 异步导出表",
        )

    def test_async_csv_export_returns_task_id_and_registers_owner(self):
        fake_task = MagicMock()
        fake_task.id = "celery-task-async-csv"
        with patch(
            "apps.tabdata.tasks.import_export_tasks.async_export_data.apply_async",
            return_value=fake_task,
        ):
            response = self.client.post(
                "/api/tabdata/export/csv",
                data=json.dumps({"table_id": str(self.table.id), "async_mode": True}),
                content_type="application/json",
                **_auth_header(self.owner),
            )

        self.assertEqual(response.status_code, 200, response.content)
        data = json.loads(response.content)["data"]
        self.assertTrue(data["async"])
        self.assertEqual(data["task_id"], "celery-task-async-csv")

        meta = get_task_meta("celery-task-async-csv")
        self.assertEqual(meta["kind"], KIND_EXPORT)
        self.assertEqual(meta["user_id"], str(self.owner.id))
        self.assertEqual(meta["table_id"], str(self.table.id))

    def test_async_dispatch_bypasses_declared_response_model(self):
        """回归：export/csv|json 声明 response={200: str}、excel|pdf 声明 {200: bytes}。

        异步分支返回 dict 会被 Ninja 拿这个 model 校验并抛 500——必须回 HttpResponse
        才能跳过校验。四种格式逐一验证，避免只修一个。
        """
        for fmt in ("csv", "excel", "json", "pdf"):
            with self.subTest(format=fmt):
                fake_task = MagicMock()
                fake_task.id = f"celery-task-async-{fmt}"
                with patch(
                    "apps.tabdata.tasks.import_export_tasks.async_export_data.apply_async",
                    return_value=fake_task,
                ):
                    response = self.client.post(
                        f"/api/tabdata/export/{fmt}",
                        data=json.dumps({"table_id": str(self.table.id), "async_mode": True}),
                        content_type="application/json",
                        **_auth_header(self.owner),
                    )
                self.assertEqual(response.status_code, 200, response.content)
                self.assertEqual(
                    json.loads(response.content)["data"]["task_id"],
                    f"celery-task-async-{fmt}",
                )


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class ImportFileBase64Tests(TestCase):
    """/import/file-base64：CLI 走 JSON 通道，与 multipart /import/file 同一套实现。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        cache.clear()
        _ensure_free_tier()
        self.client = Client()
        self.owner = User.objects.create_user(
            username="i7778-import", email="i7778-import@example.com", password="x",
        )
        self.organization = Organization.objects.create(
            name="I7778 Import Org", owner_id=self.owner.id, is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.owner, role="owner",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner=self.owner,
            name="I7778 导入表",
        )

    def _post(self, payload: dict):
        return self.client.post(
            "/api/tabdata/import/file-base64",
            data=json.dumps(payload),
            content_type="application/json",
            **_auth_header(self.owner),
        )

    def test_invalid_base64_rejected(self):
        response = self._post({
            "table_id": str(self.table.id),
            "file_type": "csv",
            "file_base64": "这不是 base64!!!",
        })
        self.assertEqual(response.status_code, 400, response.content)

    def test_unsupported_file_type_rejected(self):
        response = self._post({
            "table_id": str(self.table.id),
            "file_type": "parquet",
            "file_base64": base64.b64encode(b"a,b\n1,2\n").decode("ascii"),
        })
        self.assertEqual(response.status_code, 400, response.content)

    def test_large_file_goes_async_and_registers_initiator(self):
        """超过 500KB 阈值自动转异步，返回 task_id 并登记发起人供轮询。"""
        big_csv = "name,age\n" + "".join(f"user{i},{i}\n" for i in range(60000))
        self.assertGreater(len(big_csv.encode("utf-8")), 500 * 1024)

        fake_task = MagicMock()
        fake_task.id = "celery-task-async-import"
        with patch(
            "apps.tabdata.tasks.import_export_tasks.async_import_data.apply_async",
            return_value=fake_task,
        ):
            response = self._post({
                "table_id": str(self.table.id),
                "file_type": "csv",
                "file_base64": base64.b64encode(big_csv.encode("utf-8")).decode("ascii"),
            })

        self.assertEqual(response.status_code, 200, response.content)
        data = json.loads(response.content)["data"]
        self.assertTrue(data["async"])
        self.assertEqual(data["task_id"], "celery-task-async-import")

        meta = get_task_meta("celery-task-async-import")
        self.assertEqual(meta["kind"], KIND_IMPORT)
        self.assertEqual(meta["user_id"], str(self.owner.id))


class ResolveFileContentCleanupTests(TestCase):
    """_download_from_oss 的删源语义——纯函数逻辑，不碰 DB / HTTP。"""

    def _patched_oss(self):
        oss = MagicMock()
        oss.download_bytes.return_value = b"id,name\n1,Bob\n"
        return oss

    def test_transit_key_is_deleted_after_read(self):
        """import_transit/ 这种裸中转键读完即删（DATA-3 既有行为，不能回退）。"""
        from apps.tabdata.tasks.import_export_tasks import _resolve_file_content

        oss = self._patched_oss()
        with patch("apps.services.oss.services.factory.get_oss_service", return_value=oss):
            text, _ = _resolve_file_content("csv", None, "import_transit/abc")
        self.assertEqual(text, "id,name\n1,Bob\n")
        oss.delete_object.assert_called_once_with("import_transit/abc")

    def test_managed_file_is_not_deleted(self):
        """FileRecord 托管的用户上传文件不能删——删了记录就指向空对象、计量也对不上。"""
        from apps.tabdata.tasks.import_export_tasks import _resolve_file_content

        oss = self._patched_oss()
        with patch("apps.services.oss.services.factory.get_oss_service", return_value=oss):
            _resolve_file_content("csv", None, "agent/uploads/big.csv", oss_cleanup=False)
        oss.delete_object.assert_not_called()


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class ImportOSSFileTests(TestCase):
    """/import/oss-file：大文件走对象存储，body 里只有 file_id。

    存在理由见端点 docstring——base64 通道受 CLI 10MB 请求体上限约束，
    真正到 Django 侧 10MB/20MB 上限的文件必须走这条路。
    """

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        cache.clear()
        _ensure_free_tier()
        self.client = Client()
        self.owner = User.objects.create_user(
            username="i7778-oss", email="i7778-oss@example.com", password="x",
        )
        self.outsider = User.objects.create_user(
            username="i7778-oss-out", email="i7778-oss-out@example.com", password="x",
        )
        self.organization = Organization.objects.create(
            name="I7778 OSS Org", owner_id=self.owner.id, is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.owner, role="owner",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner=self.owner,
            name="I7778 OSS 导入表",
        )
        self.file_record = self._make_file_record(upload_user=str(self.owner.id))

    def _make_file_record(self, *, upload_user: str, size: int = 8 * 1024 * 1024, key_suffix: str = "a"):
        from apps.services.oss.models import FileRecord
        return FileRecord.objects.create(
            file_name=f"big_{key_suffix}.csv",
            file_key=f"agent/uploads/big_{key_suffix}.csv",
            file_path=f"agent/uploads/big_{key_suffix}.csv",
            file_size=size,
            file_type="other",
            mime_type="text/csv",
            file_extension="csv",
            file_hash=key_suffix * 32,
            status="completed",
            upload_user=upload_user,
        )

    def _post(self, payload: dict, user=None):
        return self.client.post(
            "/api/tabdata/import/oss-file",
            data=json.dumps(payload),
            content_type="application/json",
            **_auth_header(user or self.owner),
        )

    def _payload(self, **overrides):
        payload = {
            "table_id": str(self.table.id),
            "file_id": str(self.file_record.id),
            "file_type": "csv",
        }
        payload.update(overrides)
        return payload

    def test_dispatches_with_object_key_and_no_cleanup(self):
        """派任务时带 oss_object_key，且明确不让任务删源对象。

        源对象背后有 FileRecord + 组织存储计量，读完即删会留下指向空对象的记录。
        """
        fake_task = MagicMock()
        fake_task.id = "celery-oss-import-1"
        with patch(
            "apps.tabdata.tasks.import_export_tasks.async_import_data.apply_async",
            return_value=fake_task,
        ) as apply_async:
            response = self._post(self._payload())

        self.assertEqual(response.status_code, 200, response.content)
        data = json.loads(response.content)["data"]
        self.assertTrue(data["async"])
        self.assertEqual(data["task_id"], "celery-oss-import-1")

        kwargs = apply_async.call_args.kwargs["kwargs"]
        self.assertEqual(kwargs["oss_object_key"], self.file_record.file_key)
        self.assertIs(kwargs["oss_cleanup"], False)
        self.assertNotIn("file_content", kwargs)

        meta = get_task_meta("celery-oss-import-1")
        self.assertEqual(meta["kind"], KIND_IMPORT)
        self.assertEqual(meta["user_id"], str(self.owner.id))

    def test_other_users_file_is_denied(self):
        """只能导入自己上传的文件——否则等于拿 file_id 读别人的文件内容。"""
        foreign = self._make_file_record(upload_user=str(self.outsider.id), key_suffix="b")
        response = self._post(self._payload(file_id=str(foreign.id)))
        self.assertEqual(response.status_code, 403, response.content)

    def test_unknown_file_returns_404(self):
        response = self._post(self._payload(file_id="00000000-0000-4000-8000-000000000000"))
        self.assertEqual(response.status_code, 404, response.content)

    def test_oversized_file_rejected_by_backend_limit(self):
        """CSV 上限 10MB：超了就在派任务前拒，不让 worker 白跑一趟。"""
        oversized = self._make_file_record(
            upload_user=str(self.owner.id), size=11 * 1024 * 1024, key_suffix="c",
        )
        response = self._post(self._payload(file_id=str(oversized.id)))
        self.assertEqual(response.status_code, 400, response.content)

    def test_excel_gets_higher_limit(self):
        """同样 11MB，Excel 在 20MB 上限内应放行——上限按类型分。"""
        big_excel = self._make_file_record(
            upload_user=str(self.owner.id), size=11 * 1024 * 1024, key_suffix="d",
        )
        fake_task = MagicMock()
        fake_task.id = "celery-oss-import-xlsx"
        with patch(
            "apps.tabdata.tasks.import_export_tasks.async_import_data.apply_async",
            return_value=fake_task,
        ):
            response = self._post(self._payload(file_id=str(big_excel.id), file_type="xlsx"))
        self.assertEqual(response.status_code, 200, response.content)

    def test_no_table_permission_is_denied(self):
        """文件是自己的，但对目标表没有 editor 权限——仍然拒。"""
        foreign_table = Table.objects.create(
            organization_id=Organization.objects.create(
                name="I7778 OSS Other Org", owner_id=self.outsider.id, is_default=False,
            ).id,
            space_id=None,
            owner=self.outsider,
            name="别人的表",
        )
        response = self._post(self._payload(table_id=str(foreign_table.id)))
        self.assertEqual(response.status_code, 403, response.content)

    def test_unsupported_file_type_rejected(self):
        response = self._post(self._payload(file_type="parquet"))
        self.assertEqual(response.status_code, 400, response.content)


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class ExportDownloadJsonModeTests(TestCase):
    """?redirect=false 返回签名 URL JSON——CLI 的 HTTP 客户端不跟随 302。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        cache.clear()
        _ensure_free_tier()
        self.client = Client()
        self.owner = User.objects.create_user(
            username="i7778-dl", email="i7778-dl@example.com", password="x",
        )
        self.organization = Organization.objects.create(
            name="I7778 DL Org", owner_id=self.owner.id, is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.owner, role="owner",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            owner=self.owner,
            name="I7778 下载表",
        )

        from apps.services.oss.models import FileRecord, FileUsage
        self.file_record = FileRecord.objects.create(
            file_name="export_abc.csv",
            file_key="export/20260726_abc_export.csv",
            file_path="export/20260726_abc_export.csv",
            file_size=42,
            file_type="other",
            mime_type="text/csv",
            file_extension="csv",
            file_hash="0" * 32,
            status="completed",
        )
        FileUsage.objects.create(
            file_record=self.file_record,
            user_id=self.owner.id,
            module="tabdata",
            context_type="export",
            context_id=str(self.table.id),
            is_active=True,
        )

    def _download(self, params: str = ""):
        with patch("apps.services.oss.services.factory.get_oss_service") as get_oss:
            oss = MagicMock()
            oss.generate_presigned_url.return_value = "https://oss.example.com/signed?sig=abc"
            get_oss.return_value = oss
            return self.client.get(
                f"/api/tabdata/exports/{self.file_record.id}/download{params}",
                **_auth_header(self.owner),
            )

    def test_default_still_redirects(self):
        """默认行为不变：浏览器 / Electron 继续走 302 重定向。"""
        response = self._download()
        self.assertEqual(response.status_code, 302, response.content)

    def test_redirect_false_returns_signed_url_json(self):
        response = self._download("?redirect=false")
        self.assertEqual(response.status_code, 200, response.content)
        data = json.loads(response.content)["data"]
        self.assertEqual(data["download_url"], "https://oss.example.com/signed?sig=abc")
        self.assertEqual(data["file_name"], "export_abc.csv")
        self.assertEqual(data["content_type"], "text/csv")
        self.assertGreater(data["expires_in"], 0)
