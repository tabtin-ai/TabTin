"""Agent Engine Django App 配置

agent_engine 作为独立 Django app，承担 Agent 执行引擎的：
- 运行时回调注入（trace / permission / hybrid router / frontend dispatcher /
  optional tool filter / subagent policy / action tools provider）
- AppRegistry 延迟校验
- Celery task 生命周期 ContextVar 信号注册

W10 cleanup: TinAgent registration was removed — the builtin ReAct engine
(NativeReactLoop / TinAgent / ReactAgent) is gone, all agent execution
happens on client devices via ``@tabtin/agent-runtime``. Likewise the
startup ``recover_stale_subagents`` recovery hook was removed because no
new ``SubtaskRun`` records are created on the server side.

Beat Schedule 通过 celery.py 的 `_discover_beat_schedules_auto()` 按 INSTALLED_APPS
扫描 `tasks` / `tasks.cleanup` / `tasks.memory` / `middleware.trace` 下的 `*_BEAT_SCHEDULE`
字典自动拉起，本 app 注册到 INSTALLED_APPS 后会被天然发现。

Models 物理文件位于 `apps.services.agent_engine.models`，`Meta.app_label='agent_engine'`
与本 AppConfig 的 `label='agent_engine'` 对齐，migrations 落在
`apps/services/agent_engine/migrations/`。

Wave 11（2026-04-17）彻底删除 apps.orchestration 后，本 AppConfig 是 Agent 引擎的
**唯一运行时入口与 models 宿主**；历史完整代码备份见 `legacy/orchestration/`。
"""

from __future__ import annotations

import logging
import threading
import time

from django.apps import AppConfig

from apps.services.startup_jobs import should_skip_startup_background_jobs

logger = logging.getLogger(__name__)


class AgentEngineConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.services.agent_engine"
    label = "agent_engine"
    verbose_name = "Agent Engine (执行引擎)"

    # 单次 startup 内幂等标志；线性 check-and-set 走 _lifecycle_lock。
    _validation_scheduled = False
    _lifecycle_lock = threading.Lock()

    def ready(self) -> None:
        logger.debug("[AgentEngine] ready() start")

        self._inject_services_tools_callbacks()

        self._schedule_app_registry_validation()

        try:
            import apps.services.agent_engine.context.celery_signals  # noqa: F401
        except Exception as exc:
            logger.warning("[AgentEngine] Celery context signals registration failed: %s", exc)

    @staticmethod
    def _inject_services_tools_callbacks() -> None:
        """向 services.tools 注入 agent_engine 运行时回调。

        各注入点互相独立，单个失败不影响其他注入。
        """
        injected: list[str] = []

        # --- Trace 回调 ---
        try:
            from apps.services.common.observability.trace import (
                TraceRecorder,
                get_current_parent_event_id,
            )
            from apps.services.agent_engine.utils.trace_sanitize import redact_sensitive_fields
            from apps.services.tools.traceable import set_trace_callbacks

            set_trace_callbacks(
                start_event=TraceRecorder.start_event,
                end_event=TraceRecorder.end_event,
                get_parent_event_id=get_current_parent_event_id,
                sanitize=redact_sensitive_fields,
            )
            injected.append("trace")
        except Exception as exc:
            logger.warning("[AgentEngine] Trace callback injection failed: %s", exc)

        # --- 权限校验回调 ---
        try:
            from apps.services.tools.base import set_permission_guard
            from apps.services.tools.domains.tool_permission_guard import ToolPermissionGuard

            set_permission_guard(ToolPermissionGuard.check_tool)
            injected.append("permission_guard")
        except Exception as exc:
            logger.error(
                "[AgentEngine] Permission guard injection failed (non-safe tools will be rejected): %s",
                exc,
            )

        # --- Hybrid 路由回调 ---
        try:
            from apps.services.tools.base import set_execution_router_hybrid
            from apps.services.tools.domains.execution_router import ExecutionRouter

            set_execution_router_hybrid(ExecutionRouter.execute_hybrid)
            injected.append("execution_router_hybrid")
        except Exception as exc:
            logger.warning("[AgentEngine] Execution router hybrid injection failed: %s", exc)

        # --- 前端调度器回调 ---
        try:
            from apps.services.common.dispatch.frontend_dispatcher import (
                get_frontend_dispatcher,
            )
            from apps.services.tools.client import (
                set_dispatch_frontend_action,
                set_frontend_dispatcher_getter,
            )
            from apps.services.tools.domains.execution_router import (
                ExecutionRouter as _ER,
            )

            set_frontend_dispatcher_getter(get_frontend_dispatcher)
            set_dispatch_frontend_action(_ER.dispatch_frontend_action)
            injected.append("frontend_dispatcher")
        except Exception as exc:
            logger.warning("[AgentEngine] Frontend dispatcher injection failed: %s", exc)

        # W6 (2026-05-04): ToolHub policy callbacks (optional_tool_filter /
        # subagent_policy) used to be wired here so the hub could filter
        # provider-supplied LLM tools. After W6 the hub no longer registers
        # any LLM tools, so these injections are dead — removed entirely.

        logger.info("[AgentEngine] services.tools callbacks injected: %s", injected)

    @classmethod
    def _schedule_app_registry_validation(cls) -> None:
        """在后台线程中执行 AppRegistry 校验，不阻塞 ready() 返回。

        Wave D（2026-04-17）改用 ``validate_all()`` 而非 ``validate_app_registry()``，
        让 ``validate_channel_registry`` / ``validate_entity_completeness`` 也进入启动期；
        同时 ``validate_app_registry`` 内部第 1/5/7 项已扩展遍历 ``CORE_APPS ∪ MARKETPLACE_APPS``，
        marketplace App 写错 manifest 时启动期日志会出现 WARNING（不阻塞启动）。

        幂等：即便 `ready()` 在测试/热重载场景下被重入调用，也只会启动一个校验线程。
        """
        if should_skip_startup_background_jobs():
            logger.debug("[AgentEngine] AppRegistry validation skipped for management command")
            return

        with cls._lifecycle_lock:
            if cls._validation_scheduled:
                return
            cls._validation_scheduled = True

        def _validate():
            try:
                time.sleep(1)
                from django.db import connection

                connection.ensure_connection()
                from apps.services.common.app_registry_check import validate_all

                warns = validate_all()
                if warns:
                    logger.info(
                        "[AgentEngine] AppRegistry validation: %d warning(s)", len(warns)
                    )
                else:
                    logger.debug("[AgentEngine] AppRegistry validation passed")
            except Exception as exc:
                logger.warning("[AgentEngine] AppRegistry validation error: %s", exc)
            finally:
                from django.db import connection as conn

                conn.close()

        threading.Thread(target=_validate, daemon=True).start()
