"""FTS Celery 任务（Wave 1 已实现同步管道）。

关键约束（ADR-03 / PRD 4.3.C）：
    - 所有 `apps.fts.tasks.*` 必须 `ignore_result=True`，避免 100w/day
      搜索索引任务写 django-db 结果后端放大 MySQL 压力。
    - 队列路由由 `settings.CELERY_TASK_ROUTES` 统一决定
      （`'apps.fts.tasks.*': {'queue': 'search_indexing'}`），
      任务装饰器**不**再声明 `queue=...`，避免重复声明一致性问题
      （Review D1）。
    - 独立 worker 启动见 `scripts/backend/celery-start.sh` 的 fts 段
      （并发 4、`--max-tasks-per-child=1000`）。

Beat schedule（由 tabtin.celery.py 的 `_discover_beat_schedules_auto`
自动发现 `FTS_BEAT_SCHEDULE` 字典并写入 DatabaseScheduler）：
    - `fts-scan-outbox`：每 5s 触发 `scan_outbox_tick`（兜底扫描两库 Outbox）
    - `fts-health-probe`：每 10s 触发 `health_probe_task`（ES 集群探测）

Wave 1 必须处理的三种可预见故障（索引同步管道核心故障面）
-------------------------------------------------------------
1. `elasticsearch.BadRequestError` 且 `body['error']['type'] ==
   'strict_dynamic_mapping_exception'`
   （所有 6 个 mapping 都声明 `dynamic: strict`，PRD 4.4 要求）
      - 场景：业务模型新增字段 / Wave 1 sync_service 多传字段 /
        mapping 迭代未同步；ES 拒绝整个文档；默认 `_bulk` 语义会把
        单个坏文档变成整批失败。
      - **处理规范**（见 `apps.fts.services.bulk_buffer.execute_bulk`）：
          * `helpers.bulk(..., raise_on_error=False)` + 按
            `items[].index.status` 拆成功 / 失败，**失败隔离**
            不拖垮本批其他文档；
          * 失败文档把 `last_error` 写回 Outbox 并 `retry_count += 1`；
          * **严禁**为了"让它过"而把 mapping 改为 `dynamic: true`
            （会让索引 schema 爆炸、降低搜索质量）；
          * 根因修复：先 PUT mapping 新字段，再重放 Outbox。
      - 相关文档：`deployment/search/README.md` 故障排查节。

2. `elasticsearch.ConnectionError` / `TransportError` / 超时
      - 场景：阿里云 ES 短暂抖动 / VPC 抖动 / 扩容中。
      - **处理规范**：
          * `flush_outbox_task` 自身 `autoretry_for=(ConnectionError,)`
            + `retry_backoff=True`；
          * 超过 `max_retries` 仍失败则保留 Outbox `processed_at=NULL`，
            由 `scan_outbox_task`（beat 每 5s）兜底重试；
          * breaker 会在连续失败 `FTS_BREAKER_FAIL_MAX` 后 open，之后
            `scan_outbox_task` 应跳过 ES 调用等待 half-open 放流量。

3. `pybreaker.CircuitBreakerError`（Redis 共享 breaker 已 open）
      - 场景：ES 多次失败 + breaker 熔断，或 Redis 不可达 + 生产环境
        `FTS_BREAKER_REQUIRE_REDIS=true` 直接 raise。
      - **处理规范**：
          * Task 捕获 `CircuitBreakerError` 不视为成功，不推进
            `processed_at`，保留 Outbox 待 breaker 恢复；
          * 不要自行重试（breaker 就是为了防止死亡螺旋）；
          * half-open 阶段由 breaker 自身控制放流量，task 层无需感知。
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

from celery import shared_task

from apps.fts.client import breaker_run, get_client, is_engine_enabled
from apps.fts.index_definitions import (
    INDEX_DEFINITIONS,
    get_index_name,
    get_messages_alias,
    get_monthly_index_name,
)
# Wave 5：metrics + OTel trace
from apps.fts.metrics import (
    record_health_status,
    record_outbox_backlog,
    record_outbox_terminal_backlog,
)
from apps.fts.otel_trace import (
    start_flush_outbox_span,
    start_update_by_query_span,
)
from apps.fts.services import sync_service
from apps.fts.services.bulk_buffer import BulkAction, execute_bulk, FailureClass
from apps.fts.services.outbox_service import (
    get_backlog,
    get_terminal_backlog,
    mark_failed,
    mark_processed,
    mark_terminal,
    scan_outbox,
)

logger = logging.getLogger(__name__)


# ── Wave 0 占位 task（保留以免破坏既有单测） ───────────────────
@shared_task(
    bind=False,
    ignore_result=True,
    name="apps.fts.tasks.noop_bootstrap_task",
)
def noop_bootstrap_task(payload: str | None = None) -> None:
    """最简占位任务，Wave 0 验证队列连通性用。"""
    logger.info("[FTS] noop_bootstrap_task received payload=%s", payload)


# ── Wave 1 任务 ─────────────────────────────────────────────────
# ============================================================
# 1. flush_outbox_task: 扫描 Outbox + bulk flush 到 ES
# ============================================================
def _resolve_logical_from_index_name(index_name: str) -> str | None:
    """从 outbox 存的 `index_name`（如 `tabtin-messages`）反推逻辑名。

    Wave 1 outbox 写入的 index_name 是 alias 名，需要反推找到定义并解析
    对应 model。`tabtin-` 前缀 + base_name。
    """
    for logical, definition in INDEX_DEFINITIONS.items():
        if get_index_name(definition["base_name"]) == index_name:
            return logical
    return None


def _fetch_instance_for_logical(logical: str, doc_id: str) -> Any | None:
    """按逻辑索引名从对应业务模型 ORM 读取实例（select_related 预拉）。

    返回 `None` 表示业务数据已删除（对应 outbox 里的 upsert 会被跳过，
    视作"业务先删，signal 先到 delete 再到 upsert"的正常场景）。
    """
    try:
        if logical == "messages":
            from apps.chat.conversation.models import ChatMessage
            # 注意：session 在 MySQL，space 在 PG，严禁 JOIN session__space
            # （跨库 FK 不能 SELECT JOIN）。sync_service 内部按需跨库查 PG
            return (
                ChatMessage.objects
                .select_related("session")
                .filter(pk=doc_id)
                .first()
            )
        if logical == "resources":
            from apps.tabtinspace.models import ContextItem
            return (
                ContextItem.objects
                .using("postgresql")
                .select_related("workspace", "project")
                .filter(pk=doc_id)
                .first()
            )
        if logical == "agents":
            from apps.tabtinspace.models import Agent
            return Agent.objects.using("postgresql").filter(pk=doc_id).first()
        if logical == "spaces":
            from apps.tabtinspace.services.host_resolver import resolve_host
            return resolve_host(doc_id)
        if logical == "memos":
            from apps.tabmemo.models import Memo
            return Memo.objects.using("postgresql").filter(pk=doc_id).first()
        if logical == "im":
            from apps.tabchat.models import Message
            return (
                Message.objects
                .using("postgresql")
                .select_related("conversation")
                .filter(pk=doc_id)
                .first()
            )
    except Exception:  # pragma: no cover - 跨库 ORM 偶发故障
        logger.exception(
            "[FTS] fetch instance failed logical=%s doc_id=%s",
            logical, doc_id,
        )
    return None


def _build_document(logical: str, instance: Any) -> dict[str, Any] | None:
    """根据逻辑索引名调对应 `to_*_document`。"""
    if logical == "messages":
        return sync_service.to_message_document(instance)
    if logical == "resources":
        return sync_service.to_resource_document(instance)
    if logical == "agents":
        return sync_service.to_agent_document(instance)
    if logical == "spaces":
        return sync_service.to_space_document(instance)
    if logical == "memos":
        return sync_service.to_memo_document(instance)
    if logical == "im":
        return sync_service.to_im_document(instance)
    return None


def _resolve_physical_index(logical: str, instance: Any | None, doc_id: str) -> str:
    """物理索引名解析。

    - messages：按 instance.created_at 走月度 rollover；若 instance 不在
      （delete 场景），用当前时间 fallback（delete 对多月份 alias 不行，
      故需要具体月份；但 delete 单条无法精确追溯历史月份，因此 Wave 1
      对 messages 的单条 delete 通过 `delete_by_query_task` 而非 bulk
      delete 来处理——见 _handle_messages_delete_fallback）。
    """
    if logical == "messages":
        dt = getattr(instance, "created_at", None)
        return get_monthly_index_name("messages", dt)
    return get_index_name(INDEX_DEFINITIONS[logical]["base_name"])


@shared_task(
    bind=True,
    ignore_result=True,
    name="apps.fts.tasks.flush_outbox_task",
    max_retries=5,
    default_retry_delay=30,
    autoretry_for=(),  # 显式不 autoretry，失败通过 mark_failed 推进
)
def flush_outbox_task(self, db: str = "default", limit: int = 500) -> dict[str, Any]:
    """扫描 + bulk flush 指定库的 Outbox 积压。

    Returns:
        dict 用于日志/调试：{"attempted": n, "success": k, "failed": f, "breakdown": {...}}
        （注意 `ignore_result=True`，返回值不落 result backend。）
    """
    if not is_engine_enabled():
        return {"skipped": "engine_disabled"}

    rows = scan_outbox(db, limit=limit)
    if not rows:
        # Wave 5：空 outbox 也要 record backlog（避免 Grafana 看到"无数据"）
        try:
            record_outbox_backlog(db=db, count=get_backlog(db))
            record_outbox_terminal_backlog(db=db, count=get_terminal_backlog(db))
        except Exception:  # pragma: no cover
            pass
        return {"skipped": "empty_outbox"}

    # 构造 bulk actions：把 upsert 读实例转 document，delete 直接构造
    # 消息类 delete（非级联）单条很少，Wave 1 让它走 delete_by_query
    # 减少物理索引探测；其他索引 delete 直接 bulk delete
    actions: list[BulkAction] = []
    skip_rows: list[int] = []  # 业务数据已删或 should_index 判 False，推进 processed
    deferred_delete_by_query: list[tuple[str, str, str]] = []

    for row in rows:
        logical = _resolve_logical_from_index_name(row.index_name)
        if logical is None:
            logger.warning(
                "[FTS] unknown index_name=%s row_id=%s, mark_failed",
                row.index_name, row.id,
            )
            mark_failed(db, row.id, f"unknown_index:{row.index_name}")
            continue

        if row.action == "upsert":
            instance = _fetch_instance_for_logical(logical, row.doc_id)
            if instance is None:
                # 业务数据已被删；视作 noop 推进 processed_at
                skip_rows.append(row.id)
                continue
            doc = _build_document(logical, instance)
            if doc is None:
                # should_index_* 判 False（trashed/archived/is_deleted）
                # Wave 1 策略：静默推进 processed_at；实际是否再索引由
                # signal 下一次 save 时决定（或交给 delete outbox 补齐）
                skip_rows.append(row.id)
                continue
            physical = _resolve_physical_index(logical, instance, row.doc_id)
            actions.append(BulkAction(
                _op_type="index",
                _index=physical,
                _id=row.doc_id,
                row_id=row.id,
                _source=doc,
            ))
        elif row.action == "delete":
            if logical == "messages":
                # Wave 5 R1-04 优化：outbox 行有 `created_at`（业务事件入队时间），
                # 用它推断消息月度物理索引名 —— 假设 outbox.created_at 与
                # ChatMessage.created_at 在同一个月（业务事件触发即写 outbox）。
                # 直接 bulk delete 比 delete_by_query 节省 1 次 ES round-trip + 跨分片扫描。
                # 兜底：跨月场景（极罕见）依旧走 delete_by_query，避免 wrong-index 404。
                row_dt = getattr(row, "created_at", None)
                if row_dt is not None:
                    physical = get_monthly_index_name("messages", row_dt)
                    actions.append(BulkAction(
                        _op_type="delete",
                        _index=physical,
                        _id=row.doc_id,
                        row_id=row.id,
                    ))
                    continue
                # 没有 created_at 字段（理论上不发生）→ 走 delete_by_query 兜底
                deferred_delete_by_query.append(
                    (get_messages_alias(), "message_id", row.doc_id)
                )
                skip_rows.append(row.id)
                continue
            physical = _resolve_physical_index(logical, None, row.doc_id)
            actions.append(BulkAction(
                _op_type="delete",
                _index=physical,
                _id=row.doc_id,
                row_id=row.id,
            ))
        else:
            logger.warning("[FTS] unknown outbox action=%s row_id=%s", row.action, row.id)
            mark_failed(db, row.id, f"unknown_action:{row.action}")

    # 推迟的消息 delete 发 delete_by_query_task
    for index_alias, field, value in deferred_delete_by_query:
        delete_by_query_task.delay(index_alias=index_alias, field=field, value=value)

    # Wave 5 三视角 Review C3 修复（bulk delete 月份边界 silent data loss 兜底）：
    # bulk delete 命中 ES 404 时被视为幂等成功，但 messages 索引下可能是因为
    # outbox.created_at 与 ChatMessage.created_at 跨月（< 1ms 边界场景）。
    # 兜底：延后兜底列表，bulk 完成后针对 messages 索引的 idempotent delete
    # 触发 delete_by_query（按 message_id 匹配，自动跨月）
    messages_alias = get_messages_alias()  # 拿出来准备做"是否属于 messages"判断

    # 执行 bulk
    result_breakdown: dict[str, int] = {}
    succeeded_ids = list(skip_rows)
    if actions:
        try:
            client = get_client()
            flush_result = breaker_run(
                execute_bulk,
                client,
                actions,
            )
            result_breakdown = dict(flush_result.classified_counts)
            succeeded_ids.extend(flush_result.succeeded_row_ids)

            # Wave 5 C3：messages 索引的 idempotent delete 触发 delete_by_query 兜底
            # 防止月份边界（outbox.created_at vs ChatMessage.created_at 微秒差）
            # 导致 bulk delete 走错月份 → 404 → 误判幂等 → 孤儿文档
            for target_index, target_id in flush_result.idempotent_delete_targets:
                # 检测目标是否是 messages 物理索引（base_name 'messages' 派生）
                # 命名规则：tabtin-messages-YYYY-MM；alias 是 tabtin-messages
                base_messages_prefix = get_index_name("messages")
                if target_index.startswith(base_messages_prefix):
                    logger.info(
                        "[FTS] C3 fallback: messages bulk delete 404 → delete_by_query "
                        "(月份边界保护) target_index=%s doc=%s", target_index, target_id,
                    )
                    delete_by_query_task.delay(
                        index_alias=messages_alias,
                        field="message_id",
                        value=target_id,
                    )
                # 其他索引（非 rollover）的 idempotent delete 是真幂等不需补救

            # 失败按 FailureClass 分级处理（D3 规范 + 2026-04-17 技术 Review 修正）
            # 规则：
            #   STRICT_MAPPING / MAPPER_PARSING → mark_terminal（直接终态，等 SRE 介入）
            #     避免无意义重试 5 次浪费 ES 带宽；Wave 5 Grafana 按
            #     fts_outbox_terminal_backlog 告警给 SRE。
            #   其他（TRANSIENT / CONFLICT）→ mark_failed（retry_count+1，下轮 scan 重试）
            terminal_classes = {FailureClass.STRICT_MAPPING, FailureClass.MAPPER_PARSING}
            for row_id, cls_name, err in flush_result.failed_items:
                if cls_name in terminal_classes:
                    mark_terminal(db, row_id, f"{cls_name}: {err}")
                else:
                    mark_failed(db, row_id, f"{cls_name}: {err}")
        except Exception as exc:
            # 整批失败（ConnectionError / breaker open）：不推进 processed_at
            # 让 scan_outbox_tick 下次重试；retry_count 也不增加（整批不算
            # 单文档失败）
            from pybreaker import CircuitBreakerError
            if isinstance(exc, CircuitBreakerError):
                logger.warning("[FTS] bulk aborted by breaker; backoff")
                return {
                    "attempted": len(rows),
                    "success": 0,
                    "failed": 0,
                    "aborted_reason": "circuit_breaker_open",
                }
            # 其他 ES 错误：保留 outbox 待下次扫描；task 本身 raise 让 Celery
            # 做一次 retry（带 backoff）；超过 max_retries 后也不影响 outbox
            # 由 scan_outbox_tick 持续接管
            logger.exception("[FTS] bulk flush failed with unexpected error")
            try:
                raise self.retry(exc=exc, countdown=min(30 * (2 ** self.request.retries), 300))
            except self.MaxRetriesExceededError:
                return {
                    "attempted": len(rows),
                    "success": 0,
                    "failed": 0,
                    "aborted_reason": "max_retries_exceeded",
                }

    # 标记成功
    mark_processed(db, succeeded_ids)

    # Wave 5：每次 flush 末尾刷新 backlog metric（含 0 backlog 状态）
    try:
        record_outbox_backlog(db=db, count=get_backlog(db))
        record_outbox_terminal_backlog(db=db, count=get_terminal_backlog(db))
    except Exception:  # pragma: no cover
        pass

    logger.info(
        "[FTS] flush_outbox_task db=%s attempted=%d success=%d failed=%d breakdown=%s",
        db, len(rows), len(succeeded_ids),
        len(rows) - len(succeeded_ids), result_breakdown,
    )
    return {
        "attempted": len(rows),
        "success": len(succeeded_ids),
        "failed": len(rows) - len(succeeded_ids),
        "breakdown": result_breakdown,
    }


# ============================================================
# 2. scan_outbox_tick: beat 5s 触发；分别扫两库
# ============================================================
@shared_task(
    bind=False,
    ignore_result=True,
    name="apps.fts.tasks.scan_outbox_tick",
)
def scan_outbox_tick() -> None:
    """Celery beat 每 5s 触发：分发 flush 任务给两库（D5）。"""
    if not is_engine_enabled():
        return
    flush_outbox_task.delay(db="default")
    flush_outbox_task.delay(db="postgresql")


# ============================================================
# 3. update_by_query_task: 改名 / 状态传播（R0-08）
# ============================================================
@shared_task(
    bind=True,
    ignore_result=True,
    name="apps.fts.tasks.update_by_query_task",
    max_retries=5,
    default_retry_delay=15,
    autoretry_for=(),
)
def update_by_query_task(
    self,
    index_alias: str,
    field: str,
    value: str,
    partial_doc: dict[str, Any],
) -> None:
    """ES `update_by_query`：按 `{field}={value}` 批量刷 `partial_doc` 字段。

    用于 ChatSession.title / Conversation.name 等易改字段向既有索引
    文档的冗余快照传播（PRD 4.4 + R0-08）。

    Painless 脚本用 params 避免注入；`conflicts='proceed'` 允许并发修改
    冲突时跳过继续（防止阻塞高并发改名）；`wait_for_completion=False`
    以 async task 形式异步跑，响应快。
    """
    if not is_engine_enabled():
        return
    if not partial_doc:
        return

    client = get_client()
    # Painless：用 params 把值注入；ES 会把 null 转为 ES null（可 filter）
    script_lines = []
    params: dict[str, Any] = {}
    for i, (k, v) in enumerate(partial_doc.items()):
        pkey = f"v_{i}"
        script_lines.append(f"ctx._source.{k} = params.{pkey}")
        params[pkey] = v
    body = {
        "query": {"term": {field: value}},
        "script": {
            "source": "; ".join(script_lines),
            "lang": "painless",
            "params": params,
        },
    }
    try:
        breaker_run(
            client.update_by_query,
            index=index_alias,
            body=body,
            conflicts="proceed",
            refresh=False,
            wait_for_completion=False,
        )
        logger.info(
            "[FTS] update_by_query dispatched index=%s field=%s value=%s",
            index_alias, field, value,
        )
    except Exception as exc:
        from pybreaker import CircuitBreakerError
        if isinstance(exc, CircuitBreakerError):
            logger.warning("[FTS] update_by_query aborted by breaker; will be retried by scan tick")
            return
        try:
            raise self.retry(exc=exc, countdown=min(15 * (2 ** self.request.retries), 300))
        except self.MaxRetriesExceededError:
            logger.error(
                "[FTS] update_by_query exhausted retries index=%s field=%s value=%s",
                index_alias, field, value,
            )


# ============================================================
# 4. delete_by_query_task: 级联删除（ChatSession / Space / Conversation）
# ============================================================
@shared_task(
    bind=True,
    ignore_result=True,
    name="apps.fts.tasks.delete_by_query_task",
    max_retries=5,
    default_retry_delay=15,
    autoretry_for=(),
)
def delete_by_query_task(self, index_alias: str, field: str, value: str) -> None:
    """ES `delete_by_query` on `{field}={value}`。

    用于级联清理：
        - ChatSession.post_delete → messages{session_id=...}
        - Space.post_delete → resources/memos/messages{space_id=...}
        - Conversation.post_delete → im{conversation_id=...}

    与 bulk delete 的区别：一次网络 round-trip 覆盖所有月份 rollover
    索引 + 跨分片；比"遍历所有文档 bulk delete"显著省资源。
    """
    if not is_engine_enabled():
        return
    client = get_client()
    body = {"query": {"term": {field: value}}}
    try:
        breaker_run(
            client.delete_by_query,
            index=index_alias,
            body=body,
            conflicts="proceed",
            refresh=False,
            wait_for_completion=False,
        )
        logger.info(
            "[FTS] delete_by_query dispatched index=%s field=%s value=%s",
            index_alias, field, value,
        )
    except Exception as exc:
        from pybreaker import CircuitBreakerError
        if isinstance(exc, CircuitBreakerError):
            logger.warning("[FTS] delete_by_query aborted by breaker; backoff")
            return
        try:
            raise self.retry(exc=exc, countdown=min(15 * (2 ** self.request.retries), 300))
        except self.MaxRetriesExceededError:
            logger.error(
                "[FTS] delete_by_query exhausted retries index=%s field=%s value=%s",
                index_alias, field, value,
            )


# ============================================================
# 5. health_probe_task: beat 10s 探测 ES
# ============================================================
@shared_task(
    bind=True,
    ignore_result=True,
    name="apps.fts.tasks.health_probe_task",
    max_retries=0,  # 健康探测失败不重试，交给 breaker / 告警
)
def health_probe_task(self) -> dict[str, Any]:  # noqa: ANN001
    """beat 每 10s 探测 ES 集群健康（PRD 4.8.D）。

    Wave 1 最小实现：
        - 未开启 flag → 跳过
        - 直接调 `cluster.health?timeout=1s`，**不走 breaker**
          （2026-04-17 技术 Review 修正）：health probe 的目的就是探测 ES 真实状态；
          breaker open 时走 breaker_run 会抛 CircuitBreakerError 被误判为
          unreachable，但实际 ES 可能只是抖动 + half-open 即将恢复。
          让 probe 保持独立，结果语义才清晰。
        - 区分三态：green/yellow/red / breaker_open / unreachable
        - 写 Redis key `fts:health`（TTL 30s）供 Wave 2 降级路径读

    不抛任何异常：健康探测的失败本身就是"不健康"信号，`except` 写 Redis
    即可。Wave 5 接 Prometheus gauge。
    """
    if not is_engine_enabled():
        return {"status": "disabled"}
    # 先看 breaker 状态——breaker open 意味着"最近 N 次搜索/索引失败"，
    # 但并不直接等于"ES 不可达"；health probe 不应把这俩混为一谈
    try:
        breaker = __import__("apps.fts.client", fromlist=["get_breaker"]).get_breaker()
        breaker_state = getattr(breaker, "current_state", None)
    except Exception:
        breaker_state = None

    try:
        client = get_client()
        # 直接调（不经 breaker），避免 breaker_open 污染 probe 判断
        health = client.cluster.health(request_timeout=1.0)
        # ES 8.x client 返回 ObjectApiResponse，可以 .get() 也可 dict 访问
        status = None
        if hasattr(health, "get"):
            status = health.get("status")
        elif isinstance(health, dict):
            status = health.get("status")
        status = status or "unknown"
        _write_health_redis(status)
        # Wave 5：health gauge metric
        try:
            record_health_status(status)
        except Exception:  # pragma: no cover
            pass
        return {"status": status, "breaker_state": breaker_state}
    except Exception as exc:  # pragma: no cover - health 只打点不破坏业务
        logger.warning("[FTS] health probe failed: %s", exc)
        _write_health_redis("unreachable")
        try:
            record_health_status("unreachable")
        except Exception:
            pass
        return {"status": "unreachable", "breaker_state": breaker_state}


def _write_health_redis(value: str) -> None:
    """把健康值写到 Redis key `fts:health`（TTL 30s）。"""
    try:
        from django_redis import get_redis_connection
        conn = get_redis_connection("default")
        conn.setex("fts:health", 30, value)
    except Exception:  # pragma: no cover
        logger.debug("[FTS] health redis write failed", exc_info=True)


# ============================================================
# Beat schedule（被 tabtin.celery._discover_beat_schedules_auto 自动发现）
# ============================================================
# Producer 入口：这两条会往 search_indexing 队列投递。
# SEARCH_ENGINE_ENABLED=false 时 get_fts_beat_schedule() 必须返回空，
# 且 celery setup 会把 DB 里对应 PeriodicTask 关掉。
FTS_BEAT_PRODUCER_NAMES = (
    "fts-scan-outbox",
    "fts-health-probe",
)

FTS_BEAT_GATE_DESCRIPTION = (
    "[fts-gate] SEARCH_ENGINE_ENABLED=false — stop enqueue to search_indexing"
)

_FTS_BEAT_SCHEDULE_TEMPLATE = {
    "fts-scan-outbox": {
        "task": "apps.fts.tasks.scan_outbox_tick",
        "schedule": 5.0,
        "options": {"expires": 4, "queue": "search_indexing"},
    },
    "fts-health-probe": {
        "task": "apps.fts.tasks.health_probe_task",
        "schedule": 10.0,
        "options": {"expires": 9, "queue": "search_indexing"},
    },
}


def get_fts_beat_schedule() -> dict:
    """仅在搜索引擎开启时注册会投递 search_indexing 的 beat 任务。"""
    if not is_engine_enabled():
        return {}
    return dict(_FTS_BEAT_SCHEDULE_TEMPLATE)


# 兼容自动发现：启动时按当前 settings 求值；get_beat_schedule 还会再调
# get_fts_beat_schedule() 覆盖，避免 import-time 快照与运行时 flag 不一致。
FTS_BEAT_SCHEDULE = get_fts_beat_schedule()
