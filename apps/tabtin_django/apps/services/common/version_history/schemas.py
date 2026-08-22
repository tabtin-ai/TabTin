"""
统一版本历史 API 响应格式

所有模块（TabDoc / TabSlide / TabData）使用相同的响应结构，
前端可复用同一个版本历史组件。
"""
import logging
from datetime import datetime
from typing import Optional
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

try:
    from apps.collab.services.checkpoint_context import USER_PROMPT_PREVIEW_MAX_LENGTH as _USER_PROMPT_MAX
except ImportError:
    _USER_PROMPT_MAX = 200


def serialize_history_item(history, *, module: str = "") -> dict:
    """
    将任意模块的 History 模型序列化为统一格式。

    参数:
        history:  DocHistory / SlideHistory / TableSnapshot 实例
        module:   模块标识 (tabdoc / tabslide / tabdata)

    返回:
    {
        "id": "uuid",
        "module": "tabslide",
        "is_snapshot": true,
        "is_named": false,
        "name": "",
        "pinned": false,
        "editor_type": "user",
        "editor_id": "user-uuid",
        "blob_size": 12345,
        "created_at": "2026-02-26T10:00:00Z",
        "expired_at": "2026-03-05T10:00:00Z",
        "extra": { ... }  // 模块特有字段
    }
    """
    blob_size = getattr(history, "blob_size", 0) or (
        len(history.blob) if hasattr(history, "blob") and history.blob else 0
    )

    editor_type = getattr(history, "editor_type", "") or ""
    if editor_type == "human":
        editor_type = "user"

    result = {
        "id": str(history.id),
        "module": module,
        "is_snapshot": getattr(history, "is_snapshot", True),
        "is_named": getattr(history, "is_named", False),
        "name": getattr(history, "name", "") or "",
        "pinned": getattr(history, "pinned", False),
        "editor_type": editor_type,
        "editor_id": getattr(history, "editor_id", "") or "",
        "blob_size": blob_size,
        "created_at": _fmt_dt(history.created_at),
        "expired_at": _fmt_dt(getattr(history, "expired_at", None)),
    }

    extra = {}
    for attr in ("version", "revn", "page_count", "shape_count", "record_count", "field_count"):
        val = getattr(history, attr, None)
        if val is not None:
            extra[attr] = val

    metadata = getattr(history, "metadata", None)
    if isinstance(metadata, dict):
        for attr in ("version", "revn", "page_count", "shape_count", "record_count", "field_count", "scene_count", "track_count", "binary_size"):
            if attr not in extra and attr in metadata:
                extra[attr] = metadata[attr]

    if extra:
        result["extra"] = extra

    return result


def serialize_history_list(histories, *, module: str = "") -> list[dict]:
    """批量序列化，对 agent 条目附加 agent_run_id + checkpoint_context。

    Wave 14 QC-12：批量预检 `ChatSession.status`，在 `checkpoint_context.session_exists`
    中置位"会话是否仍然存活"。前端据此在列表挂载时即刻把"查看对话片段"按钮置灰，
    避免点击后才通过 404 发现归档（消除"每条独立 404 试探"的反馈延迟）。
    """
    from apps.collab.models import ChangeLog

    agent_vh_ids = [h.id for h in histories if getattr(h, 'editor_type', '') == 'agent']
    run_id_lookup: dict = {}
    if agent_vh_ids:
        for row in (
            ChangeLog.objects.using(postgres_app_db_alias())
            .filter(version_history_id__in=agent_vh_ids)
            .exclude(agent_run_id="")
            .values("version_history_id", "agent_run_id")
        ):
            run_id_lookup.setdefault(row["version_history_id"], row["agent_run_id"])

    ctx_lookup: dict = {}
    unique_run_ids = list(set(run_id_lookup.values()))
    if unique_run_ids:
        try:
            from apps.collab.models import SpaceCheckpoint
            for sp in (
                SpaceCheckpoint.objects.using(postgres_app_db_alias())
                .filter(agent_run_id__in=unique_run_ids)
                .order_by("-created_at")
                .values("agent_run_id", "metadata", "anchor_session_id", "anchor_message_id")
            ):
                rid = sp["agent_run_id"]
                if rid in ctx_lookup:
                    continue
                meta = sp.get("metadata") or {}
                cc = meta.get("checkpoint_context") or {}
                raw_prompt = cc.get("user_prompt") or ""
                sub_convs_raw = cc.get("sub_conversations")
                if sub_convs_raw is not None and not isinstance(sub_convs_raw, list):
                    # Wave 14：脏 metadata 兜底——写入路径异常下可能是 dict/str；
                    # 此处 gracefully 降级为 None（前端视作无子任务），
                    # 但保留一次告警便于追查来源（避免 "静默丢子任务" 无日志）。
                    logger.warning(
                        "serialize_history_list: sub_conversations expected list, got %s for run_id=%s",
                        type(sub_convs_raw).__name__, rid,
                    )
                    sub_convs = None
                elif isinstance(sub_convs_raw, list):
                    sub_convs = sub_convs_raw
                else:
                    sub_convs = None
                ctx_lookup[rid] = {
                    "session_id": sp.get("anchor_session_id") or cc.get("session_id") or None,
                    "assistant_message_id": sp.get("anchor_message_id") or cc.get("assistant_message_id") or None,
                    "user_message_id": cc.get("user_message_id") or None,
                    "user_prompt": raw_prompt[:_USER_PROMPT_MAX] or None,
                    "agent_run_id": rid,
                    # has_sub_conversations 保留用于版本面板快速渲染"含子任务"角标；
                    # sub_conversations 为详情列表（Wave 12 新增），前端据此渲染子任务卡片。
                    # 两者同在以避免前端再次请求，尺寸可控（固化在 metadata 中、按页取）。
                    "has_sub_conversations": bool(sub_convs),
                    "sub_conversations": sub_convs,
                    # Wave 14 QC-12：session_exists 默认置 True，下面批量查询后按真实状态覆写。
                    # None 语义保留给"查询失败"（前端不会因为后端异常把按钮全部置灰）。
                    "session_exists": True,
                }
        except Exception:
            logger.warning(
                "serialize_history_list: SpaceCheckpoint lookup failed for %d run_ids",
                len(unique_run_ids), exc_info=True,
            )

    # Wave 14 QC-12：批量查 ChatSession 存在性 + 归档状态。
    # - 未查到的 id → session_exists=False（视为已删除/归档，不可追溯）
    # - status='archived' → session_exists=False（PRD §3.5：归档降级）
    # - 查询失败 → 保持 session_exists=True（避免后端异常把入口全置灰误导用户）
    session_ids_to_check = {
        ctx["session_id"] for ctx in ctx_lookup.values()
        if ctx.get("session_id")
    }
    if session_ids_to_check:
        try:
            from apps.chat.conversation.models import ChatSession
            alive_ids: dict[str, str] = {}
            for row in ChatSession.objects.filter(
                id__in=session_ids_to_check,
            ).values("id", "status"):
                alive_ids[str(row["id"])] = row["status"] or "active"
            for ctx in ctx_lookup.values():
                sid = ctx.get("session_id")
                if not sid:
                    continue
                sid_str = str(sid)
                st = alive_ids.get(sid_str)
                if st is None:
                    ctx["session_exists"] = False
                elif st == "archived":
                    ctx["session_exists"] = False
                # active / completed 等其它状态保持 session_exists=True
        except Exception:
            logger.warning(
                "serialize_history_list: ChatSession existence check failed for %d session_ids",
                len(session_ids_to_check), exc_info=True,
            )

    results = []
    for h in histories:
        item = serialize_history_item(h, module=module)
        run_id = run_id_lookup.get(h.id)
        item["agent_run_id"] = run_id
        if run_id and run_id in ctx_lookup:
            item["checkpoint_context"] = ctx_lookup[run_id]
        results.append(item)

    return results


def _fmt_dt(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    return dt.isoformat()
