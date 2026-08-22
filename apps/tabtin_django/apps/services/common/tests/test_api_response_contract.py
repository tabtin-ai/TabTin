from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.test import Client, SimpleTestCase, override_settings
from django.urls import path
from ninja import NinjaAPI, Router

from apps.i18n.response import validation_error_response as i18n_validation_error_response
from apps.services.common.api.router_factory import TabTinRouter
from apps.skills.api import router as skills_router
from apps.tabdata.api_helpers import validation_error_response as tabdata_validation_error_response


legacy_router = Router(tags=["ContractTestLegacy"])


@legacy_router.get("/legacy-error", response={200: dict})
def legacy_error(request):
    return i18n_validation_error_response("space_id is required")


test_api = NinjaAPI(
    title="ApiResponseContractTestAPI",
    urls_namespace="api_response_contract_test",
)
test_api.add_router("/contract", legacy_router)
test_api.add_router("/skills", skills_router)
urlpatterns = [path("api/", test_api.urls)]


def _fake_user():
    user_id = uuid.uuid4()
    return SimpleNamespace(id=user_id, is_authenticated=True, pk=user_id)


class ApiResponseContractTest(SimpleTestCase):
    def test_i18n_error_helper_returns_json_response(self):
        response = i18n_validation_error_response("space_id is required")

        self.assertEqual(response.status_code, 400)
        body = json.loads(response.content)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "VALIDATION_ERROR")
        self.assertEqual(body["data"]["detail"], "space_id is required")

    def test_i18n_validation_error_can_add_recovery_data_without_changing_envelope(self):
        response = i18n_validation_error_response(
            "版本号 0.0.3 已存在，请使用新的版本号",
            data={
                "reason": "skill_version_conflict",
                "latest_version": "0.0.3",
                "suggested_patch_version": "0.0.4",
            },
        )

        self.assertEqual(response.status_code, 400)
        body = json.loads(response.content)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "VALIDATION_ERROR")
        self.assertEqual(body["data"]["detail"], "版本号 0.0.3 已存在，请使用新的版本号")
        self.assertEqual(body["data"]["latest_version"], "0.0.3")
        self.assertEqual(body["data"]["suggested_patch_version"], "0.0.4")

    def test_tabdata_error_helper_returns_json_response(self):
        response = tabdata_validation_error_response("record_ids is required")

        self.assertEqual(response.status_code, 400)
        body = json.loads(response.content)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "VALIDATION_ERROR")

    @override_settings(ROOT_URLCONF="apps.services.common.tests.test_api_response_contract")
    def test_legacy_router_error_response_bypasses_ninja_response_schema(self):
        response = Client().get("/api/contract/legacy-error")

        self.assertEqual(response.status_code, 400)
        body = response.json()
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "VALIDATION_ERROR")

    def test_tabtin_router_injects_default_error_response_schemas(self):
        router = TabTinRouter(tags=["ContractTest"])

        @router.get("/contract", response={200: dict})
        def contract(request):
            return {"ok": True}

        operation = router.path_operations["/contract"].operations[0]
        response_statuses = set(operation.response_models.keys())

        self.assertTrue({200, 400, 401, 403, 404, 409, 422, 500}.issubset(response_statuses))

    @override_settings(ROOT_URLCONF="apps.services.common.tests.test_api_response_contract")
    def test_skill_disable_reads_space_id_from_json_body(self):
        space_id = str(uuid.uuid4())
        user = _fake_user()

        with patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=user,
        ), patch(
            "apps.skills.api._check_space_viewer",
            return_value=True,
        ), patch(
            "apps.skills.api.SkillService.disable_skill",
            return_value=True,
        ) as disable_skill:
            response = Client().post(
                "/api/skills/platform:device/operations/disable",
                data=json.dumps({"space_id": space_id}),
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer test-token",
            )

        self.assertEqual(response.status_code, 200)
        disable_skill.assert_called_once()
        self.assertEqual(disable_skill.call_args.kwargs["space_id"], space_id)
        self.assertEqual(
            disable_skill.call_args.kwargs["skill_canonical_key"],
            "platform:device/operations",
        )
