"""Agent MCP 只读同步：dispatch_user_electron_query + HTTP 路由契约。

覆盖：
1. 无 Electron → DEVICE_RUNTIME_UNAVAILABLE（409）
2. DB online 但 WS 未连 → DEVICE_RUNTIME_OFFLINE（409）
3. mock transport 成功 → success + connections；params 带权威 agent_id
4. 禁止按组织捞他人 Electron
5. router：无设备 409；成功 200 + connections envelope

纯 mock，不碰 Redis。
"""

from __future__ import annotations

import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4


def _ensure_django():
    root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, os.pardir, os.pardir)
    )
    if root not in sys.path:
        sys.path.insert(0, root)
    if "DJANGO_SETTINGS_MODULE" not in os.environ:
        os.environ["DJANGO_SETTINGS_MODULE"] = "tabtin.settings"
    import django
    from django.apps import apps

    if not apps.ready:
        django.setup()


_ensure_django()

from django.test import RequestFactory, SimpleTestCase

from apps.services.agent_engine.services.device_runtime_query_service import (
    DeviceRuntimeQueryService,
)

AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def _make_service(*, connected_fps=None, publish_result=None):
    """构造全 mock 的 service：transport 可注入。"""
    service = DeviceRuntimeQueryService.__new__(DeviceRuntimeQueryService)
    service.user = SimpleNamespace(id="u1")
    published = {}
    connected = set(connected_fps or [])

    class _FakeTransport:
        def is_device_connected(self, fp):
            return fp in connected

        def bind_action_device(self, thread_id, fp):
            published["bound_fp"] = fp

        def publish_device_action(self, fp, envelope):
            published["fp"] = fp
            published["envelope"] = envelope
            return 1

        def wait_for_result(self, thread_id, task_id, timeout):
            if publish_result is not None:
                return publish_result
            return {
                "success": True,
                "data": {
                    "connections": [
                        {
                            "id": "conn-1",
                            "name": "GitHub",
                            "enabled": True,
                            "transportKind": "stdio",
                        }
                    ]
                },
            }

        def force_release_action_device(self, thread_id):
            pass

        def check_task_dedup(self, task_id):
            return True

        def buffer_action(self, fp, envelope):
            pass

    service._transport = _FakeTransport()
    service._dispatch = MagicMock()
    return service, published


class DispatchUserElectronQueryTests(SimpleTestCase):
    def test_no_electron_returns_unavailable(self):
        service, published = _make_service()
        with patch.object(
            DeviceRuntimeQueryService,
            "_resolve_user_online_electron",
            return_value=(None, "unavailable"),
        ):
            result = service.dispatch_user_electron_query(
                agent_id=AGENT_ID,
                action="mcp.list_agent_attachments",
            )
        assert result["success"] is False
        assert result["error_code"] == "DEVICE_RUNTIME_UNAVAILABLE"
        assert result["http_status"] == 409
        assert "envelope" not in published

    def test_offline_ws_returns_offline(self):
        service, published = _make_service(connected_fps=[])
        device = SimpleNamespace(
            fingerprint="electron-fp-1",
            organization_id="org-1",
        )
        with patch.object(
            DeviceRuntimeQueryService,
            "_resolve_user_online_electron",
            return_value=(device, "offline"),
        ):
            result = service.dispatch_user_electron_query(
                agent_id=AGENT_ID,
                action="mcp.list_agent_attachments",
            )
        assert result["success"] is False
        assert result["error_code"] == "DEVICE_RUNTIME_OFFLINE"
        assert result["http_status"] == 409
        assert "envelope" not in published

    def test_success_dispatches_to_user_electron_with_agent_id(self):
        service, published = _make_service(connected_fps=["electron-fp-1"])
        device = SimpleNamespace(
            fingerprint="electron-fp-1",
            organization_id="org-1",
        )
        with patch.object(
            DeviceRuntimeQueryService,
            "_resolve_user_online_electron",
            return_value=(device, "ok"),
        ):
            result = service.dispatch_user_electron_query(
                agent_id=AGENT_ID,
                action="mcp.list_agent_attachments",
                params={"agent_id": "forged-id"},
            )
        assert result["success"] is True
        assert published["fp"] == "electron-fp-1"
        params = published["envelope"]["payload"]["params"]
        assert params["agent_id"] == AGENT_ID
        assert result["data"]["connections"][0]["name"] == "GitHub"

    def test_unknown_action_rejected(self):
        service, _ = _make_service()
        result = service.dispatch_user_electron_query(
            agent_id=AGENT_ID,
            action="mcp.attach_connection",
        )
        assert result["success"] is False
        assert result["error_code"] == "VALIDATION_ERROR"

    def test_resolve_only_queries_current_user_devices(self):
        """#7529：解析时 filter 必须带 user_id=self.user，不按 org 捞人。"""
        service, _ = _make_service(connected_fps=["mine-fp"])
        mine = SimpleNamespace(
            fingerprint="mine-fp",
            organization_id="org-1",
            user_id="u1",
        )
        filter_kwargs = {}

        class _QS:
            def filter(self, **kwargs):
                filter_kwargs.update(kwargs)
                return self

            def order_by(self, *a):
                return self

            def __getitem__(self, sl):
                return [mine]

        with patch(
            "apps.tabtinspace.models.Device",
            SimpleNamespace(objects=_QS()),
        ):
            device, status = service._resolve_user_online_electron()

        assert status == "ok"
        assert device is mine
        assert filter_kwargs.get("user_id") == "u1"
        assert filter_kwargs.get("device_type") == "electron"
        assert "organization_id" not in filter_kwargs
        assert "organization" not in filter_kwargs


class LocalMcpAttachmentsRouterTests(SimpleTestCase):
    def setUp(self):
        self.rf = RequestFactory()
        self.user = SimpleNamespace(id="u1")
        self.agent_id = uuid4()

    def _auth_request(self):
        req = self.rf.get(f"/api/context/agents/{self.agent_id}/local-mcp/attachments")
        req.auth = self.user
        return req

    def test_router_no_electron_returns_409(self):
        from apps.tabtinspace.routers.agent import list_agent_local_mcp_attachments

        with patch(
            "apps.services.agent_engine.services.device_runtime_query_service"
            ".DeviceRuntimeQueryService"
        ) as svc_cls, patch(
            "apps.tabtinspace.services.AgentService"
        ) as agent_svc:
            agent_svc.return_value.get_agent.return_value = SimpleNamespace(
                id=self.agent_id
            )
            svc_cls.return_value.dispatch_user_electron_query.return_value = {
                "success": False,
                "error": "当前没有可用的在线 Electron 设备来执行该查询",
                "error_code": "DEVICE_RUNTIME_UNAVAILABLE",
                "http_status": 409,
            }
            resp = list_agent_local_mcp_attachments(self._auth_request(), self.agent_id)

        assert resp.status_code == 409
        body = json.loads(resp.content.decode("utf-8"))
        assert body["success"] is False
        assert body["code"] == "DEVICE_RUNTIME_UNAVAILABLE"

    def test_router_success_returns_connections(self):
        from apps.tabtinspace.routers.agent import list_agent_local_mcp_attachments

        connections = [
            {
                "id": "c1",
                "name": "Notion",
                "enabled": True,
                "transportKind": "http",
            }
        ]
        with patch(
            "apps.services.agent_engine.services.device_runtime_query_service"
            ".DeviceRuntimeQueryService"
        ) as svc_cls, patch(
            "apps.tabtinspace.services.AgentService"
        ) as agent_svc:
            agent_svc.return_value.get_agent.return_value = SimpleNamespace(
                id=self.agent_id
            )
            svc_cls.return_value.dispatch_user_electron_query.return_value = {
                "success": True,
                "data": {"connections": connections},
                "device_fingerprint": "electron-fp-1",
            }
            resp = list_agent_local_mcp_attachments(self._auth_request(), self.agent_id)

        assert isinstance(resp, dict)
        assert resp["success"] is True
        assert resp["data"]["connections"] == connections

    def test_router_agent_not_found(self):
        from apps.tabtinspace.routers.agent import list_agent_local_mcp_attachments

        with patch("apps.tabtinspace.services.AgentService") as agent_svc:
            agent_svc.return_value.get_agent.return_value = None
            resp = list_agent_local_mcp_attachments(self._auth_request(), self.agent_id)

        assert resp.status_code == 404
