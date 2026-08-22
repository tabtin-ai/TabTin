"""Multiagent API package — surviving router shells.

W10 cleanup history (the missing pieces are intentional):

- ``agent_api`` / ``agent_ask_user`` / ``agent_review`` / ``agent_shared``
  removed — those endpoints invoked the deleted ``NativeReactLoop`` /
  ``TinAgent`` / ``ReactAgent`` and were already de-registered from
  ``urls_deferred.py`` (Electron client also short-circuits via
  ``ORCHESTRATION_OFFLINE``). HITL responses now flow through the WS
  ``agent.action.device.{fingerprint}`` channel (W7c).
- ``subagent_api`` / ``runs_api`` / ``tool_manifest_api`` removed —
  router shells served the builtin engine; never re-attached after M5.

Surviving routers (still mounted by ``urls_deferred.py``):
- ``subagent_template_api.router`` — SubAgentTemplate CRUD
- ``agentdash_api.router``         — AdminDash trace / health debug

``action_api`` is **not** a router — it only exports
``ActionResultSchema`` consumed by ``services/common/ws/handlers/action.py``.

Lazy attribute access keeps ASGI startup fast.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "agentdash_router",
    "subagent_template_router",
    "subtask_run_router",
    "telemetry_resource_open_router",
]


def __getattr__(name: str) -> Any:
    if name == "agentdash_router":
        from .agentdash_api import router as agentdash_router
        return agentdash_router
    if name == "subagent_template_router":
        from .subagent_template_api import router as subagent_template_router
        return subagent_template_router
    if name == "subtask_run_router":
        from .subtask_run_api import router as subtask_run_router
        return subtask_run_router
    if name == "telemetry_resource_open_router":
        # 「Agent 产物在 Space 内的打开」专题 W7：埋点上报通路。
        # main 进程批量 POST 落 PG `agent_engine_resource_open_event`。
        from .telemetry_resource_open_api import router as telemetry_resource_open_router
        return telemetry_resource_open_router
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")
