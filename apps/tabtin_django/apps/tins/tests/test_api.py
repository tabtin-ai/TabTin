"""Tins API 集成测试。

使用独立的 NinjaAPI 实例 + mock JWTAuth.authenticate 绕过真实 JWT 校验。
"""

from __future__ import annotations

import json
import uuid
from unittest.mock import patch, MagicMock

from django.test import TestCase, Client, override_settings
from django.urls import path
from ninja import NinjaAPI

from apps.tins.api import router as tins_router
from apps.tins.models import Tin, TinInstance, TinRunLog
from apps.tins.services.tin_service import TinService, TinInstanceService

_test_api = NinjaAPI(title="TinsTestAPI", urls_namespace="tins_test")
_test_api.add_router("/tins", tins_router)

urlpatterns = [path("api/", _test_api.urls)]

_fake_user_id = uuid.uuid4()


def _make_fake_user():
    user = MagicMock()
    user.id = _fake_user_id
    user.is_authenticated = True
    user.pk = _fake_user_id
    return user


_fake_user = _make_fake_user()


def _ws():
    return uuid.uuid4()


def _auth_patcher():
    """Mock JWTAuth.authenticate to return our fake user."""
    return patch(
        "apps.users.auth.permissions.JWTAuth.authenticate",
        return_value=_fake_user,
    )


@override_settings(ROOT_URLCONF="apps.tins.tests.test_api")
class TinsAPIPermissionTest(TestCase):
    """权限校验、header 校验。"""
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()

    def test_missing_organization_id_returns_400(self):
        with _auth_patcher():
            resp = self.client.get(
                "/api/tins/tins",
                HTTP_AUTHORIZATION="Bearer test-token",
            )
        self.assertEqual(resp.status_code, 400)

    def test_invalid_organization_id_returns_400(self):
        with _auth_patcher():
            resp = self.client.get(
                "/api/tins/tins",
                HTTP_AUTHORIZATION="Bearer test-token",
                HTTP_X_ORGANIZATION_ID="not-a-uuid",
            )
        self.assertEqual(resp.status_code, 400)

    @patch("apps.tins.api._parse_request_context")
    def test_forbidden_organization_returns_403(self, mock_ctx):
        from apps.tabdata.api_helpers import error_response
        mock_ctx.return_value = (None, error_response("PERMISSION_DENIED", "权限不足", status_code=403))
        with _auth_patcher():
            resp = self.client.get(
                "/api/tins/tins",
                HTTP_AUTHORIZATION="Bearer test-token",
                HTTP_X_ORGANIZATION_ID=str(uuid.uuid4()),
            )
        self.assertEqual(resp.status_code, 403)


@override_settings(ROOT_URLCONF="apps.tins.tests.test_api")
class TinsAPICRUDTest(TestCase):
    """CRUD + 分页 + Schema 格式测试。"""
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        self.ws = _ws()
        self.space = uuid.uuid4()

    def _request(self, method, url, data=None):
        with _auth_patcher(), \
             patch("apps.tins.api._parse_request_context", return_value=(self.ws, None)), \
             patch("apps.tins.api._ensure_space"):
            fn = getattr(self.client, method)
            kwargs = {
                "HTTP_AUTHORIZATION": "Bearer test-token",
                "HTTP_X_ORGANIZATION_ID": str(self.ws),
                "content_type": "application/json",
            }
            if data is not None:
                kwargs["data"] = json.dumps(data)
            return fn(url, **kwargs)

    # ── create_tin: source 硬编码 ─────────────

    def test_create_tin_source_hardcoded(self):
        resp = self._request("post", "/api/tins/tins", data={
            "name": "My Tin",
            "description": "desc",
        })
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body.get("success"))
        tin_data = body["data"]
        self.assertEqual(tin_data["source"], "user_created")
        self.assertEqual(tin_data["name"], "My Tin")
        self.assertIn("panel_html", tin_data)
        self.assertIn("manifest", tin_data)

    # ── list_tins: 分页 ──────────────────────

    def test_list_tins_pagination(self):
        for i in range(5):
            TinService.create_tin(organization_id=self.ws, data={"name": f"Tin {i}", "source": "user_created"})

        resp = self._request("get", "/api/tins/tins?offset=0&limit=2")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()["data"]
        self.assertEqual(len(body["tins"]), 2)
        self.assertEqual(body["total"], 5)
        self.assertTrue(body["has_more"])

        resp2 = self._request("get", "/api/tins/tins?offset=4&limit=2")
        body2 = resp2.json()["data"]
        self.assertEqual(len(body2["tins"]), 1)
        self.assertFalse(body2["has_more"])

    # ── list_instances: TinInstanceListOut 格式 ──

    def test_list_instances_schema(self):
        tin = TinService.create_tin(organization_id=self.ws, data={
            "name": "Schema Tin",
            "panel_html": "<h1>Panel</h1>",
            "content_script": "console.log('cs')",
            "background_script": "console.log('bg')",
            "source": "user_created",
        })
        TinService.activate_tin(tin)
        TinInstanceService.install_tin(
            tin=tin, space_id=self.space, organization_id=self.ws,
        )

        resp = self._request("get", f"/api/tins/instances?space_id={self.space}")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()["data"]
        self.assertEqual(body["total"], 1)
        inst = body["instances"][0]

        self.assertIn("tin", inst)
        self.assertEqual(inst["tin"]["panel_html"], "<h1>Panel</h1>")
        self.assertEqual(inst["tin"]["content_script"], "console.log('cs')")
        self.assertNotIn("background_script", inst["tin"])
        self.assertNotIn("agent_instructions", inst["tin"])

    # ── TinOut Literal 类型输出 ──────────────

    def test_tin_out_literal_fields(self):
        TinService.create_tin(organization_id=self.ws, data={
            "name": "Literal Test",
            "source": "user_created",
        })
        resp = self._request("get", "/api/tins/tins")
        body = resp.json()["data"]
        t = body["tins"][0]
        self.assertIn(t["status"], ["draft", "active", "disabled"])
        self.assertIn(t["source"], ["agent_generated", "user_created", "market", "shared"])
        self.assertIn(t["activation_mode"], ["auto", "suggest", "manual"])
        self.assertIn(t["activation_match"], ["any", "all"])
        self.assertIn(t["panel_position"], ["sidebar_right", "sidebar_left", "bottom_panel", "overlay"])

    # ── install_tin: space 归属校验 ──────

    def test_install_tin_foreign_space_returns_400(self):
        """space_id 不属于 organization 时应返回 400。"""
        tin = TinService.create_tin(organization_id=self.ws, data={
            "name": "Foreign Space Test", "source": "user_created",
        })
        TinService.activate_tin(tin)
        foreign_space = uuid.uuid4()

        with _auth_patcher(), \
             patch("apps.tins.api._parse_request_context", return_value=(self.ws, None)), \
             patch("apps.tins.api._ensure_space", side_effect=ValueError("智能体空间不存在")):
            resp = self.client.post(
                "/api/tins/instances",
                data=json.dumps({
                    "tin_id": str(tin.id),
                    "space_id": str(foreign_space),
                }),
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer test-token",
                HTTP_X_ORGANIZATION_ID=str(self.ws),
            )
        self.assertEqual(resp.status_code, 400)

    # ── list_instances: space 归属校验 ──

    def test_list_instances_foreign_space_returns_400(self):
        """space_id 不属于 organization 时应返回 400。"""
        foreign_space = uuid.uuid4()

        with _auth_patcher(), \
             patch("apps.tins.api._parse_request_context", return_value=(self.ws, None)), \
             patch("apps.tins.api._ensure_space", side_effect=ValueError("智能体空间不存在")):
            resp = self.client.get(
                f"/api/tins/instances?space_id={foreign_space}",
                HTTP_AUTHORIZATION="Bearer test-token",
                HTTP_X_ORGANIZATION_ID=str(self.ws),
            )
        self.assertEqual(resp.status_code, 400)

    # ── list_run_logs offset 分页 ─────────────

    def test_list_run_logs_offset_pagination(self):
        tin = TinService.create_tin(organization_id=self.ws, data={
            "name": "Log Tin", "source": "user_created",
        })
        inst = TinInstanceService.install_tin(
            tin=tin, space_id=self.space, organization_id=self.ws,
        )
        for i in range(5):
            TinInstanceService.log_run(inst, "script_run", input_data={"i": i})

        resp = self._request("get", f"/api/tins/instances/{inst.id}/logs?offset=0&limit=2")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()["data"]
        self.assertEqual(len(body["logs"]), 2)
        self.assertEqual(body["total"], 5)
        self.assertTrue(body["has_more"])

        resp2 = self._request("get", f"/api/tins/instances/{inst.id}/logs?offset=4&limit=2")
        body2 = resp2.json()["data"]
        self.assertEqual(len(body2["logs"]), 1)
        self.assertFalse(body2["has_more"])
