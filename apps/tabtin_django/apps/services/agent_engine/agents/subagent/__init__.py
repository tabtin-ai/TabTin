"""Subagent orchestration subsystem.

W10 cleanup: ``factory`` (SubagentFactory / SubagentReactAgent) and
``compressor`` were removed together with the builtin ReAct engine.
Subagent execution now happens on client devices via ``@tabtin/agent-runtime``.

W5 cleanup (2026-05-26, 子 Agent 模块完善总控): the in-Django announce
pipeline submodules were removed — W10 had left them orphaned (the only
consumer ``flush_orphaned_announcements`` had been retired and ``announce()``
never had a production entry point). Result delivery is now performed by
``@tabtin/agent-runtime`` emitting ``SUBAGENT_COMPLETED`` events directly
to the parent process.

Surviving public symbols (loaded lazily):
  - registry: SubagentRegistry — subagent run records. Read paths
    (``get_record`` / ``count_active`` / ``is_blocked``) + ``cancel`` are
    consumed by ``apps.users.auth.admin_api._cancel_active_agent_runs``.
    Stale spawn-side methods (``register`` / ``spawn_lock`` /
    ``wait_for_result``) were removed in the same W5 wave; see registry.py
    for the cleanup note.
  - policy: SubagentToolPolicy, filter_subagent_tools — tool filter
    consumed directly by action-tool registry helpers
    (``apps.services.tools.domains.action_tool_registry``). After W6
    (2026-05-04) the legacy ToolHub injection path
    (``apps.services.agent_engine.apps._inject_services_tools_callbacks``)
    no longer wires this filter into Python-side LLM tool listings, since
    the LLM tool SSoT now lives entirely in the TS runtime.
"""

__all__ = [
    "SubagentRegistry",
    "SubagentToolPolicy",
    "filter_subagent_tools",
]


def __getattr__(name: str):
    if name == "SubagentRegistry":
        from .registry import SubagentRegistry
        globals()["SubagentRegistry"] = SubagentRegistry
        return SubagentRegistry
    if name in ("SubagentToolPolicy", "filter_subagent_tools"):
        from .policy import SubagentToolPolicy, filter_subagent_tools
        globals()["SubagentToolPolicy"] = SubagentToolPolicy
        globals()["filter_subagent_tools"] = filter_subagent_tools
        return globals()[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
