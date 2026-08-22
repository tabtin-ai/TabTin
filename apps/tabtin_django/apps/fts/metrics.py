"""FTS Prometheus 指标（PRD 6.3 + Wave 5 补全）。

设计原则：
    - **prometheus-client 是进程内单例**：模块级 Counter/Histogram 只能定义一次；
      同进程多次 import 不会重复注册（prometheus-client 内部去重）
    - **零侵入接入**：所有指标通过 helper 函数（`record_search_outcome` /
      `record_outbox_backlog` 等）暴露；调用方不直接操作 Counter/Gauge 对象，
      便于后续替换实现（OTel / DataDog 等）
    - **labels 收敛**：Histogram label 维度过多会导致 series 爆炸；
      `SEARCH_LATENCY` 只 label `degraded`（True/False） + `path`（cli/fc/web）
    - **flag 关闭也安全**：fts 关闭时 metrics 仍可定义/记录；只是值不会增长
    - **集成边界**：`metric_timer` 是上下文管理器，self.search() 内部包一次；
      失败也会记录耗时（通过 `__exit__` exc_type 判定 success/failed）

⚠ **生产 Multi-process 部署警告**（Wave 5 三视角 Review C1 + R5-21）：
    生产 gunicorn 是 multi-worker（`workers = cpu_count() * 2 + 1`，典型 16-32 个）。
    prometheus-client 默认拿当前进程的全局 REGISTRY，**不会聚合其他 worker**！
    `/metrics/` 端点每次只返回 1/N worker 的真实数据 → SLO 数字失真。

    **必须在生产部署前完成以下配置**（见 ROLLBACK.md §X 补充指南）：
        1. `requirements.txt` 加 `prometheus_client[multiprocess]` 依赖
        2. settings.py 顶部加 `os.environ['PROMETHEUS_MULTIPROC_DIR'] = '/tmp/prometheus_multiproc'`
        3. 重写 `/metrics/` 端点：用 `MultiProcessCollector` 聚合：
           ```python
           from prometheus_client import CollectorRegistry, generate_latest
           from prometheus_client.multiprocess import MultiProcessCollector
           registry = CollectorRegistry()
           MultiProcessCollector(registry)
           return HttpResponse(generate_latest(registry), ...)
           ```
        4. **本文件的所有 Gauge 必须显式声明 `multiprocess_mode='livesum'`**：
           - OUTBOX_BACKLOG / OUTBOX_TERMINAL_BACKLOG / HEALTH_STATUS / INDEX_LAG /
             REINDEX_PROGRESS 5 个 Gauge 在 multi-process 模式下需要明确聚合策略
        5. gunicorn `pre_fork` 钩子里也设环境变量
    R5-21（Wave 5 后新增遗留）跟踪此项；上线前 SRE 必修。

集成点（Wave 5 落地）：
    - `search_service.search` 入口 → 全 6 索引搜索延迟 + 路径标签 (web/cli/fc)
    - `fallback_service.fallback_search` 入口 → 同上 + degraded=True
    - `fallback_service.should_fallback` 触发降级 → DEGRADE_COUNT.labels(reason).inc()
    - `tasks.flush_outbox_task` 末尾 → OUTBOX_BACKLOG.set(get_backlog(...))
    - `tasks.health_probe_task` → HEALTH_STATUS.labels(status).set(1)
    - `SearchTool.run` 入口 → FC_INVOKE_COUNT.labels(notice).inc()（R4-04 修复）
    - `signals._safe_write_outbox` 失败 → OUTBOX_WRITE_FAILED_COUNT.inc()（R1-08）
    - `acl_service` cache invalidate 失败 → ACL_INVALIDATE_FAILED_COUNT.inc()（R2-10）

告警规则（PRD 6.3）：
    | 指标 | 告警条件 | 级别 |
    | fts_search_duration_seconds P95 | > 500ms 持续 5min | Warning |
    | fts_search_duration_seconds P99 | > 1s 持续 5min | Critical |
    | fts_outbox_backlog | > 10000 持续 5min | Warning |
    | fts_outbox_terminal_backlog | > 0 持续 5min | Critical (schema 问题) |
    | fts_degrade_total rate | > 1/min | Critical |
    | fts_zero_result_total rate | 突增 3 倍 | Warning |

复用 prometheus-client 已有的 metrics endpoint：
    `apps.services.common.ws.metrics.metrics_view` 暴露 /metrics（通用入口）。
    定义在本模块的 metric 会自动被 generate_latest() 收集，无需额外注册。
"""
from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from typing import Iterator, Literal, Optional

logger = logging.getLogger(__name__)

# prometheus-client 是必装依赖（requirements.txt 已 pin >=0.20.0）；
# 但 try-import 容错让单测 / Wave 0 早期 stage 仍可运行
try:
    from prometheus_client import Counter, Gauge, Histogram
    _PROM_AVAILABLE = True
except ImportError:
    _PROM_AVAILABLE = False
    Counter = Gauge = Histogram = None  # type: ignore[assignment,misc]


# ── 指标定义 ────────────────────────────────────────────────────
# Histogram bucket（秒）：覆盖 PRD 2.2 SLO 的 P95<200ms / P99<500ms +
# 实际生产 5s 超时 + 30s 极端长查询。比 prom 默认 bucket 更细。
_LATENCY_BUCKETS = (
    0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 2.0, 5.0, 10.0, 30.0,
)

if _PROM_AVAILABLE:
    SEARCH_LATENCY: "Histogram" = Histogram(  # type: ignore[type-arg]
        "fts_search_duration_seconds",
        "Unified search end-to-end latency (CLI / FC / Web 三入口共享)",
        labelnames=("path", "degraded"),
        buckets=_LATENCY_BUCKETS,
    )

    INDEX_LAG: "Gauge" = Gauge(  # type: ignore[type-arg]
        "fts_index_lag_seconds",
        "Index lag from DB write to ES doc availability (按 outbox.created_at 计算)",
        labelnames=("index",),
        multiprocess_mode="max",
    )

    # multiprocess_mode='livesum' 在 multi-process gunicorn 下聚合多 worker 的 Gauge
    # （C1 修复：不同 worker 的 backlog 累加；不传时 multi-process 拿不到正确值）
    OUTBOX_BACKLOG: "Gauge" = Gauge(  # type: ignore[type-arg]
        "fts_outbox_backlog",
        "Pending outbox rows count (告警 > 10000 持续 5min)",
        labelnames=("db",),
        multiprocess_mode="livesum",
    )

    OUTBOX_TERMINAL_BACKLOG: "Gauge" = Gauge(  # type: ignore[type-arg]
        "fts_outbox_terminal_backlog",
        "Terminal-failure outbox rows (retry_count >= 5; schema 问题 SRE 介入)",
        labelnames=("db",),
        multiprocess_mode="livesum",
    )

    DEGRADE_COUNT: "Counter" = Counter(  # type: ignore[type-arg]
        "fts_degrade_total",
        "Search degradation events by reason",
        labelnames=("reason",),  # engine_disabled/health_red/circuit_open/...
    )

    ZERO_RESULT_COUNT: "Counter" = Counter(  # type: ignore[type-arg]
        "fts_zero_result_total",
        "Searches that returned zero results (突增 3x 告警可能索引异常)",
    )

    FC_INVOKE_COUNT: "Counter" = Counter(  # type: ignore[type-arg]
        "fts_fc_invoke_total",
        "Function-Call (Agent) tabtin.search invocations by notice",
        labelnames=("notice",),  # ''=normal / no_accessible_spaces / error
    )

    OUTBOX_WRITE_FAILED_COUNT: "Counter" = Counter(  # type: ignore[type-arg]
        "fts_outbox_write_failed_total",
        "Outbox row write failures swallowed by signal handler (R1-08)",
        labelnames=("model",),
    )

    ACL_INVALIDATE_FAILED_COUNT: "Counter" = Counter(  # type: ignore[type-arg]
        "fts_acl_invalidate_failed_total",
        "ACL cache invalidation failures swallowed by signal handler (R2-10)",
    )

    HEALTH_STATUS: "Gauge" = Gauge(  # type: ignore[type-arg]
        "fts_health_status",
        "ES cluster health status as gauge (1=current; 0=other)",
        labelnames=("status",),  # green/yellow/red/unreachable
        multiprocess_mode="max",  # 任一 worker 看到 red 都算 red（保守）
    )

    REINDEX_PROGRESS: "Gauge" = Gauge(  # type: ignore[type-arg]
        "fts_reindex_progress_total",
        "fts_reindex 命令处理的文档数（按索引）",
        labelnames=("index",),
        multiprocess_mode="livesum",
    )

    REINDEX_FAILURES: "Counter" = Counter(  # type: ignore[type-arg]
        "fts_reindex_failures_total",
        "fts_reindex 命令失败文档数（按索引）",
        labelnames=("index",),
    )
else:
    # prom 未装时所有 metric 是 no-op stub（不抛错）
    class _NoOpMetric:
        def labels(self, *args, **kwargs):
            return self

        def observe(self, *args, **kwargs):
            return None

        def inc(self, *args, **kwargs):
            return None

        def set(self, *args, **kwargs):
            return None

    SEARCH_LATENCY = INDEX_LAG = OUTBOX_BACKLOG = OUTBOX_TERMINAL_BACKLOG = _NoOpMetric()  # type: ignore[assignment]
    DEGRADE_COUNT = ZERO_RESULT_COUNT = FC_INVOKE_COUNT = _NoOpMetric()  # type: ignore[assignment]
    OUTBOX_WRITE_FAILED_COUNT = ACL_INVALIDATE_FAILED_COUNT = _NoOpMetric()  # type: ignore[assignment]
    HEALTH_STATUS = REINDEX_PROGRESS = REINDEX_FAILURES = _NoOpMetric()  # type: ignore[assignment]


SearchPath = Literal["web", "cli", "fc"]


# ── 公开 helper（调用方只用这些） ───────────────────────────────
@contextmanager
def search_timer(*, path: SearchPath = "web") -> Iterator[dict]:
    """搜索延迟计时上下文管理器。

    Yields:
        meta 字典：调用方可在 ctx 内 set `meta['degraded'] = True` 标记降级路径，
        退出时按最终状态 observe。

    用法::

        with search_timer(path="web") as meta:
            resp = search(...)
            if resp.degraded:
                meta["degraded"] = True

    设计要点：
        - 失败也记录耗时（捕获 exc_type 不掩盖异常 / 仍 re-raise）
        - degraded 作为 label：分开看降级时延 vs 正常时延的 P95
    """
    started = time.monotonic()
    meta: dict = {"degraded": False}
    try:
        yield meta
    finally:
        elapsed = time.monotonic() - started
        try:
            label_value = "true" if meta.get("degraded") else "false"
            SEARCH_LATENCY.labels(path=path, degraded=label_value).observe(elapsed)
        except Exception:  # pragma: no cover
            logger.debug("[FTS][metrics] search_timer observe failed", exc_info=True)


def record_degrade(reason: str) -> None:
    """降级事件计数（PRD 6.3 告警入口）。

    reason 应取自 SearchResponse.degraded_reason 的 9 种封闭枚举之一。
    """
    if not reason:
        return
    try:
        DEGRADE_COUNT.labels(reason=reason).inc()
    except Exception:  # pragma: no cover
        logger.debug("[FTS][metrics] record_degrade failed", exc_info=True)


def record_zero_result() -> None:
    """零结果计数。突增 3x 告警可能是索引异常。"""
    try:
        ZERO_RESULT_COUNT.inc()
    except Exception:  # pragma: no cover
        logger.debug("[FTS][metrics] record_zero_result failed", exc_info=True)


def record_fc_invoke(*, notice: Optional[str] = None) -> None:
    """FC（tabtin.search）工具调用计数（R4-04）。

    notice 取自 SearchTool 返回 JSON 的 notice 字段：
        - None / "" → 'normal'
        - 'no_accessible_spaces' → 区分权限错配场景
        - 'error' → 工具内部错误（VALIDATION / AUTH_MISSING / INTERNAL_ERROR）
    """
    label = (notice or "normal").strip() or "normal"
    try:
        FC_INVOKE_COUNT.labels(notice=label).inc()
    except Exception:  # pragma: no cover
        logger.debug("[FTS][metrics] record_fc_invoke failed", exc_info=True)


def record_outbox_backlog(db: str, count: int) -> None:
    """写入 outbox backlog gauge（按数据库）。

    Wave 5 接入：`flush_outbox_task` 末尾调一次（每 5s 跑），让 Grafana 看到趋势。
    """
    try:
        OUTBOX_BACKLOG.labels(db=db).set(int(count))
    except Exception:  # pragma: no cover
        logger.debug("[FTS][metrics] record_outbox_backlog failed", exc_info=True)


def record_outbox_terminal_backlog(db: str, count: int) -> None:
    """终态失败 outbox backlog gauge。

    Wave 5 接入：`scan_outbox_tick` 调一次，> 0 持续 5min 触发 SRE 告警
    （schema 问题需要 put_mapping + requeue_terminal）。
    """
    try:
        OUTBOX_TERMINAL_BACKLOG.labels(db=db).set(int(count))
    except Exception:  # pragma: no cover
        logger.debug("[FTS][metrics] record_outbox_terminal_backlog failed", exc_info=True)


def record_health_status(status: str) -> None:
    """ES 集群健康状态 gauge（health_probe_task 调）。

    每次只把当前 status 设 1，其他 status 设 0，让 PromQL 容易写出
    `sum by (status) (fts_health_status)` 看分布。
    """
    if not status:
        return
    valid_statuses = ("green", "yellow", "red", "unreachable", "disabled")
    try:
        for s in valid_statuses:
            HEALTH_STATUS.labels(status=s).set(1 if s == status else 0)
    except Exception:  # pragma: no cover
        logger.debug("[FTS][metrics] record_health_status failed", exc_info=True)


def record_outbox_write_failed(model: str) -> None:
    """signal handler 内 _safe_write_outbox 失败计数（R1-08）。"""
    try:
        OUTBOX_WRITE_FAILED_COUNT.labels(model=(model or "unknown")).inc()
    except Exception:  # pragma: no cover
        logger.debug("[FTS][metrics] record_outbox_write_failed failed", exc_info=True)


def record_acl_invalidate_failed() -> None:
    """ACL 缓存失效失败计数（R2-10）。"""
    try:
        ACL_INVALIDATE_FAILED_COUNT.inc()
    except Exception:  # pragma: no cover
        logger.debug("[FTS][metrics] record_acl_invalidate_failed failed", exc_info=True)


def record_reindex_progress(index: str, count: int) -> None:
    """fts_reindex 进度 gauge（命令进度可视化）。"""
    try:
        REINDEX_PROGRESS.labels(index=index).set(int(count))
    except Exception:  # pragma: no cover
        logger.debug("[FTS][metrics] record_reindex_progress failed", exc_info=True)


def record_reindex_failures(index: str, count: int = 1) -> None:
    """fts_reindex 失败计数（按索引）。"""
    try:
        REINDEX_FAILURES.labels(index=index).inc(int(count))
    except Exception:  # pragma: no cover
        logger.debug("[FTS][metrics] record_reindex_failures failed", exc_info=True)


__all__ = [
    "SEARCH_LATENCY",
    "INDEX_LAG",
    "OUTBOX_BACKLOG",
    "OUTBOX_TERMINAL_BACKLOG",
    "DEGRADE_COUNT",
    "ZERO_RESULT_COUNT",
    "FC_INVOKE_COUNT",
    "OUTBOX_WRITE_FAILED_COUNT",
    "ACL_INVALIDATE_FAILED_COUNT",
    "HEALTH_STATUS",
    "REINDEX_PROGRESS",
    "REINDEX_FAILURES",
    "search_timer",
    "record_degrade",
    "record_zero_result",
    "record_fc_invoke",
    "record_outbox_backlog",
    "record_outbox_terminal_backlog",
    "record_health_status",
    "record_outbox_write_failed",
    "record_acl_invalidate_failed",
    "record_reindex_progress",
    "record_reindex_failures",
]
