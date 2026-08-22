"""Tracker API 共享 helper（被 trackers.py / sidechannel.py 共用）。

== 设计动机 ==

波次 4 Stage 2.1 把 ``agenda_api.py`` 拆成 ``api/trackers.py``（主 CRUD）+
``api/sidechannel.py``（侧路：templates / webhook / progress / filtered-events）。
``_serialize_tracker_run`` 这个序列化 helper 之前住在 sidechannel.py 里，
trackers.py 反向 import 它——逻辑组织错位（trackers.py 是主路，不该依赖
sidechannel.py 内部实现）。

Module E 把这个共享 helper 抽到本文件，trackers.py / sidechannel.py 都从
``_helpers`` import，消除反向依赖。

== 内容 ==

- ``_serialize_tracker_run(tracker_run, include_steps=False)`` —— TrackerRun 序列化
  到 TrackerRunOut schema。
"""

from __future__ import annotations


def _serialize_tracker_run(
    tracker_run,
    include_steps: bool = False,
    *,
    capabilities: dict | None = None,
) -> dict:
    """charter v1.8 §7.2 序列化 TrackerRun。

    ``include_steps`` 仅为兼容历史调用者签名；Wave 2 删除多步骤后该参数不再
    产生子结构，保留是为了避免破坏调用 signature。
    """
    from apps.tracker.tracker_schemas import TrackerRunOut

    run_ctx = tracker_run.context or {}
    return TrackerRunOut(
        id=tracker_run.id,
        tracker_id=tracker_run.tracker_id,
        chat_session_id=getattr(tracker_run, "chat_session_id", None),
        trigger_type=tracker_run.trigger_type,
        trigger_context=tracker_run.trigger_context or {},
        status=tracker_run.status,
        progress=tracker_run.progress,
        progress_pct=getattr(tracker_run, "progress_pct", 0) or 0,
        progress_message=getattr(tracker_run, "progress_message", "") or "",
        tokens_used=tracker_run.tokens_used,
        current_cycle=getattr(tracker_run, "current_cycle", 1),
        max_cycles=getattr(tracker_run, "max_cycles", 3),
        artifacts=run_ctx.get("_artifacts", []),
        report_doc_id=run_ctx.get("_report_doc_id"),
        started_at=tracker_run.started_at,
        finished_at=tracker_run.finished_at,
        duration=tracker_run.duration,
        error_summary=tracker_run.error_summary,
        # TS-28：completed 透出 Agent 回复；failed 透出 agent_result.error_message
        # （ 已写入 context，此前序列化只读 response，失败详情对外不可见）。
        result_summary=_run_result_summary(tracker_run.status, run_ctx),
        capabilities=capabilities or {},
        created_at=tracker_run.created_at,
    ).model_dump(mode="json")


def _run_result_summary(status: str, run_ctx: dict) -> str:
    agent_result = run_ctx.get("agent_result") or {}
    if not isinstance(agent_result, dict):
        return ""
    if status == "completed":
        return str(agent_result.get("response") or "")[:2000]
    if status == "failed":
        return str(
            agent_result.get("error_message")
            or run_ctx.get("raw_error")
            or ""
        )[:2000]
    return ""
