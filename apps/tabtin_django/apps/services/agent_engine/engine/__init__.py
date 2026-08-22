"""Engine — agent runtime dispatch.

The builtin ReAct execution engine (NativeReactLoop, ReactAgent, TinAgent)
was removed in M5. All Agent execution now happens on client devices
(Electron/Daemon) via @tabtin/agent-runtime; Django only routes prompts
to the bound device.

Surviving modules:
- ``agent_dispatcher`` — forwards prompts via :class:`PromptForwardService`
  to the bound device's local runtime.

Previously-here modules have been migrated:
- ``injected_state`` → :mod:`apps.services.common.state.injected_state`
- ``tool_result_storage`` → :mod:`apps.services.common.tool_result_storage`
- ``cli_hitl_result`` → :mod:`apps.services.common.cli_hitl_result`
- ``state_types`` → :mod:`apps.services.agent_engine.state.state_types`
"""

from .agent_dispatcher import AgentDispatcher, AgentOrchestrator

__all__ = [
    "AgentDispatcher",
    "AgentOrchestrator",
]
