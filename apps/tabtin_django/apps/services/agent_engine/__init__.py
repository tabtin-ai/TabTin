"""
agent_engine — Agent 引擎核心模块（独立 Django app）。

承载整个 Agent 运行期的引擎核心：engine, middleware, agents, prompts,
tasks, registry, state, observability, persistence, utils。

作为 Django app：
- AppConfig 在 `apps.services.agent_engine.apps.AgentEngineConfig`
- 7 个 Agent 运行期 model（`models.py`，`Meta.app_label='agent_engine'`）归属本 app，
  migrations 位于 `apps/services/agent_engine/migrations/`
- Beat Schedule 由 celery.py `_discover_beat_schedules_auto()` 按 INSTALLED_APPS
  扫描本 app 下的 tasks / tasks.cleanup / tasks.memory / middleware.trace 自动发现

历史沿革（2026-04）：
- W10 之前引擎代码零散在 apps.orchestration 下，W10 升级为独立 Django app
- Wave 11（2026-04-17）彻底删除 apps.orchestration，完整代码备份见
  `legacy/orchestration/`
"""
