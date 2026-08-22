"""W3 §3.3.3-3.3.4 Anthropic 6 件套消费器 + ContentBlock 重组器。

== 核心职责 ==

消费 daemon Wave 2 emit 的 6 件套（`message_*` + `content_block_*`），重组为
`ContentBlock[]`（v3 §2.2 schema），驱动 ChatMessage 落库。

== 6 件套时序契约（Anthropic 协议 v3 §2.3.3） ==

```
message_start
  → content_block_start(0)
    → content_block_delta(0)*
  → content_block_stop(0)
  → content_block_start(1)
    → content_block_delta(1)*
  → content_block_stop(1)
  → ...
  → message_delta（携带 stop_reason / stop_sequence / usage 累计）
  → message_stop（触发落库）
```

**严格串行**：同 message 内 `content_block_start(N+1)` 必在 `content_block_stop(N)`
之后；不允许 N+1 早于 N stop。daemon 端 proxy-provider 已保证（详见
packages/agent-runtime/src/providers/proxy-provider.ts L66-L72）。

== 协议层 envelope 解析 ==

daemon emit 的 envelope 是 `{ type, payload }` 嵌套形态，envelope 公共字段
（protocol_version / min_compatible_version / _seq / trace_id / thread_id）
塞在 `payload` 内。generated Pydantic 类是 flat 形态——envelope + payload
字段平铺在同一 BaseModel，用 `event_type` 做 discriminator，alias `_seq` →
`field_seq`。

解析适配：
```python
flat = {**evt["payload"], "event_type": evt["type"]}
ContentBlockStart.model_validate(flat)  # 强 typed 强校验
```

== 双 trigger 落库（v3 §3.3.3-3.3.4） ==

- **主路径**：`message_stop` 同步触发 `finalize_and_persist(message_id)`
- **兜底路径**：`lifecycle(phase=end | error | cancelled)` 时 reassembler
  对所有"start 过但未 stop 的 message"强制 finalize（partial=True）+ 落库
- **后台 reconciliation worker**（每 5 分钟跑）：扫描"trace 有 message_stop
  事件但 chat_message 表没行"——从 trace 重建（灾难恢复路径）

== 幂等去重 ==

ChatMessage 表上有 `(session_id, client_event_id)` UniqueConstraint。本
reassembler 落库时也用同一 client_event_id（从 message_start 的 envelope
trace_id 推算 / 或从 lifecycle payload.client_event_id 取）—— 即便 daemon
端 lite-collector 桥的 inject `agent.stream.assistant(phase='final')` 路径
也跑到了 _write_chat_messages，两边幂等不重复落库。

== 对老桥（lite-collector inject）的兼容 ==

- `LITE_COLLECTOR_ENABLED=true`（默认）：daemon 端两路并发——既 emit 6 件套
  又 inject assistant final。Django 这边两条路径都进 `_write_chat_messages`，
  通过 client_event_id UniqueConstraint 去重，先到先赢，后到的 IntegrityError
  被 catch（见 relay_message_writer._upsert_chat_message）—— 落库结果一致。
- `LITE_COLLECTOR_ENABLED=false`（W3 完成后切）：daemon 不再 inject，只 emit
  6 件套。Django 这边 6 件套唯一路径，由 reassembler 接管落库。

== 重要不变量（防止 W4a-L16 类的"假修复"） ==

1. **绝不 mock ORM**：Pydantic 校验 + ChatMessage.objects.create 真打 DB（测试
   层用 `@pytest.mark.django_db(transaction=True)`，不允许 unittest.mock 替代）。
2. **绝不 dict 拆解 6 件套 payload**：必须用 generated Pydantic 解析获得强 typed
   ContentBlock。dict 拆解会导致 W2 silent bypass 二代（"emit 改了 consumer 没改"）。
3. **绝不只跑单测就 PASS**：需要"daemon emit → IPC → relay → reassembler → DB"
   完整 e2e 验证（见 test_content_block_reassembler_e2e.py）。

@cleanup-after 永久保留——这是 Django 的核心 6 件套消费器，不会被拆。
"""

from __future__ import annotations

import logging
import threading
import time
import uuid as uuid_mod
from dataclasses import dataclass, field
from typing import Any, Optional

from pydantic import ValidationError
from django.utils import timezone

from apps.services.wire_generated.any_event import (
    AnyContentBlockStreamEvent,
    ContentBlock,
    AgentStreamMessageStartAnyContentBlockStreamEvent as MessageStartEvent,
    AgentStreamMessageDeltaAnyContentBlockStreamEvent as MessageDeltaEvent,
    AgentStreamMessageStopAnyContentBlockStreamEvent as MessageStopEvent,
    AgentStreamContentBlockStartAnyContentBlockStreamEvent as ContentBlockStartEvent,
    AgentStreamContentBlockDeltaAnyContentBlockStreamEvent as ContentBlockDeltaEvent,
    AgentStreamContentBlockStopAnyContentBlockStreamEvent as ContentBlockStopEvent,
)

logger = logging.getLogger(__name__)


# ── 反推 helper：text_summary 取前 200 字（W4a-L27 P1） ─────────────────────

# 摘要长度上限（v3 §3.3.1 字段表 text_summary 用于会话列表 + 全文搜索 + 兜底
# 渲染——200 字够展示一句完整内容，但不会让 SQL 行过大）。
_TEXT_SUMMARY_MAX_CHARS = 200


def derive_text_summary(blocks: list[dict[str, Any]]) -> str:
    """从 ContentBlock[] 反推 text_summary（W4a-L27 P1 必须落地）。

    策略：拼接所有 `text` 块的 `text` 字段，截前 200 字。其余块类型
    （tool_use / thinking / image / tabtin_*）不计入 summary——会话列表只展示
    用户可读连续文本。

    edge cases:
    - **全部都是 tool_use 块**（罕见但合法）→ 返回 `[工具调用]` 占位文案（W3 P1 修复：
      avoid 会话列表完全空白；前端可显示 "AI 调用了工具" 兜底）
    - **全部都是 thinking 块**（用户 abort 极早期）→ 返回 `[思考中]` 占位
    - **全部都是 tabtin_rich_content 块**（图卡 / 表格预览） → 返回 `[富内容]` 占位
    - 第一个 text 块就 > 200 字 → 截断，无省略号（保持纯文本可拼接）
    - blocks 为空 / None → 返回 ''
    """
    if not blocks:
        return ''
    parts: list[str] = []
    has_tool_use = False
    has_thinking = False
    has_rich = False
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = block.get('type', '')
        if block_type == 'text':
            text = block.get('text', '')
            if isinstance(text, str) and text:
                parts.append(text)
                if sum(len(p) for p in parts) >= _TEXT_SUMMARY_MAX_CHARS:
                    break
        elif block_type in ('tool_use', 'server_tool_use', 'mcp_tool_use'):
            has_tool_use = True
        elif block_type in ('thinking', 'redacted_thinking'):
            has_thinking = True
        elif block_type in ('tabtin_rich_content', 'image', 'document', 'video'):
            has_rich = True

    if parts:
        joined = '\n'.join(parts)
        return joined[:_TEXT_SUMMARY_MAX_CHARS]

    # P1 修复：纯非 text 内容时返回占位文案，避免会话列表空白
    if has_tool_use:
        return '[工具调用]'
    if has_rich:
        return '[富内容]'
    if has_thinking:
        return '[思考中]'
    return ''


def derive_full_text_content(blocks: list[dict[str, Any]]) -> str:
    """从 ContentBlock[] 反推**完整**用户可见文本（不截断）。

    与 `derive_text_summary` 的区别：后者只取前 200 字供会话列表 / FTS / 搜索；
    本函数拼接全部 `text` 块，供 API `ChatMessageSchema.content` 在 **user**
    消息上返回全文——前端 MessageBubble 直接渲染 `content`，若误用
    `text_summary` 会在服务端回灌后把用户长提示词截断到 200 字（DV 类 bug）。

    无 text 块时返回 ''（调用方可回落 `text_summary`）。
    """
    if not blocks:
        return ''
    parts: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get('type') == 'text':
            text = block.get('text', '')
            if isinstance(text, str) and text:
                parts.append(text)
    return '\n'.join(parts) if parts else ''


def derive_error_info(
    *,
    stop_reason: str,
    lifecycle_error: Optional[dict[str, Any]] = None,
    system_notices: Optional[list[dict[str, Any]]] = None,
    message_stop_error_info: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    """从多源反推 error_info_json（W4a-L27 P1 必须落地）。

    输入信号优先级（高 → 低）：
    1. **`message_stop_error_info`** —— daemon emit 的 `message_stop.error_info`
       真信号（W4.5 第二波 P0-1 加），含 `partial_reason` 三档
       (`aborted` / `stream_interrupted` / `message_stop_fallback`) + 可选
       `category` / `error_class` / `error_message`。daemon 真区分三档语义后，
       不再依赖客户端启发式反推。
    2. **lifecycle phase=error/cancelled** payload（次权威；daemon 缺省时使用）
    3. **stop_reason='aborted' / 'refusal' / 'error'** （Anthropic 标准；
       W4c R6-P0-1 启发式）
    4. **error 类 SYSTEM_NOTICE**（runtime 主动播报的错误）

    输出 ErrorInfo schema:
    ```
    {
      "category": "aborted" | "timeout" | "protocol_error" | "runtime_failed" | "refusal",
      "error_class": str,
      "error_message": str,
      "suggested_action": str | None,
      "partial_reason": "aborted" | "stream_interrupted" | "message_stop_fallback",
      "aborted": bool,
    }
    ```

    成功路径返回 None；任何信号源命中即返回非空 dict（落库到 `chat_message.error_info_json`）。
    """
    if not stop_reason and not lifecycle_error and not system_notices and not message_stop_error_info:
        return None

    info: dict[str, Any] = {}

    # ── 信号源 #1：daemon emit 的 message_stop.error_info（最高优先级） ──
    # W4.5 第二波 P0-1 修复（2026-05-12）：daemon `envelope-emitter.endMessage(
    # { errorInfo })` 在 abort / runtime error / stall retry 等异常路径携带的
    # 结构化信号。reassembler `_on_message_stop` 收上来后 _serialize 透传过来。
    # daemon 真区分三档后这条信号永远比客户端启发式准——譬如 stall retry 路径
    # daemon 知道是"主动收尾兜底"应标 message_stop_fallback；客户端如果只能从
    # stop_reason 反推就只能误判为 stream_interrupted。
    if isinstance(message_stop_error_info, dict):
        for k in ('partial_reason', 'category', 'error_class', 'error_message', 'suggested_action'):
            v = message_stop_error_info.get(k)
            if v:
                info[k] = v
        # category='aborted' 时同步设置 aborted=True，让前端不依赖字符串匹配
        # （与下面 stop_reason='aborted' 分支保持一致行为）。
        if info.get('category') == 'aborted' or info.get('partial_reason') == 'aborted':
            info['aborted'] = True

    # ── 信号源 #2~#4：daemon 缺省时的 W4c R6-P0-1 启发式回落 ──

    if stop_reason == 'aborted':
        info.setdefault('category', 'aborted')
        info['aborted'] = True  # P1 修复：显式 aborted 布尔字段（前端不依赖字符串匹配）
        info.setdefault('error_message', '用户中止了操作')
        # W4.5 P0-1：daemon 未携带 partial_reason 时由 stop_reason 反推一档，
        # 让历史回放路径 + 老 daemon 版本仍有可读 partial_reason。
        info.setdefault('partial_reason', 'aborted')
    elif stop_reason == 'refusal':
        info.setdefault('category', 'refusal')
        info.setdefault('error_class', 'ContentSafetyRefusal')
        info.setdefault('error_message', '安全策略拒绝生成')
    elif stop_reason == 'error':
        info.setdefault('category', 'runtime_failed')
        info.setdefault('error_message', '运行时异常导致终止')
        info.setdefault('partial_reason', 'stream_interrupted')

    if isinstance(lifecycle_error, dict):
        # lifecycle payload: { phase: error | cancelled, error_class?, error_message?, ... }
        phase = lifecycle_error.get('phase')
        if phase == 'cancelled':
            info['category'] = 'aborted'
            info['aborted'] = True
            info['error_message'] = lifecycle_error.get('error_message') or info.get('error_message') or '已取消'
            info.setdefault('partial_reason', 'aborted')
        elif phase == 'error':
            info['category'] = info.get('category') or 'runtime_failed'
            for k in ('error_class', 'error_message', 'suggested_action'):
                v = lifecycle_error.get(k)
                if v:
                    info[k] = v
            info.setdefault('partial_reason', 'stream_interrupted')

    if system_notices:
        # SYSTEM_NOTICE.payload: { notice_type: 'error_*' | ..., message?, error_class?, ... }
        for notice in system_notices:
            if not isinstance(notice, dict):
                continue
            notice_type = notice.get('notice_type', '')
            if not str(notice_type).startswith('error_') and notice_type != 'error':
                continue
            for k in ('error_class', 'error_message', 'suggested_action'):
                v = notice.get(k)
                if v and k not in info:
                    info[k] = v
            if 'category' not in info:
                if 'timeout' in str(notice_type).lower():
                    info['category'] = 'timeout'
                elif 'protocol' in str(notice_type).lower():
                    info['category'] = 'protocol_error'
                else:
                    info['category'] = 'runtime_failed'

    return info if info else None


# ── 重组器内部数据结构 ───────────────────────────────────────────────────


@dataclass
class _BlockSlot:
    """单 ContentBlock 的累积状态（消费 content_block_* 事件期间）。"""
    index: int
    block_id: str
    arrival_seq: int
    arrived_at: str
    # block 初始 shell（来自 content_block_start.block）；delta 累积到 text /
    # thinking / signature / input 字段；stop 时 finalize（input_json 解析）
    block: dict[str, Any]
    event_seq: Optional[int] = None
    # tool_use 类型的 partial JSON 累积（content_block_delta input_json_delta）
    pending_input_json: str = ''
    finalized: bool = False


@dataclass
class _MessageState:
    """单 message_id 的完整状态（从 message_start 到 message_stop）。"""
    message_id: str
    role: str
    model_id: str
    model_name: str
    started_at: str
    run_id: str
    # 本条消息实际执行 Agent；会话 agent_id 是下一轮默认指针，不能替代历史事实。
    agent_id: str = ''
    subagent_run_id: str = ''
    # 协议层 message_kind 取代旧 synthetic 字段（W4.5 协议升级 + W1a 一刀切删除）。
    # daemon wire `MessageStartSchema.message_kind` 必填三档：
    #   - 'llm'：主 LLM 真实输出 / 合成 user tool_result 包装（reassembler 按 role+blocks 复合判别走合并路径）
    #   - 'tool_artifact'：工具产物气泡（widget / search_results / cli_output 等富内容 mini-message）
    #   - 'error_envelope'：daemon 自合成的错误文案气泡（context overflow / capability gate 等）
    # 本字段从 `evt.message_kind.value` 直读；下游消费方
    # （`_serialize` / `relay_message_writer`）只按 message_kind switch，不再有
    # 派生 synthetic 兜底——任何"判别合成消息"的逻辑都靠 message_kind != 'llm' 显式表达。
    message_kind: str = 'llm'
    # block index → slot
    slots: dict[int, _BlockSlot] = field(default_factory=dict)
    # 收到 message_delta 累积的元字段
    stop_reason: str = ''
    stop_sequence: str = ''
    usage: Optional[dict[str, int]] = None
    # 状态标记
    finalized: bool = False
    # 来自 envelope 的元数据（用于落库 ChatMessage）
    trace_id: str = ''
    thread_id: str = ''
    # client_event_id 由 envelope 推算或外部注入
    client_event_id: str = ''
    # relay_events 允许整批重投；同一 message 内用 daemon 原始 _seq 做事件级幂等，
    # 防止 content_block_delta 在 retry/recover 后被二次 append。
    seen_event_keys: set[tuple[str, int, int]] = field(default_factory=set)
    # ── W3 第三轮 Review P0-3 修复：内存 GC 时间戳 ──
    # 创建时间（message_start 收到时记录）；用于超时清理避免 in-memory state
    # 在 DB 落库失败 + daemon 之后不再发该 message 相关事件时永久挂住。
    # 阈值由 ContentBlockReassembler.GC_TTL_SECONDS 控制（默认 1800s = 30 分钟）。
    created_at_ts: float = field(default_factory=time.monotonic)
    # ── W4.5 第二波 P0-1 修复（2026-05-12）：message_stop.error_info 真信号 ──
    # daemon `envelope-emitter.endMessage({ errorInfo })` 携带 partial_reason
    # 三档（'aborted' / 'stream_interrupted' / 'message_stop_fallback'）+
    # category / error_class / error_message。`_on_message_stop` 写入本字段；
    # `_serialize` 透传给 derive_error_info 作为最优先信号源——客户端启发式
    # 反推（W4c R6-P0-1 stop_reason / aborted）让位给 daemon 真信号。
    # daemon 缺省（向后兼容旧 daemon 版本 / 历史 message）时本字段保持 None，
    # derive_error_info 回落 stop_reason / lifecycle / SYSTEM_NOTICE 启发式。
    message_stop_error_info: Optional[dict[str, Any]] = None


# ── 重组器主类 ───────────────────────────────────────────────────────────


class ContentBlockReassembler:
    """6 件套消费 + 重组 + 落库驱动器（线程级单例）。

    生命周期：进程级单例（一个 Django relay consumer 处理多个 thread / session 共享）。
    内部按 `message_id` 维护独立 `_MessageState`，互不干扰。

    线程安全：状态变更走 `_lock`（Python GIL 不能保证 dict 复合操作原子，
    relay_handler 跑在 ASGI event loop 但 _spawn_background_trace_write 等
    会发到独立 thread）。

    内存上界：单 message 一般 ≤ 10 blocks × 几 KB；finalize 后从 `_messages`
    pop 移除——绝不长期挂住已 finalize 的 state。

    **W3 第三轮 Review P0-3 修复：超时 GC**：
    DB 落库失败 + daemon 之后不再发该 message 相关事件 → state 永久挂住的
    场景被超时清理覆盖。每次 consume / get_active_message_ids / serialize_for_persist
    入口都做 best-effort GC（按需限流：上次 GC 后至少 GC_INTERVAL_SECONDS 才再扫一次
    避免热路径性能下降）。
    """

    # GC 阈值：单 message state 在 reassembler 内存中存活时间上限（秒）
    # 30 分钟覆盖正常 LLM 长任务（reasoning + 多工具调用）；超过即视为僵死
    GC_TTL_SECONDS: float = 1800.0
    # GC 扫描节流间隔（避免每次 consume 都全量扫，热路径开销大）
    GC_INTERVAL_SECONDS: float = 60.0

    def __init__(self) -> None:
        self._messages: dict[str, _MessageState] = {}
        self._lock = threading.Lock()
        self._last_gc_ts: float = time.monotonic()

    # ── 入口：消费一条 envelope event ──────────────────────────────────────

    def _maybe_gc(self) -> None:
        """W3 P0-3：限流 GC——清理超时 _MessageState 避免内存泄漏。

        必须在持有 _lock 的情况下调用。最早 GC_INTERVAL_SECONDS 才扫一次。
        每次 GC 把所有 created_at_ts 早于 now - GC_TTL_SECONDS 的 message pop。
        """
        now = time.monotonic()
        if now - self._last_gc_ts < self.GC_INTERVAL_SECONDS:
            return
        self._last_gc_ts = now
        cutoff = now - self.GC_TTL_SECONDS
        expired = [
            msg_id for msg_id, state in self._messages.items()
            if state.created_at_ts < cutoff
        ]
        if expired:
            for msg_id in expired:
                state = self._messages.pop(msg_id, None)
                if state is not None:
                    logger.warning(
                        "[Reassembler GC] expired msg=%s thread=%s ttl=%.0fs "
                        "stop_reason=%s blocks=%d —— DB 落库可能失败 + daemon 不再"
                        "发后续事件，by reconciliation worker（trace_event 重建）兜底",
                        msg_id, state.thread_id, self.GC_TTL_SECONDS,
                        state.stop_reason or 'in-flight', len(state.slots),
                    )

    def consume(self, evt: dict[str, Any]) -> None:
        """消费 6 件套之一。其它 event_type 静默忽略。

        evt 形态（daemon emit 嵌套 envelope）：
        ```
        {
          "type": "agent.stream.message_start" | ... | "agent.stream.content_block_stop",
          "payload": {  # envelope 公共字段在 payload 内
            "protocol_version": "v2",
            "min_compatible_version": "v2",
            "_seq": 0,
            "trace_id": "...",
            "thread_id": "...",
            "message_id": "...",
            ...                       # 各事件类型自有字段
          }
        }
        ```
        """
        event_type = evt.get('type', '')
        if not isinstance(event_type, str):
            return
        if event_type not in _SIX_PIECE_EVENT_TYPES:
            return

        # ── 协议层适配：嵌套 envelope → flat（generated Pydantic 是 flat 形态） ──
        payload = evt.get('payload') or {}
        if not isinstance(payload, dict):
            logger.warning(
                "[Reassembler] 6 件套 envelope payload 非 dict，丢弃: type=%s",
                event_type,
            )
            return
        flat = {**payload, 'event_type': event_type}

        # ── Pydantic 强 typed 解析（discriminator on event_type） ──
        try:
            parsed = AnyContentBlockStreamEvent.model_validate(flat)
        except ValidationError as exc:
            # **W4.5-A2 修复（真生产路径运维可观测）**：
            # 真实的 "daemon emit 了 Django Pydantic union 不认识的 delta_type /
            # block.type / event_type" 会在这里被 Discriminator 拦截，**不会**
            # 走到下面 `_on_content_block_delta` 末尾的 else 分支——所以这里
            # 必须把 "unknown delta_type" / "unknown block.type" 关键字写进
            # log message，运维 grep 才搜得到（前一次 W4c "补 logger.warn 重做"
            # 的假修复就栽在这——加的位置走不到）。下面 `_on_content_block_delta`
            # line 567-574 的兜底 logger.warning 保留作防御性双保险，
            # 标注 "理论 unreachable（Pydantic Discriminator 提前拦截）"。
            logger.warning(
                "[Reassembler] Pydantic 校验失败，丢弃事件: type=%s err=%s "
                "（可能因 daemon emit 新 event_type / unknown delta_type / "
                "unknown block.type 但 Django Pydantic union 未升级——"
                "请检查 wire schema 升级路径或 daemon emit 协议）",
                event_type, exc.errors()[:3],  # 只取前 3 条错误避免日志爆炸
            )
            return

        # parsed.root 是具体的 6 件套 event class 之一（已被 discriminator 选中）
        evt_typed = parsed.root

        with self._lock:
            # P0-3：限流 GC—— 每个 consume 入口尝试清理超时 state，每个进程
            # 至少 GC_INTERVAL_SECONDS 才真扫一次（避免热路径每次都 O(n)）
            self._maybe_gc()
            if isinstance(evt_typed, MessageStartEvent):
                self._on_message_start(evt_typed)
            elif isinstance(evt_typed, ContentBlockStartEvent):
                # daemon 在 emit 时分配的权威 arrival_seq。Pydantic extra='ignore'
                # 会丢弃未重生成的 typed 字段,故从原始 payload 直读;非整数 → None。
                daemon_arrival = payload.get('arrival_seq')
                self._on_content_block_start(
                    evt_typed,
                    daemon_arrival if isinstance(daemon_arrival, int) else None,
                )
            elif isinstance(evt_typed, ContentBlockDeltaEvent):
                self._on_content_block_delta(evt_typed)
            elif isinstance(evt_typed, ContentBlockStopEvent):
                self._on_content_block_stop(evt_typed)
            elif isinstance(evt_typed, MessageDeltaEvent):
                self._on_message_delta(evt_typed)
            elif isinstance(evt_typed, MessageStopEvent):
                self._on_message_stop(evt_typed)
            # 不应出现其他类型——AnyContentBlockStreamEvent 已穷举 6 类

    # ── 主路径：message_stop 触发落库 ──────────────────────────────────────

    def serialize_for_persist(self, message_id: str) -> Optional[dict[str, Any]]:
        """**W3 P0-C 修复**：序列化 message state 但**不弹出**——让消费方先尝试
        DB 落库，成功后再调 `pop_after_persist(message_id)` 释放内存。

        DB 落库失败时 state 保留在内存，下批 critical_events 时仍可重试。

        本方法替代原 `finalize_and_pop`——后者在 DB 落库前就 pop，DB 失败会
        丢失重组结果。

        Returns:
            None 如果 message_id 没见过；否则返回 serialize 后的 dict（语义同
            原 finalize_and_pop 返回值）。
        """
        with self._lock:
            state = self._messages.get(message_id)
            if state is None:
                return None
            # 拷贝避免下游修改污染内存 state
            import copy as _copy
            state_copy = _copy.deepcopy(state)
        return self._serialize(state_copy)

    def pop_after_persist(self, message_id: str) -> None:
        """**W3 P0-C 修复**：DB 落库成功后调本方法释放内存 state。

        如果 message_id 未见过 / 已 pop —— 静默 noop（重复 pop 安全）。
        """
        with self._lock:
            self._messages.pop(message_id, None)

    def finalize_and_pop(self, message_id: str) -> Optional[dict[str, Any]]:
        """**保留兼容**：旧 API（弹出 + 序列化原子操作）。

        新代码应改用 `serialize_for_persist` + `pop_after_persist` 配对调用，
        让 DB 落库失败时 state 还在内存。本函数现在内部转调新 API 但有**风险**：
        DB 失败仍会丢 state（pop 已执行）。reconciliation worker 的内部
        ContentBlockReassembler 实例适合用本 API（它是临时实例，pop 即销毁）。
        """
        result = self.serialize_for_persist(message_id)
        if result is not None:
            self.pop_after_persist(message_id)
        return result

    def get_active_message_ids(self) -> list[str]:
        """返回当前 reassembler 正持有的 message_id 列表。

        用于 lifecycle(phase=end|error|cancelled) 兜底路径——relay 收到
        lifecycle 时调本方法查"还有哪些 in-flight message 没收到 message_stop"，
        对每个调 serialize_for_persist + 落库 + pop_after_persist。

        P0-3：本入口也触发 _maybe_gc—— lifecycle fallback 是兜底兜底路径，
        在此 GC 旧 state 不会影响主路径性能。
        """
        with self._lock:
            self._maybe_gc()
            return list(self._messages.keys())

    def get_state_snapshot(self, message_id: str) -> Optional[dict[str, Any]]:
        """诊断接口：取某 message 当前累积的快照（不弹出，不落库）。

        用于 reconciliation worker / 排障。返回的 dict 与 finalize_and_pop
        相同形态，但 `partial=True`（state 仍 in-flight）。
        """
        with self._lock:
            state = self._messages.get(message_id)
            if state is None:
                return None
            # snapshot 不动 state——拷贝再 serialize
            import copy as _copy
            state_copy = _copy.deepcopy(state)
        return self._serialize(state_copy, force_partial=True)

    # ── 状态机内部 ────────────────────────────────────────────────────────

    def _on_message_start(self, evt: MessageStartEvent) -> None:
        # alias 路径：field_seq 是 _seq 的 alias，不直接读
        message_id = evt.message_id
        if message_id in self._messages:
            # message_id 重复——通常是 daemon retry 同一 LLM 调用；以新 start
            # 覆盖（保留原 client_event_id 链路，但 blocks 重新累积）
            logger.info(
                "[Reassembler] message_id=%s 重复 message_start——覆盖旧累积",
                message_id,
            )
        # `evt.message_kind` 是 Pydantic Enum（MessageKind.llm / tool_artifact /
        # error_envelope）—— `.value` 取字面量字符串落到 state，下游 _serialize
        # / relay 都用字符串语义直接判别，避免 Enum 跨包传递（reconciliation
        # worker 可能在不同 wire_generated import 顺序里拿到不同 Enum 类）。
        self._messages[message_id] = _MessageState(
            message_id=message_id,
            role=evt.role.value,  # Role enum
            model_id=evt.model_id,
            model_name=evt.model_name,
            started_at=evt.started_at,
            run_id=evt.run_id,
            agent_id=evt.agent_id or '',
            subagent_run_id=evt.subagent_run_id or '',
            message_kind=evt.message_kind.value if hasattr(evt.message_kind, 'value') else str(evt.message_kind),
            trace_id=str(evt.trace_id.root) if evt.trace_id else '',
            thread_id=str(evt.thread_id.root) if evt.thread_id else '',
        )

    def _seen_or_mark_event(
        self,
        state: _MessageState,
        evt: Any,
        *,
        index: int = -1,
    ) -> bool:
        """返回 True 表示同一 message 内重复事件已消费，应跳过。

        去重只看协议事件身份，不看文本内容，避免误删模型合法输出的重复字符。
        `message_start` 维持原有"重复 start 重置 state"语义，因此不走本 helper。
        """
        seq_value = getattr(evt, 'field_seq', None)
        seq = getattr(seq_value, 'root', seq_value)
        event_type = getattr(evt, 'event_type', None)
        if not isinstance(seq, int) or not isinstance(event_type, str) or not event_type:
            return False
        key = (event_type, seq, index)
        if key in state.seen_event_keys:
            logger.debug(
                "[Reassembler] duplicate event skipped: msg=%s type=%s seq=%s index=%s",
                state.message_id, event_type, seq, index,
            )
            return True
        state.seen_event_keys.add(key)
        return False

    def _on_content_block_start(
        self, evt: ContentBlockStartEvent, daemon_arrival_seq: Optional[int] = None,
    ) -> None:
        state = self._messages.get(evt.message_id)
        if state is None:
            logger.warning(
                "[Reassembler] content_block_start 但无 message_start: msg=%s",
                evt.message_id,
            )
            return
        if self._seen_or_mark_event(state, evt, index=evt.index):
            return
        # evt.block 是 ContentBlock RootModel，dump 成 dict 作为 slot 初始 shell。
        #
        # **W4.5 第二波 B2 实证（2026-05-12）**：本 dict 化的"通用累积路径"
        # 是所有 22 个 ContentBlock 类型（含 6 个 tabtin_* 扩展）共同走的入口——
        # `tabtin_rich_content` block 不需要专属处理逻辑：
        #   - 这类 block 的完整 payload（`type` / `kind` / `summary` / `group_id?` /
        #     `payload?` 见 TabTinRichContentBlockSchema）在 daemon emit
        #     `content_block_start` 时**一次性传完整结构**——daemon 端工具
        #     （show_widget / present_to_user / search_results 等）通过
        #     `context.emitRichContentBlock` 拼一个完整的 ContentBlock 三件套
        #     mini-message（content_block_start + content_block_stop，没有
        #     content_block_delta 流），因此 reassembler 在 cb_start 时 dump 成
        #     dict 就拿到完整 block；
        #   - cb_stop 时不需要 finalize 任何东西（不像 tool_use 需要 parse
        #     pending_input_json），slot.block 就是最终落库形态；
        #   - 历史 RICH_CONTENT 事件（`agent.stream.rich_content`）已下线——
        #     daemon 0 处真 emit，wire 层 / Renderer / 4 端 mobile / Django relay
        #     白名单同步清。
        # 任何新加 tabtin_* block 类型只要 schema 在 wire 层有定义、generated
        # Pydantic AnyEvent union 包含，就自动支持，无需改 reassembler。
        block_dict = evt.block.model_dump(mode='json', exclude_none=True)
        seq_value = getattr(evt, 'field_seq', None)
        event_seq = getattr(seq_value, 'root', seq_value)
        state.slots[evt.index] = _BlockSlot(
            index=evt.index,
            block_id=evt.block_id,
            # arrival_seq 权威来自 daemon emit(,thread 单调微秒);daemon 缺失
            # (老版本 / Pydantic 未重生成)才回落服务器 wall-clock 微秒(≈1.78e15,
            # 在 JS 安全整数 9e15 内,与前端同尺度)。
            arrival_seq=daemon_arrival_seq if daemon_arrival_seq is not None else time.time_ns() // 1000,
            arrived_at=timezone.now().isoformat(),
            event_seq=event_seq if isinstance(event_seq, int) else None,
            block=block_dict,
        )

    def _on_content_block_delta(self, evt: ContentBlockDeltaEvent) -> None:
        state = self._messages.get(evt.message_id)
        if state is None:
            return
        slot = state.slots.get(evt.index)
        if slot is None:
            logger.warning(
                "[Reassembler] content_block_delta 但无 slot: msg=%s idx=%d",
                evt.message_id, evt.index,
            )
            return
        if self._seen_or_mark_event(state, evt, index=evt.index):
            return
        # delta.root 是具体的 delta payload（discriminator on type）
        delta = evt.delta.root
        delta_type = delta.type

        if delta_type == 'text_delta':
            prev = slot.block.get('text', '') or ''
            slot.block['text'] = prev + delta.text
        elif delta_type == 'connector_text_delta':
            # connector_text_delta 累积也写到 text 字段（ConnectorText 是 Claude
            # Code feature flag 路径，下游消费者按 text 渲染）
            prev = slot.block.get('text', '') or ''
            slot.block['text'] = prev + delta.connector_text
        elif delta_type == 'thinking_delta':
            prev = slot.block.get('thinking', '') or ''
            slot.block['thinking'] = prev + delta.thinking
        elif delta_type == 'signature_delta':
            prev = slot.block.get('signature', '') or ''
            slot.block['signature'] = prev + delta.signature
        elif delta_type == 'input_json_delta':
            slot.pending_input_json += delta.partial_json
        elif delta_type == 'citations_delta':
            citations = slot.block.setdefault('citations', [])
            if isinstance(citations, list):
                citations.append(delta.citation.model_dump(mode='json', exclude_none=True))
        else:
            # **W4.5-A2 修复**：本分支理论 unreachable —— Pydantic Discriminator
            # 在 `_on_evt` line 386-393 阶段（`AnyContentBlockStreamEvent.model_validate`）
            # 就已经把未知 delta_type 当 ValidationError 拦截，永远到不了这里。
            # 真生产路径的 "unknown delta_type" log 见上述 ValidationError catch
            # 分支（含 "unknown delta_type" 关键字，运维可 grep 定位）。
            # 本分支保留为**防御性双保险**：未来若 Pydantic discriminator 被改为
            # 松开 / 接受 union 之外的 delta_type，此 logger.warning 仍兜底
            # silent drop——同时保留 "unknown delta_type" 关键字，确保运维 grep
            # 在任一升级路径下都能命中。
            logger.warning(
                "reassembler: unknown delta_type %s on message_id=%s index=%s — "
                "可能 daemon emit 新 delta_type 但 Django 未升级；silent drop 增量数据，"
                "请检查 wire schema 升级路径或 daemon emit 协议",
                delta_type, evt.message_id, evt.index,
            )

    def _on_content_block_stop(self, evt: ContentBlockStopEvent) -> None:
        state = self._messages.get(evt.message_id)
        if state is None:
            return
        slot = state.slots.get(evt.index)
        if slot is None:
            return
        if self._seen_or_mark_event(state, evt, index=evt.index):
            return
        # tool_use 类型 finalize：JSON.parse pending_input_json
        block_type = slot.block.get('type', '')
        if (
            slot.pending_input_json
            and block_type in ('tool_use', 'server_tool_use', 'mcp_tool_use')
        ):
            try:
                import json
                parsed = json.loads(slot.pending_input_json)
                if isinstance(parsed, dict):
                    slot.block['input'] = parsed
                else:
                    # 不是 dict（譬如 LLM 输出了 array）—— 走 input_parse_error
                    slot.block['input'] = {}
                    slot.block['input_parse_error'] = {
                        'message': 'tool_use.input is not a JSON object',
                        'partial': slot.pending_input_json,
                    }
            except (ValueError, TypeError) as exc:
                slot.block['input'] = {}
                slot.block['input_parse_error'] = {
                    'message': f'partial JSON parse failed: {exc}',
                    'partial': slot.pending_input_json,
                }
        slot.pending_input_json = ''
        slot.finalized = True

    def _on_message_delta(self, evt: MessageDeltaEvent) -> None:
        state = self._messages.get(evt.message_id)
        if state is None:
            return
        if self._seen_or_mark_event(state, evt):
            return
        # evt.delta 是 Delta(stop_reason, stop_sequence)
        if evt.delta.stop_reason:
            state.stop_reason = evt.delta.stop_reason
        if evt.delta.stop_sequence:
            state.stop_sequence = evt.delta.stop_sequence
        # usage 是 cumulative（v3 §2.3.1）—— 直接覆盖，不累加
        if evt.usage is not None:
            state.usage = {
                'input_tokens': evt.usage.input_tokens,
                'output_tokens': evt.usage.output_tokens,
            }
            if evt.usage.cache_creation_input_tokens is not None:
                state.usage['cache_creation_input_tokens'] = evt.usage.cache_creation_input_tokens
            if evt.usage.cache_read_input_tokens is not None:
                state.usage['cache_read_input_tokens'] = evt.usage.cache_read_input_tokens

    def _on_message_stop(self, evt: MessageStopEvent) -> None:
        state = self._messages.get(evt.message_id)
        if state is None:
            return
        if self._seen_or_mark_event(state, evt):
            return
        state.finalized = True
        # W4.5 第二波 P0-1 修复（2026-05-12）：透传 daemon emit 的真信号。
        #
        # daemon `envelope-emitter.endMessage({ errorInfo })` 在 abort / runtime
        # error / stall retry 等异常路径上携带结构化 error_info（含 partial_reason
        # 三档 + category / error_class / error_message）。reassembler 这里只
        # 暂存到 state，序列化时由 `_serialize` → `derive_error_info(
        # message_stop_partial_reason=...)` 作为最优先信号合并到 error_info_json
        # 落库到 `chat_message.error_info_json` 字段。
        if evt.error_info is not None:
            ei = evt.error_info
            # `ei` 来自 Pydantic ErrorInfo（generated/python wire_generated），
            # 字段都是 optional。dump 成 dict 后剔除 None 避免落库写空值。
            ei_dict = ei.model_dump(mode='json', exclude_none=True)
            if ei_dict:
                state.message_stop_error_info = ei_dict
        # 不在这里 pop——pop 由消费方（relay）调 finalize_and_pop 触发，
        # 让消费方有机会先取 snapshot 再落库

    # ── 序列化：state → 落库 dict ───────────────────────────────────────────

    def _serialize(self, state: _MessageState, force_partial: bool = False) -> dict[str, Any]:
        # 把 slots 按 index 排序成 ContentBlock[]
        # **W3 P0-E 修复**：把 slot.block_id（daemon 端生成的稳定 ID）塞进
        # block dict，让 ChatMessage.content_blocks_json 中每个 block 都带
        # block_id 字段——checkpoint_anchor_block_id 字段才能精准定位某个
        # block（v3 §3.3.1 双锚定 ID + index）。
        sorted_slots = sorted(state.slots.values(), key=lambda s: s.index)
        content_blocks = []
        for slot in sorted_slots:
            block_with_id = dict(slot.block)
            block_with_id['block_id'] = slot.block_id
            block_with_id['arrival_seq'] = slot.arrival_seq
            block_with_id['arrived_at'] = slot.arrived_at
            if slot.event_seq is not None:
                block_with_id['event_seq'] = slot.event_seq
            content_blocks.append(block_with_id)
        any_unfinalized = any(not slot.finalized for slot in sorted_slots)
        partial = force_partial or (not state.finalized) or any_unfinalized

        # W4.5 第二波 P0-1（2026-05-12）：把 daemon emit 的 message_stop.error_info
        # 一同透传——内层主路径 `derive_error_info` 调用直接合并；外层 relay
        # 调用（含 lifecycle / SYSTEM_NOTICE 跨事件信号）也会用到这个值。
        message_stop_error_info = state.message_stop_error_info
        partial_reason_from_message_stop = (
            message_stop_error_info.get('partial_reason')
            if isinstance(message_stop_error_info, dict)
            else None
        )

        return {
            'message_id': state.message_id,
            'role': state.role,
            'model_id': state.model_id,
            'model_name': state.model_name,
            'started_at': state.started_at,
            'run_id': state.run_id,
            'agent_id': state.agent_id,
            'subagent_run_id': state.subagent_run_id,
            # 协议层唯一判别字段（W4.5 + W1a 协议层重构后）：
            # 三档 'llm' / 'tool_artifact' / 'error_envelope' 取代旧 `synthetic`
            # bool —— `synthetic` 字段已在 wire 层 + reassembler state 彻底删除，
            # 任何下游消费方（relay_message_writer / API schema / 前端 handler）
            # 必须按 message_kind switch，不再有"派生 synthetic"兜底语义。
            'message_kind': state.message_kind,
            'trace_id': state.trace_id,
            'thread_id': state.thread_id,
            'client_event_id': state.client_event_id,
            'content_blocks': content_blocks,
            'stop_reason': state.stop_reason,
            'stop_sequence': state.stop_sequence,
            'usage_json': state.usage,
            'text_summary': derive_text_summary(content_blocks),
            # W4.5 第二波 P0-1：daemon emit 的 message_stop.error_info 透传给
            # 上层 relay_message_writer——relay 在主路径 / lifecycle fallback 路径
            # 调 derive_error_info 时会传 message_stop_error_info 作为最优先源；
            # reassembler 自己也先合一遍兜底（万一 relay 路径漏传也不丢真信号）。
            'message_stop_error_info': message_stop_error_info,
            # error_info_json 这里只能反推 stop_reason 维度——lifecycle / SYSTEM_NOTICE
            # 信号要由消费方调 derive_error_info() 时合并传入（reassembler 不持有
            # 跨事件类型的信号）。本路径预合一份让 reconciliation worker / 仅
            # serialize_for_persist 内部调用方拿到完整 error_info_json。
            'error_info_json': derive_error_info(
                stop_reason=state.stop_reason,
                message_stop_error_info=message_stop_error_info,
            ),
            'partial': partial,
            # 暴露 partial_reason 顶层字段，便于 reconciliation / 测试断言定位
            # daemon emit 的真信号是否流到这一层（不直接落库；落库统一走
            # error_info_json.partial_reason 字段）。
            'partial_reason': partial_reason_from_message_stop,
        }


# ── 6 件套事件类型常量集合（解耦 wire_generated 内部命名） ──────────────

_SIX_PIECE_EVENT_TYPES = frozenset({
    'agent.stream.message_start',
    'agent.stream.message_delta',
    'agent.stream.message_stop',
    'agent.stream.content_block_start',
    'agent.stream.content_block_delta',
    'agent.stream.content_block_stop',
})


def is_six_piece_event(event_type: str) -> bool:
    """协议层判别：是否为 W3 6 件套事件。"""
    return event_type in _SIX_PIECE_EVENT_TYPES


# ── 进程级单例（relay_handler 调） ───────────────────────────────────────

# 全进程共享一个 reassembler 实例——按 message_id 隔离 state，不会跨 message
# 串扰。Django ASGI consumer 是单进程多 worker，每个 worker 进程一个 instance。
_global_reassembler: Optional[ContentBlockReassembler] = None
_global_reassembler_lock = threading.Lock()


def get_reassembler() -> ContentBlockReassembler:
    """获取进程级 reassembler 单例。"""
    global _global_reassembler
    if _global_reassembler is None:
        with _global_reassembler_lock:
            if _global_reassembler is None:
                _global_reassembler = ContentBlockReassembler()
    return _global_reassembler


def reset_reassembler_for_test() -> None:
    """测试 helper：reset 单例（pytest fixture 用）。"""
    global _global_reassembler
    with _global_reassembler_lock:
        _global_reassembler = None
