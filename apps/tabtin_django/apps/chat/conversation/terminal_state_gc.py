"""
终端"假运行"诚实降级 —— Layer 3 主判定（终端假运行根治 v3 PRD §5 Layer 3 / 失败模式 F14）。

## 背景（这层在治什么）

`run_terminal_command` 前台等待超时（wait_ms 用尽）时返回一份 `status:"running"`
快照作为 tool_result，merge 进对应 assistant `ChatMessage.content_blocks_json`。
命令在后台终结时 host 本应再 relay 一条"终态 tool_result"（completed/killed/failed）
覆盖这份 running 快照（见 `background-task-terminal-result.ts` +
`relay_message_writer._merge_tool_result_block_into_message` supersede 逻辑）。

但当 **Layer 1（可靠投递）+ Layer 2（崩溃兜底 sidecar/启动对账）双双失效**——
host 崩溃 / 断电 / kill -9 且连 sidecar 都没落上、relay 落盘也丢了——这份 running
快照会**永远停在"运行中"**，用户重载对话只能看到无限转圈（F14：仅 running 无终态、
heal 不触发）。

## 这层做什么（诚实底线，不是再加一道判定）

周期扫 `content_blocks_json` 内 `status:"running"` 的终端 tool_result，若其存活时间
超过 `hard_timeout`（record 自带 `hard_timeout_ms`，否则默认 12h）→ 把它标成
**"未知终态"（status:"unknown"）**，而不是成功/失败。心智：前两层全失效时
**诚实地说"运行状态未知（可能已结束）"，而不是无限转圈，也不是朴素超时改判
误杀正常长跑任务**。

## 为什么 12h 默认阈值不会误杀长跑（PRD §8.8 验收）

- 阈值锚点 = 承载 running 快照那条 assistant 消息的 `created_at`（命令起跑时间的
  保守下界——消息落库 ≤ 命令真正起跑，故"age > 阈值"严格意味着命令至少存活了阈值）。
- `wait_ms:0` 的数小时 dev server：age 远未到 12h → **不标 unknown**（§8.8 通过）。
- 若 running 快照携带 `hard_timeout_ms`（前向兼容：当前 shell.ts 的 running envelope
  尚未带此字段，未来 Layer 2 / shell 改造补上后本模块自动尊重），**更大**的 per-block
  阈值会保护真·长驻服务（24h dev server 不会在 12h 被标）。
- 只标 **unknown**（诚实"不知道"），绝不标 completed/killed/failed——避免把还在跑的
  长任务误判成"已结束/失败"。
- 标记**可逆**：本模块直接改 DB block 的 content（不带 `_terminal_update`、保留
  `session_id`），若真·终态日后经 relay 迟到，`_merge_tool_result_block_into_message`
  仍能按 `tool_use_id` + `session_id` 命中并 supersede 掉这份 unknown 块。

本模块只放**纯逻辑 + DB 扫描实现**（不含 celery 装饰器，便于无 DB 环境单测纯函数）；
`@shared_task` 包装 + beat 注册在 `apps/chat/conversation/tasks.py`。
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any, Iterable

logger = logging.getLogger(__name__)

# ── Layer 3 判定常量 ────────────────────────────────────────────────────

#: 默认硬死线：12h（PRD §5 Layer 3）。running 快照存活超过此锚点仍无终态 → 标 unknown。
#: 取 12h 是"宁可晚标也别误杀长跑"的保守值：正常 dev server / 大型构建几小时内远不触发；
#: 真到 12h 还没任何终态信号，"运行状态未知"本身就是最诚实的描述。
DEFAULT_HARD_TIMEOUT_MS = 12 * 60 * 60 * 1000

#: 扫描回看窗口上限（天）。与 `cleanup_old_chat_messages` 的默认保留期（90d）对齐——
#: 取 90d 让"消息已落 running 快照、但 12h–90d 间一直没等到终态"的残余都在覆盖范围内，
#: 不留"既不被本 GC 扫、又没到 cleanup 删除线"的真空带。再老的消息已被 cleanup 物理删除。
#: 限定窗口（而非全表）+ 时间窗走 (role, created_at) 索引 + LIKE 预筛 + 单轮 LIMIT，
#: 共同保证扫描有界。
DEFAULT_MAX_LOOKBACK_DAYS = 90

#: 单轮扫描候选上限（按 created_at 升序，最老的最可能已 stale 优先处理）。
#: JSON 解析很廉价（参考 trim_blocks_json 每批 500、上限数千），2000 单轮足够且有界。
DEFAULT_SCAN_LIMIT = 2000

#: DB 落库批大小（id__in 批量取对象再逐条 save，避免一次性 load 过多 content_blocks_json）。
DEFAULT_DB_BATCH_SIZE = 200

#: unknown 终态标记的成因（写进 content，便于排障 / 前端区分；非业务路由字段）。
#: **注意**：取值刻意不含子串 "running"——否则会被 `_candidate_message_ids` 的
#: `Cast(JSONField→Text) LIKE '%running%'` 预筛在每轮重新选中已标记的消息，白占扫描预算。
UNKNOWN_REASON_STALE = "stale_no_terminal_state"


def _coerce_positive_int(value: Any) -> int | None:
    """把可能的 hard_timeout_ms 取值安全转正整数；非正数 / 非数字 → None。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    return None


def parse_terminal_running_content(block: Any) -> dict | None:
    """若 block 是"终端 running 快照" tool_result，返回其解析后的 content dict，否则 None。

    判别（强信号，避免把别的工具的 status 误判成终端）：
      - block.type == 'tool_result'
      - content 是 JSON 字符串且含子串 'running'（廉价预判，绝大多数 block 直接短路）
      - 解析后 status == 'running'
      - 带非空 session_id（所有 running envelope 都带 PTY agent session_id，且
        supersede 也靠它精确匹配——见 `_extract_terminal_session_id`）
    """
    if not isinstance(block, dict) or block.get("type") != "tool_result":
        return None
    content = block.get("content")
    if not isinstance(content, str) or "running" not in content:
        return None
    try:
        data = json.loads(content)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if data.get("status") != "running":
        return None
    session_id = data.get("session_id")
    if not (isinstance(session_id, str) and session_id):
        return None
    return data


def running_terminal_is_stale(
    content: dict,
    *,
    message_created_at: datetime | None,
    now: datetime,
    default_hard_timeout_ms: int = DEFAULT_HARD_TIMEOUT_MS,
) -> bool:
    """判定一份 running 终端快照是否"超 hard_timeout 仍无终态" → 应标 unknown。

    阈值 = content 自带 `hard_timeout_ms`（前向兼容；当前 running envelope 尚未带）
    否则 `default_hard_timeout_ms`（12h）。锚点 = 承载该快照的 ChatMessage.created_at。
    """
    if not isinstance(content, dict):
        return False
    if content.get("status") != "running":
        return False
    # 已被本任务标过 unknown 的不重复处理（幂等；status 已非 running 时也走不到这）。
    if content.get("terminal_state_unknown"):
        return False
    if message_created_at is None:
        return False
    threshold_ms = _coerce_positive_int(content.get("hard_timeout_ms")) or default_hard_timeout_ms
    age_ms = (now - message_created_at).total_seconds() * 1000.0
    return age_ms > threshold_ms


def build_unknown_terminal_content(
    content: dict,
    *,
    now: datetime,
    applied_hard_timeout_ms: int,
) -> dict:
    """从 running 快照 content 构造"未知终态" content（保留排障 / 跳转所需字段）。

    - `status` → 'unknown'（前端判定真相源：渲染"运行状态未知"中性态，**不是**失败红）。
    - 保留 `session_id` / `output_file` / `command` / `cwd` / `pid` / `stdout_tail` /
      `elapsed_ms`——让前端仍可"查看输出 / 跳转终端"，且 `session_id` 保证真·终态
      迟到时 supersede 仍能精确命中覆盖。
    - 补 `stdout`（= stdout_tail）让前端 `extractTerminal` 识别为 terminal kind 并展示 tail。
    - 标记字段：`terminal_state_unknown` / `unknown_reason` / `marked_unknown_at` /
      `hard_timeout_ms`（记录实际采用的阈值，供审计 + 幂等去重）。
    - **不带** `_terminal_update`：本写入是 DB 直改，不走 relay supersede 路径；保留这点
      也让真·终态迟到时（带 `_terminal_update`）能正常覆盖掉这份 unknown 块。
    """
    new_content = dict(content)
    new_content["status"] = "unknown"
    new_content["terminal_state_unknown"] = True
    new_content["unknown_reason"] = UNKNOWN_REASON_STALE
    new_content["marked_unknown_at"] = now.isoformat()
    new_content["hard_timeout_ms"] = applied_hard_timeout_ms
    # 总是补 `stdout`（即使空串）：让前端 `extractTerminal` 稳定识别成 terminal kind 走
    # 结构化渲染（它的 hasSuccessShape 判别看 'stdout' in d）。`wait_ms:0` 的静默后台
    # 任务 stdout_tail 为空，若不补 stdout 会回落 legacy fallback——功能仍可渲染但不稳定。
    if "stdout" not in new_content:
        tail = new_content.get("stdout_tail")
        new_content["stdout"] = tail if isinstance(tail, str) else ""
    return new_content


def apply_unknown_marks(
    blocks: Any,
    *,
    message_created_at: datetime | None,
    now: datetime,
    default_hard_timeout_ms: int = DEFAULT_HARD_TIMEOUT_MS,
) -> tuple[Any, int]:
    """对一条消息的 content_blocks_json 应用 Layer 3 标记。

    Returns: (new_blocks, marked_count)。无任何块需要标记时返回 (原 blocks, 0)，
    调用方据此跳过 save（零写放大）。纯函数，不碰 DB，便于无 DB 环境单测。
    """
    if not isinstance(blocks, list):
        return blocks, 0
    new_blocks: list | None = None
    marked = 0
    for i, block in enumerate(blocks):
        content = parse_terminal_running_content(block)
        if content is None:
            continue
        if not running_terminal_is_stale(
            content,
            message_created_at=message_created_at,
            now=now,
            default_hard_timeout_ms=default_hard_timeout_ms,
        ):
            continue
        applied = _coerce_positive_int(content.get("hard_timeout_ms")) or default_hard_timeout_ms
        new_content = build_unknown_terminal_content(
            content, now=now, applied_hard_timeout_ms=applied,
        )
        if new_blocks is None:
            new_blocks = list(blocks)
        new_block = dict(block)
        new_block["content"] = json.dumps(new_content, ensure_ascii=False)
        new_blocks[i] = new_block
        marked += 1
    if new_blocks is None:
        return blocks, 0
    return new_blocks, marked


def _candidate_message_ids(
    *,
    now: datetime,
    default_hard_timeout_ms: int,
    max_lookback_days: int,
    limit: int,
) -> list:
    """取候选 assistant 消息 id（粗筛 = role + created_at 时间窗 + 可选 JSON 文本预筛）。

    粗筛窗口 `[now - max_lookback, now - default_hard_timeout]`：
      - 上界 `now - default_hard_timeout`：比默认硬死线还年轻的消息一定没到默认阈值，
        直接排除；携带**更大** per-block 阈值的长跑任务即便落入窗口，精确判定也不会误标
        （被保护——这是 §8.8 不误杀长跑的关键）。
        **已知取舍**：若将来 running 快照携带**小于**默认（12h）的 per-block `hard_timeout_ms`
        （当前 shell.ts envelope 尚不写该字段），该任务超自身阈值后仍要等满 12h 才会被这条
        粗筛捞到——粗筛上界只按默认阈值算。接线更小 per-block 阈值时，需把上界改成
        `now - min(default, 最小可能 per-block)` 才能及时捞到。当前不存在更小阈值，无影响。
      - 下界 `now - max_lookback`：与 cleanup 保留期对齐，更老的已被 cleanup 物理删除。
    走 `(role, created_at)` 复合索引。按 created_at 升序（最老最可能 stale 优先）。

    best-effort JSON 文本预筛：把 content_blocks_json cast 成文本再 LIKE '%running%'，
    把绝大多数不含终端块的消息在 DB 侧滤掉（精确判定仍在 Python 端做）。DB 不支持
    Cast / 报错时安全回退到纯时间窗粗筛（正确性不依赖预筛）。
    """
    from django.db.models import TextField
    from django.db.models.functions import Cast
    from apps.chat.conversation.models import ChatMessage

    cutoff_eligible = now - timedelta(milliseconds=default_hard_timeout_ms)
    cutoff_oldest = now - timedelta(days=max_lookback_days)

    base_qs = ChatMessage.objects.filter(
        role="assistant",
        created_at__lt=cutoff_eligible,
        created_at__gte=cutoff_oldest,
    )

    try:
        narrowed = (
            base_qs
            .annotate(_cbj_text=Cast("content_blocks_json", TextField()))
            .filter(_cbj_text__contains="running")
        )
        return list(narrowed.order_by("created_at").values_list("id", flat=True)[:limit])
    except Exception:
        logger.warning(
            "[TerminalStateGC] JSON 文本预筛不可用，回退纯时间窗粗筛（正确性不受影响）",
            exc_info=True,
        )
        return list(base_qs.order_by("created_at").values_list("id", flat=True)[:limit])


def _iter_id_batches(ids: list, batch_size: int) -> Iterable[list]:
    for start in range(0, len(ids), batch_size):
        yield ids[start:start + batch_size]


def mark_stale_running_terminals_impl(
    *,
    now: datetime | None = None,
    default_hard_timeout_ms: int = DEFAULT_HARD_TIMEOUT_MS,
    max_lookback_days: int = DEFAULT_MAX_LOOKBACK_DAYS,
    limit: int = DEFAULT_SCAN_LIMIT,
    db_batch_size: int = DEFAULT_DB_BATCH_SIZE,
) -> dict:
    """扫描并把"超 hard_timeout 仍 running 无终态"的终端块标成 unknown。

    返回 {"scanned": N, "marked_messages": M, "marked_blocks": K}。
    Django 相关 import 全部惰性（在函数内），让 `terminal_state_gc` 模块本身可在
    无 Django/celery 环境被导入（纯函数单测）。
    """
    from django.db import transaction
    from django.utils import timezone
    from apps.chat.conversation.models import ChatMessage

    if now is None:
        now = timezone.now()

    candidate_ids = _candidate_message_ids(
        now=now,
        default_hard_timeout_ms=default_hard_timeout_ms,
        max_lookback_days=max_lookback_days,
        limit=limit,
    )

    scanned = 0
    marked_messages = 0
    marked_blocks = 0

    for batch_ids in _iter_id_batches(candidate_ids, db_batch_size):
        messages = ChatMessage.objects.filter(id__in=batch_ids).only(
            "id", "created_at", "content_blocks_json",
        )
        for msg in messages:
            scanned += 1
            new_blocks, marked = apply_unknown_marks(
                msg.content_blocks_json,
                message_created_at=msg.created_at,
                now=now,
                default_hard_timeout_ms=default_hard_timeout_ms,
            )
            if not marked:
                continue
            msg.content_blocks_json = new_blocks
            try:
                with transaction.atomic():
                    # 只修补 terminal block，不 bump updated_at，避免历史消息被误当成新活动。
                    msg.save(update_fields=["content_blocks_json"])
                marked_messages += 1
                marked_blocks += marked
            except Exception:
                logger.error(
                    "[TerminalStateGC] 标 unknown 落库失败（下轮重试）: msg=%s",
                    msg.id, exc_info=True,
                )

    if marked_messages:
        logger.info(
            "[TerminalStateGC] Layer 3 诚实降级完成: scanned=%d marked_messages=%d "
            "marked_blocks=%d default_hard_timeout_ms=%d lookback_days=%d",
            scanned, marked_messages, marked_blocks,
            default_hard_timeout_ms, max_lookback_days,
        )
    return {
        "scanned": scanned,
        "marked_messages": marked_messages,
        "marked_blocks": marked_blocks,
    }
