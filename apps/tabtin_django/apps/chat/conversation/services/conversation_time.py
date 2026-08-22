"""对话时间权威（ 方案 B）。

回退边界（preview / 可见性过滤 / cleanup 物理删除）此前全部基于
``ChatMessage.created_at``。但 ``created_at`` 是 **落库时间**，不是对话时间——
relay 迟到重投 / RelayRetryQueue recover 补写的行，created_at 是补投时刻，
与真实对话顺序可以完全颠倒（实证：session 9b866ea1 中「中间回复」的
created_at 晚于「最终回答」40 秒+，且晚于回退时刻本身），导致回退预览集合
错乱、清算边界与 runtime 语义边界漂移。

权威对话时间是 agent-runtime emit 时分配的 ``arrival_seq``（epoch 微秒、
单调，），随事件 payload / content_blocks_json 落库，前端时间线排序
（messageTimelineOrder.ts）已以它为准。本模块把同一口径带到服务端边界计算：

- 写入侧：``resolve_message_arrival_seq`` 从事件 payload / blocks 提取，落到
  ``ChatMessage.arrival_seq`` 列；
- 边界侧：``q_conversation_after`` / ``q_conversation_before`` 生成按对话时间
  比较的 Q 过滤（legacy 行 arrival_seq 为 NULL 时回落 created_at，同点用 id
  tie-break，与旧口径兼容）。

纯 Q 组合、不用 DB 方言函数（EXTRACT 等），PG / SQLite 兼容层同源可用。
"""

from __future__ import annotations

from datetime import datetime, timezone as dt_timezone
from typing import Any

from django.db.models import Q

#: arrival_seq 的时间尺度：epoch 微秒（前端 nextLocalArrivalSeq = Date.now()*1000）。
MICROSECONDS_PER_SECOND = 1_000_000

#: 早期后端曾把 arrival_seq 以纳秒写进 content_blocks_json（≈1.78e18），与
#: 微秒尺度差 1000 倍；与前端 messageTimelineOrder.normalizeArrivalSeq 同款归一。
_NANOSECOND_SCALE_THRESHOLD = 10 ** 16


def normalize_arrival_seq(value: Any) -> int | None:
    """把疑似 arrival_seq 的值归一为 epoch 微秒 int；不可用返回 None。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    seq = int(value)
    if seq <= 0:
        return None
    if seq >= _NANOSECOND_SCALE_THRESHOLD:
        seq //= 1000
    return seq


def derive_arrival_seq_from_blocks(blocks: Any) -> int | None:
    """取 ContentBlock[] 中最小的块级 arrival_seq（= 该消息首块出现时刻）。"""
    if not isinstance(blocks, list):
        return None
    candidates = [
        seq
        for block in blocks
        if isinstance(block, dict)
        for seq in (normalize_arrival_seq(block.get("arrival_seq")),)
        if seq is not None
    ]
    return min(candidates) if candidates else None


def resolve_message_arrival_seq(payload: dict | None, blocks: Any) -> int | None:
    """写入侧提取：payload 顶层 arrival_seq（daemon emit 权威）优先，块级最小值兜底。"""
    if isinstance(payload, dict):
        top = normalize_arrival_seq(payload.get("arrival_seq"))
        if top is not None:
            return top
    return derive_arrival_seq_from_blocks(blocks)


def conversation_point(msg) -> tuple[int, datetime]:
    """消息的对话时间点：(epoch 微秒 seq, 等价 datetime)。

    有 ``arrival_seq`` 用之（datetime 由 seq 换算，供与 legacy NULL 行的
    created_at 比较）；legacy 行回落 created_at。
    """
    seq = normalize_arrival_seq(getattr(msg, "arrival_seq", None))
    if seq is not None:
        return seq, datetime.fromtimestamp(seq / MICROSECONDS_PER_SECOND, tz=dt_timezone.utc)
    created_at = msg.created_at
    return int(created_at.timestamp() * MICROSECONDS_PER_SECOND), created_at


def q_conversation_after(target_msg, *, include_target: bool) -> Q:
    """对话时间上位于 ``target_msg`` 之后的消息（回退移除侧）。

    - ``include_target=True``：user 目标——含目标本身一并移除（id__gte）。
    - ``include_target=False``：assistant 目标——保留目标，仅移除其后（id__gt）。

    行内比较规则：有 arrival_seq 的行按 seq；NULL 行按 created_at 与目标对话
    时间点的 datetime 等价值比较；同点用 id tie-break（沿用旧口径，保证与
    ``q_conversation_before`` 互补无缝）。
    """
    seq, dt = conversation_point(target_msg)
    strictly_after = (
        Q(arrival_seq__isnull=False, arrival_seq__gt=seq)
        | Q(arrival_seq__isnull=True, created_at__gt=dt)
    )
    same_point = (
        Q(arrival_seq=seq)
        | Q(arrival_seq__isnull=True, created_at=dt)
    )
    id_edge = Q(id__gte=target_msg.id) if include_target else Q(id__gt=target_msg.id)
    return strictly_after | (same_point & id_edge)


def q_conversation_before(target_msg, *, include_target: bool) -> Q:
    """对话时间上位于 ``target_msg`` 之前的消息（回退可见侧 / checkpoint 锚点）。

    与 ``q_conversation_after`` 严格互补：同一 include_target 语义下，二者对
    session 全集是不重不漏的二分。
    """
    seq, dt = conversation_point(target_msg)
    strictly_before = (
        Q(arrival_seq__isnull=False, arrival_seq__lt=seq)
        | Q(arrival_seq__isnull=True, created_at__lt=dt)
    )
    same_point = (
        Q(arrival_seq=seq)
        | Q(arrival_seq__isnull=True, created_at=dt)
    )
    id_edge = Q(id__lte=target_msg.id) if include_target else Q(id__lt=target_msg.id)
    return strictly_before | (same_point & id_edge)


def conversation_sort_key(row: dict) -> tuple[int, str]:
    """values() 行的对话时间排序键（preview 列表用）。"""
    seq = normalize_arrival_seq(row.get("arrival_seq"))
    if seq is None:
        created_at = row.get("created_at")
        seq = int(created_at.timestamp() * MICROSECONDS_PER_SECOND) if created_at else 0
    return seq, str(row.get("id") or "")
