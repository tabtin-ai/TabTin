"""fix: electron forward 按 Agent 显式绑定的 control_device 路由（跨 organization）。

回归场景：team-space Agent 的 control_device 是用户注册在 personal organization 的
Electron。原先 `_route_to_device` 只按 space.organization 查 electron → 跨 organization
查不到 → published=0（@AI / Tracker 对这类 Agent 全失败）。修复后按显式 control_device
直发。

纯 mock，不碰 DB（可在 sqlite 下跑）。
"""

import os
import sys
from types import SimpleNamespace
from unittest.mock import patch


def _ensure_django():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, os.pardir, os.pardir))
    if root not in sys.path:
        sys.path.insert(0, root)
    if "DJANGO_SETTINGS_MODULE" not in os.environ:
        os.environ["DJANGO_SETTINGS_MODULE"] = "tabtin.settings"
    import django
    from django.apps import apps
    if not apps.ready:
        django.setup()


_ensure_django()

from apps.services.agent_engine.services.prompt_forward_service import (
    PromptForwardService,
    _thread_binding_keys,
)

_RCD = "apps.tabtinspace.services.execution_binding.resolve_control_device"


_OWNER = "user-owner-1"
_OTHER = "user-other-2"


def test_resolve_electron_control_fp_online_electron():
    dev = SimpleNamespace(
        device_type="electron", status="online", fingerprint="electron-xyz", user_id=_OWNER,
    )
    with patch(_RCD, return_value=dev):
        fp = PromptForwardService._resolve_electron_control_fingerprint(
            None, agent_id="a1", execution_owner_user_id=_OWNER,
        )
    assert fp == "electron-xyz"


def test_resolve_electron_control_fp_busy_ok():
    dev = SimpleNamespace(
        device_type="electron", status="busy", fingerprint="electron-b", user_id=_OWNER,
    )
    with patch(_RCD, return_value=dev):
        assert PromptForwardService._resolve_electron_control_fingerprint(
            None, agent_id="a1", execution_owner_user_id=_OWNER,
        ) == "electron-b"


def test_resolve_electron_control_fp_skips_non_electron():
    dev = SimpleNamespace(
        device_type="daemon", status="online", fingerprint="daemon-1", user_id=_OWNER,
    )
    with patch(_RCD, return_value=dev):
        assert PromptForwardService._resolve_electron_control_fingerprint(
            None, agent_id="a1", execution_owner_user_id=_OWNER,
        ) is None


def test_resolve_electron_control_fp_skips_offline():
    dev = SimpleNamespace(
        device_type="electron", status="offline", fingerprint="e1", user_id=_OWNER,
    )
    with patch(_RCD, return_value=dev):
        assert PromptForwardService._resolve_electron_control_fingerprint(
            None, agent_id="a1", execution_owner_user_id=_OWNER,
        ) is None


def test_resolve_electron_control_fp_none_device():
    with patch(_RCD, return_value=None):
        assert PromptForwardService._resolve_electron_control_fingerprint(
            None, agent_id="a1", execution_owner_user_id=_OWNER,
        ) is None


def test_resolve_electron_control_fp_rejects_other_user_same_machine():
    """#6799：同物理机异账号——Workspace.device 归属他人时不得路由。"""
    dev = SimpleNamespace(
        device_type="electron",
        status="online",
        fingerprint="electron-shared-machine",
        user_id=_OTHER,
    )
    with patch(_RCD, return_value=dev):
        assert PromptForwardService._resolve_electron_control_fingerprint(
            None, agent_id="a1", execution_owner_user_id=_OWNER,
        ) is None


def test_resolve_electron_control_fp_rejects_missing_owner():
    """#6799：未传执行主人时 fail-closed，避免账号切换后按 fingerprint 误投。"""
    dev = SimpleNamespace(
        device_type="electron", status="online", fingerprint="electron-xyz", user_id=_OWNER,
    )
    with patch(_RCD, return_value=dev):
        assert PromptForwardService._resolve_electron_control_fingerprint(
            None, agent_id="a1", execution_owner_user_id=None,
        ) is None


def test_route_to_device_prefers_explicit_electron_control():
    """跨 organization：daemon 解析为空 → electron 按显式 control_device 直发 → published=1。"""
    electron = SimpleNamespace(
        device_type="electron", status="online", fingerprint="electron-ctrl", user_id=_OWNER,
    )
    svc = PromptForwardService()
    space = SimpleNamespace(organization_id="team-A")  # 与设备 organization 不同也无妨（修复点）
    with patch(_RCD, return_value=electron), \
         patch("apps.services.agent_engine.services.prompt_forward_service.is_device_ws_connected", return_value=True), \
         patch.object(PromptForwardService, "_try_publish", return_value=True) as mock_pub, \
         patch.object(PromptForwardService, "_bind_action_device_for_thread") as mock_bind:
        published = svc._route_to_device(
            "thread-1", space, {"type": "x"},
            reliable=True, agent_id="a1", execution_owner_user_id=_OWNER,
        )
    assert published == 1
    mock_pub.assert_called_once()
    mock_bind.assert_called_once_with("thread-1", "electron-ctrl")


def test_route_to_device_no_org_electron_fallback():
    """#7529：无显式 control_device 时即使同 org 有 online Electron，也不兜底投递。"""
    svc = PromptForwardService()
    space = SimpleNamespace(organization_id="team-A")
    with patch(_RCD, return_value=None), \
         patch("apps.services.agent_engine.services.prompt_forward_service.is_device_ws_connected", return_value=True), \
         patch.object(PromptForwardService, "_try_publish", return_value=True) as mock_pub, \
         patch("apps.tabtinspace.models.Device") as mock_device_model:
        mock_device_model.objects.filter.return_value.values_list.return_value.first.return_value = (
            "electron-org-stranger"
        )
        published = svc._route_to_device(
            "thread-1", space, {"type": "x"},
            reliable=True, agent_id="a1", execution_owner_user_id=_OWNER,
        )
    assert published == 0
    mock_pub.assert_not_called()
    mock_device_model.objects.filter.assert_not_called()


def test_route_to_device_rejects_cross_user_workspace_device():
    """#6799：Workspace.device 指向同机另一账号 Device → published=0。"""
    electron = SimpleNamespace(
        device_type="electron",
        status="online",
        fingerprint="electron-shared-machine",
        user_id=_OTHER,
    )
    svc = PromptForwardService()
    space = SimpleNamespace(organization_id="team-A")
    with patch(_RCD, return_value=electron), \
         patch("apps.services.agent_engine.services.prompt_forward_service.is_device_ws_connected", return_value=True), \
         patch.object(PromptForwardService, "_try_publish", return_value=True) as mock_pub:
        published = svc._route_to_device(
            "thread-1", space, {"type": "x"},
            reliable=True, agent_id="a1", execution_owner_user_id=_OWNER,
        )
    assert published == 0
    mock_pub.assert_not_called()


def test_thread_binding_keys_cover_raw_and_chat_session_forms():
    assert _thread_binding_keys("sess-1") == ["sess-1", "chat-session-sess-1"]
    assert _thread_binding_keys("chat-session-sess-1") == ["chat-session-sess-1", "sess-1"]


def test_bind_action_device_for_thread_writes_both_thread_forms():
    calls: list[tuple[str, str]] = []

    class FakeTransport:
        def bind_action_device(self, thread_id, device_fingerprint):
            calls.append((thread_id, device_fingerprint))

    with patch(
        "apps.services.agent_engine.services.prompt_forward_service.ActionTransportService",
        return_value=FakeTransport(),
    ):
        PromptForwardService._bind_action_device_for_thread("chat-session-sess-1", "electron-ctrl")

    assert calls == [
        ("chat-session-sess-1", "electron-ctrl"),
        ("sess-1", "electron-ctrl"),
    ]


def test_probe_execution_device_reachable_electron_online():
    electron = SimpleNamespace(
        device_type="electron", status="online", fingerprint="e-online", user_id=_OWNER,
    )
    with (
        patch(_RCD, return_value=electron),
        patch(
            "apps.services.agent_engine.services.prompt_forward_service.is_daemon_ws_connected",
            return_value=False,
        ),
        patch(
            "apps.services.agent_engine.services.prompt_forward_service.is_device_ws_connected",
            return_value=True,
        ),
    ):
        result = PromptForwardService.probe_execution_device_reachable(
            None, agent_id="a1", execution_owner_user_id=_OWNER,
        )
    assert result == {
        "reachable": True,
        "error_category": None,
        "runtime": "electron",
    }


def test_probe_execution_device_reachable_offline():
    electron = SimpleNamespace(
        device_type="electron", status="offline", fingerprint="e-off", user_id=_OWNER,
    )
    with (
        patch(_RCD, return_value=electron),
        patch(
            "apps.services.agent_engine.services.prompt_forward_service.is_daemon_ws_connected",
            return_value=False,
        ),
        patch(
            "apps.services.agent_engine.services.prompt_forward_service.is_device_ws_connected",
            return_value=False,
        ),
    ):
        result = PromptForwardService.probe_execution_device_reachable(
            None, agent_id="a1", execution_owner_user_id=_OWNER,
        )
    assert result["reachable"] is False
    assert result["error_category"] == "device_offline"
    assert result["runtime"] is None
