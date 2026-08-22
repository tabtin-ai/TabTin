from __future__ import annotations

import logging
import uuid
from functools import lru_cache
from typing import Any, Dict, FrozenSet, Optional

from apps.services.common.agent_protocol.namespace import action_event_type
from apps.services.agent_engine.services.action_transport_service import ActionTransportService
from apps.services.agent_engine.services.device_dispatch_service import DeviceDispatchService
from apps.services.common.ws.protocol import build_envelope, new_event_id
from apps.tabtinspace.models import Workspace

logger = logging.getLogger(__name__)


#: UI 级设备查询 action 白名单。
#:
#: 与 device 域 mobile 工具（``tool_registry``）区隔：这些不是 LLM 工具，
#: 而是远端客户端的只读 UI 请求：
#: - ``fs.*``：远程文件浏览
#: - ``mcp.list_agent_attachments``：查询当前用户在线 Electron 上某 Agent
#:   已挂载且启用的 MCP 摘要（Agent MCP 只读同步）
#:
#: 权限口径：只读 → Space / Agent viewer 即可（routers 做映射）。
UI_QUERY_ACTIONS: FrozenSet[str] = frozenset({
    "fs.list_dir",
    "fs.read_file_preview",
    "mcp.list_agent_attachments",
})

#: 需要服务端注入权威 working_dir 边界的 fs.* UI 查询。
_FS_UI_QUERY_ACTIONS: FrozenSet[str] = frozenset({
    "fs.list_dir",
    "fs.read_file_preview",
})

#: SessionShare 窄预览内部 action（不进通用 /devices/query UI 白名单）。
SHARED_SESSION_FS_ACTIONS: FrozenSet[str] = frozenset({
    "fs.read_file_preview",
    "fs.materialize_file_ref",
    "fs.restore_file_from_url",
})

_RESULT_META_KEYS = frozenset({
    "device_fingerprint",
    "device_type",
    "dispatch_reason",
    "required_capability",
    "binding_source",
})


@lru_cache(maxsize=1)
def _build_allowed_actions() -> FrozenSet[str]:
    """Derive allowed device actions from the tool registry (single source of truth)."""
    from apps.services.tools.domains.device.tool_registry import get_all_tools

    return frozenset(t.name for t in get_all_tools()) | UI_QUERY_ACTIONS


def get_allowed_device_query_actions() -> FrozenSet[str]:
    return _build_allowed_actions()


class DeviceRuntimeQueryService:
    """为 CLI 等无线程调用方提供 Space 级设备能力查询。"""

    def __init__(self, user) -> None:
        self.user = user
        self._transport = ActionTransportService()
        self._dispatch = DeviceDispatchService()

    def dispatch_space_action(
        self,
        *,
        space_id: str,
        action: str,
        params: Optional[Dict[str, Any]] = None,
        timeout_seconds: int = 60,
        required_role: str = "viewer",
    ) -> Dict[str, Any]:
        if not space_id:
            return self._error("VALIDATION_ERROR", "space_id is required", 400)

        if not action:
            return self._error("VALIDATION_ERROR", "action is required", 400)

        if action not in get_allowed_device_query_actions():
            return self._error("VALIDATION_ERROR", f"unsupported device query action: {action}", 400)

        space = (
            Workspace.objects
            .select_related("device")
            .filter(id=space_id)
            .first()
        )
        if space is None:
            return self._error("NOT_FOUND", "Workspace 不存在", 404)

        if str(space.created_by_id) != str(getattr(self.user, "id", "")):
            return self._error("PERMISSION_DENIED", "当前用户无权访问该 Workspace", 403)

        params = dict(params or {})
        if action in _FS_UI_QUERY_ACTIONS:
            # ：fs.* 远程文件浏览的路径边界必须用**服务端权威**的
            # working_dir（Space/Agent 绑定），不能信客户端 params——执行侧
            # （Electron bridge / DaemonActionBridge）以 ``_working_dir`` 为
            # 唯一 boundary root 做 read 判定。缺 working_dir 直接拒绝。
            # 注意：mcp.* 等同属 UI_QUERY_ACTIONS，但不走 working_dir 注入。
            working_dir = str(getattr(space, "working_dir", "") or "")
            if not working_dir:
                return self._error(
                    "WORKING_DIR_NOT_SET",
                    "该 Workspace 尚未设置工作目录，无法浏览设备文件",
                    409,
                )
            params["_working_dir"] = working_dir
            params["_space_id"] = str(space.id)

        return self._dispatch_to_workspace_device(
            workspace=space,
            action=action,
            params=params,
            user_id=str(getattr(self.user, "id", "") or "") or None,
            timeout_seconds=timeout_seconds,
            thread_prefix="tin-device-cli",
            allow_session_electron=(action in UI_QUERY_ACTIONS),
            strip_result_meta=False,
        )

    def dispatch_user_electron_query(
        self,
        *,
        agent_id: str,
        action: str,
        params: Optional[Dict[str, Any]] = None,
        timeout_seconds: int = 20,
    ) -> Dict[str, Any]:
        """向**当前用户自己的**在线 Electron 派发 UI 级设备查询。

        用于手机只读同步 Agent 在本机 Electron 已挂载的 MCP
        （``mcp.list_agent_attachments``）。

        安全边界（对齐 ）：
        - 只解析 ``Device.user_id == self.user`` 且 ``device_type=electron``
          的 online/busy 设备；
        - **禁止**回退到组织内其他人的 Electron。
        """
        if not agent_id:
            return self._error("VALIDATION_ERROR", "agent_id is required", 400)
        if not action:
            return self._error("VALIDATION_ERROR", "action is required", 400)
        if action not in UI_QUERY_ACTIONS:
            return self._error(
                "VALIDATION_ERROR",
                f"unsupported device query action: {action}",
                400,
            )

        # 服务端权威写入 agent_id，避免客户端漏传或伪造。
        params = dict(params or {})
        params["agent_id"] = str(agent_id)

        device, resolve_status = self._resolve_user_online_electron()
        result_meta = {
            "device_fingerprint": getattr(device, "fingerprint", None) if device else None,
            "device_type": "electron",
            "dispatch_reason": "user_owned_electron",
            "required_capability": None,
            "binding_source": "user_device",
        }
        if resolve_status == "unavailable":
            return self._error(
                "DEVICE_RUNTIME_UNAVAILABLE",
                "当前没有可用的在线 Electron 设备来执行该查询",
                409,
                degraded=True,
                **result_meta,
            )
        if resolve_status == "offline" or device is None:
            return self._error(
                "DEVICE_RUNTIME_OFFLINE",
                "目标 Electron 设备当前未在线或未建立 device_runtime 连接",
                409,
                degraded=True,
                **result_meta,
            )

        runtime_fp = str(getattr(device, "fingerprint", "") or "")
        if not runtime_fp:
            return self._error(
                "DEVICE_RUNTIME_UNAVAILABLE",
                "当前没有可用的在线 Electron 设备来执行该查询",
                409,
                degraded=True,
                **result_meta,
            )

        return self._publish_and_wait(
            runtime_fp=runtime_fp,
            action=action,
            params=params,
            timeout_seconds=timeout_seconds,
            thread_prefix="tin-user-electron",
            organization_id=str(getattr(device, "organization_id", "") or "") or None,
            result_meta=result_meta,
            strip_result_meta=False,
        )

    def dispatch_owner_workspace_fs_action(
        self,
        *,
        workspace: Workspace,
        action: str,
        params: Optional[Dict[str, Any]] = None,
        execution_owner_user_id: str,
        timeout_seconds: int = 60,
    ) -> Dict[str, Any]:
        """以 owner 执行身份向绑定设备派发 SessionShare 文件预览 action。

        调用方必须已完成 SessionShare / session owner 鉴权；本方法不再做
        ``created_by`` 门禁，避免把 grantee 加成 Workspace 成员。
        """
        if action not in SHARED_SESSION_FS_ACTIONS:
            return self._error(
                "VALIDATION_ERROR",
                f"unsupported shared-session fs action: {action}",
                400,
            )
        if workspace is None:
            return self._error("NOT_FOUND", "Workspace 不存在", 404)

        working_dir = str(getattr(workspace, "working_dir", "") or "")
        if not working_dir:
            return self._error(
                "WORKING_DIR_NOT_SET",
                "该 Workspace 尚未设置工作目录，无法预览设备文件",
                409,
            )

        params = dict(params or {})
        params["_working_dir"] = working_dir
        params["_space_id"] = str(workspace.id)

        return self._dispatch_to_workspace_device(
            workspace=workspace,
            action=action,
            params=params,
            user_id=str(execution_owner_user_id or "") or None,
            timeout_seconds=timeout_seconds,
            thread_prefix="tin-shared-fs",
            allow_session_electron=True,
            strip_result_meta=True,
        )

    def _dispatch_to_workspace_device(
        self,
        *,
        workspace: Workspace,
        action: str,
        params: Dict[str, Any],
        user_id: Optional[str],
        timeout_seconds: int,
        thread_prefix: str,
        allow_session_electron: bool,
        strip_result_meta: bool,
    ) -> Dict[str, Any]:
        decision = self._dispatch.resolve_space_target(
            workspace,
            action,
            user_id=user_id,
        )
        result_meta = {
            "device_fingerprint": decision.device_fingerprint,
            "device_type": decision.device_type,
            "dispatch_reason": decision.reason,
            "required_capability": decision.required_capability,
            "binding_source": decision.binding_source,
        }

        runtime_fp = decision.device_fingerprint
        # ：UI 级 fs.* 查询也接受绑定设备为 Electron 的情形——
        # DEVICE_RUNTIME_TYPES 只含 daemon/cloud，Electron 绑定的 Space 在
        # resolve_space_target 里会落到 kind="session_electron"（reason=
        # control_device_no_runtime）但 fingerprint 指向绑定的 Electron 设备。
        # Electron 主进程订阅了自己的 device action topic（ElectronAgentService
        # + device-file-action-bridge），能收本 envelope 并回结果，链路成立。
        dispatchable = decision.kind == "device_runtime" or (
            allow_session_electron
            and decision.kind == "session_electron"
            and decision.device_type == "electron"
        )
        if not dispatchable or not runtime_fp:
            return self._error(
                "DEVICE_RUNTIME_UNAVAILABLE",
                "当前 Space 没有可用的能力设备来执行该查询",
                409,
                degraded=True,
                **result_meta,
            )

        if not self._transport.is_device_connected(runtime_fp):
            return self._error(
                "DEVICE_RUNTIME_OFFLINE",
                "目标能力设备当前未在线或未建立 device_runtime 连接",
                409,
                degraded=True,
                **result_meta,
            )

        return self._publish_and_wait(
            runtime_fp=runtime_fp,
            action=action,
            params=params,
            timeout_seconds=timeout_seconds,
            thread_prefix=thread_prefix,
            organization_id=str(getattr(workspace, "organization_id", "") or "") or None,
            result_meta=result_meta,
            strip_result_meta=strip_result_meta,
        )

    def _resolve_user_online_electron(self) -> tuple[Optional[Any], str]:
        """解析当前用户自己的 online/busy Electron（WS 已连接优先）。

        Returns:
            (device, status)：status 为 ``ok`` / ``offline`` / ``unavailable``。
            - unavailable：用户名下无 online/busy 的 Electron
            - offline：DB 显示在线但 WS 未连接
            - ok：找到可派发设备
        """
        from apps.tabtinspace.models import Device

        user_id = getattr(self.user, "id", None)
        if not user_id:
            return None, "unavailable"

        # 硬约束：只查自己的设备，绝不按 organization 捞别人的 Electron。
        candidates = list(
            Device.objects.filter(
                user_id=user_id,
                device_type="electron",
                status__in=("online", "busy"),
                control_status="active",
            )
            .order_by("-last_heartbeat_at", "-updated_at")[:20]
        )
        if not candidates:
            return None, "unavailable"

        for device in candidates:
            fp = str(getattr(device, "fingerprint", "") or "")
            if fp and self._transport.is_device_connected(fp):
                return device, "ok"
        return candidates[0], "offline"

    def _publish_and_wait(
        self,
        *,
        runtime_fp: str,
        action: str,
        params: Dict[str, Any],
        timeout_seconds: int,
        thread_prefix: str,
        organization_id: Optional[str],
        result_meta: Dict[str, Any],
        strip_result_meta: bool,
    ) -> Dict[str, Any]:
        """向指定设备 fingerprint 发布 action 并等待结果。"""
        task_id = f"{action}_{uuid.uuid4().hex[:16]}"
        thread_id = f"{thread_prefix}-{uuid.uuid4().hex}"
        event_id = new_event_id()
        payload = {
            "task_id": task_id,
            "action": action,
            "params": params,
            "thread_id": thread_id,
        }
        envelope = build_envelope(
            action_event_type("request"),
            event_id,
            payload,
            event_id=event_id,
            thread_id=thread_id,
            organization_id=organization_id,
        )

        try:
            self._transport.bind_action_device(thread_id, runtime_fp)
            published = self._transport.publish_device_action(runtime_fp, envelope)
            if not published:
                # DEV-P1-10: publish 失败时才 buffer，且先做去重检查
                if self._transport.check_task_dedup(task_id):
                    self._transport.buffer_action(runtime_fp, envelope)
                logger.warning(
                    "[DeviceRuntimeQueryService] publish failed, buffered for reconnect: fp=%s task=%s",
                    runtime_fp, task_id,
                )
                return self._error(
                    "DEVICE_ACTION_DELIVERY_FAILED",
                    "设备动作下发失败（已缓冲待重连），请稍后重试",
                    502,
                    degraded=True,
                    **result_meta,
                )

            # DEV-P1-10: publish 成功后不再做二次 is_device_connected 检查 + buffer，
            # 避免同一 envelope 被 publish 和 buffer 双路径投递导致 double-execution。
            # 若设备在 publish 后瞬间断线，依赖设备 ACK 或 wait_for_result 超时处理。

            result = self._transport.wait_for_result(thread_id, task_id, timeout_seconds)
            if result is None:
                return self._error(
                    "TASK_TIMEOUT",
                    f"等待设备响应超时（{timeout_seconds}s），设备可能在断线恢复后延迟返回结果",
                    504,
                    degraded=True,
                    **result_meta,
                )

            if isinstance(result, dict):
                if strip_result_meta:
                    # SessionShare 预览：不向外透出设备指纹等执行现场细节。
                    return {
                        k: v for k, v in result.items() if k not in _RESULT_META_KEYS
                    }
                return {**result, **result_meta}
            return self._error(
                "BACKEND_ERROR",
                "设备返回了无法识别的响应",
                502,
                degraded=True,
                **result_meta,
            )
        except (TimeoutError, ConnectionError, BrokenPipeError) as exc:
            logger.warning(
                "[DeviceRuntimeQueryService] dispatch connection/timeout error: %s", exc,
                exc_info=True,
            )
            return self._error(
                "BACKEND_ERROR",
                f"设备通信异常: {exc}",
                504,
                degraded=True,
                **result_meta,
            )
        except Exception as exc:
            logger.critical("[DeviceRuntimeQueryService] dispatch failed: %s", exc, exc_info=True)
            return self._error(
                "BACKEND_ERROR",
                f"设备查询失败: {exc}",
                500,
                degraded=True,
                **result_meta,
            )
        finally:
            self._transport.force_release_action_device(thread_id)

    @staticmethod
    def _error(code: str, message: str, http_status: int, **extra: Any) -> Dict[str, Any]:
        return {
            "success": False,
            "error": message,
            "error_code": code,
            "http_status": http_status,
            **extra,
        }


__all__ = [
    "UI_QUERY_ACTIONS",
    "SHARED_SESSION_FS_ACTIONS",
    "get_allowed_device_query_actions",
    "DeviceRuntimeQueryService",
]
