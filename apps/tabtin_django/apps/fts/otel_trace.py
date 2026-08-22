"""FTS OpenTelemetry 链路追踪（Wave 5 ADR-05 落地）。

设计原则：
    - **try-import 兼容**：参照 `apps/services/agent_engine/middleware/otel_trace.py`
      的模式，未装 OTel 时降级为 no-op 上下文管理器（不破坏行为）。
    - **fts 内部 only**：不污染非 fts 代码（PRD 总控约束）。
    - **零侵入**：每个 span 通过 `with start_*_span(...) as span:` 语法接入；
      span 的 attribute 用半结构化字段（user_id / organization_id / request_id）
      便于跨服务关联。
    - **GenAI 语义无关**：搜索是普通 Web/RPC 调用，不用 GenAI semconv，
      用 OTel 通用 attribute 命名（service.name / db.system / http.target）。

集成点（Wave 5 落地）：
    - `api.unified_search` → root span "fts.search.web"
    - `SearchTool.run` → root span "fts.search.fc"
    - `search_service.search` → child span "fts.search_service"
    - `acl_service.get_user_accessible_spaces` → child span "fts.acl"
    - `hydration_service.hydrate` → child span "fts.hydrate"
    - `tasks.flush_outbox_task` → root span "fts.flush_outbox"
    - `tasks.update_by_query_task` → root span "fts.update_by_query"

R0-01 决策记录：
    Wave 5 引入 `opentelemetry-sdk` 但保持 try-import 兼容（避免强制依赖
    在 CI/dev 流水线上失败）。在生产环境通过设置 `OTEL_EXPORTER_OTLP_ENDPOINT`
    + 安装 `opentelemetry-sdk` 启用；本地开发不安装时是 no-op。

兼容现有 `agent_engine.middleware.otel_trace`：
    那里已有 try-import 模式，本模块各自独立 try-import 不冲突；同一进程
    都装 OTel SDK 时它们写入同一个 TracerProvider。
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Iterator, Optional

logger = logging.getLogger(__name__)

# ── 可选依赖：OpenTelemetry SDK ────────────────────────────────
_otel_available = False
_tracer = None

try:
    from opentelemetry import trace as _otel_trace
    from opentelemetry.trace import StatusCode as _OtelStatusCode
    _otel_available = True
    _tracer = _otel_trace.get_tracer(
        "tabtin.fts",
        schema_url="https://opentelemetry.io/schemas/1.24.0",
    )
except ImportError:
    pass  # 未安装即降级为 no-op

# 通用 OTel attribute key（不用 GenAI semconv，本服务不是 LLM）
ATTR_SERVICE_NAME = "service.name"
ATTR_USER_ID = "tabtin.user.id"
ATTR_ORGANIZATION_ID = "tabtin.organization.id"
ATTR_REQUEST_ID = "tabtin.request.id"
ATTR_SEARCH_PATH = "tabtin.search.path"  # web / cli / fc
ATTR_SEARCH_QUERY_LEN = "tabtin.search.query_length"  # 不记录原 query（隐私）
ATTR_SEARCH_TYPES = "tabtin.search.types"
ATTR_SEARCH_TOTAL = "tabtin.search.total"
ATTR_SEARCH_DEGRADED = "tabtin.search.degraded"
ATTR_SEARCH_DEGRADED_REASON = "tabtin.search.degraded_reason"
ATTR_SEARCH_NOTICE = "tabtin.search.notice"
ATTR_INDEX_NAME = "tabtin.fts.index"
ATTR_DB_NAME = "db.name"

SPAN_SEARCH_ROOT = "fts.search"
SPAN_ACL = "fts.acl"
SPAN_HYDRATE = "fts.hydrate"
SPAN_FLUSH_OUTBOX = "fts.flush_outbox"
SPAN_UPDATE_BY_QUERY = "fts.update_by_query"
SPAN_DELETE_BY_QUERY = "fts.delete_by_query"


def is_otel_available() -> bool:
    return _otel_available


# ── no-op 上下文管理器 ─────────────────────────────────────────
class _NoOpSpan:
    """no-op span：所有 set_attribute / set_status / record_exception 都是 no-op。"""

    def set_attribute(self, *args, **kwargs):
        return None

    def set_status(self, *args, **kwargs):
        return None

    def record_exception(self, *args, **kwargs):
        return None

    def end(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *args, **kwargs):
        return False


def _start_span(name: str, attributes: Optional[dict] = None):
    """创建一个 span（兼容 OTel 缺失场景）。"""
    if not _otel_available or _tracer is None:
        return _NoOpSpan()
    span = _tracer.start_span(name=name, attributes=attributes or {})
    return span


# ── 公开 helper：search 入口 root span ─────────────────────────
@contextmanager
def start_search_span(
    *,
    user_id: str = "",
    organization_id: str = "",
    request_id: str = "",
    path: str = "web",
    query_length: Optional[int] = None,
    types: Optional[str] = None,
) -> Iterator[Any]:
    """根 span：覆盖 `/api/search` / `tabtin.search` FC / CLI 入口。

    Yields:
        span 对象（OTel 真实 span 或 _NoOpSpan）。调用方可在 with 块内
        `span.set_attribute(...)` 加额外属性，特别是出 span 前补 total/degraded。
    """
    attrs = {
        ATTR_SERVICE_NAME: "tabtin-fts",
        ATTR_SEARCH_PATH: path,
    }
    if user_id:
        attrs[ATTR_USER_ID] = user_id
    if organization_id:
        attrs[ATTR_ORGANIZATION_ID] = organization_id
    if request_id:
        attrs[ATTR_REQUEST_ID] = request_id
    if query_length is not None:
        attrs[ATTR_SEARCH_QUERY_LEN] = int(query_length)
    if types:
        attrs[ATTR_SEARCH_TYPES] = types

    span = _start_span(SPAN_SEARCH_ROOT, attrs)
    try:
        # 用 with：让 OTel 真实 span 也支持 set_attribute / set_status
        if _otel_available and not isinstance(span, _NoOpSpan):
            try:
                from opentelemetry import trace as otel_trace
                # 进入 span context，让子 span 自动挂在它下面
                with otel_trace.use_span(span, end_on_exit=False):
                    yield span
            except Exception:  # pragma: no cover - 主路径不挂
                yield span
        else:
            yield span
    except Exception as exc:
        if _otel_available and not isinstance(span, _NoOpSpan):
            try:
                span.record_exception(exc)
                span.set_status(_OtelStatusCode.ERROR, str(exc))
            except Exception:
                pass
        raise
    finally:
        try:
            span.end()
        except Exception:
            pass


@contextmanager
def start_acl_span(
    *, user_id: str = "", organization_id: str = "",
) -> Iterator[Any]:
    """ACL service 子 span。"""
    attrs = {ATTR_SERVICE_NAME: "tabtin-fts", ATTR_DB_NAME: "postgresql,redis"}
    if user_id:
        attrs[ATTR_USER_ID] = user_id
    if organization_id:
        attrs[ATTR_ORGANIZATION_ID] = organization_id
    span = _start_span(SPAN_ACL, attrs)
    try:
        yield span
    finally:
        try:
            span.end()
        except Exception:
            pass


@contextmanager
def start_hydrate_span(*, item_count: int = 0) -> Iterator[Any]:
    """Hydration service 子 span。"""
    attrs = {ATTR_SERVICE_NAME: "tabtin-fts", "tabtin.fts.hydrate.item_count": item_count}
    span = _start_span(SPAN_HYDRATE, attrs)
    try:
        yield span
    finally:
        try:
            span.end()
        except Exception:
            pass


@contextmanager
def start_flush_outbox_span(*, db: str = "", attempted: int = 0) -> Iterator[Any]:
    """flush_outbox_task root span（task 入口，无父 span）。"""
    attrs = {
        ATTR_SERVICE_NAME: "tabtin-fts",
        ATTR_DB_NAME: db,
        "tabtin.fts.outbox.attempted": attempted,
    }
    span = _start_span(SPAN_FLUSH_OUTBOX, attrs)
    try:
        yield span
    finally:
        try:
            span.end()
        except Exception:
            pass


@contextmanager
def start_update_by_query_span(
    *, index_alias: str = "", field: str = "", value: str = "",
) -> Iterator[Any]:
    """update_by_query task root span。"""
    attrs = {
        ATTR_SERVICE_NAME: "tabtin-fts",
        ATTR_INDEX_NAME: index_alias,
        "tabtin.fts.upbq.field": field,
        # value 可能是 UUID/sensitive；只记录 length
        "tabtin.fts.upbq.value_length": len(value) if value else 0,
    }
    span = _start_span(SPAN_UPDATE_BY_QUERY, attrs)
    try:
        yield span
    finally:
        try:
            span.end()
        except Exception:
            pass


def annotate_search_response(span: Any, *, response: Any) -> None:
    """把 SearchResponse 的关键字段写到 span attributes（不记录 query 内容防隐私）。"""
    if not _otel_available or isinstance(span, _NoOpSpan):
        return
    try:
        span.set_attribute(ATTR_SEARCH_TOTAL, int(getattr(response, "total", 0) or 0))
        span.set_attribute(ATTR_SEARCH_DEGRADED, bool(getattr(response, "degraded", False)))
        reason = getattr(response, "degraded_reason", None)
        if reason:
            span.set_attribute(ATTR_SEARCH_DEGRADED_REASON, str(reason))
        notice = getattr(response, "notice", None)
        if notice:
            span.set_attribute(ATTR_SEARCH_NOTICE, str(notice))
    except Exception:  # pragma: no cover
        logger.debug("[FTS][otel] annotate_search_response failed", exc_info=True)


__all__ = [
    "is_otel_available",
    "start_search_span",
    "start_acl_span",
    "start_hydrate_span",
    "start_flush_outbox_span",
    "start_update_by_query_span",
    "annotate_search_response",
]
