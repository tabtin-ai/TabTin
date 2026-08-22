"""Bulk 批量写 ES + 失败隔离（D3 规范）。

D3 / PRD 4.4 规范：
    - 所有 6 个 mapping 都是 `dynamic: strict`；新增字段必须先 put_mapping 再重放
    - `helpers.bulk(..., raise_on_error=False, stats_only=False)` 必须按
      `items[].index.status` 拆分成功 / 失败，**单文档失败不拖垮整批**
    - 失败分级：
        1. `strict_dynamic_mapping_exception`：mapping 不兼容；**不自动重试**
           （自动重试只会继续失败），`last_error` 写回，人工排查
        2. `mapper_parsing_exception` / 类型不匹配：同上，不自动重试
        3. 其他（网络 / 超时 / 5xx）：`retry_count += 1`，等 `scan_outbox_task`
           下一轮按 backoff 重试
    - breaker open 时直接 raise `CircuitBreakerError`，调用方不推进
      `processed_at` 让 `scan_outbox_task` 下轮探测是否恢复

Return shape：`BulkFlushResult` 便于 Celery 任务做日志 / 指标。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

__all__ = [
    "BulkFlushResult",
    "BulkAction",
    "execute_bulk",
    "classify_failure",
    "FailureClass",
]


# ── 数据结构 ────────────────────────────────────────────────────
@dataclass
class BulkAction:
    """单条 bulk action，对应 ES `helpers.bulk` 输入。

    - `_op_type`：`index`（upsert）/ `delete`
    - `_index`：物理索引名（messages 要展开成 `tabtin-messages-2026-04`）
    - `_id`：doc_id
    - `_source`：upsert 时必填；delete 时忽略
    - `row_id`：对应 Outbox.id（便于 mark_processed/mark_failed）
    """

    _op_type: str
    _index: str
    _id: str
    row_id: int
    _source: dict[str, Any] | None = None

    def to_bulk_dict(self) -> dict[str, Any]:
        """转成 `helpers.bulk` 接受的 dict 形式。"""
        d: dict[str, Any] = {
            "_op_type": self._op_type,
            "_index": self._index,
            "_id": self._id,
        }
        if self._op_type == "index" and self._source is not None:
            d["_source"] = self._source
        return d


class FailureClass:
    """bulk 失败分级（D3）。"""

    NONE = "none"
    STRICT_MAPPING = "strict_dynamic_mapping_exception"
    MAPPER_PARSING = "mapper_parsing_exception"
    CONFLICT = "version_conflict_engine_exception"
    TRANSIENT = "transient"  # 可自动重试（网络 / 5xx / 超时）


@dataclass
class BulkFlushResult:
    """bulk 执行的汇总结果。

    - `succeeded_row_ids`：成功的 Outbox.id，需 `mark_processed`
    - `failed_items`：失败详情列表 `(row_id, failure_class, raw_error)`
    - `total_actions`：本批提交动作数
    - `classified_counts`：按 FailureClass 统计
    - `idempotent_deletes`：identifies "delete on missing doc"（ES 返回 404
      not_found）的次数；HIGH-4 修复后这种 case 被视作幂等成功，**不**进
      `failed_items`、**不**触发 retry。计数仅用于观察（Wave 5 metric）
    """

    succeeded_row_ids: list[int] = field(default_factory=list)
    failed_items: list[tuple[int, str, str]] = field(default_factory=list)
    total_actions: int = 0
    classified_counts: dict[str, int] = field(default_factory=dict)
    idempotent_deletes: int = 0
    # Wave 5 三视角 Review C3 修复：记录 idempotent delete 涉及的 (index, doc_id)
    # 上层任务会针对 messages 索引（月份边界 silent data loss 风险）触发
    # delete_by_query 兜底；其他索引的 idempotent delete 是真幂等无需补救
    idempotent_delete_targets: list[tuple[str, str]] = field(default_factory=list)

    def bump(self, cls_name: str) -> None:
        self.classified_counts[cls_name] = self.classified_counts.get(cls_name, 0) + 1


def _is_idempotent_delete_not_found(op_body: dict[str, Any]) -> bool:
    """判定一个 bulk delete 的"成功失败"是否实际是幂等成功（HIGH-4）。

    场景：业务先 trash → outbox 写 delete → flush 删除 ES doc → mark_processed；
    再 hard delete → signal 又写 delete → flush 时 ES 返回 `{"status":404,
    "result":"not_found"}`。helpers.bulk 把它放进 errors 列表（因为 status >= 400），
    但语义上**目标态已达成**（doc 不存在），不应触发 retry。

    判定规则（只对 `delete` op_type 生效）：
        status == 404 AND result == "not_found"

    注意：这里**不**包含 `_op_type='index'` 的场景；index 操作不会因 doc 不存在
    报 404。也不包含 `delete_by_query` —— 那是另一个 API。
    """
    if not isinstance(op_body, dict):
        return False
    return op_body.get("status") == 404 and op_body.get("result") == "not_found"


def classify_failure(error_type: str | None, error_reason: str | None) -> str:
    """根据 ES 返回的 `error.type` 判定失败级别。

    分类规则（Wave 1）：
        - strict_dynamic_mapping_exception → STRICT_MAPPING（不自动重试）
        - mapper_parsing_exception / document_parsing_exception /
          illegal_argument_exception → MAPPER_PARSING（schema/数据问题，
          不自动重试）
        - version_conflict_* → CONFLICT
        - 其他（es_rejected_execution_exception / cluster_block /
          shard unavailable / unknown）→ TRANSIENT（允许 scan_outbox
          下一轮 retry，直到 retry_count >= max_retries 被过滤掉）
    """
    if not error_type:
        return FailureClass.TRANSIENT
    et = error_type.lower()
    if et == "strict_dynamic_mapping_exception":
        return FailureClass.STRICT_MAPPING
    if et.startswith("mapper_parsing") or et.startswith("document_parsing"):
        return FailureClass.MAPPER_PARSING
    # illegal_argument_exception 通常是 schema / 请求参数问题，不自动重试
    if et == "illegal_argument_exception":
        return FailureClass.MAPPER_PARSING
    if et.startswith("version_conflict"):
        return FailureClass.CONFLICT
    # 其他异常类型默认视作 transient（保守起见；真正不可修复的 schema 问题
    # 往往命中上面的精确匹配）
    return FailureClass.TRANSIENT


# ── 执行器 ──────────────────────────────────────────────────────
def execute_bulk(
    client: Any,
    actions: list[BulkAction],
    *,
    refresh: bool = False,
    request_timeout: float | None = 10.0,
) -> BulkFlushResult:
    """执行 `helpers.bulk`，按 D3 规范做失败隔离。

    Args:
        client: `elasticsearch.Elasticsearch` 实例
        actions: 本批 `BulkAction` 列表
        refresh: 是否立即 refresh（测试场景用 True；生产走默认 1s
            refresh_interval 即可，否则写入吞吐会掉）
        request_timeout: 单次 bulk 的 HTTP 超时（秒）

    Returns:
        `BulkFlushResult`：成功/失败 id 列表 + 失败分级计数

    失败语义：
        - `helpers.bulk(raise_on_error=False)` 不会整批 raise，而是返回
          `(success_count, errors)`；我们自己遍历 items 拆分
        - 若 helpers.bulk 本身 raise（连接错误 / breaker open）：由调用方
          捕获，按 transient 处理（整批不推进 processed_at）
    """
    from elasticsearch import helpers

    result = BulkFlushResult(total_actions=len(actions))
    if not actions:
        return result

    # 建立 row_id 索引便于反查（helpers.bulk 保持顺序）
    action_dicts = [a.to_bulk_dict() for a in actions]
    row_id_by_pos = {i: a.row_id for i, a in enumerate(actions)}

    # stats_only=False → 返回每个 item 的详情
    # raise_on_error=False → 单条失败不抛异常（D3 关键）
    # raise_on_exception=False → helpers 内部异常也不抛，返回 errors
    success_count, errors = helpers.bulk(
        client,
        action_dicts,
        raise_on_error=False,
        raise_on_exception=False,
        stats_only=False,
        refresh=refresh,
        request_timeout=request_timeout,
    )

    # 构造"第 i 条动作是否失败"的位图
    failed_positions: set[int] = set()
    for err_item in (errors or []):
        # helpers.bulk 的 errors 是 dict 形式 {"index": {"status": 400, "error": {...}}}
        # 实际 errors list 只含 status >= 400 的条目，而非所有 items；
        # 必须从 error_item 里读 _id 来反查 actions 位置。
        if not isinstance(err_item, dict):
            logger.warning("[FTS] bulk error item is not dict: %r", err_item)
            continue
        op_type, op_body = next(iter(err_item.items()))

        # HIGH-4 修复：bulk delete 拿到 404 not_found 是**幂等成功**，不入 failed
        # 不加到 failed_positions → 外层"其余视为成功"自然把它算成功
        # Wave 5 C3 修复：记录 (index, doc_id)，上层针对 messages 索引补 delete_by_query
        if op_type == "delete" and _is_idempotent_delete_not_found(op_body):
            result.idempotent_deletes += 1
            target_index = op_body.get("_index") or ""
            target_id = op_body.get("_id") or ""
            if target_id:
                result.idempotent_delete_targets.append((target_index, target_id))
            continue

        failed_doc_id = op_body.get("_id")
        error_info = op_body.get("error") or {}
        if isinstance(error_info, str):
            error_type = None
            error_reason = error_info
        else:
            error_type = error_info.get("type")
            error_reason = error_info.get("reason")
        cls_name = classify_failure(error_type, error_reason)
        result.bump(cls_name)

        # 反查 row_id
        matched_row_id: int | None = None
        matched_pos: int | None = None
        for i, a in enumerate(actions):
            if i in failed_positions:
                continue
            if a._id == failed_doc_id and a._op_type == op_type:
                matched_row_id = a.row_id
                matched_pos = i
                break
        if matched_pos is not None:
            failed_positions.add(matched_pos)
        if matched_row_id is None:
            logger.warning(
                "[FTS] bulk error: failed to locate matching action for doc_id=%s op=%s",
                failed_doc_id, op_type,
            )
            continue
        raw = f"{error_type or '?'}: {error_reason or ''}"
        result.failed_items.append((matched_row_id, cls_name, raw[:400]))

    # 其余都视为成功（含幂等 delete 404）
    for i, a in enumerate(actions):
        if i in failed_positions:
            continue
        result.succeeded_row_ids.append(a.row_id)

    logger.info(
        "[FTS] bulk_flush total=%d success=%d failed=%d idempotent_deletes=%d breakdown=%s",
        result.total_actions,
        len(result.succeeded_row_ids),
        len(result.failed_items),
        result.idempotent_deletes,
        result.classified_counts,
    )
    return result
