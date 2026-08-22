"""设备解析 + 设备名兜底文案（W13 D4）。

把 ChatSession + 可选的 ``app_context._execution_agent_id`` 转换成
``(space, agent, control_device)``，供 ``RemoteAgentDispatcher`` 做三分支路由。

设备名兜底规则（D4）：
- 优先 ``Device.name``
- 空时回退 ``"{device_type} 设备 ({fingerprint[:6]})"``，例如
  ``"daemon 设备 (a3f2c1)"``
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional

from apps.tabtinspace.services.execution_binding import (
    ExecutionBinding,
    resolve_execution_binding,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DispatchTarget:
    """``RemoteAgentDispatcher`` 路由判定所需的全部上下文。"""

    space: Any
    agent: Any
    control_device: Any
    binding_source: str


def _extract_explicit_agent_id(app_context: Optional[Dict[str, Any]]) -> Optional[str]:
    """渠道路径会通过 app_context 显式指定执行 Agent。"""
    if not app_context:
        return None
    explicit = app_context.get("_execution_agent_id") or app_context.get(
        "execution_agent_id"
    )
    if not explicit:
        return None
    return str(explicit)


def resolve_dispatch_target(
    session,
    app_context: Optional[Dict[str, Any]] = None,
) -> DispatchTarget:
    """根据 session/app_context 解析 (space, agent, control_device)。

    任何解析失败均**不抛异常**——control_device 会得到 ``None``，
    从而走 lightweight 分支，避免误把"找不到 agent"算成"设备离线"。

    注意：当调用方**显式**传入 ``_execution_agent_id`` 但解析不到 Agent 时，
    会留 warning 日志——这通常意味着渠道路由 / 委托配置有 bug，应被 ops
    立即关注，而不是默默降级到轻量。
    """
    space = getattr(session, "workspace", None)
    explicit_agent_id = (
        _extract_explicit_agent_id(app_context)
        or str(getattr(session, "agent_id", "") or "")
        or None
    )
    binding: ExecutionBinding = resolve_execution_binding(
        space=space,
        agent_id=explicit_agent_id,
    )

    if explicit_agent_id and binding.agent is None:
        logger.warning(
            "[remote_agent] explicit _execution_agent_id=%s could not be resolved; "
            "falling back to lightweight branch (session=%s)",
            explicit_agent_id,
            getattr(session, "id", None),
        )

    return DispatchTarget(
        space=space,
        agent=binding.agent,
        control_device=binding.device,
        binding_source=binding.source,
    )


def format_device_name(device: Any) -> str:
    """W13 D4：设备名兜底文案。

    >>> format_device_name(device_with_name)
    'Mac mini 工作机'
    >>> format_device_name(device_without_name)
    'daemon 设备 (a3f2c1)'
    """
    if device is None:
        return "未绑定设备"

    name = (getattr(device, "name", "") or "").strip()
    if name:
        return name

    device_type = (getattr(device, "device_type", "") or "device").strip() or "device"
    fingerprint = (getattr(device, "fingerprint", "") or "").strip()
    short_fp = fingerprint[:6] if fingerprint else "unknown"
    return f"{device_type} 设备 ({short_fp})"


__all__ = [
    "DispatchTarget",
    "resolve_dispatch_target",
    "format_device_name",
]
