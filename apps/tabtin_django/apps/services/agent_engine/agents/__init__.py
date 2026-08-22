"""Agent definitions.

W10 cleanup: TinAgent stub removed. All Agent execution is now performed
by ``@tabtin/agent-runtime`` on client devices (Electron/Daemon); Django
no longer hosts any builtin ReAct agent.

W5 cleanup (2026-05-26): the in-Django announce pipeline submodules were
removed — W10 had left them orphaned and the primary consumer
``flush_orphaned_announcements`` had already been retired. Subagent result
delivery now goes through ``@tabtin/agent-runtime`` emitting
``SUBAGENT_COMPLETED`` events directly to the parent process.

Surviving submodules:
- ``subagent.policy`` — subagent tool filter (used by action-tool registry)
- ``subagent.registry`` — subagent run registry (kept for collab cascading
  rollback read path + admin_api cancel; spawn-side write path retired in
  W5 together with the announce pipeline)
"""

__all__: list[str] = []
