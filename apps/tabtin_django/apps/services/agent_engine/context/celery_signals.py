"""
Celery task 生命周期中的 ContextVar / threading.local 管理。

task_prerun:
  - 若 kwargs 含 agent_run_id / run_id，写入 run_id_var ContextVar，
    使下游 _resolve_editor_type() 等函数能正确识别 Agent 操作。
  - 若 kwargs 含 api_key_organization_id，恢复 API Key organization 约束
    （ATK-2: 确保 Celery 任务继承 HTTP 请求的 organization 约束）。
  - 清理 threading.local 的 window_id，防止 Celery 线程复用残留。

task_postrun:
  - 调用 reset_all_context() 清理全部 ContextVar（run_id / user_id /
    organization_id / delegation_object_scope / api_key_organization 等），
    兜底防止 Celery 线程复用导致跨任务上下文污染。

注意：capture.py 中已有针对 _MEMORY_TASK_PREFIX 的 task_prerun/task_postrun，
两套信号互不冲突——本模块在所有 task 上运行，capture.py 只在 memory 前缀任务上
额外做 thread_context.clear_context()。
"""

from __future__ import annotations

import logging

from celery.signals import task_prerun, task_postrun

logger = logging.getLogger(__name__)


@task_prerun.connect
def _setup_run_id_for_celery_task(sender=None, kwargs=None, **_):
    run_id = None
    if kwargs:
        run_id = kwargs.get("agent_run_id") or kwargs.get("run_id")
    if run_id:
        try:
            from apps.services.common.platform_context import set_current_run_id
            set_current_run_id(str(run_id))
        except Exception:
            logger.error("task_prerun: set_current_run_id failed", exc_info=True)

    session_id = kwargs.get("session_id") if kwargs else None
    if session_id:
        try:
            from apps.services.common.platform_context import set_current_session_id
            set_current_session_id(str(session_id))
        except Exception:
            logger.error("task_prerun: set_current_session_id failed", exc_info=True)

    # ATK-2: 从 kwargs 恢复 API Key organization 约束到 ContextVar
    if kwargs:
        api_key_wt = kwargs.get("api_key_organization_id")
        if api_key_wt:
            try:
                from apps.users.auth.api_key_context import set_api_key_organization_constraint
                set_api_key_organization_constraint(str(api_key_wt))
            except Exception:
                logger.error("task_prerun: set_api_key_organization_constraint failed", exc_info=True)

    try:
        from apps.tabdata.request_context import clear_request_context
        clear_request_context()
    except Exception:
        logger.error("task_prerun: clear_request_context failed", exc_info=True)


@task_postrun.connect
def _cleanup_context_after_celery_task(sender=None, **_):
    try:
        from apps.services.common.platform_context import reset_all_context
        reset_all_context()
    except Exception:
        logger.error("task_postrun: reset_all_context failed", exc_info=True)
    try:
        from apps.tabdata.request_context import clear_request_context
        clear_request_context()
    except Exception:
        logger.error("task_postrun: clear_request_context failed", exc_info=True)
