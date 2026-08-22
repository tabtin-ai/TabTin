from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal, Optional

from apps.services.common.execution_agent_cache import get_cached_execution_agent_id
from apps.services.common.device_capability_registry import (
    DEVICE_AVAILABLE_STATUSES,
    DEVICE_RUNTIME_TYPES,
    classify_capability_category,
    get_capability_transport,
    get_tool_capability_map,
    has_capability,
    normalize_device_capabilities,
)
from apps.tabtinspace.services.execution_binding import resolve_execution_binding

logger = logging.getLogger(__name__)

THREAD_CTX_CACHE_TTL = 60  # _get_thread_context 缓存 60s，与 _resolve_daemon_info 一致
_THREAD_CTX_NONE_SENTINEL = "__thread_ctx_none__"

DispatchTargetKind = Literal["server", "session_electron", "device_runtime", "blocked"]

FallbackPolicy = Literal["electron_ok", "device_only", "wait_required"]

DEVICE_FALLBACK_POLICY: dict[str, FallbackPolicy] = {
    "terminal_execute": "device_only",
    "terminal_read": "device_only",
    "terminal_write": "device_only",
    "file": "device_only",
    "code_search": "device_only",
    "git": "device_only",
    "ssh": "device_only",
    "video_render_mg": "device_only",
    "video_export": "device_only",
    "browser": "electron_ok",
    "mcp": "electron_ok",
    # data device (mobile/iot) 能力全部不可降级
    "device_info": "device_only",
    "battery": "device_only",
    "network_info": "device_only",
    "health": "device_only",
    "location": "device_only",
    "contacts": "device_only",
    "sms_read": "device_only",
    "sms_send": "device_only",
    "call_log": "device_only",
    "phone_call": "device_only",
    "calendar": "device_only",
    "notification": "device_only",
    "app_list": "device_only",
    "media_read": "device_only",
    "media_read_video": "device_only",
    "screen_capture": "device_only",
    "screen_ui_tree": "device_only",
    "screen_input": "device_only",
    "app_management": "device_only",
    "system_settings": "device_only",
}

_DEFAULT_FALLBACK_POLICY: FallbackPolicy = "electron_ok"


@dataclass(frozen=True)
class DispatchDecision:
    kind: DispatchTargetKind
    reason: str
    required_capability: Optional[str] = None
    device_fingerprint: Optional[str] = None
    device_type: Optional[str] = None
    binding_source: Optional[str] = None
    error: Optional[str] = None


class DeviceDispatchService:
    """动作分发层：只负责决定谁来执行。"""

    def resolve_action_target(self, thread_id: str, action_type: Optional[str]) -> DispatchDecision:
        session, space = self._get_thread_context(thread_id)
        explicit_agent_id = self._get_explicit_agent_id_for_thread(thread_id)
        user_id = str(getattr(session, "user_id", "") or "") or None
        if not user_id:
            user_id = self._get_context_user_id_for_thread(thread_id)

        if space is None:
            required_capability = self._resolve_required_capability(action_type)
            if explicit_agent_id:
                return self.resolve_space_target(
                    None,
                    action_type,
                    user_id=user_id,
                    agent_id=explicit_agent_id,
                )
            policy = DEVICE_FALLBACK_POLICY.get(
                required_capability or "", _DEFAULT_FALLBACK_POLICY,
            )
            if policy == "device_only":
                return DispatchDecision(
                    kind="blocked",
                    reason="space_not_found_no_fallback",
                    required_capability=required_capability,
                    error="space_not_found",
                )
            return DispatchDecision(
                kind="session_electron",
                reason="space_not_found",
                required_capability=required_capability,
            )

        return self.resolve_space_target(
            space,
            action_type,
            user_id=user_id,
            agent_id=explicit_agent_id,
        )

    def resolve_space_target(
        self,
        space,
        action_type: Optional[str],
        *,
        user_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> DispatchDecision:
        binding = resolve_execution_binding(space=space, agent_id=agent_id)
        device = binding.device
        required_capability = self._resolve_required_capability(action_type)
        capability_category = (
            classify_capability_category(required_capability)
            if required_capability
            else None
        )
        capability_transport = (
            get_capability_transport(required_capability)
            if required_capability
            else None
        )

        if capability_transport == "session_electron":
            return DispatchDecision(
                kind="session_electron",
                reason="session_capability_transport",
                required_capability=required_capability,
                device_fingerprint=getattr(device, "fingerprint", None) if device is not None else None,
                device_type=getattr(device, "device_type", None) if device is not None else None,
                binding_source=binding.source,
            )

        fallback_reason = "no_control_device"
        fallback_fp = None
        fallback_device_type = None

        if device is not None:
            device_type = getattr(device, "device_type", None)
            raw_capabilities = getattr(device, "capabilities", None)
            fallback_fp = getattr(device, "fingerprint", None)
            fallback_device_type = device_type

            # W13 D6 短期实施：busy 视为可用，不再因 busy 把 control device
            if getattr(device, "status", None) not in DEVICE_AVAILABLE_STATUSES:
                fallback_reason = "device_offline"
            elif device_type not in DEVICE_RUNTIME_TYPES:
                fallback_reason = "control_device_no_runtime"
            else:
                capabilities = normalize_device_capabilities(
                    raw_capabilities,
                    device_type=device_type,
                )
                if required_capability and not has_capability(capabilities, required_capability):
                    logger.info(
                        "[DeviceDispatch] bound device lacks capability %s, trying organization capability device: type=%s fp=%s",
                        required_capability,
                        device_type,
                        getattr(device, "fingerprint", None),
                    )
                    fallback_reason = "capability_mismatch"
                else:
                    return DispatchDecision(
                        kind="device_runtime",
                        reason="bound_runtime_device",
                        required_capability=required_capability,
                        device_fingerprint=getattr(device, "fingerprint", None),
                        device_type=device_type,
                        binding_source=binding.source,
                    )

        if space is not None and capability_category == "data" and required_capability:
            data_device = self._pick_organization_data_device(
                space=space,
                user_id=user_id,
                required_capability=required_capability,
                exclude_device_id=str(getattr(device, "id", "") or "") or None,
            )
            if data_device is not None:
                return DispatchDecision(
                    kind="device_runtime",
                    reason="organization_data_device",
                    required_capability=required_capability,
                    device_fingerprint=getattr(data_device, "fingerprint", None),
                    device_type=getattr(data_device, "device_type", None),
                    binding_source="organization.data_device",
                )

        policy = DEVICE_FALLBACK_POLICY.get(
            required_capability or "", _DEFAULT_FALLBACK_POLICY,
        )
        if policy == "device_only":
            logger.info(
                "[DeviceDispatch] capability %s requires device runtime, but no qualified runtime is available "
                "(reason=%s fp=%s); "
                "refusing silent fallback to Electron",
                required_capability,
                fallback_reason,
                fallback_fp,
            )
            return DispatchDecision(
                kind="blocked",
                reason=f"{fallback_reason}_no_fallback",
                required_capability=required_capability,
                device_fingerprint=fallback_fp,
                device_type=fallback_device_type,
                binding_source=binding.source,
                error=fallback_reason,
            )

        return DispatchDecision(
            kind="session_electron",
            reason=fallback_reason,
            required_capability=required_capability,
            device_fingerprint=fallback_fp,
            device_type=fallback_device_type,
            binding_source=binding.source,
        )

    @staticmethod
    def _resolve_required_capability(action_type: Optional[str]) -> Optional[str]:
        if not action_type:
            return None
        return get_tool_capability_map().get(action_type)

    @staticmethod
    def _get_context_space_for_thread(thread_id: str):
        try:
            from apps.services.common.thread_context import (
                get_current_space_id,
                get_current_thread_id,
            )
            from apps.tabtinspace.models import Workspace

            current_thread_id = get_current_thread_id()
            current_space_id = get_current_space_id()
            if current_thread_id != thread_id or not current_space_id:
                return None
            return (
                Workspace.objects
                .select_related("device")
                .filter(id=current_space_id)
                .first()
            )
        except Exception as exc:
            logger.debug("[DeviceDispatch] resolve context space failed: %s", exc)
            return None

    @staticmethod
    def _get_explicit_agent_id_for_thread(thread_id: str) -> Optional[str]:
        try:
            from apps.services.common.thread_context import (
                get_current_execution_agent_id,
                get_current_thread_id,
            )

            current_thread_id = get_current_thread_id()
            current_agent_id = get_current_execution_agent_id()
            if current_thread_id == thread_id and current_agent_id:
                return str(current_agent_id)
        except Exception:
            pass  # defensive: ContextVar 快速路径失败，回落到缓存/DB 解析 agent_id

        cached_agent_id = get_cached_execution_agent_id(thread_id)
        if cached_agent_id:
            return cached_agent_id

        try:
            from apps.channel_gateway.models import ChannelBinding

            agent_id = (
                ChannelBinding.objects
                .filter(thread_id=thread_id)
                .values_list("agent_id", flat=True)
                .first()
            )
            return str(agent_id) if agent_id else None
        except Exception as exc:
            logger.debug("[DeviceDispatch] resolve explicit agent failed: %s", exc)
            return None

    @staticmethod
    def _get_context_user_id_for_thread(thread_id: str) -> Optional[str]:
        try:
            from apps.services.common.thread_context import (
                get_current_thread_id,
                get_current_user_id,
            )

            current_thread_id = get_current_thread_id()
            current_user_id = get_current_user_id()
            if current_thread_id == thread_id and current_user_id:
                return str(current_user_id)
        except Exception:
            pass  # defensive: ContextVar 读取 user_id 失败，调用方走无用户上下文降级
        return None

    @staticmethod
    def _get_thread_context(thread_id: str):
        """从 thread_id 获取 (session, space)。

        支持所有合法 thread_id 前缀：chat-session-、tin-、browser-。
        chat-session- 走快速 id 查询，其他前缀走 thread_id 字段查询。
        """
        try:
            context_space = DeviceDispatchService._get_context_space_for_thread(thread_id)
            if context_space is not None:
                return None, context_space

            from django.core.cache import cache

            cache_key = f"thread_context:{thread_id}"
            cached = cache.get(cache_key)
            if cached is not None:
                logger.debug("[DeviceDispatch] thread_context cache hit: thread=%s", thread_id)
                return (None, None) if cached == _THREAD_CTX_NONE_SENTINEL else cached

            from apps.chat.conversation.models import ChatSession

            if thread_id.startswith("chat-session-"):
                session_id = thread_id[len("chat-session-"):]
                session = (
                    ChatSession.objects
                    .filter(id=session_id)
                    .first()
                )
            else:
                session = (
                    ChatSession.objects
                    .filter(thread_id=thread_id)
                    .first()
                )

            if session and session.workspace:
                result = (session, session.workspace)
                cache.set(cache_key, result, timeout=THREAD_CTX_CACHE_TTL)
                logger.debug("[DeviceDispatch] thread_context cache miss, DB hit: thread=%s", thread_id)
                return result

            cache.set(cache_key, _THREAD_CTX_NONE_SENTINEL, timeout=THREAD_CTX_CACHE_TTL)
            logger.debug("[DeviceDispatch] thread_context cache miss, no session/space: thread=%s", thread_id)
        except Exception as exc:
            logger.debug("[DeviceDispatch] resolve thread binding failed: %s", exc)
        return None, None

    @staticmethod
    def invalidate_thread_context_cache(session_or_thread_id: str):
        """主动失效 thread context 缓存（供会话 close/delete 时调用）。

        接受 session_id（裸 UUID）或完整 thread_id（chat-session-xxx/tin-xxx/browser-xxx）。
        裸 UUID 时自动补 chat-session- 前缀以匹配新缓存 key 格式。
        """
        try:
            from django.core.cache import cache
            cache.delete(f"thread_context:{session_or_thread_id}")
            if not session_or_thread_id.startswith(("chat-session-", "tin-", "browser-")):
                cache.delete(f"thread_context:chat-session-{session_or_thread_id}")
        except Exception:
            pass  # defensive: 缓存失效失败不影响会话删除主流程

    @staticmethod
    def _pick_organization_data_device(
        *,
        space,
        user_id: Optional[str],
        required_capability: str,
        exclude_device_id: Optional[str] = None,
    ):
        try:
            from apps.tabtinspace.models import Device

            queryset = Device.objects.filter(
                organization_id=getattr(space, "organization_id", None),
                role="data",
                status="online",
            )
            if user_id:
                queryset = queryset.filter(user_id=user_id)
            if exclude_device_id:
                queryset = queryset.exclude(id=exclude_device_id)

            for candidate in queryset.only(
                "id",
                "fingerprint",
                "device_type",
                "capabilities",
                "status",
            )[:20]:
                capabilities = normalize_device_capabilities(
                    getattr(candidate, "capabilities", None),
                    device_type=getattr(candidate, "device_type", None),
                )
                if has_capability(capabilities, required_capability):
                    return candidate
        except Exception as exc:
            logger.debug("[DeviceDispatch] pick organization capability device failed: %s", exc)
        return None


__all__ = [
    "DEVICE_FALLBACK_POLICY",
    "DispatchDecision",
    "DispatchTargetKind",
    "DeviceDispatchService",
    "FallbackPolicy",
]
