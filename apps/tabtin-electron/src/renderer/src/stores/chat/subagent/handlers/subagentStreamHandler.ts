/**
 * subagentStreamHandler — 处理 SUBAGENT_STREAM_EVENT，把子 Agent 的实时 envelope
 * 拆包后写入 `useSubagentLiveStore`，让 SubagentDetailPane 跟主对话同款 token-by-token
 * 实时显示（PRD §4.18 子 Agent 实时流架构）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  事件来源
 * ═══════════════════════════════════════════════════════════════════════
 *
 * - `packages/agent-runtime/src/engine/agent-tool.ts` 的 while 循环：把 fork-query
 *   yield 出来的**每个** child envelope wrap 成 SUBAGENT_STREAM_EVENT forward 给
 *   父 emitter；嵌套子 Agent 也会递归 wrap（subagent_chain 累积）
 * - 主进程 `ElectronAgentHost.ts` 的 stream-event IPC 通配 forward 到 renderer
 * - renderer `streamMessageHandler.ts` dispatch 阶段早返路由到本 handler（必须先于
 *   `eventType.startsWith('agent.stream.subagent_')` 的 subagentHandler 兜底，
 *   否则会被路由到 subagentHandler 的 statusMap 检查 silent ignore）
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  Payload schema（inline 约定，见 events.ts SUBAGENT_STREAM_EVENT 注释）
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ```ts
 * {
 *   // 叶子 run id：最末端实际产出此 envelope 的子 Agent（嵌套时不是直接子，
 *   // 而是链条最底层的那个）。Pane 路由 key。
 *   subagent_run_id: string
 *   // 直接上一层子 Agent 的 run id；null = 主 Agent 直接派的（最常见）
 *   parent_run_id?: string | null
 *   // 祖先链，顺序 [直接父层 run, …, 叶子 run]（index 0 = 最近祖先，末项 = subagent_run_id）。
 *   // 注意方向是「近祖先 → 叶子」，不是「子 → 父」。UI 本期不画树，留扩展。
 *   subagent_chain?: string[]
 *   child_event: { type: string; payload: Record<string, unknown> }  // 原 envelope
 * }
 * ```
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  与 subagentHandler 的分工
 * ═══════════════════════════════════════════════════════════════════════
 *
 * - **本 handler（subagent_stream_event）**：写 useSubagentLiveStore（Pane 用，
 *   transcript 完整体）；终态 child_event 只关闭详情 transcript。聚合卡状态以
 *   parent message blocks / SUBAGENT_* metadata 事实为准。
 * - **subagentHandler（subagent_started / progress / completed / failed / queued
 *   / hitl_required / model_call / speaker_push_message）**：写
 *   useChatRuntimeStore.subagentRunsBySessionId（卡片用，metadata 摘要）
 *
 * 两者**正交互补**：父 chat UI 卡片看 metadata；子 Pane 看 transcript。
 */

import { useSubagentLiveStore } from '../../../subagentLive'
import type { AgentStreamMessage, HandlerContext } from '../../stream/handlers/streamHandlerTypes'
import { createLogger } from '@/utils/logger'

const log = createLogger('E2E:SubagentStream')

interface SubagentStreamPayload {
  subagent_run_id?: unknown
  parent_run_id?: unknown
  subagent_chain?: unknown
  child_event?: unknown
}

interface ChildEvent {
  type: string
  payload: Record<string, unknown>
}

function isChildEvent(v: unknown): v is ChildEvent {
  if (v === null || typeof v !== 'object') return false
  const obj = v as { type?: unknown; payload?: unknown }
  return typeof obj.type === 'string' && obj.payload !== null && typeof obj.payload === 'object'
}

export function handleSubagentStreamEvent(message: AgentStreamMessage, ctx: HandlerContext): void {
  const { sessionId } = ctx
  const payload = (message.payload ?? {}) as SubagentStreamPayload

  const runId = typeof payload.subagent_run_id === 'string' ? payload.subagent_run_id : ''
  if (!runId) {
    log.warn('SUBAGENT_STREAM_EVENT 缺 subagent_run_id，忽略', {
      session: sessionId.slice(0, 8),
    })
    return
  }

  const childEvent = payload.child_event
  if (!isChildEvent(childEvent)) {
    log.warn('SUBAGENT_STREAM_EVENT.child_event 形态不合法，忽略', {
      session: sessionId.slice(0, 8),
      runId: runId.slice(0, 8),
    })
    return
  }

  const chain = Array.isArray(payload.subagent_chain)
    ? payload.subagent_chain.filter((s): s is string => typeof s === 'string')
    : undefined

  // 应用到 live store——subagent_run_id 已经能反查到 parent session（通过
  // useChatRuntimeStore.subagentRunsBySessionId 的反向 lookup），但每条事件
  // do-while lookup 成本太高，这里直接用 sessionId（stream-event IPC 已带）
  // 作为 parentSessionId。同一 run 多次 apply parentSessionId 保持不变（store
  // 只在首次记录 prev?.parentSessionId ?? newParent，后续不覆盖）。
  useSubagentLiveStore.getState().applyChildEvent(runId, childEvent, sessionId, chain)

  // 子 Agent 进入终态（child_event 是 done / lifecycle.end 等）→ 只收敛详情
  // live store。聚合卡的最终状态必须来自 parent message block / SUBAGENT_* metadata
  // 事实，避免把 child stream 的生命周期事件变成第二套真相源。
  if (childEvent.type === 'agent.stream.done') {
    useSubagentLiveStore.getState().markRunTerminal(runId)
    return
  }
  if (childEvent.type === 'agent.stream.lifecycle') {
    const phase = (childEvent.payload as { phase?: unknown }).phase
    if (phase === 'end') {
      useSubagentLiveStore.getState().markRunTerminal(runId)
    }
  }
}
