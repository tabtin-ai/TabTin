"""
Agent Debug API - 回放 + 实时 + 可观测性
"""

import logging
import re
from typing import Optional, Union
from urllib.parse import unquote
import json
import uuid

logger = logging.getLogger(__name__)

from django.db import DatabaseError
from django.db.models import CharField, Count, Max, Min, Q, TextField, Value
from django.db.models.fields.json import KeyTextTransform
from django.db.models.functions import Cast, Coalesce
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.services.common.api_errors import (
    MSG_UNAUTHORIZED,
    MSG_SUPERUSER_ONLY,
    MSG_CURSOR_INVALID_UUID,
    MSG_CURSOR_NOT_FOUND,
    MSG_TRACE_NOT_FOUND,
    MSG_STATE_NOT_FOUND,
    MSG_THREAD_NOT_FOUND,
    MSG_NO_ACCESS_TRACE,
    raise_unauthorized,
    raise_superuser_only,
    raise_forbidden,
    raise_not_found,
    raise_bad_request,
    raise_internal,
)
from apps.chat.conversation.models import ChatLLMSnapshot, ChatSession
from apps.chat.conversation.services.semantic_message_count import (
    count_semantic_messages,
    is_context_injection_message,
)
from apps.services.agent_engine.models import ExecutionTrace, TraceEvent
from apps.services.agent_execution.effective_runtime_config import resolve_workspace_approval_mode
from apps.tabtinspace.models import Organization
from apps.users.auth.api import jwt_auth
from apps.users.auth.models import User
from apps.users.auth.permissions import SuperuserAuth

router = Router()

def _serialize_trace(trace: ExecutionTrace) -> dict:
    return {
        "id": trace.id,
        "trace_id": str(trace.trace_id),
        "thread_id": trace.thread_id,
        "graph_type": trace.graph_type,
        "session_id": trace.session_id,
        "instance_id": trace.instance_id,
        "organization_id": trace.organization_id,
        "user_id": trace.user_id,
        "status": trace.status,
        "started_at": trace.started_at.isoformat() if trace.started_at else None,
        "ended_at": trace.ended_at.isoformat() if trace.ended_at else None,
        "error": trace.error,
        "metadata": trace.metadata,
    }

def _serialize_event(event: TraceEvent) -> dict:
    return {
        "id": str(event.event_uuid),
        "trace_id": str(event.trace.trace_id),
        "parent_event_id": str(event.parent_event.event_uuid)
        if event.parent_event_id
        else None,
        "event_type": event.event_type,
        "name": event.name,
        "seq": event.seq,
        "started_at": event.started_at.isoformat() if event.started_at else None,
        "ended_at": event.ended_at.isoformat() if event.ended_at else None,
        "duration_ms": event.duration_ms,
        "input": event.input,
        "output": event.output,
        "error": event.error,
        "usage": event.usage,
    }

def _ensure_trace_owner(request, trace: ExecutionTrace):
    user = request.auth
    if not user:
        raise_unauthorized()
    if user.is_superuser:
        return
    if trace.user_id != str(user.id):
        raise_forbidden(MSG_NO_ACCESS_TRACE)

def _normalize_query_value(value: Optional[Union[str, list]]) -> Optional[str]:
    if isinstance(value, list):
        return value[0] if value else None
    return value

def _build_trace_queryset(
    user,
    thread_id: Optional[Union[str, list]],
    session_id: Optional[Union[str, list]],
    graph_type: Optional[Union[str, list]],
):
    thread_id = _normalize_query_value(thread_id)
    session_id = _normalize_query_value(session_id)
    graph_type = _normalize_query_value(graph_type)
    qs = ExecutionTrace.objects.all().order_by("-id")
    if not user.is_superuser:
        qs = qs.filter(user_id=str(user.id))
    if thread_id:
        qs = qs.filter(thread_id=thread_id)
    if session_id:
        qs = qs.filter(session_id=session_id)
    if graph_type:
        qs = qs.filter(graph_type=graph_type)
    return qs

def _build_pagination(total: int, page: int, page_size: int) -> dict:
    total_pages = (total + page_size - 1) // page_size if total else 0
    normalized_page = min(page, total_pages) if total_pages else 1
    return {
        "page": normalized_page,
        "page_size": page_size,
        "total": total,
        "total_pages": total_pages,
        "offset": max(0, (normalized_page - 1) * page_size),
    }

def _parse_uuid(value) -> Optional[uuid.UUID]:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


def _batch_load_thread_sessions(rows: list[dict]) -> dict[str, ChatSession]:
    """按当前页 thread 批量解析 ChatSession，避免列表 N+1。"""
    thread_ids = [row["thread_id"] for row in rows if row.get("thread_id")]
    by_thread: dict[str, ChatSession] = {}
    if not thread_ids:
        return by_thread

    for session in ChatSession.objects.select_related("user").filter(thread_id__in=thread_ids):
        if session.thread_id:
            by_thread[session.thread_id] = session

    uuid_to_thread: dict[uuid.UUID, str] = {}
    for row in rows:
        thread_id = row.get("thread_id")
        if not thread_id or thread_id in by_thread:
            continue
        if thread_id.startswith("chat-session-"):
            session_uuid = _parse_uuid(thread_id.removeprefix("chat-session-"))
            if session_uuid:
                uuid_to_thread[session_uuid] = thread_id
        session_uuid = _parse_uuid(row.get("session_id"))
        if session_uuid and session_uuid not in uuid_to_thread:
            uuid_to_thread[session_uuid] = thread_id

    if uuid_to_thread:
        for session in ChatSession.objects.select_related("user").filter(
            id__in=list(uuid_to_thread.keys())
        ):
            mapped_thread_id = uuid_to_thread.get(session.id)
            if mapped_thread_id and mapped_thread_id not in by_thread:
                by_thread[mapped_thread_id] = session

    return by_thread


def _batch_organization_names(organization_ids: list[str]) -> dict[str, str]:
    cleaned = [org_id for org_id in organization_ids if org_id]
    if not cleaned:
        return {}
    return {
        str(org_id): name
        for org_id, name in Organization.objects.filter(id__in=cleaned).values_list("id", "name")
        if name
    }


def _matching_user_ids(search_term: str) -> list[str]:
    """按运营可见身份字段匹配用户，手机号与昵称/用户名共享一个入口。"""
    return [
        str(user_id)
        for user_id in User.objects.filter(
            Q(nickname__icontains=search_term)
            | Q(username__icontains=search_term)
            | Q(phone__icontains=search_term)
        ).values_list("id", flat=True)[:500]
    ]


def _filter_traces_by_session_title(qs, session_title: str):
    sessions = ChatSession.objects.filter(title__icontains=session_title).only("id", "thread_id")
    thread_ids: list[str] = []
    session_ids: list[str] = []
    for session in sessions.iterator():
        session_ids.append(str(session.id))
        thread_ids.append(f"chat-session-{session.id}")
        if session.thread_id:
            thread_ids.append(session.thread_id)
    if not thread_ids and not session_ids:
        return qs.none()
    return qs.filter(Q(thread_id__in=thread_ids) | Q(session_id__in=session_ids))


def _serialize_thread_summary(
    row: dict,
    duration_map: dict[str, int],
    sessions_by_thread: Optional[dict[str, ChatSession]] = None,
    organization_names: Optional[dict[str, str]] = None,
) -> dict:
    thread_id = row["thread_id"]
    session = (sessions_by_thread or {}).get(thread_id)
    user_id = (str(session.user_id) if session else None) or (row.get("user_id") or None)
    organization_id = (
        (session.organization_id if session else None) or (row.get("organization_id") or None)
    )
    organization_id = str(organization_id) if organization_id else None
    return {
        "thread_id": thread_id,
        "session_id": row.get("session_id") or (str(session.id) if session else None),
        "session_title": (session.title if session and session.title else None),
        "user_id": user_id,
        "user_name": _display_name(session.user) if session else None,
        "user_phone": getattr(session.user, "phone", None) if session else None,
        "organization_id": organization_id,
        "organization_name": (
            (organization_names or {}).get(organization_id) if organization_id else None
        ),
        "trace_count": row["trace_count"],
        "first_started_at": row["first_started_at"].isoformat() if row.get("first_started_at") else None,
        "latest_started_at": row["latest_started_at"].isoformat() if row.get("latest_started_at") else None,
        "total_duration_ms": duration_map.get(thread_id, 0),
        "status_stats": {
            "completed": row["completed_count"],
            "running": row["running_count"],
            "error": row["error_count"],
        },
        "total_tool_calls": 0,
        "total_llm_calls": 0,
    }


def _resolve_chat_session(thread_id: str, traces) -> Optional[ChatSession]:
    session_ids = []
    if thread_id.startswith("chat-session-"):
        session_ids.append(thread_id.removeprefix("chat-session-"))
    trace_session_id = next((trace.session_id for trace in traces if trace.session_id), None)
    if trace_session_id:
        session_ids.append(trace_session_id)

    for session_id in session_ids:
        try:
            session_uuid = uuid.UUID(str(session_id))
        except (ValueError, TypeError, AttributeError):
            continue
        session = (
            ChatSession.objects.select_related(
                "user", "workspace", "project", "agent", "current_model",
            )
            .filter(id=session_uuid)
            .first()
        )
        if session:
            return session
    return None


def _scope_traces_to_chat_session(qs, session: Optional[ChatSession]):
    """排除复用 thread_id 时落在当前 ChatSession 创建前的历史 Trace。"""
    if not session:
        return qs
    return qs.filter(started_at__gte=session.created_at)


# ：local-runtime 把 session_id 当 trace_id 的 persist_message 旁路桶。
# 无 lifecycle/done 收口，AdminDash 会永久显示「运行中」。观测侧隐藏并 lazy heal。
_SESSION_PERSIST_BUCKET_GRAPH = "local-runtime"


def _is_session_persist_bucket(trace) -> bool:
    session_id = getattr(trace, "session_id", None)
    trace_id = getattr(trace, "trace_id", None)
    if not session_id or not trace_id:
        return False
    if getattr(trace, "graph_type", None) != _SESSION_PERSIST_BUCKET_GRAPH:
        return False
    return str(trace_id) == str(session_id)


def _session_persist_bucket_q() -> Q:
    return (
        Q(graph_type=_SESSION_PERSIST_BUCKET_GRAPH)
        & Q(session_id__isnull=False)
        & ~Q(session_id="")
        & Q(session_id=Cast("trace_id", output_field=CharField()))
    )


def _exclude_session_persist_buckets(qs):
    return qs.exclude(_session_persist_bucket_q())


def _lazy_heal_session_persist_buckets(*, thread_id: Optional[str] = None) -> int:
    """将仍 running 的 session persist 桶标为 completed，避免列表「运行中」噪声。"""
    heal_qs = ExecutionTrace.objects.filter(
        _session_persist_bucket_q(),
        status="running",
        ended_at__isnull=True,
    )
    if thread_id:
        heal_qs = heal_qs.filter(thread_id=thread_id)
    return heal_qs.update(status="completed", ended_at=timezone.now())


def _visible_thread_traces(traces: list) -> list:
    """隐藏 session persist 桶；顺带 heal 仍 running 的存量。"""
    heal_pks = [
        getattr(trace, "pk", None) or getattr(trace, "id", None)
        for trace in traces
        if _is_session_persist_bucket(trace)
        and getattr(trace, "status", None) == "running"
        and getattr(trace, "ended_at", None) is None
    ]
    heal_pks = [pk for pk in heal_pks if pk is not None]
    if heal_pks:
        ExecutionTrace.objects.filter(pk__in=heal_pks, status="running").update(
            status="completed",
            ended_at=timezone.now(),
        )
    return [trace for trace in traces if not _is_session_persist_bucket(trace)]


def _display_name(value) -> Optional[str]:
    if value is None:
        return None
    getter = getattr(value, "get_display_name", None)
    if callable(getter):
        return getter()
    for field in ("name", "display_name", "model_name"):
        result = getattr(value, field, None)
        if result:
            return str(result)
    return str(value)


# ：本机 Codex id → 展示名（与 Electron OPENAI_CODEX_MODELS 对齐；运营回看用）。
# 不进 agent-runtime——产品表归属宿主 / AdminDash。
_CODEX_MODEL_DISPLAY_NAMES = {
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-5.6-terra": "GPT-5.6 Terra",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "gpt-5.5": "GPT-5.5",
    "gpt-5.4": "GPT-5.4",
    "gpt-5.4-mini": "GPT-5.4 Mini",
}


def _label_for_model_key(model_key: str) -> str:
    """把 runtime model id（Codex 字面量或 catalog UUID）解析成运营可读名。"""
    key = (model_key or "").strip()
    if not key:
        return ""
    codex = _CODEX_MODEL_DISPLAY_NAMES.get(key)
    if codex:
        return codex
    try:
        model_uuid = uuid.UUID(key)
    except (ValueError, TypeError, AttributeError):
        return key
    try:
        from apps.services.llm.models import LLMModel

        row = (
            LLMModel.objects.filter(id=model_uuid)
            .only("display_name", "model_name")
            .first()
        )
    except Exception:
        logger.debug("resolve model label failed for %s", key, exc_info=True)
        return key
    if not row:
        return key
    return (row.display_name or row.model_name or key).strip() or key


def _latest_trace_model_key(traces) -> Optional[str]:
    """从最近 done TraceEvent.usage.by_model 取实际执行模型 id。"""
    if not traces:
        return None
    real_traces = [t for t in traces if getattr(t, "pk", None) is not None]
    if not real_traces:
        return None
    done_events = (
        TraceEvent.objects.filter(trace__in=real_traces, event_type="done")
        .exclude(usage__isnull=True)
        .order_by("-started_at", "-seq")
        .only("usage")[:30]
    )
    for done in done_events:
        if not isinstance(done.usage, dict):
            continue
        by_model = done.usage.get("by_model")
        if not isinstance(by_model, dict) or not by_model:
            continue
        # 多模型时取最后一个 key（插入序；Python 3.7+ dict 保序）
        key = next(reversed(list(by_model.keys())), None)
        if isinstance(key, str) and key.strip():
            return key.strip()
    return None


def _resolve_session_model_name(session, messages, traces) -> Optional[str]:
    """会话主体「模型」：优先实际执行（snapshot / by_model），再回退 session.current_model。

    Codex / 本机 BYOK 不会写 ChatSession.current_model FK；运营回看必须以
    消息快照或 trace usage 为准。

    注意：overview 的 messages 可能是「最旧 N 条」截断窗口，不能用它推断
    「最近实际模型」——必须先查全库最新 assistant snapshot。
    """
    del messages  # 截断窗口不可靠，保留形参兼容调用方

    if session is not None:
        try:
            snap = (
                session.messages.filter(role="assistant")
                .exclude(model_name_snapshot="")
                .order_by("-arrival_seq", "-created_at", "-id")
                .values_list("model_name_snapshot", flat=True)
                .first()
            )
            if isinstance(snap, str) and snap.strip():
                return _label_for_model_key(snap.strip())
        except Exception:
            logger.debug("resolve session message model snapshot failed", exc_info=True)

    trace_key = _latest_trace_model_key(traces)
    if trace_key:
        return _label_for_model_key(trace_key)

    if session is not None:
        return _display_name(session.current_model)
    return None


def _organization_name(organization_id: str) -> Optional[str]:
    try:
        return (
            Organization.objects.filter(id=organization_id)
            .values_list("name", flat=True)
            .first()
        )
    except (ValueError, TypeError):
        return None


@router.get("/debug/threads", auth=SuperuserAuth())
def list_threads(
    request,
    keyword: str = "",
    status: str = "",
    user: str = "",
    organization: str = "",
    user_id: str = "",
    user_name: str = "",
    organization_id: str = "",
    organization_name: str = "",
    session_title: str = "",
    page: int = 1,
    page_size: int = 20,
):
    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    qs = ExecutionTrace.objects.all()
    normalized_keyword = keyword.strip()
    if normalized_keyword:
        qs = qs.filter(
            Q(thread_id__icontains=normalized_keyword)
            | Q(session_id__icontains=normalized_keyword)
        )

    # 合并筛选：用户名 / 手机号 / 用户 ID（OR）；旧参数仍兼容
    normalized_user = user.strip()
    if normalized_user:
        matched_user_ids = _matching_user_ids(normalized_user)
        user_q = Q(user_id__icontains=normalized_user)
        if matched_user_ids:
            user_q |= Q(user_id__in=matched_user_ids)
        qs = qs.filter(user_q)
    else:
        normalized_user_id = user_id.strip()
        if normalized_user_id:
            qs = qs.filter(user_id__icontains=normalized_user_id)

        normalized_user_name = user_name.strip()
        if normalized_user_name:
            matched_user_ids = _matching_user_ids(normalized_user_name)
            qs = qs.filter(user_id__in=matched_user_ids) if matched_user_ids else qs.none()

    normalized_organization = organization.strip()
    if normalized_organization:
        matched_org_ids = [
            str(org_id)
            for org_id in Organization.objects.filter(
                name__icontains=normalized_organization
            ).values_list("id", flat=True)[:500]
        ]
        org_q = Q(organization_id__icontains=normalized_organization)
        if matched_org_ids:
            org_q |= Q(organization_id__in=matched_org_ids)
        qs = qs.filter(org_q)
    else:
        normalized_organization_id = organization_id.strip()
        if normalized_organization_id:
            qs = qs.filter(organization_id__icontains=normalized_organization_id)

        normalized_organization_name = organization_name.strip()
        if normalized_organization_name:
            matched_org_ids = [
                str(org_id)
                for org_id in Organization.objects.filter(
                    name__icontains=normalized_organization_name
                ).values_list("id", flat=True)[:500]
            ]
            qs = (
                qs.filter(organization_id__in=matched_org_ids)
                if matched_org_ids
                else qs.none()
            )

    normalized_session_title = session_title.strip()
    if normalized_session_title:
        qs = _filter_traces_by_session_title(qs, normalized_session_title)

    # ：会话 persist 桶不计「运行中」/ 不计入 trace 总数。
    # 必须在 group annotate 之前 exclude：若把 ~_session_persist_bucket_q()
    # 放进 Count(..., filter=...)，同时 annotate session_id=Max("session_id")，
    # Django 会把 FILTER 里的 session_id 解析成外层 MAX 聚合，PostgreSQL 报
    # 「aggregate functions are not allowed in FILTER」→ AdminDash 会话列表 500。
    qs = _exclude_session_persist_buckets(qs)
    grouped = (
        qs.values("thread_id")
        .annotate(
            session_id=Max("session_id"),
            user_id=Max("user_id"),
            organization_id=Max("organization_id"),
            trace_count=Count("id"),
            completed_count=Count("id", filter=Q(status="completed")),
            running_count=Count("id", filter=Q(status="running")),
            error_count=Count("id", filter=Q(status="error")),
            first_started_at=Min("started_at"),
            latest_started_at=Max("started_at"),
        )
    )

    normalized_status = status.strip()
    if normalized_status == "error":
        grouped = grouped.filter(error_count__gt=0)
    elif normalized_status == "running":
        grouped = grouped.filter(running_count__gt=0)
    elif normalized_status == "completed":
        grouped = grouped.filter(completed_count__gt=0, error_count=0, running_count=0)
    elif normalized_status and normalized_status != "all":
        raise_bad_request("status 参数不合法")

    grouped = grouped.order_by("-latest_started_at", "-trace_count", "thread_id")
    total = grouped.count()
    pagination = _build_pagination(total, page, page_size)
    rows = list(grouped[pagination["offset"]: pagination["offset"] + page_size])

    thread_ids = [row["thread_id"] for row in rows]
    duration_map: dict[str, int] = {thread_id: 0 for thread_id in thread_ids}
    if thread_ids:
        for trace in ExecutionTrace.objects.filter(thread_id__in=thread_ids).only(
            "thread_id",
            "started_at",
            "ended_at",
        ):
            if trace.started_at and trace.ended_at:
                duration_ms = int((trace.ended_at - trace.started_at).total_seconds() * 1000)
                if duration_ms > 0:
                    duration_map[trace.thread_id] = duration_map.get(trace.thread_id, 0) + duration_ms

    sessions_by_thread = _batch_load_thread_sessions(rows)
    organization_ids = []
    for row in rows:
        session = sessions_by_thread.get(row["thread_id"])
        org_id = (session.organization_id if session else None) or row.get("organization_id")
        if org_id:
            organization_ids.append(str(org_id))
    organization_names = _batch_organization_names(organization_ids)

    return {
        "items": [
            _serialize_thread_summary(
                row,
                duration_map,
                sessions_by_thread=sessions_by_thread,
                organization_names=organization_names,
            )
            for row in rows
        ],
        "pagination": {
            "page": pagination["page"],
            "page_size": page_size,
            "total": total,
            "total_pages": pagination["total_pages"],
        },
    }


def _httpish_url(value: object) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    if value.startswith(("http://", "https://", "data:")):
        return value
    return None


_MD_RESOURCE_LINK_RE = re.compile(r"\[([^\]]+)\]\((tabtin://resource/[^)\s\"'`]+)\)")
_BARE_RESOURCE_URI_RE = re.compile(r"tabtin://resource/[^\s)\]\"'`]+")
_TRAILING_URI_PUNCT_RE = re.compile(r"[.,;:!?。，、；：！？…]+$", re.UNICODE)
_FENCED_CODE_RE = re.compile(r"```[\s\S]*?(?:```|$)")
_INLINE_CODE_RE = re.compile(r"`[^`\n]*`")


def _strip_code_segments(text: str) -> str:
    return _INLINE_CODE_RE.sub(" ", _FENCED_CODE_RE.sub(" ", text))


def _sanitize_resource_href(href: str) -> str:
    return _TRAILING_URI_PUNCT_RE.sub("", href)


def _parse_tabtin_resource(href: str) -> Optional[tuple[str, str]]:
    """解析 tabtin://resource/{type}/{id}，截断 id 视为无效。"""
    if not isinstance(href, str) or not href.startswith("tabtin://resource/"):
        return None
    rest = href[len("tabtin://resource/") :].split("?", 1)[0]
    parts = rest.split("/", 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    resource_type = parts[0]
    resource_id = unquote(parts[1])
    if "…" in resource_id or "\u2026" in resource_id:
        return None
    if resource_type != "file" and "..." in resource_id:
        return None
    return resource_type, resource_id


def _attachment_kind_for_resource(resource_type: str) -> str:
    normalized = resource_type.lower()
    if normalized in ("document", "doc", "tabdoc"):
        return "document"
    if normalized in ("table", "tabdata"):
        return "table"
    if normalized == "file":
        return "file"
    return "resource"


def _collect_text_for_attachments(blocks, content: Optional[str]) -> str:
    parts: list[str] = []
    if isinstance(content, str) and content.strip():
        parts.append(content)
    if isinstance(blocks, list):
        for block in blocks:
            if (
                isinstance(block, dict)
                and block.get("type") == "text"
                and isinstance(block.get("text"), str)
                and block["text"].strip()
            ):
                parts.append(block["text"])
    return "\n".join(parts)


def _extract_message_attachments(blocks, content: Optional[str] = None) -> list[dict]:
    """投影运营可读的附件 / Agent 产物摘要（不含完整 blocks）。

    来源：
    1. 用户 image/file/video/document 块
    2. Agent tabtin_rich_content file / resource_ref（可交付）
    3. 正文 markdown / 裸 tabtin://resource 链接（与 Electron 本轮产物对齐）
    """
    if not isinstance(blocks, list):
        blocks = []

    attachments: list[dict] = []
    seen: set[str] = set()

    def _push(
        *,
        kind: str,
        filename: str,
        file_id: Optional[str] = None,
        mime_type: Optional[str] = None,
        size: Optional[int] = None,
        url: Optional[str] = None,
        preview_url: Optional[str] = None,
        source: str = "user",
        resource_type: Optional[str] = None,
        resource_id: Optional[str] = None,
    ) -> None:
        dedupe = None
        if resource_type and resource_id:
            dedupe = f"{resource_type}:{resource_id}".lower()
        elif file_id:
            dedupe = f"file:{file_id}".lower()
        else:
            dedupe = url or preview_url or filename
        if not dedupe or dedupe in seen:
            return
        seen.add(dedupe)
        item = {
            "kind": kind,
            "filename": filename,
            "source": source,
        }
        if file_id:
            item["file_id"] = file_id
        if mime_type:
            item["mime_type"] = mime_type
        if isinstance(size, int):
            item["size"] = size
        if url:
            item["url"] = url
        if preview_url:
            item["preview_url"] = preview_url
        if resource_type:
            item["resource_type"] = resource_type
        if resource_id:
            item["resource_id"] = resource_id
        attachments.append(item)

    def _push_resource(
        *,
        href: Optional[str],
        title: str,
        resource_type: Optional[str] = None,
        resource_id: Optional[str] = None,
    ) -> None:
        parsed = _parse_tabtin_resource(href) if href else None
        if parsed:
            resource_type, resource_id = parsed
        if not resource_type or not resource_id:
            return
        kind = _attachment_kind_for_resource(resource_type)
        canonical = href or f"tabtin://resource/{resource_type}/{resource_id}"
        _push(
            kind=kind,
            filename=title or resource_id,
            file_id=resource_id if kind == "file" else None,
            url=canonical,
            source="agent",
            resource_type=resource_type,
            resource_id=resource_id,
        )

    for block in blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype in ("image", "file", "video", "document"):
            source = block.get("source") if isinstance(block.get("source"), dict) else {}
            file_id = block.get("file_id") or source.get("file_id")
            if not isinstance(file_id, str):
                file_id = None
            url = _httpish_url(block.get("url")) or _httpish_url(source.get("url"))
            if not url and source.get("type") == "base64" and isinstance(source.get("data"), str):
                media = source.get("media_type") if isinstance(source.get("media_type"), str) else "image/png"
                url = f"data:{media};base64,{source['data']}"
            preview = _httpish_url(block.get("preview_url"))
            filename = (
                block.get("filename")
                or block.get("title")
                or (file_id and f"{file_id[:8]}…")
                or "附件"
            )
            if not isinstance(filename, str):
                filename = "附件"
            mime = block.get("mime_type") or source.get("media_type")
            if not isinstance(mime, str):
                mime = None
            size = block.get("size")
            _push(
                kind="image" if btype == "image" else "file",
                filename=filename,
                file_id=file_id,
                mime_type=mime,
                size=size if isinstance(size, int) else None,
                url=url,
                preview_url=preview,
                source="user",
            )
            continue

        if btype in ("tabtin_rich_content", "rich_content"):
            payload = block.get("payload") if isinstance(block.get("payload"), dict) else {}
            kind = block.get("kind")
            artifact_kind = block.get("artifact_kind") or payload.get("artifact_kind")

            if kind == "file" or artifact_kind in ("oss_file", "local_file"):
                file_id = payload.get("file_id") or block.get("file_id")
                if not isinstance(file_id, str):
                    file_id = None
                url = (
                    _httpish_url(payload.get("access_url"))
                    or _httpish_url(block.get("access_url"))
                    or _httpish_url(payload.get("url"))
                    or _httpish_url(block.get("url"))
                )
                resource_url = None
                for candidate in (
                    payload.get("url"),
                    block.get("url"),
                    f"tabtin://resource/file/{file_id}" if file_id else None,
                ):
                    if isinstance(candidate, str) and candidate.startswith("tabtin://resource/"):
                        resource_url = candidate
                        break
                filename = (
                    payload.get("filename")
                    or block.get("filename")
                    or block.get("summary")
                    or (file_id and f"{file_id[:8]}…")
                    or "Agent 文件"
                )
                if not isinstance(filename, str):
                    filename = "Agent 文件"
                mime = payload.get("mime_type") or block.get("mime_type")
                if not isinstance(mime, str):
                    mime = None
                size = payload.get("file_size") or block.get("file_size")
                attach_kind = "image" if (mime or "").startswith("image/") else "file"
                _push(
                    kind=attach_kind,
                    filename=filename,
                    file_id=file_id,
                    mime_type=mime,
                    size=size if isinstance(size, int) else None,
                    url=url or resource_url,
                    preview_url=_httpish_url(
                        payload.get("preview_url")
                        or payload.get("image_url")
                        or block.get("preview_url")
                        or block.get("image_url")
                    ),
                    source="agent",
                    resource_type="file" if file_id or resource_url else None,
                    resource_id=file_id,
                )
                continue

            # 与 Electron 可交付口径对齐：platform_resource / 显式 resource_ref
            if kind == "resource_ref" or artifact_kind == "platform_resource":
                href = None
                for candidate in (block.get("url"), payload.get("url")):
                    if isinstance(candidate, str) and candidate.startswith("tabtin://"):
                        href = candidate
                        break
                resource_type = (
                    block.get("resource_type")
                    or payload.get("resource_type")
                )
                resource_id = block.get("resource_id") or payload.get("resource_id")
                if not isinstance(resource_type, str):
                    resource_type = None
                if not isinstance(resource_id, str):
                    resource_id = None
                title = (
                    block.get("resource_name")
                    or payload.get("resource_name")
                    or block.get("summary")
                    or payload.get("summary")
                    or resource_id
                    or "Agent 资源"
                )
                if not isinstance(title, str):
                    title = "Agent 资源"
                _push_resource(
                    href=href,
                    title=title,
                    resource_type=resource_type,
                    resource_id=resource_id,
                )

    # 正文资源链接（本会话常文档创建成功后只写 markdown，无独立 rich 块）
    text = _collect_text_for_attachments(blocks, content)
    if "tabtin://resource/" in text:
        cleaned = _strip_code_segments(text)
        label_by_url: dict[str, str] = {}
        for match in _MD_RESOURCE_LINK_RE.finditer(cleaned):
            label = re.sub(r"[*`_~]", "", match.group(1) or "").strip()
            href = _sanitize_resource_href(match.group(2) or "")
            if href and label and href not in label_by_url:
                label_by_url[href] = label
        for match in _BARE_RESOURCE_URI_RE.finditer(cleaned):
            href = _sanitize_resource_href(match.group(0))
            if not href:
                continue
            title = label_by_url.get(href) or ""
            parsed = _parse_tabtin_resource(href)
            if not parsed:
                continue
            _resource_type, resource_id = parsed
            _push_resource(
                href=href,
                title=title or resource_id,
            )

    return attachments


def _serialize_chat_message_for_export(message) -> dict:
    """对话导出：落库 chat_message 字段，含 content_blocks_json。"""
    blocks = message.content_blocks_json if isinstance(message.content_blocks_json, list) else []
    content = message.text_summary or ""
    return {
        "id": str(message.id),
        "role": message.role,
        "message_kind": message.message_kind,
        "content": content,
        "text_summary": message.text_summary or "",
        "content_blocks_json": blocks,
        "attachments": _extract_message_attachments(blocks, content),
        "trace_id": str(message.trace_id) if message.trace_id else None,
        "agent_run_id": message.agent_run_id or None,
        "model_name": message.model_name_snapshot or None,
        "model_display_name": (
            _label_for_model_key(message.model_name_snapshot)
            if message.model_name_snapshot
            else None
        ),
        "stop_reason": message.stop_reason or None,
        "usage": message.usage_json,
        "error": message.error_info_json,
        "subagent_run_id": message.subagent_run_id or None,
        "created_at": message.created_at.isoformat(),
    }


def _system_from_llm_snapshot(session_id: str) -> Optional[dict]:
    """从 chat_llm_snapshot 取该 session 最近一次调用的 system（含 sections）。

    注意：是 session 级「最近一条快照」，不是按 turn / 按消息对齐。
    会话中途改 Agent / 规则时，导出的 system 可能对不上早期轮次。
    """
    snapshot = (
        ChatLLMSnapshot.objects.filter(session_id=str(session_id))
        .order_by("-updated_at", "-iteration", "-id")
        .first()
    )
    if snapshot is None:
        return None
    payload = snapshot.snapshot_json if isinstance(snapshot.snapshot_json, dict) else None
    if not payload:
        return None
    system = payload.get("system")
    if not isinstance(system, dict):
        return None
    sections = system.get("sections")
    if not isinstance(sections, list) or not sections:
        return None
    model_key = snapshot.model or payload.get("model") or None
    return {
        "system": system,
        "system_source": {
            "kind": "chat_llm_snapshot",
            "run_id": snapshot.run_id,
            "iteration": snapshot.iteration,
            "model": model_key,
            "model_display_name": _label_for_model_key(model_key) if model_key else None,
            "created_at": snapshot.created_at.isoformat() if snapshot.created_at else None,
            "updated_at": snapshot.updated_at.isoformat() if snapshot.updated_at else None,
            "truncated_for_relay": bool(payload.get("truncated_for_relay")),
        },
    }


def _system_from_prompt_context_messages(session) -> Optional[dict]:
    """无云端快照时，回退到落库的 system_prompt_context 消息。

    形态与 snapshot 不同：通常只有单段 sections[0].name=system_prompt_context，
    没有完整 identity / tools / skills 等分段。
    """
    prompt_messages = list(
        session.messages.filter(message_kind="system_prompt_context").order_by(
            "-arrival_seq", "-created_at", "-id"
        )[:1]
    )
    if not prompt_messages:
        return None
    message = prompt_messages[0]
    blocks = message.content_blocks_json if isinstance(message.content_blocks_json, list) else []
    text_parts = []
    for block in blocks:
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
            text_parts.append(block["text"])
    text = "\n".join(text_parts).strip() or (message.text_summary or "")
    if not text:
        return None
    return {
        "system": {
            "sections": [
                {
                    "name": "system_prompt_context",
                    "source": "chat_message",
                    "charCount": len(text),
                    "contentPreview": text,
                }
            ],
            "charCount": len(text),
        },
        "system_source": {
            "kind": "system_prompt_context",
            "message_id": str(message.id),
            "created_at": message.created_at.isoformat() if message.created_at else None,
        },
    }


def _resolve_system_prompt_for_export(session) -> dict:
    """Admin 导出附带系统提示词。

    优先级：
    1. chat_llm_snapshot — session 最近一次（非按 turn）
    2. system_prompt_context — 无快照时的落库回退（单段形态）
    3. system=null + system_source.kind=missing
    """
    from_snapshot = _system_from_llm_snapshot(session.id)
    if from_snapshot:
        return from_snapshot
    from_context = _system_from_prompt_context_messages(session)
    if from_context:
        return from_context
    return {
        "system": None,
        "system_source": {"kind": "missing", "reason": "no_llm_snapshot_or_system_prompt_context"},
    }


def _resolve_export_model(session, visible_messages: list, system_payload: dict) -> dict:
    """导出最近实际模型，同时保留稳定的原始 ID 与运营展示名。"""
    for message in reversed(visible_messages):
        model_key = getattr(message, "model_name_snapshot", None)
        if getattr(message, "role", None) == "assistant" and isinstance(model_key, str) and model_key.strip():
            normalized_key = model_key.strip()
            return {
                "id": normalized_key,
                "display_name": _label_for_model_key(normalized_key),
                "source": "assistant_message",
            }

    system_source = system_payload.get("system_source")
    if isinstance(system_source, dict):
        model_key = system_source.get("model")
        if isinstance(model_key, str) and model_key.strip():
            normalized_key = model_key.strip()
            return {
                "id": normalized_key,
                "display_name": _label_for_model_key(normalized_key),
                "source": "llm_snapshot",
            }

    current_model = getattr(session, "current_model", None)
    current_model_id = getattr(session, "current_model_id", None)
    if current_model is not None or current_model_id:
        model_id = str(current_model_id) if current_model_id else None
        return {
            "id": model_id,
            "display_name": _display_name(current_model),
            "source": "session_current_model",
        }

    return {"id": None, "display_name": None, "source": "missing"}


def _llm_snapshots_for_export(session_id: str, snapshot_limit: int) -> tuple[list[dict], bool]:
    """Return client-aligned LLM snapshots with stable server-side metadata.

    ``snapshot`` remains the original relay payload so operators can compare it
    directly with Electron's ``llm-snapshot-*.json`` export. The wrapper only
    adds searchable database metadata and a readable model label.
    """
    limit = max(1, min(snapshot_limit, 500))
    rows = list(
        ChatLLMSnapshot.objects.filter(session_id=str(session_id))
        .order_by("created_at", "iteration", "id")[: limit + 1]
    )
    truncated = len(rows) > limit
    exported = []
    for row in rows[:limit]:
        payload = row.snapshot_json if isinstance(row.snapshot_json, dict) else {}
        model_key = row.model or payload.get("model") or None
        exported.append(
            {
                "run_id": row.run_id,
                "iteration": row.iteration,
                "model": model_key,
                "model_display_name": _label_for_model_key(model_key) if model_key else None,
                "created_at": row.created_at.isoformat() if row.created_at else None,
                "updated_at": row.updated_at.isoformat() if row.updated_at else None,
                "snapshot": payload,
            }
        )
    return exported, truncated


@router.get("/debug/threads/{thread_id}/chat-messages", auth=SuperuserAuth())
def get_thread_chat_messages(
    request,
    thread_id: str,
    message_limit: int = 500,
    snapshot_limit: int = 100,
):
    """导出落库 chat_message（含 content_blocks_json）+ session 级系统提示词。

    ``llm_snapshots`` additionally carries the client-aligned model-call
    snapshots. ``snapshot_limit`` defaults to 100 and is capped at 500.

    messages：与 overview 时间轴同一可见性口径（隐藏内部 context 注入）。

    system / system_source：
    - 优先取该 session 最近一次 chat_llm_snapshot.snapshot_json.system
      （完整 sections；非按 turn 对齐）
    - 无可用快照时回退 system_prompt_context 消息（单段 sections）
    - 都没有则 system=null，system_source.kind=missing

    AdminDash 下载整包 JSON；Trace / LLM Input Inspector 仍走原观测入口。
    """
    trace_qs = ExecutionTrace.objects.filter(thread_id=thread_id)
    session = _resolve_chat_session(thread_id, list(trace_qs[:20]))
    if not session:
        raise_not_found(MSG_THREAD_NOT_FOUND)

    limit = max(1, min(message_limit, 1000))
    all_messages = list(session.messages.order_by("arrival_seq", "created_at", "id"))
    visible_messages = [
        message for message in all_messages if not is_context_injection_message(message)
    ]
    exported = [_serialize_chat_message_for_export(message) for message in visible_messages[:limit]]
    system_payload = _resolve_system_prompt_for_export(session)
    llm_snapshots, llm_snapshots_truncated = _llm_snapshots_for_export(
        str(session.id), snapshot_limit
    )
    return {
        "thread_id": thread_id,
        "session_id": str(session.id),
        "source": "chat_message",
        "message_count": len(exported),
        "messages_truncated": len(visible_messages) > len(exported),
        "messages": exported,
        "model": _resolve_export_model(session, visible_messages, system_payload),
        "system": system_payload.get("system"),
        "system_source": system_payload.get("system_source"),
        "llm_snapshot_count": len(llm_snapshots),
        "llm_snapshots_truncated": llm_snapshots_truncated,
        "llm_snapshots": llm_snapshots,
    }


@router.get("/debug/threads/{thread_id}/overview", auth=SuperuserAuth())
def get_thread_overview(request, thread_id: str, message_limit: int = 200):
    """返回运营回看首屏需要的 Session 摘要与可读消息。"""
    trace_qs = ExecutionTrace.objects.filter(thread_id=thread_id)
    if not trace_qs.exists():
        raise_not_found(MSG_THREAD_NOT_FOUND)

    session = _resolve_chat_session(thread_id, trace_qs)
    _lazy_heal_session_persist_buckets(thread_id=thread_id)
    traces = list(
        _exclude_session_persist_buckets(
            _scope_traces_to_chat_session(trace_qs, session)
        ).order_by("started_at", "id")
    )
    limit = max(1, min(message_limit, 500))
    messages = []
    message_count = 0
    if session:
        message_qs = session.messages.order_by("arrival_seq", "created_at", "id")
        all_messages = list(message_qs)
        message_count = count_semantic_messages(all_messages)
        visible_messages = [
            message for message in all_messages if not is_context_injection_message(message)
        ]
        for message in visible_messages[:limit]:
            blocks = (
                message.content_blocks_json
                if isinstance(getattr(message, "content_blocks_json", None), list)
                else []
            )
            content = message.text_summary or ""
            messages.append(
                {
                    "id": str(message.id),
                    "role": message.role,
                    "message_kind": message.message_kind,
                    "content": content,
                    "attachments": _extract_message_attachments(blocks, content),
                    "trace_id": str(message.trace_id) if message.trace_id else None,
                    "agent_run_id": message.agent_run_id or None,
                    "model_name": (
                        _label_for_model_key(message.model_name_snapshot)
                        if message.model_name_snapshot
                        else None
                    ),
                    "stop_reason": message.stop_reason or None,
                    "usage": message.usage_json,
                    "error": message.error_info_json,
                    "subagent_run_id": message.subagent_run_id or None,
                    "created_at": message.created_at.isoformat(),
                }
            )

    error_traces = [trace for trace in traces if trace.status == "error"]
    return {
        "thread_id": thread_id,
        "session": (
            {
                "id": str(session.id),
                "title": session.title,
                "status": session.status,
                "is_paused": session.is_paused,
                "user_id": str(session.user_id),
                "user_name": _display_name(session.user),
                "organization_id": session.organization_id,
                "organization_name": _organization_name(session.organization_id),
                "workspace_id": str(session.workspace_id) if session.workspace_id else None,
                "workspace_name": _display_name(session.workspace),
                "project_id": str(session.project_id) if session.project_id else None,
                "project_name": _display_name(session.project),
                "agent_id": str(session.agent_id) if session.agent_id else None,
                "agent_name": _display_name(session.agent),
                "agent_mode": session.agent_mode,
                "approval_mode": resolve_workspace_approval_mode(
                    session.workspace,
                    project=session.project_id,
                ),
                # ：优先实际执行模型（Codex / BYOK snapshot·by_model），非仅 FK
                "model_name": _resolve_session_model_name(session, messages, traces),
                "context_tier_id": session.context_tier_id or None,
                "created_at": session.created_at.isoformat(),
                "last_message_at": (
                    session.last_message_at.isoformat() if session.last_message_at else None
                ),
                "message_count": message_count,
                "input_tokens": session.input_tokens,
                "output_tokens": session.output_tokens,
                "total_tokens": session.total_tokens,
                "cache_read_input_tokens": session.cache_read_input_tokens,
                "cache_creation_input_tokens": session.cache_creation_input_tokens,
                "compaction_count": session.compaction_count,
                "forked_from_id": str(session.forked_from_id) if session.forked_from_id else None,
                "revert_at": session.revert_at.isoformat() if session.revert_at else None,
            }
            if session
            else None
        ),
        "messages": messages,
        "messages_truncated": len(visible_messages) > len(messages) if session else False,
        "trace_summary": {
            "total": len(traces),
            "completed": sum(trace.status == "completed" for trace in traces),
            "running": sum(trace.status == "running" for trace in traces),
            "error": len(error_traces),
            "latest_error": error_traces[-1].error if error_traces else None,
        },
    }

@router.get("/debug/traces", auth=SuperuserAuth())
def list_traces(
    request,
    thread_id: Optional[Union[str, list]] = None,
    session_id: Optional[Union[str, list]] = None,
    graph_type: Optional[Union[str, list]] = None,
):

    # 手动解析 limit 和 cursor
    limit = int(request.GET.get('limit', 50))
    cursor_str = request.GET.get('cursor')
    cursor = None
    if cursor_str:
        try:
            cursor = uuid.UUID(cursor_str)
        except ValueError:
            raise_bad_request(MSG_CURSOR_INVALID_UUID)

    qs = _build_trace_queryset(request.auth, thread_id, session_id, graph_type)
    normalized_thread_id = _normalize_query_value(thread_id)
    if normalized_thread_id:
        session = _resolve_chat_session(normalized_thread_id, qs)
        qs = _scope_traces_to_chat_session(qs, session)
        _lazy_heal_session_persist_buckets(thread_id=normalized_thread_id)
        qs = _exclude_session_persist_buckets(qs)
    if cursor:
        cursor_trace = ExecutionTrace.objects.filter(trace_id=cursor).first()
        if not cursor_trace:
            raise_bad_request(MSG_CURSOR_NOT_FOUND)
        qs = qs.filter(id__lt=cursor_trace.id)
    limit_val = max(1, min(limit or 50, 200))
    items = list(qs[:limit_val])
    next_cursor = str(items[-1].trace_id) if items else None
    return {
        "items": [_serialize_trace(item) for item in items],
        "next_cursor": next_cursor,
    }


@router.get("/debug/threads/{thread_id}/traces", auth=SuperuserAuth())
def list_thread_traces(request, thread_id: str):
    """返回当前 ChatSession 生命周期内的执行记录，供会话详情页使用。"""
    qs = ExecutionTrace.objects.filter(thread_id=thread_id).order_by("-id")
    session = _resolve_chat_session(thread_id, qs)
    _lazy_heal_session_persist_buckets(thread_id=thread_id)
    items = list(
        _exclude_session_persist_buckets(
            _scope_traces_to_chat_session(qs, session)
        )[:200]
    )
    return {
        "items": [_serialize_trace(item) for item in items],
        "next_cursor": str(items[-1].trace_id) if len(items) == 200 else None,
    }


@router.get("/debug/traces/{trace_id}", auth=SuperuserAuth())
def get_trace(request, trace_id: str):
    trace = ExecutionTrace.objects.filter(trace_id=trace_id).first()
    if not trace:
        raise_not_found(MSG_TRACE_NOT_FOUND)
    return _serialize_trace(trace)

@router.get("/debug/traces/{trace_id}/events", auth=SuperuserAuth())
def get_trace_events(
    request,
    trace_id: str,
):

    # 手动解析 limit 和 cursor
    limit = int(request.GET.get('limit', 200))
    cursor_str = request.GET.get('cursor')
    cursor = None
    if cursor_str:
        try:
            cursor = uuid.UUID(cursor_str)
        except ValueError:
            raise_bad_request(MSG_CURSOR_INVALID_UUID)

    trace = ExecutionTrace.objects.filter(trace_id=trace_id).first()
    if not trace:
        raise_not_found(MSG_TRACE_NOT_FOUND)
    qs = (
        TraceEvent.objects.filter(trace=trace)
        .select_related("trace", "parent_event")
        .order_by("seq")
    )
    if cursor:
        cursor_event = TraceEvent.objects.filter(
            trace=trace, event_uuid=cursor
        ).first()
        if not cursor_event:
            raise_bad_request(MSG_CURSOR_NOT_FOUND)
        qs = qs.filter(seq__gt=cursor_event.seq)
    limit_val = max(1, min(limit or 200, 500))
    events = list(qs[:limit_val])
    next_cursor = str(events[-1].event_uuid) if events else None
    return {
        "items": [_serialize_event(event) for event in events],
        "next_cursor": next_cursor,
    }

@router.get("/user/traces", auth=jwt_auth)
def list_user_traces(
    request,
    thread_id: Optional[Union[str, list]] = None,
    session_id: Optional[Union[str, list]] = None,
    graph_type: Optional[Union[str, list]] = None,
):
    # 手动解析 limit 和 cursor
    limit = int(request.GET.get('limit', 50))
    cursor_str = request.GET.get('cursor')
    cursor = None
    if cursor_str:
        try:
            cursor = uuid.UUID(cursor_str)
        except ValueError:
            raise_bad_request(MSG_CURSOR_INVALID_UUID)

    qs = _build_trace_queryset(request.auth, thread_id, session_id, graph_type)
    if cursor:
        cursor_trace = ExecutionTrace.objects.filter(trace_id=cursor).first()
        if not cursor_trace:
            raise_bad_request(MSG_CURSOR_NOT_FOUND)
        qs = qs.filter(id__lt=cursor_trace.id)
    limit_val = max(1, min(limit or 50, 200))
    items = list(qs[:limit_val])
    next_cursor = str(items[-1].trace_id) if items else None
    return {
        "items": [_serialize_trace(item) for item in items],
        "next_cursor": next_cursor,
    }

@router.get("/user/traces/{trace_id}", auth=jwt_auth)
def get_user_trace(request, trace_id: str):
    trace = ExecutionTrace.objects.filter(trace_id=trace_id).first()
    if not trace:
        raise_not_found(MSG_TRACE_NOT_FOUND)
    _ensure_trace_owner(request, trace)
    return _serialize_trace(trace)

@router.get("/user/traces/{trace_id}/events", auth=jwt_auth)
def get_user_trace_events(
    request,
    trace_id: str,
):
    # 手动解析 limit 和 cursor
    limit = int(request.GET.get('limit', 200))
    cursor_str = request.GET.get('cursor')
    cursor = None
    if cursor_str:
        try:
            cursor = uuid.UUID(cursor_str)
        except ValueError:
            raise_bad_request(MSG_CURSOR_INVALID_UUID)

    trace = ExecutionTrace.objects.filter(trace_id=trace_id).first()
    if not trace:
        raise_not_found(MSG_TRACE_NOT_FOUND)
    _ensure_trace_owner(request, trace)
    qs = (
        TraceEvent.objects.filter(trace=trace)
        .select_related("trace", "parent_event")
        .order_by("seq")
    )
    if cursor:
        cursor_event = TraceEvent.objects.filter(
            trace=trace, event_uuid=cursor
        ).first()
        if not cursor_event:
            raise_bad_request(MSG_CURSOR_NOT_FOUND)
        qs = qs.filter(seq__gt=cursor_event.seq)
    limit_val = max(1, min(limit or 200, 500))
    events = list(qs[:limit_val])
    next_cursor = str(events[-1].event_uuid) if events else None
    return {
        "items": [_serialize_event(event) for event in events],
        "next_cursor": next_cursor,
    }

# ------------------------------------------------------------------
# Phase 2: 增强 Debug API（可观测性）
# ------------------------------------------------------------------

@router.get("/debug/traces/{trace_id}/prompt-snapshots", auth=SuperuserAuth())
def get_trace_prompt_snapshots(request, trace_id: str):
    """获取某次 trace 的所有 prompt 快照。"""
    trace = ExecutionTrace.objects.filter(trace_id=trace_id).first()
    if not trace:
        raise_not_found(MSG_TRACE_NOT_FOUND)
    events = (
        TraceEvent.objects.filter(trace=trace, event_type="prompt_snapshot")
        .select_related("trace", "parent_event")
        .order_by("seq")
    )
    return {"items": [_serialize_event(e) for e in events]}

@router.get("/debug/traces/{trace_id}/middleware-timing", auth=SuperuserAuth())
def get_trace_middleware_timing(request, trace_id: str):
    """获取 middleware 耗时数据（优先从 TraceEvent 读取，回退到 state）。"""
    trace = ExecutionTrace.objects.filter(trace_id=trace_id).first()
    if not trace:
        raise_not_found(MSG_TRACE_NOT_FOUND)

    from apps.services.agent_engine.observability.middleware_timing import load_middleware_timing_from_trace
    timing = load_middleware_timing_from_trace(trace_id)

    return {"thread_id": trace.thread_id, "middleware_timing": timing}

@router.get("/debug/traces/{trace_id}/errors", auth=SuperuserAuth())
def get_trace_errors(request, trace_id: str):
    """获取 trace 中的结构化错误事件。

    H2-A 运维 Review P0 修复：原本只查 `event_type="error"`（云端
    `TraceRecorder.record_event(event_type="error", ...)` 写入），
    但本地 Runtime 通过 `relay_trace_writer._make_trace_event` 写入的
    `event_type` 是 stream 短名（`done` / `lifecycle` / `tool` 等），
    错误事件落在 `done(error=true)` / `lifecycle(phase=error)` 等地方
    的 `error` 字段。两种来源都要识别，否则 AdminDash 错误 Tab 对本地
    Runtime trace 完全空壳。

    匹配规则：
      - 历史云端引擎：`event_type='error'`（向后兼容历史 trace 数据）
      - 本地 Runtime：`error` 字段非空（done(error) / lifecycle(error)
        会写入 error 文本到该字段，由 `_make_trace_event` 统一处理）
    """
    trace = ExecutionTrace.objects.filter(trace_id=trace_id).first()
    if not trace:
        raise_not_found(MSG_TRACE_NOT_FOUND)
    events = (
        TraceEvent.objects.filter(trace=trace)
        .filter(Q(event_type="error") | (~Q(error__isnull=True) & ~Q(error="")))
        .select_related("trace", "parent_event")
        .order_by("seq")
    )
    return {"items": [_serialize_event(e) for e in events]}

@router.get("/debug/threads/{thread_id}/state", auth=SuperuserAuth())
def get_thread_state(request, thread_id: str):
    """获取 ConversationState 详情（用于调试）。"""
    try:
        from apps.services.agent_engine.persistence.conversation_store import ConversationStore
        # ATK-3: superuser 专用调试端点（_ensure_superuser 已校验），不传 expected_user_id
        state = ConversationStore.load_state(thread_id)
    except (DatabaseError, json.JSONDecodeError, OSError) as exc:
        raise_internal(f"加载状态失败: {exc}")
    except Exception as exc:
        logger.critical("[get_thread_state] unexpected error loading state: %s", exc, exc_info=True)
        raise_internal(f"加载状态失败: {exc}")

    if state is None:
        raise_not_found(MSG_STATE_NOT_FOUND)

    messages = state.get("messages") or []
    safe_state = {
        k: v for k, v in state.items()
        if k != "messages" and not k.startswith("__")
    }

    return {
        "thread_id": thread_id,
        "messages_count": len(messages),
        "messages_roles": _count_roles(messages),
        "state_keys": list(safe_state.keys()),
        "state": safe_state,
    }

@router.get("/debug/stats/errors", auth=SuperuserAuth())
def get_error_stats(request):
    """错误聚合统计（按 category 和时间范围）。

    H2-A 运维 Review P0 修复：与 `get_trace_errors` 同步——错误事件
    既包括云端 `event_type='error'` 也包括本地 Runtime 的 `error` 字段
    非空事件。`category` 优先取 input.category（云端），fallback 到
    input.error_class（本地 Runtime FR-06 的 done.error_class），
    再 fallback 到 event_type 短名做粗粒度聚合。
    """

    from datetime import timedelta

    hours = max(1, min(int(request.GET.get("hours", 24)), 720))
    since = timezone.now() - timedelta(hours=hours)

    by_category_rows = (
        TraceEvent.objects.filter(started_at__gte=since)
        .filter(Q(event_type="error") | (~Q(error__isnull=True) & ~Q(error="")))
        .annotate(
            # output_field 必须显式声明：KeyTextTransform 输出 TextField，
            # 而 TraceEvent.event_type 是 CharField，Django Coalesce 不允许
            # 混合两种 string 类型，会抛 FieldError（"Expression contains
            # mixed types: TextField, CharField"）。统一为 TextField。
            category=Coalesce(
                KeyTextTransform("category", "input"),
                # 本地 Runtime FR-06：done event 的 input 含 error_class
                # （AgentErrorCode：LLM_ERROR / TOOL_TIMEOUT / DOOM_LOOP_DETECTED
                # 等）。聚合时复用 — 让运维能"按 LLM_ERROR 拉所有失败 trace"。
                KeyTextTransform("error_class", "input"),
                # 兜底：用 event_type 做粗粒度分类（done / lifecycle 等）
                "event_type",
                Value("unknown"),
                output_field=TextField(),
            )
        )
        .values("category")
        .annotate(count=Count("id"))
        .order_by("category")
    )
    by_category = {row["category"]: row["count"] for row in by_category_rows}
    total_errors = sum(by_category.values())

    total_traces = ExecutionTrace.objects.filter(started_at__gte=since).count()
    error_traces = ExecutionTrace.objects.filter(
        started_at__gte=since, status="error"
    ).count()

    return {
        "period_hours": hours,
        "total_errors": total_errors,
        "by_category": by_category,
        "total_traces": total_traces,
        "error_traces": error_traces,
        "error_rate": round(error_traces / max(total_traces, 1), 4),
    }

@router.post("/debug/threads/{thread_id}/debug-mode", auth=SuperuserAuth())
def toggle_debug_mode(request, thread_id: str):
    """开启/关闭某个 thread 的 debug 模式。"""

    try:
        body = json.loads(request.body) if request.body else {}
    except Exception:
        body = {}
    enabled = body.get("enabled", True)

    try:
        from apps.services.agent_engine.services.debug_mode_service import DebugModeService
        success = DebugModeService.toggle(thread_id, bool(enabled))
        if not success:
            raise_not_found(MSG_THREAD_NOT_FOUND)
    except HttpError:
        raise
    except Exception as exc:
        raise_internal(f"更新失败: {exc}")

    return {"thread_id": thread_id, "debug_mode": bool(enabled)}

def _count_roles(messages: list) -> dict:
    counts: dict = {}
    for m in messages:
        if isinstance(m, dict):
            role = m.get("role", "unknown")
            counts[role] = counts.get(role, 0) + 1
    return counts

# ------------------------------------------------------------------
# Phase 5: Health Check
# ------------------------------------------------------------------

@router.get("/health", auth=SuperuserAuth())
def agent_health_check(request):
    """Agent 系统自检（W10 简化版）。

    旧实现枚举注册表里的 Agent 实例 / 工具列表 / 中间件计数 —— 这些都
    属于已删除的历史云端引擎，本 endpoint 不再尝试探测它们。Agent 执行
    健康度现由设备端 runtime + relay_events 路径自有遥测，AdminDash 只
    关心 Django 依赖（Redis / PostgreSQL）是否在线即可。
    """

    result: dict = {
        "redis": "unknown",
        "postgresql": "unknown",
    }

    try:
        import redis as redis_lib
        from django.conf import settings as django_settings
        r = redis_lib.Redis(
            host=getattr(django_settings, "REDIS_HOST", "localhost"),
            port=getattr(django_settings, "REDIS_PORT", 6379),
            db=getattr(django_settings, "REDIS_DB", 2),
        )
        r.ping()
        result["redis"] = "ok"
    except Exception as exc:
        logger.warning("[AgentDash] Redis health check failed: %s", exc)
        result["redis"] = f"error: {exc}"

    try:
        from django.db import connections
        conn = connections["postgresql"]
        conn.ensure_connection()
        result["postgresql"] = "ok"
    except Exception as exc:
        logger.warning("[AgentDash] PostgreSQL health check failed: %s", exc)
        result["postgresql"] = f"error: {exc}"

    return result
