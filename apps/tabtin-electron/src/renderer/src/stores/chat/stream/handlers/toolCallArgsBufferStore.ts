/**
 * Tool-use input_json_delta 流式累积器（Wave 4a 重构后）。
 *
 * 业务目标：让前端能逐 token 拿到 LLM 流式吐 tool_use args 的 partial input。
 *
 * **Wave 4a 重构说明**：本文件原先消费老协议 `agent.stream.tool_call_args_delta`
 * 事件。Wave 4a 切换到 Anthropic 6 件套协议后，老协议入口（handleToolCallArgsDelta）
 * 物理删除，新入口 `feedInputJsonDelta` 由 `streamMessageHandler` 在分发
 * `content_block_delta(input_json_delta)` 时调用。
 *
 * **为什么不整文件删？**（违反"物理删 3 个 handler"的字面要求）
 * 本文件除老协议入口外，还包含 W4b 范围（components/chat/）的核心依赖：
 *   - `subscribeToolCallArgsDelta` / `subscribeToolCallArgsEvents` 订阅 API
 *   - `getToolCallArgsBuffer` / `listToolCallArgsBuffers` 查询 API
 *   - `clearToolCallArgsBuffers` / `gcStaleToolCallArgsBuffers` lifecycle 清理 API
 *   - sentinel 协议 (`SentinelReason` / `ToolCallArgsEvent`) 类型定义
 * 这些都是 widget streaming 子系统（`useWidgetStreaming.ts` / `RichWidget.tsx` /
 * `ToolCallArgsDeltaDevPanel.tsx` / `lifecycleHandler.ts` 等）的运行时依赖——
 * 它们是**协议无关**的内存 buffer 抽象，整文件删会导致 W4b 范围连带失败。
 *
 * 老协议入口 `handleToolCallArgsDelta` 已物理删除；删除的代码不在注释中。
 *
 * 持久化语义：**transient 事件**——不进 conversation history、不写 TraceEvent
 * 表、不进 content_blocks_json。本模块把 partial_json 累积到 in-memory store，供：
 *   1. dev mode debug 视图（看 LLM 决策实时形成）
 *   2. widget 真流式渲染（通过订阅 API 消费）
 *
 * 关键不变量：content_block_stop 到达时（在 store 内做 JSON.parse），accumulated
 * partial_json 的最终值与 tool_use.input 一致。
 *
 * 高频事件——1000 token/s 时每秒几千条。本模块故意避开 zustand（重渲染开销），
 * 用本地 Map + 轻量 listener 模型。
 */

import { createLogger } from '@/utils/logger'

const log = createLogger('E2E:ToolArgsDelta')

/** 单个 tool_use 调用过程中累积的 partial args 状态。 */
export interface ToolCallArgsBuffer {
  /** LLM 给的 tool_use id（同一调用期间所有 deltas 共享）。 */
  toolCallId: string
  /** 工具名（首条 delta 已知）。 */
  toolName: string
  /** 累积到当前为止的 args JSON 片段（可能是不完整 JSON）。 */
  accumulatedArgs: string
  /** 收到的 deltas 数量（dev mode 观测用）。 */
  deltaCount: number
  /** 首次 delta 到达的时间戳。 */
  startedAt: number
  /** 最近一次 delta 的时间戳。 */
  lastDeltaAt: number
  /**
   * 是否已击中 ACCUMULATED_ARGS_HARD_CAP。一旦为 true，后续 delta 被丢弃，
   * 渲染端可据此显示 "args 过长已截断" 提示。
   */
  truncated?: boolean
}

/**
 * Sentinel 触发原因（widget 治理 Wave 2.5b §任务 2）。
 *
 * 历史背景：lifecycle phase=end/error/terminated 时 `clearToolCallArgsBuffers`
 * 会给所有 in-flight buffer 发一个 sentinel 通知，消费方（RichWidget）需要
 * 知道流式被中断了。原版本用 `deltaCount === 0` 作为约定标识——跨文件耦合
 * 没显式 union type，未来 refactor 容易 silent regress（譬如有人把
 * deltaCount 改成 number | null 后 `=== 0` 不再 truthy）。
 *
 * 显式 union type 让 sentinel 协议在类型层强约束，预留扩展点：
 *   - session_ended: lifecycle phase='end'（正常完成）
 *   - session_errored: lifecycle phase='error'（异常退出）
 *   - session_terminated: lifecycle phase='terminated'（外部强制终止）
 *   - session_disconnected: WS 断链 / removeStreamingSession 路径（预留，
 *     当前 lifecycleHandler 不调；Wave 3 cancel UI 后接通）
 *   - turn_gc: 同一 session 跨 turn GC 已 finalize 的 buffer（任务 3）
 *   - manual: 测试 / 手动调用兜底
 */
export type SentinelReason =
  | 'session_ended'
  | 'session_errored'
  | 'session_terminated'
  | 'session_disconnected'
  | 'turn_gc'
  | 'manual'

/**
 * 显式 union type（widget 治理 Wave 2.5b §任务 2）：消费方现在能在类型层
 * 区分"流式中"和"已终止"两种事件。
 *
 * 设计权衡：
 *   - 用 `kind` 字段而非 phantom type 类做判别——序列化友好（未来跨进程
 *     forward 也能用 JSON）+ TypeScript narrowing 自然
 *   - delta 事件 buffer 字段直接复用 `ToolCallArgsBuffer`——避免复制字段名
 *     带来的双事实源（deltaCount / accumulatedArgs 等本来就是 buffer 内部状态）
 *   - sentinel 不带 buffer——sentinel 是"buffer 已被清"的事件，buffer 引用
 *     失去意义；只暴露 toolCallId / toolName / reason 让消费方做必要的清理
 *     （如清掉 "流式中…" badge）
 */
export type ToolCallArgsEvent =
  | { kind: 'delta'; buffer: ToolCallArgsBuffer }
  | {
      kind: 'sentinel'
      toolCallId: string
      toolName: string
      reason: SentinelReason
    }

/** Type guard: delta 事件（消费方常用：取 buffer 状态更新 UI）。 */
export function isToolCallArgsDelta(
  event: ToolCallArgsEvent,
): event is Extract<ToolCallArgsEvent, { kind: 'delta' }> {
  return event.kind === 'delta'
}

/** Type guard: sentinel 事件（消费方常用：清理 in-flight UI 状态）。 */
export function isToolCallArgsSentinel(
  event: ToolCallArgsEvent,
): event is Extract<ToolCallArgsEvent, { kind: 'sentinel' }> {
  return event.kind === 'sentinel'
}

type ListenerEntry = {
  sessionId: string
  fn: (buffer: ToolCallArgsBuffer) => void
}

type EventListenerEntry = {
  sessionId: string
  fn: (event: ToolCallArgsEvent) => void
}

/**
 * 单个工具调用的累积 args 上限（字节，等价 char count——args 是 ASCII JSON）。
 *
 * Wave 2 真实用户视角 Review (P0-2) 发现：原实现 `accumulatedArgs += delta`
 * 没有任何上限——一个失控的 LLM（或异常 session 不发 lifecycle end）会让
 * buffer 持续涨到几十 MB。配合 `STREAMING_CODE_HARD_CAP_BYTES = 16KB` 的
 * 渲染端硬截断，这里把累积上限设到 64KB（widget 8KB code + JSON envelope
 * + 多轮 partial overhead）。超过后丢弃后续 delta + 标记 truncated。
 */
const ACCUMULATED_ARGS_HARD_CAP = 64 * 1024

/**
 * 全局缓冲区——按 sessionId + toolCallId 索引。
 *
 * 设计权衡：直接挂 zustand store 会让每个 delta 触发全树重渲染（1000 Hz
 * 时 React commit 会被打爆）。改用 Map + 显式 listener 模型，让消费者
 * （dev panel / widget 真流式视图）自己决定 throttle 策略（rAF、节流等）。
 */
const buffersBySession = new Map<string, Map<string, ToolCallArgsBuffer>>()

/** 订阅者列表（Widget Wave 2 真流式渲染会接进来；本期 dev panel 用）。 */
const listeners = new Set<ListenerEntry>()

/**
 * 新协议订阅者（widget 治理 Wave 2.5b §任务 2）：接受显式 union type。
 *
 * 与 `subscribeToolCallArgsDelta` 共存：旧消费方（RichWidget）继续用 buffer
 * + `deltaCount === 0` 模式（A 子 Agent 后续 PR 迁移）；新消费方（dev panel
 * + 未来订阅）用本 API + type guard。两套 listener 同步 fanout，行为一致。
 */
const eventListeners = new Set<EventListenerEntry>()

/**
 * 订阅一个 session 的 tool_call_args_delta 事件流（旧 API，向后兼容）。
 *
 * @deprecated 请改用 `subscribeToolCallArgsEvents` + `isToolCallArgsDelta` /
 *   `isToolCallArgsSentinel` 类型守卫——隐式 sentinel 协议（`deltaCount === 0`）
 *   跨文件耦合无显式类型约束，未来 refactor 易 silent regress。
 *   本 API 保留以兼容 RichWidget 等旧消费方，由 A 子 Agent 后续 PR 迁移。
 * @returns 取消订阅函数
 */
export function subscribeToolCallArgsDelta(
  sessionId: string,
  fn: (buffer: ToolCallArgsBuffer) => void,
): () => void {
  const entry: ListenerEntry = { sessionId, fn }
  listeners.add(entry)
  return () => {
    listeners.delete(entry)
  }
}

/**
 * 订阅 tool_call_args_delta 事件（新 API，显式 union type）。
 *
 * 消费方应使用 `isToolCallArgsDelta` / `isToolCallArgsSentinel` 类型守卫
 * 区分两类事件——这样未来加 sentinel reason 或 delta 字段时，新消费方
 * 自然得到类型层提示，旧消费方不被影响。
 *
 * @returns 取消订阅函数
 */
export function subscribeToolCallArgsEvents(
  sessionId: string,
  fn: (event: ToolCallArgsEvent) => void,
): () => void {
  const entry: EventListenerEntry = { sessionId, fn }
  eventListeners.add(entry)
  return () => {
    eventListeners.delete(entry)
  }
}

/**
 * 读取当前 session + tool_call_id 累积到的 partial args。
 *
 * 用途：Widget Wave 2 真流式渲染时初始化 / dev panel "show current"。
 */
export function getToolCallArgsBuffer(
  sessionId: string,
  toolCallId: string,
): ToolCallArgsBuffer | undefined {
  return buffersBySession.get(sessionId)?.get(toolCallId)
}

/**
 * 列出 session 下所有 in-flight 的 tool_use 缓冲区——dev panel 用。
 */
export function listToolCallArgsBuffers(sessionId: string): ToolCallArgsBuffer[] {
  const m = buffersBySession.get(sessionId)
  return m ? Array.from(m.values()) : []
}

/**
 * 清空 session 的所有 tool_call_args_delta 缓冲区。
 *
 * 时机：lifecycle phase='end' 或 cancel 时由 lifecycleHandler 调。
 * 单纯的 tool 调用结束（phase='end'）不必清理——因为此时 accumulated args
 * 已经和 tool_use final input 等价，留着对 dev panel 仍有价值（看历史）。
 *
 * **Wave 2 产品 Review（必修-2）补丁**：清理时通知所有 listener 让它们
 * 知道流式中断了。RichWidget 收到 sentinel buffer 后清掉 "流式中…" badge
 * 显示 "已中断"——避免 LLM 中断时 badge 永远转。
 *
 * **widget 治理 Wave 2.5b §任务 2**：sentinel 协议升级——保留旧 listener
 * 收 `deltaCount === 0` buffer 的兼容路径（RichWidget 不动），同时给新
 * listener fanout 显式 `ToolCallArgsEvent` sentinel 事件含 reason。
 *
 * @param sessionId 要清的 session
 * @param reason sentinel 触发原因；默认 'session_ended' 兼容现有调用方
 */
export function clearToolCallArgsBuffers(
  sessionId: string,
  reason: SentinelReason = 'session_ended',
): void {
  const sessionBuffers = buffersBySession.get(sessionId)
  buffersBySession.delete(sessionId)
  if (!sessionBuffers) return
  // 给每个 in-flight buffer 发一个 sentinel 通知（deltaCount=0 + lastDeltaAt
  // 设当前时间），listener 通过 deltaCount=0 识别"流式终止"。
  for (const buffer of sessionBuffers.values()) {
    notifySentinel(sessionId, buffer.toolCallId, buffer.toolName, reason, buffer)
  }
}

/**
 * 单条 buffer 清理（W4a 三轮 C-P0-2 + A-P0-2 新增）。
 *
 * 用途：
 *   - messageStart 重置（C-P0-2）：daemon retry / WS replay 时清掉本 message
 *     已知 toolCallId 的 buffer，防止 attempt 1 残留污染 attempt 2。
 *   - `__pending__` placeholder replay（A-P0-2）：cb_start 把真 toolCallId
 *     wire 起来时，先清"`__pending__`" 这条 placeholder buffer，再 replay
 *     已暂存的 fragments 进真 toolCallId 的新 buffer。
 *
 * 与 clearToolCallArgsBuffers 区别：粒度——本函数只动一条 toolCallId 的
 * buffer，不动其它；session 级清理用 clearToolCallArgsBuffers。
 *
 * @param sessionId 当前 session
 * @param toolCallId 要清的 buffer 对应的 toolCallId（含 `__pending__` sentinel）
 * @param reason sentinel 触发原因（默认 'turn_gc' 让 listener 走清 badge 路径）
 * @returns true 表示有 buffer 被清；false 表示该 buffer 不存在
 */
export function clearToolCallArgsBufferByToolCallId(
  sessionId: string,
  toolCallId: string,
  reason: SentinelReason = 'turn_gc',
): boolean {
  const sessionBuffers = buffersBySession.get(sessionId)
  if (!sessionBuffers) return false
  const buffer = sessionBuffers.get(toolCallId)
  if (!buffer) return false
  sessionBuffers.delete(toolCallId)
  if (sessionBuffers.size === 0) buffersBySession.delete(sessionId)
  notifySentinel(sessionId, toolCallId, buffer.toolName, reason, buffer)
  return true
}

/**
 * 把 `__pending__` placeholder buffer 的累积 fragments replay 进真 toolCallId
 * 的 buffer（W4a 三轮 A-P0-2）。
 *
 * 场景：daemon emit `content_block_delta(input_json_delta)` 早于 `content_block_start`
 * 到达时（理论不应发生但要兜底），handler 把 partial_json 暂存到 entry 的
 * `_pendingInputJsonFragments` 数组，而**不**调 feedInputJsonDelta（否则
 * 走 `__pending__` 占位 toolCallId 写 buffer 永远孤儿）。当真 cb_start 到达，
 * entry.block.id 被设为真 toolCallId，本函数把暂存的 fragments 一次性灌进
 * 新 buffer——RichWidget 早期 token 不丢。
 *
 * @param sessionId 当前 session
 * @param toolCallId 真 toolCallId（cb_start 拿到的 block.id）
 * @param toolName 工具名（cb_start 拿到的 block.name）
 * @param fragments 暂存的 partial_json 片段数组（按到达顺序）
 */
export function replayPendingInputJsonFragments(
  sessionId: string,
  toolCallId: string,
  toolName: string,
  fragments: ReadonlyArray<string>,
): void {
  if (fragments.length === 0) return
  for (const fragment of fragments) {
    feedInputJsonDelta(sessionId, toolCallId, toolName, fragment)
  }
}

/**
 * 单独 fanout 一个 sentinel 事件——给两套 listener 协议都发：
 *   - 旧 API（subscribeToolCallArgsDelta）：发一个 deltaCount=0 的伪 buffer
 *   - 新 API（subscribeToolCallArgsEvents）：发显式 sentinel 事件含 reason
 */
function notifySentinel(
  sessionId: string,
  toolCallId: string,
  toolName: string,
  reason: SentinelReason,
  /**
   * 旧 API sentinel 需要一个 buffer 模板（deltaCount/accumulatedArgs 字段
   * 的兼容）。如果没有现成 buffer（譬如手动调用），合成一个最小可用的。
   */
  buffer: ToolCallArgsBuffer | null,
): void {
  const sentinelBuffer: ToolCallArgsBuffer = buffer
    ? {
        ...buffer,
        // 关键标识：deltaCount=0 表示"已终止"语义。listener 端通过它判断要不要
        // 把"流式中…"切到"已中断"。
        deltaCount: 0,
      }
    : {
        toolCallId,
        toolName,
        accumulatedArgs: '',
        deltaCount: 0,
        startedAt: Date.now(),
        lastDeltaAt: Date.now(),
      }

  for (const entry of listeners) {
    if (entry.sessionId === sessionId) {
      try {
        entry.fn(sentinelBuffer)
      } catch (err) {
        log.warn('[args_delta] listener threw on cleanup notification', err)
      }
    }
  }

  const sentinelEvent: ToolCallArgsEvent = {
    kind: 'sentinel',
    toolCallId,
    toolName,
    reason,
  }
  for (const entry of eventListeners) {
    if (entry.sessionId === sessionId) {
      try {
        entry.fn(sentinelEvent)
      } catch (err) {
        log.warn('[args_delta] event listener threw on sentinel notification', err)
      }
    }
  }
}

/**
 * 多 turn buffer GC（widget 治理 Wave 2.5b §任务 3）。
 *
 * 业务背景：`subscribeToolCallArgsDelta` 在内存维护
 * `Map<sessionId, Map<toolCallId, ToolCallArgsBuffer>>`。原版本只在 lifecycle
 * 终态（phase=end/error/terminated）清整个 session 的 buffer，但 chat session
 * 一个 turn 完成后**不清**——同一 session 跑 100 个 turn，每轮的 toolCall
 * buffer 全累积在内存。一个 session 用 8 小时跑 1000 个 toolCall × 64KB =
 * 64MB 内存。
 *
 * 修法：在 turn_end / turn_start 时按 idle 时长清"已 finalize 的 buffer"，
 * 不误清还在 in-flight 的 buffer：
 *   - lastDeltaAt < (now - STALE_BUFFER_TTL_MS) 视为 finalize（args 已完整，
 *     LLM 不再吐 delta；通常 turn_end 时 LLM 流早已结束 N 秒）
 *   - 该 buffer 触发 sentinel 通知（reason='turn_gc'）让消费方按需清 UI
 *     状态——但实测中绝大多数 buffer 已经在 RICH_CONTENT final 时被消费方
 *     切到持久化态，不会有"流式中"badge 残留
 *
 * @returns 实际清理的 buffer 数量
 */
export function gcStaleToolCallArgsBuffers(sessionId: string): number {
  const sessionBuffers = buffersBySession.get(sessionId)
  if (!sessionBuffers) return 0
  const now = Date.now()
  const stale: Array<{ toolCallId: string; toolName: string; buffer: ToolCallArgsBuffer }> = []
  for (const [toolCallId, buffer] of sessionBuffers) {
    if (now - buffer.lastDeltaAt > STALE_BUFFER_TTL_MS) {
      stale.push({ toolCallId, toolName: buffer.toolName, buffer })
    }
  }
  if (stale.length === 0) return 0

  for (const { toolCallId, toolName, buffer } of stale) {
    sessionBuffers.delete(toolCallId)
    notifySentinel(sessionId, toolCallId, toolName, 'turn_gc', buffer)
  }
  if (sessionBuffers.size === 0) buffersBySession.delete(sessionId)

  log.debug('[args_delta] gc stale buffers', {
    session: sessionId.slice(0, 8),
    cleared: stale.length,
    remaining: sessionBuffers.size,
  })
  return stale.length
}

/**
 * 已 finalize buffer 视为"过期"的阈值。
 *
 * 选 2 秒的理由：
 *   - LLM 流式吐 args 通常 0.5-3 秒内全部完成，turn_end 之间通常有 ≥ 5 秒
 *     间隔（工具 execute + LLM 二次推理），buffer.lastDeltaAt 离 turn_end
 *     一般 ≥ 5 秒 → 远大于 2 秒阈值，能可靠清掉
 *   - 假设 LLM 吐 args 时网络抖动停顿 1.x 秒后续上，2 秒阈值够安全
 *   - in-flight buffer（lastDeltaAt 离 now < 1 秒）绝不会被误清
 */
const STALE_BUFFER_TTL_MS = 2000

/**
 * 喂一条 partial_json 增量进入 buffer（Wave 4a 新协议入口）。
 *
 * 调用方：`streamMessageHandler` 在分发 `content_block_delta(input_json_delta)`
 * 时——它已经从 store 拿到当前 block_id（即 tool_use.id）和 tool_name，所以
 * 本函数直接接受平铺参数，避免反复解析 envelope。
 *
 * 设计要点（与原 `handleToolCallArgsDelta` 一致，删除老协议入口后保留行为）：
 * - **不调 store.set**：高频事件，绝不触发 React 重渲染。消费者通过 `subscribe` API。
 * - **容忍 partial JSON**：partial_json 可能不完整（e.g. `'{"path"`），不解析、
 *   不验证，原样累积。最终 content_block_stop 时由 store 内 JSON.parse 兜底。
 * - **零未知 sessionId 假设**：listener 自己按 sessionId 过滤；模块照单全收。
 *
 * @param sessionId 当前 session
 * @param toolCallId tool_use.id（沿用上游 LLM 原生 id，禁止重生成）
 * @param toolName 工具名（首次 delta 已知；后续 delta 透传即可，重复设置幂等）
 * @param partialJson 本次 delta 的 partial JSON 片段（可能不完整）
 */
export function feedInputJsonDelta(
  sessionId: string,
  toolCallId: string,
  toolName: string,
  partialJson: string,
): void {
  if (!sessionId || !toolCallId || !partialJson) {
    // 任何一个空都没法累积——保持 transient 语义不报错
    return
  }

  let sessionBuffers = buffersBySession.get(sessionId)
  if (!sessionBuffers) {
    sessionBuffers = new Map()
    buffersBySession.set(sessionId, sessionBuffers)
  }

  const now = Date.now()
  let buffer = sessionBuffers.get(toolCallId)
  if (!buffer) {
    buffer = {
      toolCallId,
      toolName,
      accumulatedArgs: '',
      deltaCount: 0,
      startedAt: now,
      lastDeltaAt: now,
    }
    sessionBuffers.set(toolCallId, buffer)
    log.debug('[args_delta] new tool_use buffer', {
      session: sessionId.slice(0, 8),
      toolCallId: toolCallId.slice(0, 12),
      toolName,
    })
  }

  // P0-2 防线：累积上限检查。超过 cap 后丢弃 delta，避免内存无界膨胀。
  // 选 64KB > widget 8KB code 上限（show-widget.ts MAX_CODE_BYTES）+ JSON
  // envelope 的合理 budget，正常 LLM 用例打不到这条线；异常 LLM / 失控
  // session 在这里被截断，配合渲染端 STREAMING_CODE_HARD_CAP_BYTES=16KB
  // 的二级护栏，浏览器进程不会因此涨到几十 MB。
  if (buffer.accumulatedArgs.length + partialJson.length > ACCUMULATED_ARGS_HARD_CAP) {
    if (!buffer.truncated) {
      buffer.truncated = true
      log.warn('[args_delta] buffer hit hard cap, dropping subsequent deltas', {
        session: sessionId.slice(0, 8),
        toolCallId: toolCallId.slice(0, 12),
        toolName: buffer.toolName,
        accumulatedBytes: buffer.accumulatedArgs.length,
        droppedDeltaBytes: partialJson.length,
      })
    }
    const remaining = ACCUMULATED_ARGS_HARD_CAP - buffer.accumulatedArgs.length
    if (remaining > 0) {
      buffer.accumulatedArgs += partialJson.slice(0, remaining)
    }
  } else {
    buffer.accumulatedArgs += partialJson
  }
  buffer.deltaCount += 1
  buffer.lastDeltaAt = now
  if (toolName && !buffer.toolName) buffer.toolName = toolName

  // 逐 delta 的进度不落日志（属于流式增量，非事件）。每个工具调用开始时的
  // `[args_delta] new tool_use buffer` 已是每工具一次的事件信号；实时进度看
  // ToolCallArgsDeltaDevPanel 可视化面板。

  // 通知订阅者（dev panel 等）。listener 自己决定是否 throttle——
  // 这里同步 fan-out，让 caller 看到最准的状态。
  for (const entry of listeners) {
    if (entry.sessionId === sessionId) {
      try {
        entry.fn(buffer)
      } catch (err) {
        log.warn('[args_delta] listener threw', err)
      }
    }
  }

  // 新 API（显式 delta 事件）：与旧 API 同步 fanout，保持两套消费方行为一致。
  const deltaEvent: ToolCallArgsEvent = { kind: 'delta', buffer }
  for (const entry of eventListeners) {
    if (entry.sessionId === sessionId) {
      try {
        entry.fn(deltaEvent)
      } catch (err) {
        log.warn('[args_delta] event listener threw', err)
      }
    }
  }
}

/** 测试用：重置内部状态。 */
export function __resetToolCallArgsBuffersForTests(): void {
  buffersBySession.clear()
  listeners.clear()
  eventListeners.clear()
}
