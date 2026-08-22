from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, Optional

from apps.services.agent_engine.services.action_transport_service import ActionTransportService
from apps.services.agent_engine.services.device_dispatch_service import DeviceDispatchService
from apps.services.common.agent_protocol.namespace import action_event_type
from apps.services.common.ws.protocol import build_envelope, new_event_id
from apps.tabtinspace.models import Workspace

logger = logging.getLogger(__name__)


class VideoRenderDispatchService:
    """TabVideo 服务端出片到 daemon/headless action 的专用分发服务。"""

    def __init__(self, user=None) -> None:
        self.user = user
        self._transport = ActionTransportService()
        self._dispatch = DeviceDispatchService()

    def dispatch_video_action(
        self,
        *,
        space_id: str,
        action: str,
        params: Optional[Dict[str, Any]] = None,
        timeout_seconds: int = 30 * 60,
        required_role: str = "editor",
    ) -> Dict[str, Any]:
        if not space_id:
            return self._error("VALIDATION_ERROR", "space_id is required", 400)
        if not action:
            return self._error("VALIDATION_ERROR", "action is required", 400)

        space = (
            Workspace.objects
            .select_related("device")
            .filter(id=space_id)
            .first()
        )
        if space is None:
            return self._error("NOT_FOUND", "当前项目未关联可用的导出空间，无法执行视频导出。", 404)

        if self.user is not None and str(space.created_by_id) != str(self.user.id):
            return self._error("PERMISSION_DENIED", "当前用户无权在该 Workspace 导出视频", 403)

        user_id = str(getattr(self.user, "id", "") or "") or None
        decision = self._dispatch.resolve_space_target(space, action, user_id=user_id)
        expected_capability = self._expected_capability(action)
        result_meta = {
            "device_fingerprint": decision.device_fingerprint,
            "device_type": decision.device_type,
            "dispatch_reason": decision.reason,
            "required_capability": decision.required_capability or expected_capability,
            "binding_source": decision.binding_source,
        }

        if expected_capability and decision.required_capability != expected_capability:
            logger.error(
                "[VideoRenderDispatchService] action capability mapping missing/mismatched: action=%s expected=%s actual=%s",
                action, expected_capability, decision.required_capability,
            )
            return self._error(
                "VIDEO_RENDER_CAPABILITY_UNREGISTERED",
                f"视频导出能力映射异常：{action} 未正确声明为 {expected_capability}，请更新 action manifest 或设备能力注册。",
                500,
                degraded=True,
                **result_meta,
            )

        runtime_fp = decision.device_fingerprint
        if decision.kind != "device_runtime" or not runtime_fp:
            return self._error(
                "VIDEO_RENDER_DEVICE_UNAVAILABLE",
                "当前项目没有可用的后台导出设备，请绑定或启动具备视频导出能力的设备后重试。",
                409,
                degraded=True,
                **result_meta,
            )

        if not self._transport.is_device_connected(runtime_fp):
            return self._error(
                "VIDEO_RENDER_DEVICE_OFFLINE",
                "目标视频导出设备当前未在线，请启动后台导出服务后重试。",
                409,
                degraded=True,
                **result_meta,
            )

        runtime_timeout_ms = max(1, int(timeout_seconds * 1000))
        action_params = dict(params or {})
        action_params.setdefault("timeout_ms", runtime_timeout_ms)

        task_id = f"{action}_{uuid.uuid4().hex[:16]}"
        thread_id = f"tin-video-render-{uuid.uuid4().hex}"
        event_id = new_event_id()
        payload = {
            "task_id": task_id,
            "action": action,
            "params": action_params,
            "thread_id": thread_id,
            "timeout_ms": runtime_timeout_ms,
        }
        envelope = build_envelope(
            action_event_type("request"),
            event_id,
            payload,
            event_id=event_id,
            thread_id=thread_id,
            organization_id=str(getattr(space, "organization_id", "") or "") or None,
        )

        try:
            self._transport.bind_action_device(thread_id, runtime_fp)
            published = self._transport.publish_device_action(runtime_fp, envelope)
            if not published:
                if self._transport.check_task_dedup(task_id):
                    self._transport.buffer_action(runtime_fp, envelope)
                return self._error(
                    "VIDEO_RENDER_DELIVERY_FAILED",
                    "视频导出任务下发失败（已缓冲待设备重连），请稍后重试。",
                    502,
                    degraded=True,
                    **result_meta,
                )

            result = self._transport.wait_for_result(thread_id, task_id, timeout_seconds)
            if result is None:
                return self._error(
                    "VIDEO_RENDER_TIMEOUT",
                    f"等待视频导出设备响应超时（{timeout_seconds}s）。",
                    504,
                    degraded=True,
                    **result_meta,
                )

            if isinstance(result, dict):
                return {**result, **result_meta}
            return self._error(
                "VIDEO_RENDER_BAD_RESPONSE",
                "视频导出设备返回了无法识别的响应。",
                502,
                degraded=True,
                **result_meta,
            )
        except (TimeoutError, ConnectionError, BrokenPipeError) as exc:
            logger.warning("[VideoRenderDispatchService] dispatch transport error: %s", exc, exc_info=True)
            return self._error(
                "VIDEO_RENDER_TRANSPORT_ERROR",
                f"视频导出设备通信异常: {exc}",
                504,
                degraded=True,
                **result_meta,
            )
        except Exception as exc:
            logger.critical("[VideoRenderDispatchService] dispatch failed: %s", exc, exc_info=True)
            return self._error(
                "VIDEO_RENDER_DISPATCH_FAILED",
                f"视频导出任务分发失败: {exc}",
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

    @staticmethod
    def _expected_capability(action: str) -> Optional[str]:
        if action == "tabvideo_export":
            return "video_export"
        return None


__all__ = ["VideoRenderDispatchService"]
