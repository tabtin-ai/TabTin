/**
 * useSubagentLiveStore — 子 Agent 实时 stream message store（PRD §4.18）
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  解决什么问题
 * ═══════════════════════════════════════════════════════════════════════
 *
 * v3.2 之前架构：子 Agent 的 LLM stream（content_block_delta / message_start
 * 等真实 LLM 文本内容）由 `packages/agent-runtime/src/engine/fork-query.ts`
 * 消费 + 写盘到 `subagents/agent-{childId}/messages.jsonl`，但 `agent-tool.ts`
 * 的 while 循环只挑了 6 种白名单事件 forward 给父 emitter——子 Agent 的真实
 * LLM 文本内容**从未桥到 renderer**。SubagentDetailPane 只能等 jsonl 落盘后
 * 通过 IPC 读，体验上"打开正在跑的子 Agent" 必撞 `file_missing` 加载失败。
 *
 * v3.2 修复（PRD §4.18）：
 *   - `agent-tool.ts` while 循环 forward 全量 child envelope 为
 *     SUBAGENT_STREAM_EVENT，附加 subagent_run_id + chain
 *   - 主进程 `agent-engine:stream-event` IPC 通配 forward 到 renderer
 *   - **本 store** 接住事件，按 subagent_run_id 维护 ReplayState 状态机，
 *     用 `applyEnvelopeEvent` 增量 reduce 成 ChatMessage[]
 *   - SubagentDetailPane 数据源：live store 优先，无 live 才 fallback jsonl
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  与现有 store 的关系
 * ═══════════════════════════════════════════════════════════════════════
 *
 * | store | 数据 | 关心什么 |
 * |---|---|---|
 * | `useChatStore.messagesBySessionId` | 主对话 chat session 消息 | 主 Agent 对话 |
 * | `useChatRuntimeStore.subagentRunsBySessionId` | 子 Agent metadata（status/step/tool 历史） | 卡片 / 聚合视图 |
 * | `useSubagentSessionStore.subagentSessionDataBySubId` | jsonl 三件套缓存（messages/snapshots/events 原始 envelope lines） | 历史回看 |
 * | **本 store `messagesByRunId`** | 实时 ReplayState（reduce 后的 ChatMessage[]） | **Pane 实时显示** |
 *
 * 与 useSubagentSessionStore 的区别：
 *   - 数据形态：subagentSession 存原始 envelope lines（IPC 拉回的 jsonl 原文）；
 *     本 store 存 reducer 状态机 + 派生 ChatMessage[]
 *   - 数据来源：subagentSession ← IPC 读 jsonl 文件；本 store ← stream-event IPC 实时推
 *   - 互补：run 还在跑 / 终态 LRU 内 → 走本 store；live 不在 → fallback subagentSession
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  内存 retention 策略
 * ═══════════════════════════════════════════════════════════════════════
 *
 * - **running 状态全量 retain**：用户随时可能点开 Pane 看实时进度
 * - **终态 run LRU 50**：超过 50 个 completed/failed/cancelled run 时按 last-touched
 *   LRU evict（与现有 evictSession 12-session LRU、subagentRunsBySessionId .slice(-200)
 *   同款治理思路）
 * - **单 run 内消息无 cap**：单个子 Agent 跑出来几十 KB 文本是常态，硬 cap 反而会
 *   截断历史。50 个 run × 100KB ≈ 5MB 内存，并行 dogfood 场景压力可忽略
 * - **clear hooks**：父 session 删除 / organization 切换 / logout 时 clear 对应 run
 */

import { create } from 'zustand'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  type ReplayState,
  createInitialReplayState,
  applyEnvelopeEvent,
  selectReplayMessages,
} from '../../components/chat/subagent/replaySubagentMessages'
import { registerResetAction } from '../sessionResetRegistry'
import { useChatStore } from '../chat/useChatStore'
import { commitBlocks } from '../chat/messages/messageBlocks'
import type { ContentBlockEntry } from '../useChatRuntimeStore'

/**
 *  子代理数据层统一：把某 run 的 reduce 结果落进父 session 的
 * `messagesBySessionId`（数据层不区分主/子/孙——全用 `subagent_run_id` 标身份，
 * 主 MessageList 已按它隔离；SubagentDetailPane / deriver 按它作用域消费）。
 *
 * 关键：子代理消息与**历史 / 主 Agent 消息结构完全一致**——`content_blocks_json`
 * （持久 / 落库形态）+ committed `message.blocks`（内存 SSoT）都写全。这样无论
 * 实时、会话内回看、还是刷新后从 API 恢复，读法都一样（不会「修实时坏历史」）：
 *   - `content_blocks_json`：随 reduce 结果更新，作持久 / 兜底源（committed 被
 *     LRU evict 或跨端时仍可读）。
 *   - committed `message.blocks`：`commitBlocks` 覆盖写（无 guard，永远最新），
 *     供细粒度响应式读。
 *
 * 性能：仅在块内容真变化时换消息对象（限主时间线重算频率）；主 MessageList 按
 * `subagent_run_id` 隔离掉这些消息，重算不改变主流可见输出。
 */
function _syncRunMessagesToChatStore(
  parentSessionId: string | undefined,
  runId: string,
  messages: ChatMessage[],
): void {
  if (!parentSessionId || messages.length === 0) return
  const store = useChatStore.getState()
  const dmById = new Map(messages.map((dm) => [dm.id, dm]))
  // 全字段拷贝：dm 已带主 Agent/历史同款全字段（id/role/content/content_blocks_json/
  // model_id/model_name/message_kind/stop_reason/usage_json/error_info_json/blocks），
  // 只补身份标记，**不丢字段**。
  const toStoreMessage = (dm: ChatMessage): ChatMessage => ({
    ...dm,
    subagent_run_id: runId,
    agent_run_id: runId,
  })

  // 换对象条件（块数量 / 中断态 / 模型元字段变化）+ 追加缺失，逻辑内聚在 store action。
  store.mergeSubagentMessages(parentSessionId, toStoreMessage, messages, 'live')

  // committed 覆盖写（无 guard，永远最新）——供 useMessageBlocksById 细粒度响应式读。
  for (const dm of messages) {
    commitBlocks(parentSessionId, dm.id, (dm.blocks ?? []) as ContentBlockEntry[])
  }
}

/**
 * run 终态时把完整 content_blocks_json 快照写回父 session 消息（无块数量守门）——
 * 补齐流式期按块数量更新遗留的末块文本，保证持久形态完整。
 */
function _flushRunContentBlocksJson(
  parentSessionId: string,
  runId: string,
  messages: ChatMessage[],
): void {
  if (!parentSessionId || messages.length === 0) return
  // 终态全字段快照——补齐流式期按块数量更新遗留的末块文本与元字段（flush：覆盖已有、不追加）。
  const toStoreMessage = (dm: ChatMessage): ChatMessage => ({ ...dm, subagent_run_id: runId, agent_run_id: runId })
  useChatStore.getState().mergeSubagentMessages(parentSessionId, toStoreMessage, messages, 'flush')
}

/**
 * 终态 run LRU 上限（completed/failed/cancelled）。running 不计入 LRU 候选。
 *
 * 选 50：对标 chat runtime evictSession 12 session × 4 子 Agent/session = 48 量级。
 * 真实并行 dogfood 场景中，超过 50 个终态 run 同时存在的情况极少（用户切走 session
 * 就 evict）；保守留点余量。
 */
const TERMINAL_LRU_LIMIT = 50

// ─────────────────────────────────────────────────────────────────────────
// ：rAF 合并高频 child 事件 —— 对称主 Agent 路径（useChatRuntimeStore 的
// _pendingContentBlocks + rAF）。
//
// 背景：子 Agent 每个 content_block_delta 若都同步 selectReplayMessages（全量重建
// transcript + 深拷贝每块）+ _syncRunMessagesToChatStore（全量映射父 session），1000
// token/s 下主线程被打满、打字机卡顿，且随 transcript 增长退化到 O(N²)/消息。
//
// 收敛：applyChildEvent 只做便宜的 in-place reduce（applyEnvelopeEvent 累积进
// replayState）+ 标脏调度；每帧 flush 一次才做昂贵的派生 + 同步。终态强制 flush 防丢尾。
// ─────────────────────────────────────────────────────────────────────────

const _dirtyRunIds = new Set<string>()
let _flushHandle: ReturnType<typeof setTimeout> | null = null

function _scheduleFlush(): void {
  if (_flushHandle !== null) return
  if (typeof requestAnimationFrame === 'function') {
    _flushHandle = requestAnimationFrame(() => {
      _flushHandle = null
      _flushDirtyRuns()
    }) as unknown as ReturnType<typeof setTimeout>
    return
  }
  // 无 rAF 环境（部分测试运行时）回落 setTimeout，保持「合并到下一拍」语义。
  _flushHandle = setTimeout(() => {
    _flushHandle = null
    _flushDirtyRuns()
  }, 16)
}

/**
 * 把所有标脏 run 的 reducer 状态派生成 messages，一次 set() 写回，再同步父 session。
 * 每帧至多一次（rAF），把 per-token 的 O(N) 重建降到 per-frame。
 */
function _flushDirtyRuns(): void {
  if (_dirtyRunIds.size === 0) return
  const runIds = Array.from(_dirtyRunIds)
  _dirtyRunIds.clear()

  const derived: Array<{ runId: string; messages: ChatMessage[]; parentSessionId?: string }> = []
  useSubagentLiveStore.setState((state) => {
    let changed = false
    const nextRuns = { ...state.runsByRunId }
    for (const runId of runIds) {
      const entry = nextRuns[runId]
      if (!entry) continue // 已被 clear/evict
      const messages = selectReplayMessages(entry.replayState)
      nextRuns[runId] = { ...entry, messages, lastTouchedAt: Date.now() }
      derived.push({ runId, messages, parentSessionId: entry.parentSessionId })
      changed = true
    }
    return changed ? { runsByRunId: nextRuns } : state
  })

  for (const d of derived) {
    _syncRunMessagesToChatStore(d.parentSessionId, d.runId, d.messages)
  }
}

/** 测试用：同步 flush 所有 pending run（避免依赖 rAF 时序）。 */
export function flushSubagentLiveBatch(): void {
  if (_flushHandle !== null) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(_flushHandle as unknown as number)
    } else {
      clearTimeout(_flushHandle)
    }
    _flushHandle = null
  }
  _flushDirtyRuns()
}

interface RunEntry {
  /** Reducer 状态机（envelope event 应用累积体），不直接给 UI 用 */
  replayState: ReplayState
  /** 派生的 ChatMessage[]：每次 apply 后重新计算（同时换 array 引用，让 selector 触发 re-render） */
  messages: ChatMessage[]
  /** 上次 apply 的时间戳，LRU 排序依据 */
  lastTouchedAt: number
  /** 该 run 已知的"终态"标记，仅供 LRU 候选筛选。本 store 自身不判定状态，由 chat runtime 通过 `markRunTerminal` 通知 */
  isTerminal: boolean
  /** 父 session id：用于 `clearByParentSession`（父 session 删除时一并清掉子 Agent live 数据） */
  parentSessionId?: string
  /** 嵌套 chain（含自己，最末项 = runId），LRU 不依赖此字段；UI 未来画树时用 */
  chain?: string[]
}

interface SubagentLiveState {
  /** 按 subagent_run_id 索引的 live 状态机 + 派生 messages */
  runsByRunId: Record<string, RunEntry>

  /**
   * 应用一个 child envelope event（来自 SUBAGENT_STREAM_EVENT 拆包后）。
   *
   * @param runId          subagent_run_id（路由 key）
   * @param childEvent     原始 envelope（含 type / payload）
   * @param parentSessionId 父 session id（首次见到此 run 时记下，后续不变）
   * @param chain          嵌套 chain（首次见到此 run 时记下；同 run 多次到达 chain 应一致，不一致以最早为准）
   */
  applyChildEvent: (
    runId: string,
    childEvent: { type: string; payload: Record<string, unknown> },
    parentSessionId?: string,
    chain?: string[],
  ) => void

  /**
   * 把某 run 标为终态（由 chat runtime 在收到 SUBAGENT_COMPLETED/FAILED 时通知本 store）。
   * 仅影响 LRU 候选筛选，不删除 messages。
   */
  markRunTerminal: (runId: string) => void

  /** 清掉某个 run 的全部 live 数据（cancel/手动重启 / orphan 清理时调） */
  clearByRunId: (runId: string) => void

  /** 清掉某父 session 下所有子 Agent live 数据（父 session 删除时调） */
  clearByParentSession: (parentSessionId: string) => void

  /** 全清（logout / organization 切换） */
  clear: () => void
}

export const useSubagentLiveStore = create<SubagentLiveState>((set, get) => ({
  runsByRunId: {},

  applyChildEvent: (runId, childEvent, parentSessionId, chain) => {
    const existing = get().runsByRunId[runId]
    // ：终态后迟到的 stream/progress 不再 reduce，避免已完成子 run 继续烧主线程。
    if (existing?.isTerminal) return

    // 新 run 首注册 entry（含 LRU eviction）。仅每个子 Agent 触发一次，非 per-token。
    if (!existing) {
      set(state => {
        // 竞态双检：schedule 到 set 之间理论不会有并发，但保持幂等。
        if (state.runsByRunId[runId]) return state
        const replayState = createInitialReplayState()
        let runsByRunId = state.runsByRunId
        const terminalRunIds = Object.entries(state.runsByRunId)
          .filter(([, e]) => e.isTerminal)
          .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt)
          .map(([id]) => id)
        if (terminalRunIds.length >= TERMINAL_LRU_LIMIT) {
          const toEvictCount = terminalRunIds.length - TERMINAL_LRU_LIMIT + 1
          const evictIds = terminalRunIds.slice(0, toEvictCount)
          if (evictIds.length > 0) {
            runsByRunId = { ...state.runsByRunId }
            for (const id of evictIds) {
              delete runsByRunId[id]
              _dirtyRunIds.delete(id)
            }
          }
        }
        return {
          runsByRunId: {
            ...runsByRunId,
            [runId]: {
              replayState,
              messages: [],
              lastTouchedAt: Date.now(),
              isTerminal: false,
              parentSessionId,
              chain,
            },
          },
        }
      })
    }

    // 每 token 的热路径：只做便宜的 in-place reduce（replayState 内对象引用稳定），
    // 昂贵的 selectReplayMessages + 父 session 同步挪到 rAF flush，每帧至多一次。
    const entry = get().runsByRunId[runId]
    if (!entry) return
    applyEnvelopeEvent(entry.replayState, childEvent)
    _dirtyRunIds.add(runId)
    _scheduleFlush()
  },

  markRunTerminal: (runId) => {
    // ：先强制 flush 该 run 的 pending 事件——否则最后几个 token 还压在 rAF
    // 队列里、messages 未派生，终态快照会丢尾。
    flushSubagentLiveBatch()
    set(state => {
      const p = state.runsByRunId[runId]
      if (!p || p.isTerminal) return state
      return {
        runsByRunId: {
          ...state.runsByRunId,
          [runId]: { ...p, isTerminal: true, lastTouchedAt: Date.now() },
        },
      }
    })
    // ：run 终态时把**完整** content_blocks_json 快照写回父 session 消息——
    // 补齐流式期为限 churn 只按块数量更新遗留的「末块文本增长」，保证 committed 被
    // evict / 跨端恢复时持久形态完整。用 finalize 专用 flush（无块数量守门）。
    const entry = get().runsByRunId[runId]
    if (entry?.parentSessionId) {
      _flushRunContentBlocksJson(entry.parentSessionId, runId, entry.messages)
    }
  },

  clearByRunId: (runId) => {
    _dirtyRunIds.delete(runId)
    set(state => {
      if (!(runId in state.runsByRunId)) return state
      const next = { ...state.runsByRunId }
      delete next[runId]
      return { runsByRunId: next }
    })
  },

  clearByParentSession: (parentSessionId) => {
    set(state => {
      const toRemove = Object.entries(state.runsByRunId)
        .filter(([, e]) => e.parentSessionId === parentSessionId)
        .map(([id]) => id)
      if (toRemove.length === 0) return state
      const next = { ...state.runsByRunId }
      for (const id of toRemove) {
        delete next[id]
        _dirtyRunIds.delete(id)
      }
      return { runsByRunId: next }
    })
  },

  clear: () => {
    _dirtyRunIds.clear()
    set({ runsByRunId: {} })
  },
}))

// organization 切换 / logout 时清空 live 数据（与 useSubagentSessionStore 同款 hook）
registerResetAction('subagent-live', 'reset', () => {
  useSubagentLiveStore.getState().clear()
})

const EMPTY_LIVE_MESSAGES: ChatMessage[] = []

/**
 * Selector helper：返回某 run 的派生 messages（无 run → `[]`）。
 *
 * 用法：
 * ```ts
 * const messages = useSubagentLiveStore(s => selectLiveMessagesByRunId(s, runId))
 * ```
 *
 * 无 run 时返回稳定空数组（：冷读不得因 undefined 抛错挡住归档路径）。
 */
export function selectLiveMessagesByRunId(
  state: SubagentLiveState,
  runId: string,
): ChatMessage[] {
  return state.runsByRunId[runId]?.messages ?? EMPTY_LIVE_MESSAGES
}
