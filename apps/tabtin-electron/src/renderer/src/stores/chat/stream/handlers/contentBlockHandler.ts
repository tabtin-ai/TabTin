/**
 * ContentBlock 6 件套事件 handler（Wave 4a 新协议消费侧）。
 *
 * 上游契约（v2 §2.3 + §3.5.1）：daemon emit 6 种事件——
 *   message_start / message_delta / message_stop
 *   content_block_start / content_block_delta / content_block_stop
 *
 * 本 handler 是**唯一**的"事件 → store CRUD"翻译层；store 内部已实现 6 类边角 case
 * 兜底（lastSeq 去重 / parse 失败 / 乱序 / 强制 finalize）——本 handler 只做：
 *   1. zod parse 校验 + 容错（schema 失败 → warn + drop）
 *   2. 字段映射到 store 的 messageStart / contentBlockDelta 等方法
 *
 * **零 if-else 业务逻辑**：dispatch 用 schema discriminator 自动收窄类型；
 * 每条事件走一个独立函数（vis. visitor pattern），没有"if eventType ==='X' then..."大开关。
 *
 * 设计参考：
 * - v2 §3.5.1.b 客户端流式状态机 6 类边角 case
 * - v2 §3.5.1.c IPC vs WS 双源去重
 * - 总控 §六 Wave 4a F 节
 */

import type { ChatMessage } from '@tabtin/chat-client'
import {
  ContentBlockEvents,
  type ContentBlockEventType,
  AnyContentBlockStreamEventSchema,
  type AnyContentBlockStreamEvent,
} from '@tabtin/agent-wire'

import type { AgentStreamMessage, HandlerContext } from './streamHandlerTypes'
import { useSubagentLiveStore } from '../../../subagentLive'
import { feedInputJsonDelta } from './toolCallArgsBufferStore'
import {
  flushRuntimeBatch,
  TOOL_USE_PENDING_TOOL_CALL_ID,
  incrementDroppedEventCount,
} from '@/stores/useChatRuntimeStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { getCommittedBlocks } from '@/stores/chat/messages/messageBlocks'
import { bindActiveRun } from '@/stores/chat/execution/activeRunBinding'
import { resolveStreamingTurnAgentFace } from '../../shared/resolveStreamingTurnAgentId'
import { syncDerivedContentToChatMessage } from './syncMessageContent'
import { applyStreamingMessageDeltaUsage } from './streamTokenUsage'
import { applyTerminalToolResultUpdate } from './terminalToolResultUpdate'
import { createLogger } from '@/utils/logger'

/** ：assistant 建壳时从 session / selectedAgent 取本轮执行身份（不改 wire）。 */
function readStreamingTurnAgentFace(sessionId: string, messageAgentId?: string | null) {
  const chatState = useChatStore.getState() as {
    getSessionById?: (id: string) => {
      agent_id?: string | null
      agent_name?: string | null
      agent_avatar?: string | null
    } | undefined
    sessions?: Array<{
      id: string
      agent_id?: string | null
      agent_name?: string | null
      agent_avatar?: string | null
    }>
  }
  const session = chatState.getSessionById?.(sessionId)
    ?? chatState.sessions?.find((s) => s.id === sessionId)
  const selectedAgentId = useSpaceStore.getState().selectedAgent?.id ?? null
  return resolveStreamingTurnAgentFace({
    messageAgentId,
    sessionAgentId: session?.agent_id,
    sessionAgentName: session?.agent_name,
    sessionAgentAvatar: session?.agent_avatar,
    selectedAgentId,
  })
}

const log = createLogger('contentBlock')
const rawSubagentMessageToRunId = new Map<string, string>()

/**
 * 把 envelope 透平到 schema 期望的形态。
 *
 * Daemon emit 的 envelope（见 ElectronAgentHost streamHost.emit）形态是
 * `{ type: 'agent.stream.X', payload: {...} }`，而 schema 期望
 * `{ event_type: 'agent.stream.X', message_id, ... }` 平铺式。
 *
 * 本函数把 `{ type, payload }` 摊平：
 *   `{ event_type: type, ...payload }`
 *
 * 后向兼容 daemon 直接 emit 平铺 envelope 的场景（payload 缺省）。
 */
function flattenEnvelope(message: AgentStreamMessage): Record<string, unknown> {
  const eventType = message.type
  const payload = (message.payload ?? {}) as Record<string, unknown>
  return { event_type: eventType, ...payload }
}

/**
 * ：6 件套写入 store 的「单调排序 / 去重键」统一用 `arrival_seq`（事件源
 * 全局单调、IPC/WS 两路一致、Django relay 不覆盖），缺失时回落 `_seq`（老 daemon
 * / 单测）。
 *
 * 为什么不再直接用 `_seq`：IPC 路径 `_seq` 是 daemon envelope 序号，WS 路径
 * `_seq` 被 Django Redis INCR 覆盖成另一套序列。开启 IPC+WS 双路并存后，两路
 * 事件交错到达会让 `_seq` 非单调 → store 的 `seq <= prevSeq` 误丢有效事件。
 * `arrival_seq` 全局单调且两路一致，喂它即根治；retry（新 arrival_seq > prev）→
 * reset、WS replay（原 arrival_seq ≤ prev + finalized）→ reset 等既有语义不变。
 */
function resolveOrderingSeq(event: { arrival_seq?: number; _seq: number }): number {
  return typeof event.arrival_seq === 'number' ? event.arrival_seq : event._seq
}

function rawSubagentMessageKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`
}

function getRawSubagentRunId(
  event: AnyContentBlockStreamEvent,
  ctx: HandlerContext,
): string | undefined {
  const messageId = event.message_id
  const key = rawSubagentMessageKey(ctx.sessionId, messageId)
  // 子 Agent 身份现贴在**每个**流式事件上（envelope base 注入，见 EnvelopeEmitter）——
  // 任一 message/content_block 事件直接自识别，不再依赖「先收到 message_start 才能反查」
  // 的脆弱时序。顺带回填 map，兼容老 daemon 只在 message_start 带 id 的旧链路（其后续
  // content_block 事件不带时仍能从 map 反查）。
  const direct = (event as { subagent_run_id?: unknown }).subagent_run_id
  if (typeof direct === 'string' && direct) {
    rawSubagentMessageToRunId.set(key, direct)
    return direct
  }
  return rawSubagentMessageToRunId.get(key)
}

function routeRawSubagentContentBlock(
  event: AnyContentBlockStreamEvent,
  ctx: HandlerContext,
): boolean {
  const runId = getRawSubagentRunId(event, ctx)
  if (!runId) return false
  const { event_type: eventType, ...payload } = event as unknown as Record<string, unknown>
  useSubagentLiveStore.getState().applyChildEvent(
    runId,
    { type: eventType as string, payload },
    ctx.sessionId,
    [runId],
  )
  if (event.event_type === ContentBlockEvents.MESSAGE_STOP) {
    rawSubagentMessageToRunId.delete(rawSubagentMessageKey(ctx.sessionId, event.message_id))
  }
  return true
}

/**
 * 安全 zod parse；失败时 log + 返回 null，由 caller 决定 fallback。
 *
 * 严重错误（譬如 message_id 缺失）我们**不抛**——上层 dispatcher 不应该
 * 被一条坏事件中断；丢就丢，看 backend 修。
 *
 * **W4a 三轮 W4a-L4/L8 + 四轮 R4-8 修复——essential vs non-essential 分层 validator**：
 *
 * 老行为：zod safeParse 失败 → 整事件 drop。生产场景下 daemon emit 一个
 * 不在 schema 范围的新字段（譬如 W3 加 `text_summary` 但 wire 还没升级）
 * 会让整条 message_stop 丢失，UI 永远 finalized=false → spinner 不停。
 *
 * 新行为：
 *   1. 先做轻量 essential field 校验：
 *      - 所有事件：`event_type` + `message_id` + `_seq` 三项缺失 → drop
 *      - content_block_start：`block` 字段缺失或坏 → drop（不降级成 text 块——
 *        会让真 tool_use 块的 input 永远收不到，工具执行失败）；`index` 缺失/坏 → drop
 *      - content_block_delta：`delta` 字段缺失或坏 → drop；`index` 缺失/坏 → drop
 *      - content_block_stop：`index` 缺失/坏 → drop
 *   2. essential 通过则 zod safeParse 尝试完整解析：
 *      - 完整解析成功 → 走原路径
 *      - 完整解析失败 → 仅降级 envelope-level 字段（trace_id / thread_id /
 *        protocol_version / usage / stop_sequence / 自定义扩展字段）。**block / delta /
 *        index 等是 essential 子集——已在 Step 1 拦下不可能跑到这里**。
 *
 * 不在本函数里写：block_id_overrides parse 失败的容错——保留在
 * handleMessageStop 路径专门处理（更显式）。
 */
function safeParseEvent(message: AgentStreamMessage): AnyContentBlockStreamEvent | null {
  const flat = flattenEnvelope(message)

  // Step 1: essential field 校验
  if (typeof flat.event_type !== 'string' || flat.event_type.length === 0) {
    _incrementSchemaFail()
    log.warn('[contentBlock] essential field missing: event_type', { rawType: message.type })
    return null
  }
  if (typeof flat.message_id !== 'string' || flat.message_id.length === 0) {
    _incrementSchemaFail()
    log.warn('[contentBlock] essential field missing: message_id', { eventType: flat.event_type })
    return null
  }
  // _seq 允许 0（首条事件），但必须是非负整数
  if (typeof flat._seq !== 'number' || !Number.isFinite(flat._seq) || flat._seq < 0) {
    _incrementSchemaFail()
    log.warn('[contentBlock] essential field missing/invalid: _seq', {
      eventType: flat.event_type, messageId: String(flat.message_id).slice(0, 12),
    })
    return null
  }

  // ── W4a 四轮 R4-8：block / delta / index 字段升 essential ──
  //
  // 三轮的 _buildDegradedEvent 把 content_block_start 缺失 block 降级成
  // `{ type: 'text', text: '' }`——后续 input_json_delta 不识别 text 块，整
  // 个 tool input 丢失，tool 执行失败。这是比"整事件 drop"更严重的 silent bug。
  //
  // R4-8 决策：block / delta / index 与 event_type / message_id / _seq 同级
  // 是 essential——缺失或类型错 drop 整条事件（这条事件本来就不可用）。
  // 降级范围严格限定在 envelope-level 字段（trace_id / thread_id /
  // protocol_version / usage / stop_sequence / 自定义扩展字段）。
  const evType = flat.event_type as string
  if (
    evType === 'agent.stream.content_block_start'
    || evType === 'agent.stream.content_block_delta'
    || evType === 'agent.stream.content_block_stop'
  ) {
    if (typeof flat.index !== 'number' || !Number.isFinite(flat.index) || flat.index < 0) {
      _incrementSchemaFail()
      log.warn('[contentBlock] essential field invalid: index', {
        eventType: evType,
        messageId: String(flat.message_id).slice(0, 12),
        index: flat.index,
      })
      return null
    }
  }
  if (evType === 'agent.stream.content_block_start') {
    if (
      typeof flat.block !== 'object'
      || flat.block === null
      || typeof (flat.block as Record<string, unknown>).type !== 'string'
    ) {
      _incrementSchemaFail()
      log.warn('[contentBlock] essential field invalid: block', {
        eventType: evType,
        messageId: String(flat.message_id).slice(0, 12),
        blockShape: flat.block === null ? 'null' : typeof flat.block,
      })
      return null
    }
  }
  if (evType === 'agent.stream.content_block_delta') {
    if (
      typeof flat.delta !== 'object'
      || flat.delta === null
      || typeof (flat.delta as Record<string, unknown>).type !== 'string'
    ) {
      _incrementSchemaFail()
      log.warn('[contentBlock] essential field invalid: delta', {
        eventType: evType,
        messageId: String(flat.message_id).slice(0, 12),
        deltaShape: flat.delta === null ? 'null' : typeof flat.delta,
      })
      return null
    }
  }

  // Step 2: 完整 zod safeParse
  const result = AnyContentBlockStreamEventSchema.safeParse(flat)
  if (result.success) {
    return result.data
  }

  // Step 3: essential 通过、non-essential 失败 → 降级 fallback
  _incrementSchemaDegraded()
  log.warn('[contentBlock] schema parse degraded — non-essential field invalid, stub fallback', {
    eventType: flat.event_type,
    messageId: String(flat.message_id).slice(0, 12),
    issues: result.error.issues.slice(0, 3).map(i => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  })
  return _buildDegradedEvent(flat)
}

/**
 * 构造降级 fallback 事件——只填 essential 字段 + 当前 event_type 必需的最小
 * 集，让事件能进入 store CRUD 路径不丢，UI 至少能见到一条事件痕迹。
 *
 * 字段降级原则：
 *   - 必填字段保留（event_type / message_id / _seq）
 *   - block_id_overrides / usage / delta / block 这些 nice-to-have 字段
 *     若 parse 失败一律降级为合理空值（{}/undefined），让 store CRUD
 *     "看到完整结构"但不依赖该字段做关键决策
 */
function _buildDegradedEvent(flat: Record<string, unknown>): AnyContentBlockStreamEvent | null {
  const eventType = flat.event_type as string
  const messageId = flat.message_id as string
  const seq = flat._seq as number
  const traceId = (typeof flat.trace_id === 'string' ? flat.trace_id : 'unknown')
  const protocolVersion = (typeof flat.protocol_version === 'string' ? flat.protocol_version : 'v2') as 'v2'
  const minCompat = (typeof flat.min_compatible_version === 'string' ? flat.min_compatible_version : 'v2') as 'v2'
  const threadId = (typeof flat.thread_id === 'string' ? flat.thread_id : undefined)
  const base = {
    event_type: eventType,
    message_id: messageId,
    _seq: seq,
    trace_id: traceId,
    protocol_version: protocolVersion,
    min_compatible_version: minCompat,
    ...(threadId !== undefined ? { thread_id: threadId } : {}),
  }
  switch (eventType) {
    case 'agent.stream.message_start': {
      const role = (typeof flat.role === 'string' && (flat.role === 'assistant' || flat.role === 'user' || flat.role === 'system'))
        ? flat.role
        : 'assistant'
      const modelId = typeof flat.model_id === 'string' ? flat.model_id : undefined
      const modelName = typeof flat.model_name === 'string' ? flat.model_name : undefined
      const startedAt = typeof flat.started_at === 'string' ? flat.started_at : undefined
      const agentId = typeof flat.agent_id === 'string' && flat.agent_id.trim()
        ? flat.agent_id.trim()
        : undefined
      const subagentRunId = typeof flat.subagent_run_id === 'string' ? flat.subagent_run_id : undefined
      const runId = typeof flat.run_id === 'string' ? flat.run_id : undefined
      // **W2 协议升级（PRD §3.7.1）**：wire `MessageStartSchema.message_kind`
      // 必填三档（'llm' / 'tool_artifact' / 'error_envelope'）。degraded 路径
      // 也必须透传——否则 daemon-synthesized envelope 走降级回退时 message_kind
      // 丢失，下游 handleMessageStart 识别"daemon 合成 vs LLM 真实输出"失效。
      // 缺失时不填字段；handleMessageStart 在读出 undefined 时 fallback 到 'llm'
      // （保守按主 LLM 路径处理，至少不会误触跳过逻辑）。
      const messageKind = typeof flat.message_kind === 'string'
        && (flat.message_kind === 'llm' || flat.message_kind === 'tool_artifact' || flat.message_kind === 'error_envelope')
          ? flat.message_kind
          : undefined
      return {
        ...base,
        role,
        ...(modelId !== undefined ? { model_id: modelId } : {}),
        ...(modelName !== undefined ? { model_name: modelName } : {}),
        ...(startedAt !== undefined ? { started_at: startedAt } : {}),
        ...(agentId !== undefined ? { agent_id: agentId } : {}),
        ...(subagentRunId !== undefined ? { subagent_run_id: subagentRunId } : {}),
        ...(runId !== undefined ? { run_id: runId } : {}),
        ...(messageKind !== undefined ? { message_kind: messageKind } : {}),
      } as unknown as AnyContentBlockStreamEvent
    }
    case 'agent.stream.message_delta': {
      const delta = (typeof flat.delta === 'object' && flat.delta !== null) ? flat.delta : {}
      return { ...base, delta } as unknown as AnyContentBlockStreamEvent
    }
    case 'agent.stream.message_stop': {
      // block_id_overrides parse 失败 → 降级为 undefined（W4a-L8 修复）
      return base as unknown as AnyContentBlockStreamEvent
    }
    case 'agent.stream.content_block_start': {
      // W4a 四轮 R4-8：block / index 已在 essential 校验阶段验证；这里保留真值，
      // 不再降级为 text 块（早期 R4-8 修复前的行为会让 tool_use 块的 input
      // 永远收不到，整个 tool 执行失败）。
      const index = flat.index as number
      const block = flat.block as Record<string, unknown>
      const blockId = typeof flat.block_id === 'string' && flat.block_id.length > 0
        ? flat.block_id
        : `degraded-${messageId}-${index}`
      return { ...base, index, block_id: blockId, block } as unknown as AnyContentBlockStreamEvent
    }
    case 'agent.stream.content_block_delta': {
      // W4a 四轮 R4-8：delta / index 已在 essential 校验阶段验证；保留真值。
      const index = flat.index as number
      const delta = flat.delta as Record<string, unknown>
      return { ...base, index, delta } as unknown as AnyContentBlockStreamEvent
    }
    case 'agent.stream.content_block_stop': {
      // W4a 四轮 R4-8：index 已在 essential 校验阶段验证；保留真值。
      const index = flat.index as number
      return { ...base, index } as unknown as AnyContentBlockStreamEvent
    }
    default:
      return null
  }
}

/**
 * Metric stampers —— 桥接 useChatRuntimeStore.getDroppedEventCount()。
 * 单测 mock 掉 store 时该函数缺失，安全 fallback 为 noop。
 */
function _incrementSchemaFail(): void {
  try {
    incrementDroppedEventCount('schemaParseFail')
  } catch {
    /* noop in test */
  }
}
function _incrementSchemaDegraded(): void {
  try {
    incrementDroppedEventCount('schemaParseDegraded')
  } catch {
    /* noop in test */
  }
}

/**
 * 主入口：6 件套事件分发。
 *
 * `streamMessageHandler` 总分发器在判断 `isContentBlockEvent(type)` 后调本函数。
 * 本函数内**只**用 event_type 做 switch（schema discriminator 自动收窄）——
 * 没有"字段存在性"判断 / 没有"老协议兼容"分支。
 */
/**
 * W4a 三轮 B-P1：dispatch 路径 performance.mark 埋点。
 *
 * 用途：W4b 用 chrome devtools performance panel 看每条事件 dispatch 耗时
 * 分布；线上崩盘投诉时让用户上传 trace 直接定位"哪条 cb_delta 卡了 50ms"。
 *
 * 生产构建保留 —— performance API native 调用 < 1µs，无可观测开销。
 */
function _perfMark(name: string): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
  try {
    performance.mark(name)
  } catch {
    /* defensive */
  }
}

export function handleContentBlockEvent(message: AgentStreamMessage, ctx: HandlerContext): void {
  _perfMark('[contentBlocks] dispatch:start')
  const event = safeParseEvent(message)
  if (!event) {
    _perfMark('[contentBlocks] dispatch:end')
    return
  }
  // 防线：子 Agent 原始 6 件套若因 host/sink 路径直接进了父 stream，不能创建父
  // ChatMessage / thinking step；只写入子 Agent live store，供详情 Pane 使用。
  if (routeRawSubagentContentBlock(event, ctx)) {
    _perfMark('[contentBlocks] dispatch:end')
    return
  }

  switch (event.event_type) {
    case ContentBlockEvents.MESSAGE_START:
      handleMessageStart(event, ctx)
      break
    case ContentBlockEvents.MESSAGE_DELTA:
      handleMessageDelta(event, ctx)
      break
    case ContentBlockEvents.MESSAGE_STOP:
      handleMessageStop(event, ctx)
      break
    case ContentBlockEvents.CONTENT_BLOCK_START:
      handleContentBlockStart(event, ctx)
      break
    case ContentBlockEvents.CONTENT_BLOCK_DELTA:
      handleContentBlockDelta(event, ctx)
      break
    case ContentBlockEvents.CONTENT_BLOCK_STOP:
      handleContentBlockStop(event, ctx)
      break
    default: {
      // discriminator 已穷举；这里是 TS exhaustive guard
      const _exhaustive: never = event
      void _exhaustive
    }
  }
  _perfMark('[contentBlocks] dispatch:end')
}

// ─── 6 个单 case handler（薄翻译层）─────────────────────────────────

/**
 * Placeholder thinking agentStep 的 stable id。
 *
 * W4a 三轮 A-P0-3：所有模型 message_start 时无条件 push 一条"思考中…"占位
 * step；第一条 content_block_start 到达时按 block.type 决定升级或删除。
 * 这样 GPT-4o（不发 thinking_delta）的用户也能在 0.5-3s 等待期看到反馈，
 * 不再面对纯空白屏幕。
 */
function thinkingPlaceholderStepId(messageId: string): string {
  return `thinking-placeholder-${messageId}`
}

function contentBlockStartedAt(event: AnyContentBlockStreamEvent): string | undefined {
  const value = (event as unknown as { started_at?: unknown }).started_at
  return typeof value === 'string' && value ? value : undefined
}

function contentBlockRunId(event: AnyContentBlockStreamEvent): string | undefined {
  const value = (event as unknown as { run_id?: unknown; subagent_run_id?: unknown }).run_id
    ?? (event as unknown as { run_id?: unknown; subagent_run_id?: unknown }).subagent_run_id
  return typeof value === 'string' && value ? value : undefined
}

function fallbackMessageKind(event: AnyContentBlockStreamEvent): ChatMessage['message_kind'] {
  const explicit = (event as unknown as { message_kind?: unknown }).message_kind
  if (explicit === 'llm' || explicit === 'tool_artifact' || explicit === 'error_envelope') return explicit
  if (
    event.event_type === ContentBlockEvents.CONTENT_BLOCK_START
    && event.block.type === 'tabtin_rich_content'
  ) {
    return 'tool_artifact'
  }
  return 'llm'
}

function isUserMessageCarrier(ctx: HandlerContext, messageId: string): boolean {
  return ctx.get().messageMetaBySessionId[ctx.sessionId]?.[messageId]?.role === 'user'
}

function ensureAssistantMessageContainer(
  ctx: HandlerContext,
  event: AnyContentBlockStreamEvent,
): void {
  const messageId = event.message_id
  if (!messageId) return
  const meta = ctx.get().messageMetaBySessionId[ctx.sessionId]?.[messageId]
  if (meta?.role && meta.role !== 'assistant') return
  if (event.event_type === ContentBlockEvents.CONTENT_BLOCK_START && event.block.type === 'tool_result') return
  const startedAt = contentBlockStartedAt(event)
  const createdAt = startedAt && !Number.isNaN(Date.parse(startedAt))
    ? new Date(startedAt).toISOString()
    : new Date().toISOString()
  const runId = contentBlockRunId(event)
  const turnAgentFace = readStreamingTurnAgentFace(ctx.sessionId)
  const newMsg: ChatMessage = {
    id: messageId,
    role: 'assistant',
    content: '',
    created_at: createdAt,
    message_kind: fallbackMessageKind(event),
    content_blocks_json: [],
    ...(runId ? { agent_run_id: runId } : {}),
    ...(turnAgentFace.agentId ? { agent_id: turnAgentFace.agentId } : {}),
    ...(turnAgentFace.agentName ? { agent_name: turnAgentFace.agentName } : {}),
    ...(turnAgentFace.agentAvatar ? { agent_avatar: turnAgentFace.agentAvatar } : {}),
  }
  useChatStore.getState().ensureAssistantMessage(ctx.sessionId, newMsg)
}

function handleMessageStart(
  event: Extract<AnyContentBlockStreamEvent, { event_type: 'agent.stream.message_start' }>,
  ctx: HandlerContext,
): void {
  log.debug('← message_start', {
    session: ctx.sessionId.slice(0, 8),
    msgId: event.message_id.slice(0, 12),
    role: event.role,
    model: event.model_id,
  })
  ctx.get().messageStart(
    ctx.sessionId,
    event.message_id,
    {
      role: event.role,
      model_id: event.model_id,
      model_name: event.model_name,
      started_at: event.started_at,
      subagent_run_id: event.subagent_run_id,
    },
    resolveOrderingSeq(event),
  )

  // ── W2 协议升级（PRD §3.7.1）：识别 daemon-synthesized envelope ──
  //
  // **单源契约**：wire `MessageStartSchema.message_kind` 必填三档枚举
  // （`'llm' | 'tool_artifact' | 'error_envelope'`）替换旧的
  // `model_id === 'tabtin-tool-runtime'` 字面量 + `synthetic === true` 双重
  // 隐式判别 hack。daemon `emitDetachedMiniMessage` 永远标 `'tool_artifact'`；
  // `emitAssistantErrorMessageEnvelope` 标 `'error_envelope'`；主循环 /
  // stall retry 标 `'llm'`。判别逻辑改为 `message_kind !== 'llm'` 单源。
  //
  // **缺失兜底**：理论上 wire schema 必填 message_kind，缺失会 zod parse fail；
  // 极端 degraded 路径若 message_kind 也丢失（_buildDegradedEvent 看到原始
  // payload 缺字段），按 `'llm'` 保守处理（主 LLM 路径，至少不会误把真 LLM
  // 输出当 mini-message 吞掉 thinking placeholder）。
  //
  // **建 ChatMessage 气泡的拆分**（富内容呈现重建 阶段 0 P0）：
  //   1. 所有 role='assistant' message（包括 tool_artifact / error_envelope）
  //      **都要建**——产物气泡 / 错误文案气泡都需要 ChatMessage 容器承载。
  //   2. **thinking placeholder**：仅 message_kind='llm' 路径需要（工具产出
  //      / 错误文案旁边不该有"思考中…"spinner）。
  const messageKind = (event as { message_kind?: 'llm' | 'tool_artifact' | 'error_envelope' }).message_kind ?? 'llm'
  const isDaemonSynthesized = messageKind !== 'llm'

  // ── W4.5 §服务端 ID 命名空间统一：每个 daemon message_start 即时建 ChatMessage ──
  //
  // **关键设计**：daemon emit 的 message_id 直接作为前端 ChatMessage.id 用——
  // 前端不再预建 `temp-ai-XXX` placeholder，多轮 LLM call 自然变成多条 ChatMessage
  // （与 Django reassembler `_create_chat_message_from_reassembler_state` 落库
  // 的 `id=uuid_mod.UUID(message_id)` 严格对齐）。`useContentBlocks(sid, message.id)`
  // 流式期间和历史回放走同一份 store key，BlockTimeline 实时渲染零 ID 翻译层。
  //
  // 仅 role='assistant'：user 消息走 sendMessageAction.ts 主路径预建（带
  // attachments / sendStatus 等本地交互态字段），不应被 content_block 路径覆盖。
  //
  // **tool_artifact / error_envelope 同样要建**——它们走"产物气泡"紧凑形态 /
  // "错误文案"简化形态（MessageBubble 按 `message.message_kind` 切换 footer
  // 矩阵，详见 PRD §3.7.2），但 ChatMessage 容器本身必须存在，BlockTimeline
  // 才能挂载 tabtin_rich_content block / 错误文案 text block。
  //
  // **幂等**：同 message_id 重发（IPC vs WS 双源 / WS replay）时不会重复 push——
  // updateSessionMessages 内查重，看到已有同 id 的 message 直接 return prev。
  if (event.role === 'assistant') {
    {
      // 消息级 agent_id 是跨端/历史权威；旧事件缺省时才回退本地 session 指针。
      const eventAgentId = (event as { agent_id?: string }).agent_id?.trim()
      const turnAgentFace = readStreamingTurnAgentFace(ctx.sessionId, eventAgentId)
      const newMsg: ChatMessage = {
        id: event.message_id,
        role: 'assistant',
        content: '',
        created_at: new Date(event.started_at ?? Date.now()).toISOString(),
        // W2 协议升级（PRD §3.7.1）：ChatMessage 上冗余记录 `message_kind` 让
        // MessageBubble / MessageList 走 message_kind switch UI 形态——流式
        // 实时路径与历史回放（API 拉回）字段对齐，避免"流式期间走 message_kind
        // / 历史期间走另一字段"的双轨判别。
        message_kind: messageKind,
        // model_id 仍然冗余记录（与 API ChatMessageSchema 字段对齐 + 兼容老
        // 数据），但**业务判别不再依赖此字段**——走 message_kind 单源契约。
        model_id: event.model_id,
        // BlockTimeline 渲染从 useContentBlocks 拿数据；这里 content_blocks_json
        // 留空，由 handleContentBlockStop 在每个 block stop 时同步快照——保证
        // 历史回放（store evict 后从 ChatMessage 加载）也能看到所有 blocks。
        content_blocks_json: [],
        // per-file 回退锚点修复：assistant message 的 agent_run_id 必须落「主轮
        // run_id」。wire MessageStartSchema.run_id 必填（min 1），主 Agent 实时事件
        // 一定带；旧实现只取 subagent_run_id（仅子 Agent 有）→ 主 Agent 消息
        // agent_run_id 为空 → resolveRewindAnchorId 返 null → 回退预览误判「无历史
        // 版本可恢复」（LocalAgent 宿主实时聚合路径专属断点，刷新走 API 重载才有值）。
        //
        // 注：子 Agent message 实时已被 routeRawSubagentContentBlock 截到 subagent
        // live store（不进 messagesBySessionId），故走到此处的恒为主 Agent；
        // subagent_run_id 仅作防御兜底（历史回放经 API 加载的子 Agent 消息由后端
        // 落 agent_run_id，不经此路径）。messagesBySessionId 权威写入即此处——
        // messageStart action 只写 runtime store 的 streaming meta，不碰它。
        ...((event.subagent_run_id ?? event.run_id)
          ? { agent_run_id: event.subagent_run_id ?? event.run_id }
          : {}),
        ...(turnAgentFace.agentId ? { agent_id: turnAgentFace.agentId } : {}),
        ...(turnAgentFace.agentName ? { agent_name: turnAgentFace.agentName } : {}),
        ...(turnAgentFace.agentAvatar ? { agent_avatar: turnAgentFace.agentAvatar } : {}),
      }
      useChatStore.getState().ensureAssistantMessage(ctx.sessionId, newMsg)
      // ：主 Agent message_start 写入 ActiveRunBinding（中断归因身份）。
      if (!event.subagent_run_id) {
        bindActiveRun(ctx.sessionId, {
          runId: event.run_id,
          assistantMessageId: event.message_id,
        })
      }
    }
  }

  // ── W4a 三轮 A-P0-3：仅主 LLM 路径 push "思考中…" placeholder agentStep ──
  //
  // 背景：GPT-4o / DeepSeek 等不支持 thinking 模型，daemon 不发 thinking_delta
  // → contentBlockHandler 不会 mirror agentStep → MessageSteps 流式期间 0
  // 步骤显示 → 用户每次发消息后 0.5-3s 看到的是纯空白屏幕。
  //
  // 修法：message_start 时给所有**主 LLM** 模型 push 一条占位 thinking step；
  // 首个 content_block_start 到达时（handleContentBlockStart）按 block.type 决定：
  //   - block.type === 'thinking'：placeholder 保留并升级为真 thinking step
  //     （直接用同一 stepId 让 update 路径无缝衔接）
  //   - block.type === 'text' / 'tool_use' / ...：placeholder finalize 为
  //     status='done'（让 spinner 停下；不直接删，保留"刚才在思考"的视觉痕迹）
  //
  // **跳过 daemon-synthesized**：mini-message 是工具产出（无 LLM 思考过程），
  // synthetic error envelope 是错误文案（也无思考过程），旁边都不该挂 spinner。
  if (event.role === 'assistant' && !isDaemonSynthesized) {
    const stepId = thinkingPlaceholderStepId(event.message_id)
    ctx.get().pushAgentStepForSession(ctx.sessionId, {
      id: stepId,
      type: 'thinking',
      title: 'Thinking…',
      status: 'running',
      timestamp: Date.now(),
    })
  }
}

function handleMessageDelta(
  event: Extract<AnyContentBlockStreamEvent, { event_type: 'agent.stream.message_delta' }>,
  ctx: HandlerContext,
): void {
  log.debug('← message_delta', {
    session: ctx.sessionId.slice(0, 8),
    msgId: event.message_id.slice(0, 12),
    stop_reason: event.delta.stop_reason,
  })
  const accepted = ctx.get().messageDelta(ctx.sessionId, event.message_id, event.delta, event.usage, resolveOrderingSeq(event))

  //  token 用量实时更新：每次 LLM 调用结束的 message_delta 带 per-call
  // usage（cumulative）——实时写 usage_json（上下文环 anchor）+ 增量累加 session
  // 缓存，不再等 turn 结束的 DONE。发起端与观察端走同一路径。
  // 只在 store 接受本条 delta 时同步——被 seq/finalized 防御 drop 的 late/replay
  // 事件（如 finalize 后 daemon retry 重发）不能再进 token 路径，否则 DONE 清空
  // lastSeen 后同一 usage 会被当新增量二次入账。
  if (accepted && event.usage) {
    applyStreamingMessageDeltaUsage(ctx.sessionId, event.message_id, event.usage)
  }
}

function handleMessageStop(
  event: Extract<AnyContentBlockStreamEvent, { event_type: 'agent.stream.message_stop' }>,
  ctx: HandlerContext,
): void {
  // W4.5 第二波 P0-1（2026-05-12）：透传 daemon emit 的 error_info.partial_reason
  // 真信号——abort / runtime error / stall retry 路径 daemon 显式标三档之一，
  // 比客户端启发式推断准（譬如 stall retry 只有 daemon 自己知道是"主动收尾兜底"
  // 应标 'message_stop_fallback'，客户端从 stop_reason 反推会误判为
  // 'stream_interrupted'）。daemon 缺省时 partialReason 保持 undefined，由
  // store messageStop 内部的 prevMeta.stop_reason 启发式（'aborted' ↔ 'aborted'
  // / 其他 ↔ 'message_stop_fallback'）兜底——与历史 daemon 版本向后兼容。
  const partialReason = event.error_info?.partial_reason

  log.debug('← message_stop', {
    session: ctx.sessionId.slice(0, 8),
    msgId: event.message_id.slice(0, 12),
    persistedId: event.persisted_id?.slice(0, 12),
    overrides: event.block_id_overrides ? Object.keys(event.block_id_overrides).length : 0,
    partialReason: partialReason ?? '(none, fall back to heuristic)',
  })
  // 透传 persisted_id（W3 启用后用于 DB 主键对账）和 block_id_overrides（W3
  // 落库后回灌的真 UUID，store 按 index 替换 block_id 让 W4b React key 稳定）。
  ctx.get().messageStop(ctx.sessionId, event.message_id, resolveOrderingSeq(event), {
    persistedId: event.persisted_id,
    blockIdOverrides: event.block_id_overrides,
    // W4.5 第二波 P0-1：daemon 真信号覆盖 watchdog 客户端推断。
    // 注意：watchdog 路径自己调 `messageStop({ partialReason: 'stream_interrupted' })`
    // 显式传值——和这条路径互不冲突（watchdog 是客户端独立 timer 触发的兜底，
    // 没有 daemon emit event，本 handler 永远不会被它进入）。
    ...(partialReason ? { partialReason } : {}),
  })

  // ：终止反馈正典源——把 message_stop.error_info 同步到 ChatMessage.error_info_json，
  // 与 Django reassembler 落库字段一致；切会话 / 历史回放不依赖 DONE→metadata。
  if (event.error_info && typeof event.error_info === 'object') {
    useChatStore.getState().patchMessageById(ctx.sessionId, event.message_id, (m) => ({
      ...m,
      error_info_json: event.error_info as Record<string, unknown>,
    }))
  }

  // W4a 三轮 A-P0-3：message_stop 时兜底 finalize thinking placeholder。
  // 极端场景下 message_start → 立即 abort/timeout，从来没有 cb_start 到达——
  // 此时 placeholder 仍 running、spinner 永远转。这里把它强制收尾。
  const placeholderId = thinkingPlaceholderStepId(event.message_id)
  const steps = ctx.get().agentStepsBySessionId[ctx.sessionId] ?? []
  const placeholder = steps.find(s => s.id === placeholderId)
  if (placeholder && placeholder.status === 'running') {
    ctx.get().updateAgentStepForSession(ctx.sessionId, placeholderId, {
      status: 'done',
      durationMs: Date.now() - placeholder.timestamp,
    })
  }

  // ── W4.5 §服务端 ID 命名空间统一：message_stop 同步 ChatMessage.content_blocks_json 快照 ──
  //
  // **设计理由**：BlockTimeline 渲染走 `useContentBlocks(sid, message.id)`，
  // 数据来自 useChatRuntimeStore.contentBlocksBySessionId[sid][message_id]——
  // 这是流式期间的 in-memory 路径。但是：
  //   1. **session evict / Electron 重启** → useChatRuntimeStore 内存清空，
  //      MessageBubble 走 `legacyBlocksAdapter` fallback 读 `message.content_blocks_json`
  //   2. **历史回放**（用户切回之前的 session）→ messagesBySessionId 从云端拉，
  //      ChatMessage.content_blocks_json 是 daemon 6 件套累积出的最终形态
  //
  // 修法：message_stop 时把 store 内 finalize 后的 ContentBlockEntry[] 转成
  // ChatMessage 的 MessageBlock[] 形态写到 content_blocks_json，让 fallback 路径
  // 与流式实时路径数据一致。**只在 finalize 后写**——每个 content_block_stop 写
  // 太频繁，且 partial state 写入容易跟流式期 useContentBlocks 渲染冲突。
  //
  // 仅 role='assistant'：user 消息走 sendMessageAction 主路径预建 + relay 持久化，
  // 不应被 content_block 路径覆盖。
  flushRuntimeBatch()
  syncDerivedContentToChatMessage(ctx.sessionId, event.message_id)
}

function handleContentBlockStart(
  event: Extract<AnyContentBlockStreamEvent, { event_type: 'agent.stream.content_block_start' }>,
  ctx: HandlerContext,
): void {
  log.debug('← content_block_start', {
    session: ctx.sessionId.slice(0, 8),
    msgId: event.message_id.slice(0, 12),
    index: event.index,
    blockId: event.block_id.slice(0, 12),
    type: event.block.type,
  })
  // ：后台命令终态 `_terminal_update` mini-message 的 tool_result 块——
  // 在被 ensureAssistantMessageContainer 的早退（role!=assistant / tool_result）
  // 丢弃之前，先把终态 content 原地 upsert 进既有 tool event，live 卡片
  // （MediaImageInlineCard / TerminalCard）免重载显示真实终态。
  if (event.block.type === 'tool_result') {
    applyTerminalToolResultUpdate(event.block, ctx)
  }
  // 后台终态 mini-message 用 role=user 携带 tool_result，只负责原地更新既有
  // 工具卡，不对应一条可展示 ChatMessage。若继续写 ContentBlock，stop 前 flush
  // 会因没有消息壳丢掉 start，随后产生 "stop without matching start" 空状态。
  if (isUserMessageCarrier(ctx, event.message_id)) return
  ensureAssistantMessageContainer(ctx, event)
  // 把 daemon emit 时分配的权威 arrival_seq(,envelope 级)挂到 block 上,
  // 让 runtime / 落库 / 历史回放用同一组数字。缺失(老 daemon)时由 store 回落本地微秒。
  const eventArrival = (event as { arrival_seq?: number }).arrival_seq
  const blockWithArrival = typeof eventArrival === 'number'
    ? ({ ...event.block, arrival_seq: eventArrival } as unknown as typeof event.block)
    : event.block
  ctx.get().contentBlockStart(
    ctx.sessionId,
    event.message_id,
    event.index,
    event.block_id,
    blockWithArrival,
    resolveOrderingSeq(event),
  )

  // ── W4a 三轮 A-P0-3：首个 cb_start 到达时处理 thinking placeholder ──
  //
  // 检查这是不是第一个块（index === 0）—— 只有首块到达时才升级或 finalize
  // placeholder；后续块（index > 0）跳过避免误清。
  //
  // 升级 vs finalize：
  //   - block.type === 'thinking'：用同一个 stepId（thinking-${msgId}-${index}）
  //     重新 push 真 thinking step（同 id 触发幂等 update，placeholder 平滑过渡）；
  //     不动 placeholder（让下面的 thinking 镜像逻辑接管同 id）。
  //   - 非 thinking：placeholder finalize 为 status='done'（让 UI spinner 停，
  //     保留 timeline 痕迹）。
  if (event.index === 0) {
    const placeholderId = thinkingPlaceholderStepId(event.message_id)
    const steps = ctx.get().agentStepsBySessionId[ctx.sessionId] ?? []
    const placeholder = steps.find(s => s.id === placeholderId)
    if (placeholder && placeholder.status === 'running') {
      if (event.block.type !== 'thinking') {
        ctx.get().updateAgentStepForSession(ctx.sessionId, placeholderId, {
          status: 'done',
          durationMs: Date.now() - placeholder.timestamp,
        })
      }
      // thinking 块：placeholder 留着不动——下面 mirror 逻辑会按
      // thinking-${msgId}-0 push 一条新 step。两个 id 不同，两条 step 共存：
      //   - placeholder（thinking-placeholder-${msgId}）：'思考中…' 占位
      //   - 真 thinking step（thinking-${msgId}-0）：累积 thinking_delta
      // cb_stop 时 placeholder 也要 finalize，避免 spinner 两边都转——
      // 见 handleContentBlockStop 内 thinking 路径同步 finalize placeholder。
    }
  }
  // Widget 子系统接续（v2 §3.5.1.b 多 message 并发场景的兼容）：tool_use 块
  // 的 placeholder 创建在新协议下迁移到 content_block_start——start 事件已经
  // 知道 tool_name 和 block.id（LLM 给的 toolu_*/call_* 原生 id，v2 §2.2.1 红线），
  // 比原 streamMessageHandler 的"首条 delta 时建 placeholder"语义更早一拍，
  // UI 用户更早看到 widget 卡片占位。
  if (event.block.type === 'tool_use' && event.block.name === 'show_widget') {
    const toolCallId = event.block.id
    ctx.get().upsertRichContentBlocksByToolCallId(ctx.sessionId, [
      {
        type: 'rich_content',
        kind: 'widget',
        widget_id: `pending:${toolCallId}`,
        tool_call_id: toolCallId,
        format: 'svg',
        summary: '',
      },
    ])
  }
  // ── W4a R2-P0-2：tabtin_rich_content 块镜像到 richContentBlocksBySessionId ──
  //
  // daemon 通过 `emitDetachedMiniMessage` 把工具产出的富内容 emit 成一个独
  // 立的 5 件套 mini-message（content_block_start.block.type='tabtin_rich_content'）。
  // W4.5 第二波 B2 把老 `agent.stream.rich_content` 协议事件物理删后，本镜像
  // 路径成为富内容卡片在流式期间渲染到 `richContentBlocksBySessionId` 的
  // **唯一**入口。
  //
  // **形态摊平**：daemon block 是
  //   { type: 'tabtin_rich_content', kind, summary, group_id?, payload? }
  // 工具实际把 widget_id / format / code / image_url / tool_call_id 全塞在
  // `payload` 嵌套层（show-widget.ts:325）。但 RichContentRenderer 的
  // RichContentBlock 类型期望这些字段在顶层。所以 mirror 时把 payload 字段
  // 摊平到顶层（与持久化层 BlockItem(type='rich_content') 等价）。
  //
  // **tool_call_id 提升**：upsertRichContentBlocksByToolCallId 按顶层
  // `tool_call_id` 关联 placeholder 替换；从 payload.tool_call_id 提升到顶层
  // 才能正确替换 widget tool_use 阶段建的 `pending:` 占位。
  if (event.block.type === 'tabtin_rich_content') {
    const block = event.block as unknown as Record<string, unknown>
    const payloadInner = (block.payload && typeof block.payload === 'object')
      ? block.payload as Record<string, unknown>
      : {}
    const mirrored: Record<string, unknown> = {
      type: 'rich_content',
      kind: block.kind,
      summary: block.summary,
      ...(block.group_id ? { group_id: block.group_id } : {}),
      ...payloadInner, // widget_id / format / code / image_url / tool_call_id / ...
    }
    ctx.get().upsertRichContentBlocksByToolCallId(ctx.sessionId, [mirrored])
  }

  // ── W4a R2-P1-4 升 P0：thinking 块镜像到 agentStepsBySessionId ──
  //
  // 老协议下 STEP(step_type='thinking') 由 toolHandler.handleStep 写入
  // agentStepsBySessionId 让 MessageSteps 显示"Thinking…"卡片。W4a 删 STEP
  // 分发 + daemon 同时 emit thinking content_block，但 MessageSteps 流式期
  // 间只读 agentStepsBySessionId（不读 contentBlocksBySessionId），所以
  // thinking 流式期间用户完全看不到。本桥镜像一条 type='thinking' agentStep
  // —— content_block_start 时 push（status='running'），delta 累积时不更新
  // title 避免过度抖动，stop 时 update status='done' + durationMs。
  if (event.block.type === 'thinking') {
    const stepId = `thinking-${event.message_id}-${event.index}`
    ctx.get().pushAgentStepForSession(ctx.sessionId, {
      id: stepId,
      type: 'thinking',
      title: 'Thinking…',
      status: 'running',
      timestamp: Date.now(),
    })
  }
}

function handleContentBlockDelta(
  event: Extract<AnyContentBlockStreamEvent, { event_type: 'agent.stream.content_block_delta' }>,
  ctx: HandlerContext,
): void {
  if (isUserMessageCarrier(ctx, event.message_id)) return
  // 大量 token，不打 debug log（W2 silent bypass 教训 + widget 1000 token/s 经验）
  ensureAssistantMessageContainer(ctx, event)
  ctx.get().contentBlockDelta(
    ctx.sessionId,
    event.message_id,
    event.index,
    event.delta,
    resolveOrderingSeq(event),
  )

  // Widget 子系统接续：input_json_delta 同步喂 widget streaming buffer。
  // 当前 ContentBlock 已经在上面写到 store —— 从 store 读 entry 拿 toolCallId/toolName，
  // 然后 feedInputJsonDelta 把 partial_json 累积进 buffer，触发 RichWidget 等订阅者的
  // streaming 渲染（widget 1000 token/s 通过 in-memory Map 走，不走 Zustand 重渲染）。
  //
  // **关键 id 选择**：用 `entry.block.id`（LLM 给的 toolu_*/call_* 原生 id），
  // **不是** `entry.block_id`（envelope 层的 daemon React key）。理由（v2 §2.2.1 红线）：
  //   - widget 子系统 buffer 的 lookup key 与 tabtin_rich_content block 内
  //     `payload.tool_call_id` 配对（show-widget.ts 写入），都是 LLM 原生 id；
  //   - show-widget.ts 的 tool_call_id_finder 也用 LLM 原生 id 反查。
  if (event.delta.type === 'input_json_delta') {
    const messageBlocks = getCommittedBlocks(ctx.sessionId, event.message_id) ?? []
    const entry = messageBlocks.find(e => e.index === event.index)
    if (entry && (entry.block.type === 'tool_use' || entry.block.type === 'server_tool_use' || entry.block.type === 'mcp_tool_use')) {
      const toolCallId = entry.block.id
      // ── W4a 三轮 A-P0-2：__pending__ placeholder 跳过 widget buffer 写入 ──
      //
      // placeholder.block.id 是 sentinel，不是真 toolCallId；如果调
      // feedInputJsonDelta(sessionId, '__pending__', ...) 会写到孤儿 buffer，
      // 真 cb_start 到达后无法关联 → 早期 token 丢失。store 内 contentBlockDelta
      // 已把 partial_json 暂存到 entry._pendingInputJsonFragments，等真 cb_start
      // 触发 replay。本路径只跳过即可。
      if (toolCallId === TOOL_USE_PENDING_TOOL_CALL_ID) return
      const toolName = entry.block.name ?? ''
      feedInputJsonDelta(ctx.sessionId, toolCallId, toolName, event.delta.partial_json)
    }
  }
}

function handleContentBlockStop(
  event: Extract<AnyContentBlockStreamEvent, { event_type: 'agent.stream.content_block_stop' }>,
  ctx: HandlerContext,
): void {
  log.debug('← content_block_stop', {
    session: ctx.sessionId.slice(0, 8),
    msgId: event.message_id.slice(0, 12),
    index: event.index,
  })

  if (isUserMessageCarrier(ctx, event.message_id)) return

  // ── W4a R2-P1-4 升 P0：stop 时把 thinking 块对应的 agentStep 置完成态 ──
  //
  // 流式累积的 thinking_delta 走 rAF batch（_pendingContentBlocks），到 stop
  // 时已提交块（messages 层）还没合并最新 text。这里**强制 flush** 一次，把
  // pending 提前 commit，然后再读 entry 拿完整 thinking text 写 step.detail。
  // flush 是同步的、幂等的——多次调用无副作用。
  flushRuntimeBatch()
  const messageBlocks = getCommittedBlocks(ctx.sessionId, event.message_id) ?? []
  const entry = messageBlocks.find(e => e.index === event.index)
  if (entry?.block.type === 'thinking') {
    const stepId = `thinking-${event.message_id}-${event.index}`
    const thinkingText = entry.block.thinking ?? ''
    const detail = thinkingText.length > 200 ? thinkingText.slice(0, 200) + '...' : thinkingText
    ctx.get().updateAgentStepForSession(ctx.sessionId, stepId, {
      status: 'done',
      detail: detail || undefined,
    })
    // W4a 三轮 A-P0-3：thinking 块 stop 时同步 finalize placeholder
    // （防止 placeholder spinner 永远转）。仅当 placeholder 还在 running
    // 才置 done——避免幂等覆盖已经被 cb_start 路径 finalize 过的 step。
    if (event.index === 0) {
      const placeholderId = thinkingPlaceholderStepId(event.message_id)
      const steps = ctx.get().agentStepsBySessionId[ctx.sessionId] ?? []
      const placeholder = steps.find(s => s.id === placeholderId)
      if (placeholder && placeholder.status === 'running') {
        ctx.get().updateAgentStepForSession(ctx.sessionId, placeholderId, {
          status: 'done',
          durationMs: Date.now() - placeholder.timestamp,
        })
      }
    }
  }

  ctx.get().contentBlockStop(ctx.sessionId, event.message_id, event.index, resolveOrderingSeq(event))
}

// 重新导出 ContentBlockEventType 方便消费方做 type guard
export type { ContentBlockEventType }
