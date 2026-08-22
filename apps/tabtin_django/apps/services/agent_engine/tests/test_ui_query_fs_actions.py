"""：/devices/query 的 UI 级 fs.* 白名单与权威 working_dir 注入。

覆盖：
1. 白名单：fs.list_dir / fs.read_file_preview 在允许集合内；未知 action 被拒。
2. 权威注入：dispatch 前服务端把 Space 绑定的 working_dir / space_id 覆写进
   params（``_working_dir`` / ``_space_id``），客户端伪造值被覆盖。
3. working_dir 未设 → WORKING_DIR_NOT_SET，不发任何设备指令。
4. Electron 绑定设备（DispatchDecision kind="session_electron"、
   device_type="electron"）对 fs.* 可派发；非 fs.* 维持原行为（拒绝）。

纯 mock，不碰 DB / Redis（可在 sqlite 下跑）。
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

from apps.services.agent_engine.services.device_dispatch_service import DispatchDecision
from apps.services.agent_engine.services.device_runtime_query_service import (
    UI_QUERY_ACTIONS,
    DeviceRuntimeQueryService,
    get_allowed_device_query_actions,
)

_MOD = "apps.services.agent_engine.services.device_runtime_query_service"

SPACE_ID = "11111111-1111-1111-1111-111111111111"


def _make_space(working_dir="/Users/alice/proj", agent_working_dir=""):
    return SimpleNamespace(
        id=SPACE_ID,
        organization_id="wt-1",
        working_dir=working_dir,
        created_by_id="u1",
        agent=SimpleNamespace(working_dir=agent_working_dir),
    )


def _make_service(space, decision, connected=True):
    """构造全 mock 的 service：Space 查询 / 权限 / dispatch / transport 全替身。"""
    service = DeviceRuntimeQueryService.__new__(DeviceRuntimeQueryService)
    service.user = SimpleNamespace(id="u1")

    published = {}

    class _FakeTransport:
        def is_device_connected(self, fp):
            return connected

        def bind_action_device(self, thread_id, fp):
            published["bound_fp"] = fp

        def publish_device_action(self, fp, envelope):
            published["fp"] = fp
            published["envelope"] = envelope
            return 1

        def wait_for_result(self, thread_id, task_id, timeout):
            return {"success": True, "entries": []}

        def force_release_action_device(self, thread_id):
            pass

    class _FakeDispatch:
        def resolve_space_target(self, sp, action, user_id=None):
            return decision

    class _FakeAccess:
        def check_space_permission(self, space_id, required_role="viewer"):
            return True

    service._transport = _FakeTransport()
    service._dispatch = _FakeDispatch()
    service._access = _FakeAccess()
    return service, published


def _patch_space(space):
    # 模块已迁到 Workspace（Space 仅为过渡产品语言）；mock 对象名须对齐导入。
    qs = SimpleNamespace(
        select_related=lambda *a: qs,
        filter=lambda **kw: qs,
        first=lambda: space,
    )
    return patch(f"{_MOD}.Workspace", SimpleNamespace(objects=qs))


_RUNTIME_DECISION = DispatchDecision(
    kind="device_runtime",
    reason="bound_runtime_device",
    device_fingerprint="daemon-fp-1",
    device_type="daemon",
)

_ELECTRON_DECISION = DispatchDecision(
    kind="session_electron",
    reason="control_device_no_runtime",
    device_fingerprint="electron-fp-1",
    device_type="electron",
)


def test_whitelist_contains_fs_actions():
    allowed = get_allowed_device_query_actions()
    assert UI_QUERY_ACTIONS <= allowed
    assert "mcp.list_agent_attachments" in UI_QUERY_ACTIONS
    assert "mcp.list_agent_attachments" in allowed


def test_materialize_not_in_public_devices_query_whitelist():
    """#8767：物化 action 仅走 SessionShare 窄 API，不得进通用 /devices/query。"""
    from apps.services.agent_engine.services.device_runtime_query_service import (
        SHARED_SESSION_FS_ACTIONS,
    )

    allowed = get_allowed_device_query_actions()
    assert "fs.materialize_file_ref" in SHARED_SESSION_FS_ACTIONS
    assert "fs.materialize_file_ref" not in UI_QUERY_ACTIONS
    assert "fs.materialize_file_ref" not in allowed


def test_unknown_action_rejected():
    space = _make_space()
    service, _ = _make_service(space, _RUNTIME_DECISION)
    with _patch_space(space):
        result = service.dispatch_space_action(space_id=SPACE_ID, action="fs.not_a_thing")
    assert result["success"] is False
    assert result["error_code"] == "VALIDATION_ERROR"


def test_fs_action_injects_authoritative_working_dir():
    space = _make_space(working_dir="/srv/authoritative")
    service, published = _make_service(space, _RUNTIME_DECISION)
    with _patch_space(space):
        result = service.dispatch_space_action(
            space_id=SPACE_ID,
            action="fs.list_dir",
            # 客户端伪造的 _working_dir 必须被服务端覆盖
            params={"path": "/srv/authoritative/sub", "_working_dir": "/etc"},
        )
    assert result["success"] is True
    params = published["envelope"]["payload"]["params"]
    assert params["_working_dir"] == "/srv/authoritative"
    assert params["_space_id"] == SPACE_ID
    assert params["path"] == "/srv/authoritative/sub"


def test_fs_action_does_not_fall_back_to_agent_working_dir():
    """Workspace 单根契约：只认 workspace.working_dir，不再回退 agent.working_dir。"""
    space = _make_space(working_dir="", agent_working_dir="/home/bob/wd")
    service, published = _make_service(space, _RUNTIME_DECISION)
    with _patch_space(space):
        result = service.dispatch_space_action(
            space_id=SPACE_ID, action="fs.list_dir", params={"path": "/home/bob/wd"},
        )
    assert result["success"] is False
    assert result["error_code"] == "WORKING_DIR_NOT_SET"
    assert "envelope" not in published


def test_fs_action_without_working_dir_rejected():
    space = _make_space(working_dir="", agent_working_dir="")
    service, published = _make_service(space, _RUNTIME_DECISION)
    with _patch_space(space):
        result = service.dispatch_space_action(
            space_id=SPACE_ID, action="fs.list_dir", params={"path": "/tmp"},
        )
    assert result["success"] is False
    assert result["error_code"] == "WORKING_DIR_NOT_SET"
    assert "envelope" not in published  # 没发任何设备指令


def test_fs_action_dispatchable_to_electron_bound_device():
    space = _make_space()
    service, published = _make_service(space, _ELECTRON_DECISION)
    with _patch_space(space):
        result = service.dispatch_space_action(
            space_id=SPACE_ID, action="fs.list_dir", params={"path": "/Users/alice/proj"},
        )
    assert result["success"] is True
    assert published["fp"] == "electron-fp-1"


def test_non_fs_action_still_rejected_on_electron_decision():
    """非 fs.* 的 mobile 工具在 session_electron decision 下维持原有拒绝行为。"""
    space = _make_space()
    service, _ = _make_service(space, _ELECTRON_DECISION)
    allowed = get_allowed_device_query_actions() - UI_QUERY_ACTIONS
    if not allowed:  # 环境没注册 mobile 工具时跳过
        return
    action = sorted(allowed)[0]
    with _patch_space(space):
        result = service.dispatch_space_action(space_id=SPACE_ID, action=action)
    assert result["success"] is False
    assert result["error_code"] == "DEVICE_RUNTIME_UNAVAILABLE"


def test_fs_action_offline_device_reports_offline():
    space = _make_space()
    service, _ = _make_service(space, _RUNTIME_DECISION, connected=False)
    with _patch_space(space):
        result = service.dispatch_space_action(
            space_id=SPACE_ID, action="fs.list_dir", params={"path": "/Users/alice/proj"},
        )
    assert result["success"] is False
    assert result["error_code"] == "DEVICE_RUNTIME_OFFLINE"
