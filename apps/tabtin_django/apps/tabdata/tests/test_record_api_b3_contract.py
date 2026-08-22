"""TabData record API B3 契约 / 回归（TDA-4 / TDA-21 / TDA-22）

- TDA-4: ``POST /api/tabdata/records/upsert`` agent JWT 端点
- TDA-21: 历史还原走 ``/restore-history``，释放 ``/restore`` 给回收站
- : 单条显式 delete 必须无条件清理 native 投影，不能被内部版本漂移阻断
"""
from __future__ import annotations

import inspect
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.db.utils import OperationalError
from django.test import SimpleTestCase

from apps.tabdata.domain.value_objects import RecordCommandContext, RecordSnapshot
from apps.tabdata.exceptions import RecordVersionConflictError
from apps.tabdata.handlers.delete_record import DeleteRecordHandler
from apps.tabdata.native.record_io import NativeRecordIO


def _make_user_namespace(user_id: str = "11111111-1111-1111-1111-111111111111"):
    return SimpleNamespace(
        id=user_id,
        pk=user_id,
        is_authenticated=True,
        is_active=True,
    )


class _TabDataRecordApiBase(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._auth_patcher = patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=_make_user_namespace(),
        )
        cls._auth_patcher.start()
        cls._invite_patcher = patch(
            "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
            return_value=True,
        )
        cls._invite_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls._invite_patcher.stop()
        cls._auth_patcher.stop()
        super().tearDownClass()

    def _delete(self, url: str, *, with_auth: bool = True):
        headers = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"} if with_auth else {}
        return self.client.delete(url, **headers)

    def _post(self, url: str, payload: dict, *, with_auth: bool = True):
        headers = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"} if with_auth else {}
        return self.client.post(
            url,
            data=json.dumps(payload),
            content_type="application/json",
            **headers,
        )

    def _put(self, url: str, payload: dict, *, with_auth: bool = True):
        headers = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"} if with_auth else {}
        return self.client.put(
            url,
            data=json.dumps(payload),
            content_type="application/json",
            **headers,
        )

    def _get(self, url: str, *, with_auth: bool = True):
        headers = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"} if with_auth else {}
        return self.client.get(url, **headers)


class TestDeleteRecordApiContract(_TabDataRecordApiBase):
    """TDA-22: DELETE /records/{id} 走 RecordService.delete_record 且成功时 200。"""

    def _successful_delete(self, query: str = ""):
        record_id = uuid4()
        with patch("apps.tabdata.api_record.RecordService") as svc_cls:
            svc = MagicMock()
            svc.delete_record.return_value = True
            svc_cls.return_value = svc

            response = self._delete(f"/api/tabdata/records/{record_id}{query}")

        return record_id, response, svc.delete_record

    def test_legacy_delete_without_expected_version_still_succeeds(self):
        record_id, response, delete_record = self._successful_delete()

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body.get("success"))
        delete_record.assert_called_once()
        self.assertEqual(delete_record.call_args.args[0], record_id)
        self.assertIsNone(delete_record.call_args.kwargs["expected_version"])

    def test_delete_matching_expected_version_is_forwarded_and_succeeds(self):
        _, response, delete_record = self._successful_delete("?expected_version=7")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(delete_record.call_args.kwargs["expected_version"], 7)

    def test_delete_accepts_camel_case_expected_version_alias(self):
        _, response, delete_record = self._successful_delete("?expectedVersion=8")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(delete_record.call_args.kwargs["expected_version"], 8)

    def test_delete_rejects_non_integer_expected_version(self):
        record_id = uuid4()
        with patch("apps.tabdata.api_record.RecordService") as svc_cls:
            response = self._delete(
                f"/api/tabdata/records/{record_id}?expected_version=stale"
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "VALIDATION_ERROR")
        svc_cls.assert_not_called()

    def test_delete_record_lock_contention_returns_retryable_503(self):
        record_id = uuid4()
        db_cause = RuntimeError("canceling statement due to lock timeout")
        db_cause.pgcode = "55P03"
        lock_error = OperationalError("record version allocation failed")
        lock_error.__cause__ = db_cause

        with patch("apps.tabdata.api_record.RecordService") as svc_cls:
            svc_cls.return_value.delete_record.side_effect = lock_error
            response = self._delete(f"/api/tabdata/records/{record_id}")

        self.assertEqual(response.status_code, 503)
        body = response.json()
        self.assertEqual(body["code"], "SAVE_BUSY")
        self.assertEqual(
            body["data"],
            {"retryable": True, "retry_after_ms": 500},
        )

    def test_delete_record_version_conflict_returns_refresh_required_409(self):
        record_id = uuid4()

        with patch("apps.tabdata.api_record.RecordService") as svc_cls:
            svc_cls.return_value.delete_record.side_effect = RecordVersionConflictError(
                record_id,
                expected_version=7,
            )
            response = self._delete(
                f"/api/tabdata/records/{record_id}?expected_version=7"
            )

        self.assertEqual(
            svc_cls.return_value.delete_record.call_args.kwargs["expected_version"],
            7,
        )

        self.assertEqual(response.status_code, 409)
        body = response.json()
        self.assertEqual(body["code"], "VERSION_CONFLICT")
        self.assertEqual(
            body["data"],
            {
                "retryable": False,
                "refresh_required": True,
            },
        )

    def test_delete_record_non_contention_database_error_stays_500(self):
        record_id = uuid4()
        db_cause = RuntimeError("connection failed")
        db_cause.pgcode = "08006"
        db_error = OperationalError("database write failed")
        db_error.__cause__ = db_cause

        with patch("apps.tabdata.api_record.RecordService") as svc_cls:
            svc_cls.return_value.delete_record.side_effect = db_error
            response = self._delete(f"/api/tabdata/records/{record_id}")

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["code"], "INTERNAL_ERROR")


    def test_delete_record_route_declares_conflict_and_busy_responses(self):
        import apps.tabdata.api_record as api_record_mod

        source = inspect.getsource(api_record_mod)
        route_decl = source.split(
            '@router.delete(\n    "/records/{record_id}",',
            maxsplit=1,
        )[1].split("@api_error_handler", maxsplit=1)[0]
        self.assertIn("409: ErrorResponse", route_decl)
        self.assertIn("503: ErrorResponse", route_decl)

    def test_open_delete_record_route_declares_conflict_and_busy_responses(self):
        import apps.tabdata.api_open_space as api_open_space_mod

        source = inspect.getsource(api_open_space_mod)
        route_decl = source.split(
            '@router.delete(\n    "/spaces/{space_id}/data/tables/{table_id}/records/{record_id}",',
            maxsplit=1,
        )[1].split("@require_scope('record:delete')", maxsplit=1)[0]
        self.assertIn("409: dict", route_decl)
        self.assertIn("503: dict", route_decl)


class TestBulkDeleteRecordApiContentionContract(_TabDataRecordApiBase):
    def test_bulk_delete_lock_contention_returns_retryable_503(self):
        db_cause = RuntimeError("canceling statement due to lock timeout")
        db_cause.pgcode = "55P03"
        lock_error = OperationalError("table lock unavailable")
        lock_error.__cause__ = db_cause

        with patch("apps.tabdata.api_record.RecordService") as svc_cls:
            svc_cls.return_value.bulk_delete_records.side_effect = lock_error
            response = self._post(
                "/api/tabdata/records/bulk-delete",
                {"record_ids": [str(uuid4())]},
            )

        self.assertEqual(response.status_code, 503)
        body = response.json()
        self.assertEqual(body["code"], "SAVE_BUSY")
        self.assertEqual(
            body["data"],
            {"retryable": True, "retry_after_ms": 500},
        )

    def test_bulk_delete_non_contention_database_error_stays_500(self):
        db_cause = RuntimeError("connection failed")
        db_cause.pgcode = "08006"
        db_error = OperationalError("database write failed")
        db_error.__cause__ = db_cause

        with patch("apps.tabdata.api_record.RecordService") as svc_cls:
            svc_cls.return_value.bulk_delete_records.side_effect = db_error
            response = self._post(
                "/api/tabdata/records/bulk-delete",
                {"record_ids": [str(uuid4())]},
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["code"], "INTERNAL_ERROR")

    def test_bulk_delete_route_declares_busy_response(self):
        import apps.tabdata.api_record as api_record_mod

        source = inspect.getsource(api_record_mod)
        route_decl = source.split(
            '@router.post(\n    "/records/bulk-delete",',
            maxsplit=1,
        )[1].split("@api_error_handler", maxsplit=1)[0]
        self.assertIn("503: ErrorResponse", route_decl)

    def test_open_bulk_delete_route_declares_busy_response(self):
        import apps.tabdata.api_open_space as api_open_space_mod

        source = inspect.getsource(api_open_space_mod)
        route_decl = source.split(
            '@router.post(\n    "/spaces/{space_id}/data/tables/{table_id}/records/batch-delete",',
            maxsplit=1,
        )[1].split("@require_scope('record:delete')", maxsplit=1)[0]
        self.assertIn("503: dict", route_decl)


class TestUpdateRecordDeleteWinsContract(_TabDataRecordApiBase):
    """旧单条 PUT 在记录已删除时继续收到既有 400 错误 envelope。"""

    deleted_message = "该记录已被其他协作者删除，您刚才的修改未保存"

    def test_internal_update_returns_parseable_400_when_delete_wins(self):
        record_id = uuid4()
        with patch("apps.tabdata.api_record.RecordService") as service_cls:
            # 复现旧实现：生命周期已结束时服务层意外返回 (None, None)。
            service_cls.return_value.update_record.return_value = (None, None)

            response = self._put(
                f"/api/tabdata/records/{record_id}",
                {"data": {"title": "late"}},
            )

        self.assertEqual(response.status_code, 400)
        body = response.json()
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "VALIDATION_ERROR")
        self.assertIn(self.deleted_message, body["message"])

    def test_open_update_returns_parseable_400_when_delete_wins(self):
        from apps.tabdata.api_open_impl.record_impl import update_record_impl
        from apps.tabdata.api_open_schemas import OpenUpdateRecordBody

        table_id = uuid4()
        record_id = uuid4()
        request = SimpleNamespace(auth=_make_user_namespace())
        body = OpenUpdateRecordBody(fields={"title": "late"})

        with (
            patch("apps.tabdata.api_open_impl.record_impl.TableRecord") as record_model,
            patch("apps.tabdata.api_open_impl.record_impl.RLSContext") as rls_context,
            patch("apps.tabdata.api_open_impl.record_impl.RecordService") as service_cls,
        ):
            record_model.objects.using.return_value.filter.return_value.exists.return_value = True
            rls_context.from_request.return_value = MagicMock()
            service_cls.return_value.update_record.return_value = (None, None)

            response = update_record_impl(request, table_id, record_id, body)

        self.assertEqual(response.status_code, 400)
        response_body = json.loads(response.content)
        self.assertFalse(response_body["success"])
        self.assertEqual(response_body["code"], "VALIDATION_ERROR")
        self.assertIn(self.deleted_message, response_body["message"])


class TestOpenRecordIncrementalReloadContract(SimpleTestCase):
    def test_open_query_forwards_physical_delete_reload_signal(self):
        from apps.tabdata.api_open_impl.record_impl import (
            _execute_record_query,
        )

        request = SimpleNamespace(
            auth=_make_user_namespace(),
            headers={},
        )
        with (
            patch(
                "apps.tabdata.api_open_impl.record_impl.RLSContext.from_request",
                return_value=MagicMock(),
            ),
            patch(
                "apps.tabdata.api_open_impl.record_impl.RecordService"
            ) as service_cls,
        ):
            service_cls.return_value.list_records.return_value = {
                "records": [],
                "total": 0,
                "matched_total": 0,
                "latest_version": 12,
                "has_changes": True,
                "requires_full_reload": True,
            }
            response = _execute_record_query(
                request=request,
                table_id=uuid4(),
                page=1,
                page_size=100,
                search=None,
                filter_set=None,
                sort_by=None,
                sort_order="asc",
                field_key_type="id",
                fields_set=None,
                since_version=7,
                only_delta=True,
            )

        self.assertEqual(response.status_code, 200)
        response_body = json.loads(response.content)
        self.assertTrue(response_body["data"]["requires_full_reload"])


class TestUpdateRecordExpectedVersionContract(_TabDataRecordApiBase):
    def _successful_update(self, payload: dict):
        record_id = uuid4()
        with (
            patch("apps.tabdata.api_record.RecordService") as service_cls,
            patch(
                "apps.tabdata.api_record.serialize_record",
                return_value={"id": str(record_id), "version": 8},
            ),
        ):
            service_cls.return_value.update_record.return_value = (MagicMock(), None)
            response = self._put(f"/api/tabdata/records/{record_id}", payload)
        return response, service_cls.return_value.update_record

    def test_legacy_request_passes_none_and_still_succeeds(self):
        response, update_record = self._successful_update({
            "data": {"title": "legacy"},
        })

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(update_record.call_args.kwargs["expected_version"])

    def test_matching_version_is_forwarded_and_succeeds(self):
        response, update_record = self._successful_update({
            "data": {"title": "matched"},
            "expected_version": 7,
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(update_record.call_args.kwargs["expected_version"], 7)

    def test_version_conflict_returns_refresh_required_409(self):
        record_id = uuid4()
        with patch("apps.tabdata.api_record.RecordService") as service_cls:
            service_cls.return_value.update_record.side_effect = RecordVersionConflictError(
                record_id,
                expected_version=7,
            )
            response = self._put(
                f"/api/tabdata/records/{record_id}",
                {"data": {"title": "stale"}, "expected_version": 7},
            )

        self.assertEqual(response.status_code, 409)
        body = response.json()
        self.assertEqual(body["code"], "VERSION_CONFLICT")
        self.assertEqual(
            body["data"],
            {"retryable": False, "refresh_required": True},
        )

    def test_retryable_write_contention_returns_save_busy_503(self):
        record_id = uuid4()

        for sqlstate in ("40P01", "55P03", "40001"):
            with self.subTest(sqlstate=sqlstate):
                db_cause = RuntimeError("retryable PostgreSQL write contention")
                db_cause.pgcode = sqlstate
                db_error = OperationalError("record update failed")
                db_error.__cause__ = db_cause

                with patch("apps.tabdata.api_record.RecordService") as service_cls:
                    service_cls.return_value.update_record.side_effect = db_error
                    response = self._put(
                        f"/api/tabdata/records/{record_id}",
                        {"data": {"title": "retry"}, "expected_version": 7},
                    )

                self.assertEqual(response.status_code, 503)
                body = response.json()
                self.assertEqual(body["code"], "SAVE_BUSY")
                self.assertEqual(
                    body["data"],
                    {"retryable": True, "retry_after_ms": 500},
                )

    def test_non_contention_database_error_stays_500(self):
        record_id = uuid4()
        db_cause = RuntimeError("connection failed")
        db_cause.pgcode = "08006"
        db_error = OperationalError("record update failed")
        db_error.__cause__ = db_cause

        with patch("apps.tabdata.api_record.RecordService") as service_cls:
            service_cls.return_value.update_record.side_effect = db_error
            response = self._put(
                f"/api/tabdata/records/{record_id}",
                {"data": {"title": "fail"}, "expected_version": 7},
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["code"], "INTERNAL_ERROR")


class TestOpenApiRecordErrorContract(SimpleTestCase):
    def test_open_api_delete_keeps_legacy_service_call_without_expected_version(self):
        from apps.tabdata.api_open_impl.record_impl import delete_record_impl

        record_id = uuid4()
        request = SimpleNamespace(auth=_make_user_namespace())

        with (
            patch("apps.tabdata.api_open_impl.record_impl.TableRecord") as record_model,
            patch("apps.tabdata.api_open_impl.record_impl.RLSContext") as rls_context,
            patch("apps.tabdata.api_open_impl.record_impl.RecordService") as service_cls,
        ):
            record_model.objects.using.return_value.filter.return_value.exists.return_value = True
            rls_context.from_request.return_value = MagicMock()
            service_cls.return_value.delete_record.return_value = True

            response = delete_record_impl(request, uuid4(), record_id)

        self.assertEqual(response.status_code, 200)
        service_cls.return_value.delete_record.assert_called_once_with(
            record_id=record_id,
            rls_context=rls_context.from_request.return_value,
        )

    def test_open_api_version_conflict_returns_409(self):
        from apps.tabdata.api_open_impl.record_impl import delete_record_impl

        record_id = uuid4()
        request = SimpleNamespace(auth=_make_user_namespace())

        with (
            patch("apps.tabdata.api_open_impl.record_impl.TableRecord") as record_model,
            patch("apps.tabdata.api_open_impl.record_impl.RLSContext") as rls_context,
            patch("apps.tabdata.api_open_impl.record_impl.RecordService") as service_cls,
        ):
            record_model.objects.using.return_value.filter.return_value.exists.return_value = True
            rls_context.from_request.return_value = MagicMock()
            service_cls.return_value.delete_record.side_effect = RecordVersionConflictError(
                record_id,
                expected_version=3,
            )
            response = delete_record_impl(request, uuid4(), record_id)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(json.loads(response.content)["code"], "VERSION_CONFLICT")

    def test_open_api_lock_contention_returns_503(self):
        from apps.tabdata.api_open_impl.record_impl import delete_record_impl

        record_id = uuid4()
        request = SimpleNamespace(auth=_make_user_namespace())
        db_cause = RuntimeError("canceling statement due to lock timeout")
        db_cause.pgcode = "55P03"
        lock_error = OperationalError("record version allocation failed")
        lock_error.__cause__ = db_cause

        with (
            patch("apps.tabdata.api_open_impl.record_impl.TableRecord") as record_model,
            patch("apps.tabdata.api_open_impl.record_impl.RLSContext") as rls_context,
            patch("apps.tabdata.api_open_impl.record_impl.RecordService") as service_cls,
        ):
            record_model.objects.using.return_value.filter.return_value.exists.return_value = True
            rls_context.from_request.return_value = MagicMock()
            service_cls.return_value.delete_record.side_effect = lock_error
            response = delete_record_impl(request, uuid4(), record_id)

        self.assertEqual(response.status_code, 503)
        body = json.loads(response.content)
        self.assertEqual(body["code"], "SAVE_BUSY")
        self.assertEqual(
            body["data"],
            {"retryable": True, "retry_after_ms": 500},
        )

    def test_open_api_non_contention_database_error_stays_500(self):
        from apps.tabdata.api_open_impl.record_impl import delete_record_impl

        record_id = uuid4()
        request = SimpleNamespace(auth=_make_user_namespace())
        db_cause = RuntimeError("connection failed")
        db_cause.pgcode = "08006"
        db_error = OperationalError("database write failed")
        db_error.__cause__ = db_cause

        with (
            patch("apps.tabdata.api_open_impl.record_impl.TableRecord") as record_model,
            patch("apps.tabdata.api_open_impl.record_impl.RLSContext") as rls_context,
            patch("apps.tabdata.api_open_impl.record_impl.RecordService") as service_cls,
        ):
            record_model.objects.using.return_value.filter.return_value.exists.return_value = True
            rls_context.from_request.return_value = MagicMock()
            service_cls.return_value.delete_record.side_effect = db_error
            response = delete_record_impl(request, uuid4(), record_id)

        self.assertEqual(response.status_code, 500)
        self.assertEqual(json.loads(response.content)["code"], "INTERNAL_ERROR")

    def test_open_api_batch_delete_lock_contention_returns_503(self):
        from apps.tabdata.api_open_impl.record_impl import batch_delete_records_impl
        from apps.tabdata.api_open_schemas import BulkDeleteBody

        request = SimpleNamespace(auth=_make_user_namespace())
        db_cause = RuntimeError("deadlock detected")
        db_cause.pgcode = "40P01"
        lock_error = OperationalError("deadlock detected")
        lock_error.__cause__ = db_cause

        with (
            patch("apps.tabdata.api_open_impl.record_impl.TableRecord") as record_model,
            patch("apps.tabdata.api_open_impl.record_impl.RLSContext") as rls_context,
            patch("apps.tabdata.api_open_impl.record_impl.RecordService") as service_cls,
        ):
            record_model.objects.using.return_value.filter.return_value.values_list.return_value = []
            rls_context.from_request.return_value = MagicMock()
            service_cls.return_value.bulk_delete_records.side_effect = lock_error
            response = batch_delete_records_impl(
                request,
                uuid4(),
                BulkDeleteBody(record_ids=[str(uuid4())]),
            )

        self.assertEqual(response.status_code, 503)
        body = json.loads(response.content)
        self.assertEqual(body["code"], "SAVE_BUSY")
        self.assertEqual(
            body["data"],
            {"retryable": True, "retry_after_ms": 500},
        )


class TestOpenApiRecordErrorDocumentation(SimpleTestCase):
    """无需历史 Space fixture 的纯契约测试，确保导出的错误语义可执行。"""

    def test_developer_contract_documents_delete_conflict_and_busy(self):
        from apps.tabdata.api_open import _build_table_developer_contract

        payload = _build_table_developer_contract(
            uuid4(),
            "Orders",
            base_path="/api/open/v1/organizations/org/data",
        )
        error_codes = {item["code"]: item for item in payload["error_codes"]}

        self.assertEqual(error_codes["VERSION_CONFLICT"]["http_status"], 409)
        self.assertFalse(error_codes["VERSION_CONFLICT"]["retryable"])
        self.assertTrue(error_codes["VERSION_CONFLICT"]["refresh_required"])
        self.assertEqual(
            error_codes["VERSION_CONFLICT"]["applies_to"],
            ["deleteRecord"],
        )
        self.assertEqual(error_codes["SAVE_BUSY"]["http_status"], 503)
        self.assertTrue(error_codes["SAVE_BUSY"]["retryable"])
        self.assertEqual(error_codes["SAVE_BUSY"]["retry_after_ms"], 500)
        self.assertEqual(
            error_codes["SAVE_BUSY"]["applies_to"],
            ["deleteRecord", "batchDeleteRecords"],
        )

    def test_openapi_spec_documents_delete_conflict_and_batch_busy(self):
        from apps.tabdata.api_open import _build_table_openapi_spec

        payload = _build_table_openapi_spec(
            uuid4(),
            "Orders",
            base_path="/api/open/v1/organizations/org/data",
        )
        delete_responses = payload["paths"][
            "/tables/{table_id}/records/{record_id}"
        ]["delete"]["responses"]

        self.assertEqual(
            delete_responses["409"]["content"]["application/json"]["schema"],
            {"$ref": "#/components/schemas/ErrorEnvelope"},
        )
        self.assertEqual(
            delete_responses["503"]["content"]["application/json"]["schema"],
            {"$ref": "#/components/schemas/ErrorEnvelope"},
        )
        self.assertNotIn(
            "503",
            payload["paths"]["/tables/{table_id}/records/upsert"]["post"][
                "responses"
            ],
        )
        self.assertIn(
            "503",
            payload["paths"]["/tables/{table_id}/records/batch-delete"]["post"][
                "responses"
            ],
        )
        self.assertIn(
            "data",
            payload["components"]["schemas"]["ErrorEnvelope"]["properties"],
        )


class TestDeleteRecordNativeVersion(SimpleTestCase):
    """TDA-22 根因：native soft_delete 乐观锁必须匹配行上当前 version。"""

    def test_native_soft_delete_ignores_projection_version_drift(self):
        table_id = uuid4()
        record_id = uuid4()
        now = datetime.now(timezone.utc)
        existing = RecordSnapshot(
            id=record_id,
            table_id=table_id,
            formatted_data={"名称": "探针A"},
            version=3,
            created_by="user-1",
            updated_by="user-1",
            created_at=now,
            updated_at=now,
        )

        handler = DeleteRecordHandler(
            record_repository=MagicMock(),
            native_io=MagicMock(),
            unit_of_work=MagicMock(),
            event_bus=MagicMock(),
            field_repository=MagicMock(),
            link_service=MagicMock(),
            cascade_service=MagicMock(),
            attachment_service=MagicMock(),
        )
        handler._repo.get_by_id.return_value = existing
        handler._repo.get_by_id_for_update.return_value = existing
        handler._repo.next_version.return_value = 4
        handler._prepare_native_io = MagicMock()
        handler._link_svc.cleanup_record_links.return_value = []
        handler._handle_cascade_after_delete = MagicMock()
        handler._should_publish_event = MagicMock(return_value=False)
        handler._publish_cross_table_ws = MagicMock()
        handler._uow.with_transaction = lambda fn: fn()

        context = RecordCommandContext(
            table_id=table_id,
            record_id=record_id,
            user_id="user-1",
        )
        self.assertTrue(handler.handle(context))

        handler._native_io.delete_record.assert_called_once()
        self.assertEqual(
            handler._native_io.delete_record.call_args.kwargs["version"],
            0,
            "显式删除应按 ID 无条件清理 native 投影",
        )
        handler._repo.mark_delete_version.assert_called_once_with(table_id, 4)

    def test_native_version_miss_raises_typed_record_conflict(self):
        record_id = uuid4()
        native_io = object.__new__(NativeRecordIO)
        native_io.db_alias = "tabdata"
        native_io.qualified = '"test_schema"."test_table"'

        cursor = MagicMock()
        cursor.rowcount = 0
        connection = MagicMock()
        connection.cursor.return_value.__enter__.return_value = cursor

        with patch("apps.tabdata.native.record_io.connections") as connections:
            connections.__getitem__.return_value = connection
            with self.assertRaises(RecordVersionConflictError) as raised:
                native_io.delete_record(
                    record_id=record_id,
                    version=9,
                )

        self.assertEqual(raised.exception.record_id, record_id)
        self.assertEqual(raised.exception.expected_version, 9)


class TestRecordUpsertEndpointRegistered(SimpleTestCase):
    def test_agent_jwt_upsert_route_registered(self):
        import apps.tabdata.api_record as api_record_mod

        src = inspect.getsource(api_record_mod)
        self.assertIn('"/records/upsert"', src)
        self.assertIn("upsert_records_impl", src)


class TestRestoreRouteSplit(SimpleTestCase):
    """历史还原保留独立的 /restore-history 路径。"""

    def test_history_restore_moved_to_restore_history(self):
        import apps.tabdata.api_undo_redo as undo_mod

        src = inspect.getsource(undo_mod)
        self.assertIn('"/records/{record_id}/restore-history"', src)
        self.assertNotIn('"/records/{record_id}/restore"', src)
        self.assertIn("restore_record_to_history", src)
