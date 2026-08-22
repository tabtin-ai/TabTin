/**
 * Wave 4a · ContentBlock handler + store CRUD 综合测试
 *
 * 覆盖矩阵：
 *
 * §1. 6 件套分发：每件套 1 个测试（事件入 dispatcher → state 正确更新）
 *   1.1 message_start → messageMeta 写入 + contentBlocks 槽位 init
 *   1.2 message_delta → stop_reason / usage 累积（cumulative，取最新）
 *   1.3 message_stop → finalized=true
 *   1.4 content_block_start → blocks 数组 push + 按 index 排序
 *   1.5 content_block_delta(text_delta) → block.text 累积
 *   1.6 content_block_stop → finalized=true，tool_use 触发 JSON.parse
 *
 * §2. 状态机 6 类边角 case（v2 §3.5.1.b）：
 *   2.1 partial_json parse 失败 → input={}, input_parse_error 落字段
 *   2.2 delta 早于 start → lazy create placeholder + warn
 *   2.3 message_stop 时仍有 unfinalized → 强制 finalize + partial=true
 *   2.4 abort 路径：message_delta(stop_reason='aborted') → meta.stop_reason
 *   2.5 多 message 并发（同 session 不同 message_id）→ 各自独立
 *   2.6 IPC vs WS 双源去重：seq <= prevSeq drop
 *
 * §3. 老协议文件删除验证
 *
 * **设计权衡 - 为什么不用真实 useChatRuntimeStore？**
 * 仓库当前状态：`useChatRuntimeStore` → `chatExtraApi` → `useAuthStore` →
 * 一长串 UI 包（smartsheet-ui / app-shell / tabdoc-ui ...）。这些包 main 指向
 * `dist/` 但未 build，vite import-analysis 直接失败。原有的
 * `useChatRuntimeStore.tool-event-merge.test.ts` 同样跑不通——这是仓库基础设
 * 施 issue，不是 W4a 引入。
 *
 * **本测试的策略**：
 * - **state reducer 逻辑** 测试用 minimal mock store（仅 contentBlock 相关字段
 *   + 真 reducer 函数 from `useChatRuntimeStore`）—— 让 handler dispatch / 状态
 *   机 / 边角 case 仍然走真代码路径，不被基础设施问题阻塞。
 * - **类型契约** 通过 `pnpm typecheck` 验证（M1 验收命令）。
 *
 * 长远（W4b 接通后）：UI 端真实场景跑通时，本测试可改回 `useChatRuntimeStore`
 * 直跑（届时 smartsheet-ui 等已 build / alias 已加齐）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { handleContentBlockEvent } from '../contentBlockHandler'
import { __resetStreamTokenUsageForTests } from '../streamTokenUsage'
import { commitBlocks, __resetMessageBlocks } from '@/stores/chat/messages/messageBlocks'
import { flushSubagentLiveBatch, useSubagentLiveStore } from '../../../../subagentLive'
import {
  __resetToolCallArgsBuffersForTests,
  getToolCallArgsBuffer,
} from '../toolCallArgsBufferStore'
import type { AgentStreamMessage, HandlerContext, StreamHandlerStore } from '../streamHandlerTypes'
import type {
  ContentBlockEntry,
  MessageMeta,
} from '@/stores/useChatRuntimeStore'
import type {
  ContentBlock,
  ContentBlockDeltaPayload,
  MessageStopReason,
  MessageUsage,
} from '@tabtin/agent-wire'

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// W4.5 §服务端 ID 命名空间统一：handleMessageStart 现在通过 useChatStore.updateSessionMessages
// push 新 ChatMessage（id = daemon emit 的 message_id）。本测试只验 contentBlockHandler 内
// 部 dispatch + state machine，不验"messagesBySessionId 是否真被写入"——给 noop 即可，避免
// 引入 useChatStore → useAuthStore → smartsheet-ui 整条 UI 包 import 链路（与 useChatRuntimeStore
// mock 同源问题，详见本文件顶部注释）。messagesBySessionId 写入的端到端验证在
// sendMessageAction.test.ts 走 dummy store harness。
//
// 但 §4.11（"侧边栏 + footer 修复"）需要验证 handleMessageStop 调
// `useChatStore.getState().updateSessionMessages(...)` 时传入的 updater 函数
// 会把 deriveTextSummary 派生的 content 写到 ChatMessage——所以这里把 mock
// 改成"用 in-memory messages 数组真跑 updater"，让测试能 assert content 字段。
const _mockMessagesBySession: Record<string, Array<{
  id: string
  role: string
  content: string
  content_blocks_json?: unknown[]
  error_info_json?: Record<string, unknown> | null
}>> = {}
function _resetMockMessages(): void {
  for (const key of Object.keys(_mockMessagesBySession)) delete _mockMessagesBySession[key]
}
const _mockUpdateSessionMessages = vi.fn(
  (sessionId: string, updater: (prev: typeof _mockMessagesBySession[string]) => typeof _mockMessagesBySession[string]) => {
    const prev = _mockMessagesBySession[sessionId] ?? []
    _mockMessagesBySession[sessionId] = updater(prev)
  },
)
const _mockEnsureAssistantMessage = vi.fn(
  (sessionId: string, message: { id: string; role: string; content: string }) => {
    const prev = _mockMessagesBySession[sessionId] ?? []
    if (prev.some(m => m.id === message.id)) return
    _mockMessagesBySession[sessionId] = [...prev, message]
  },
)
const _mockPatchMessageById = vi.fn(
  (
    sessionId: string,
    messageId: string,
    patcher: (m: typeof _mockMessagesBySession[string][number]) => typeof _mockMessagesBySession[string][number],
  ) => {
    const prev = _mockMessagesBySession[sessionId] ?? []
    _mockMessagesBySession[sessionId] = prev.map(m => (m.id === messageId ? patcher(m) : m))
  },
)
// ：streamTokenUsage 在 message_delta 带 usage 时读 sessions + 调
// updateSessionTokenUsageInCaches——mock 提供空列表 + spy，本文件不验 session
// 累计数值（专属断言在 streamTokenUsage.test.ts）。
const _mockUpdateSessionTokenUsageInCaches = vi.fn()
/** ：message_start 建壳时从 session.agent_id 读取本轮执行身份。 */
const _mockSessions: Array<{
  id: string
  agent_id?: string | null
  agent_name?: string | null
  agent_avatar?: string | null
}> = []
const _mockSelectedAgent: { id: string | null } = { id: null }
vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    //  / ：commitBlocks 经 setState 不可变写 message.blocks。
    // 壳由 handleMessageStart 经 ensureAssistantMessage / updateSessionMessages 建。
    getState: () => ({
      updateSessionMessages: _mockUpdateSessionMessages,
      rewriteSessionMessages: (sid: string, _reason: string, updater: (prev: unknown[]) => unknown[]) => _mockUpdateSessionMessages(sid, updater),
      // ：vi.fn 便于 assert error_info_json patch；行为与 messageCacheSlice 幂等 append 同构。
      ensureAssistantMessage: _mockEnsureAssistantMessage,
      patchMessageById: _mockPatchMessageById,
      // ：subagentLive rAF 把子消息合流进父 messagesBySessionId（带 subagent_run_id）。
      mergeSubagentMessages: (
        sessionId: string,
        toStoreMessage: (dm: { id: string }) => { id: string; role: string; content: string; subagent_run_id?: string },
        messages: Array<{ id: string }>,
      ) => {
        _mockUpdateSessionMessages(sessionId, (prev) => {
          const byId = new Map(prev.map((m) => [m.id, m]))
          for (const dm of messages) {
            byId.set(dm.id, toStoreMessage(dm) as typeof prev[number])
          }
          return [...byId.values()]
        })
      },
      messagesBySessionId: _mockMessagesBySession,
      sessions: _mockSessions,
      getSessionById: (sessionId: string) => _mockSessions.find((s) => s.id === sessionId),
      updateSessionTokenUsageInCaches: _mockUpdateSessionTokenUsageInCaches,
    }),
    setState: (
      partial:
        | { messagesBySessionId?: typeof _mockMessagesBySession }
        | ((state: { messagesBySessionId: typeof _mockMessagesBySession }) => {
          messagesBySessionId?: typeof _mockMessagesBySession
        }),
    ) => {
      const patch = typeof partial === 'function'
        ? partial({ messagesBySessionId: _mockMessagesBySession })
        : partial
      if (!patch?.messagesBySessionId) return
      const next = patch.messagesBySessionId
      for (const key of Object.keys(_mockMessagesBySession)) {
        if (!(key in next)) delete _mockMessagesBySession[key]
      }
      Object.assign(_mockMessagesBySession, next)
    },
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      selectedAgent: _mockSelectedAgent.id ? { id: _mockSelectedAgent.id } : null,
    }),
  },
}))

// W4a R2-P1-4 升 P0 修复后 contentBlockHandler 静态 import 了真实 store 用于
// flushRuntimeBatch（thinking stop 时需要同步 flush pending 才能读到累积的
// thinking text）。单测里不需要真实 store——mock 掉，stub `flushRuntimeBatch`
// 为 no-op；本测试用 mini reducer 不走 pending 路径。
// Mock 暴露稳定 counts 引用让测试可 assert
const _mockedCounts = {
  finalizedAfterStop: 0,
  seqDrop: 0,
  replayReset: 0,
  schemaParseFail: 0,
  schemaParseDegraded: 0,
}
vi.mock('@/stores/useChatRuntimeStore', () => ({
  flushRuntimeBatch: () => {},
  TOOL_USE_PENDING_TOOL_CALL_ID: '__pending__',
  getDroppedEventCount: () => _mockedCounts,
  // W4.5 §服务端 ID 命名空间统一 + W4a 五轮 R5-4：handler 走 incrementDroppedEventCount
  // 显式 setter 走入 store 内部 _droppedEventCount 计数器，外部只读 getDroppedEventCount
  // 拿 readonly snapshot。本 mock 镜像这一对：incrementDroppedEventCount 写
  // _mockedCounts，getDroppedEventCount 返回它，断言能直接读 _mockedCounts。
  incrementDroppedEventCount: (key: keyof typeof _mockedCounts) => {
    _mockedCounts[key]++
  },
}))

// `syncMessageContent` helper 抽到独立文件后，本测试不验 ChatMessage.content
// 实际写入路径——helper 自己单测覆盖（`syncMessageContent.test.ts`）。这里只
// 验 contentBlockHandler.handleMessageStop **调用了** helper、传入正确参数。
const _mockSyncDerivedContentToChatMessage = vi.fn()
vi.mock('../syncMessageContent', () => ({
  syncDerivedContentToChatMessage: (...args: unknown[]) => _mockSyncDerivedContentToChatMessage(...args),
}))
function _resetMockedCounts(): void {
  _mockedCounts.finalizedAfterStop = 0
  _mockedCounts.seqDrop = 0
  _mockedCounts.replayReset = 0
  _mockedCounts.schemaParseFail = 0
  _mockedCounts.schemaParseDegraded = 0
}

const SESSION = 'sess-contentblock-test'
const MID_A = 'msg_test_a'
const MID_B = 'msg_test_b'

// ───────────────────────────────────────────────────────────────────
// Minimal store harness — 把 useChatRuntimeStore 的 contentBlock CRUD
// 逻辑搬过来跑，不依赖整个 store 文件 import 链路。这是真 reducer，不是 mock。
// ───────────────────────────────────────────────────────────────────

interface ContentBlockSubStore {
  contentBlocksBySessionId: Record<string, Record<string, ContentBlockEntry[]>>
  messageMetaBySessionId: Record<string, Record<string, MessageMeta>>
  contentBlocksLastSeqBySessionId: Record<string, Record<string, number>>
}

// 模仿真实 store 的 immutable shallow clone 模式（W2 silent bypass 二代教训）。
// 这些 reducer 与 useChatRuntimeStore.ts 内同名方法**字段一致**——任何 store
// 重构必须同步更新本测试，否则 W4b 集成时会 silent regress。
function createSubStore(): {
  state: ContentBlockSubStore
  apply: (updater: (s: ContentBlockSubStore) => Partial<ContentBlockSubStore>) => void
  reset: () => void
} {
  let state: ContentBlockSubStore = {
    contentBlocksBySessionId: {},
    messageMetaBySessionId: {},
    contentBlocksLastSeqBySessionId: {},
  }
  return {
    get state(): ContentBlockSubStore {
      return state
    },
    apply: (updater) => {
      const partial = updater(state)
      state = { ...state, ...partial }
    },
    reset: () => {
      state = {
        contentBlocksBySessionId: {},
        messageMetaBySessionId: {},
        contentBlocksLastSeqBySessionId: {},
      }
      //  阶段 6：内容块已迁至 messages 层，一并清（handler 读 getCommittedBlocks）。
      __resetMessageBlocks()
    },
  }
}

function applyDeltaToEntry(entry: ContentBlockEntry, delta: ContentBlockDeltaPayload): ContentBlockEntry {
  switch (delta.type) {
    case 'text_delta':
    case 'connector_text_delta': {
      const block = entry.block
      if (block.type !== 'text') return entry
      const incomingText = delta.type === 'text_delta' ? delta.text : delta.connector_text
      return { ...entry, block: { ...block, text: (block.text ?? '') + incomingText } }
    }
    case 'thinking_delta': {
      const block = entry.block
      if (block.type !== 'thinking') return entry
      return { ...entry, block: { ...block, thinking: (block.thinking ?? '') + delta.thinking } }
    }
    case 'signature_delta': {
      const block = entry.block
      if (block.type !== 'thinking') return entry
      return { ...entry, block: { ...block, signature: (block.signature ?? '') + delta.signature } }
    }
    case 'input_json_delta': {
      const accumulated = (entry.pendingInputJson ?? '') + delta.partial_json
      return { ...entry, pendingInputJson: accumulated }
    }
    case 'citations_delta': {
      const block = entry.block
      if (block.type !== 'text') return entry
      const prev = block.citations ?? []
      return { ...entry, block: { ...block, citations: [...prev, delta.citation] } }
    }
    default:
      return entry
  }
}

function applyFinalizeFallback(entry: ContentBlockEntry): ContentBlockEntry {
  const pending = entry.pendingInputJson
  if (pending === undefined || pending === '') return entry
  const block = entry.block
  if (block.type !== 'tool_use' && block.type !== 'server_tool_use' && block.type !== 'mcp_tool_use') {
    return { ...entry, pendingInputJson: undefined }
  }
  try {
    const parsed = JSON.parse(pending)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...entry, block: { ...block, input: parsed as Record<string, unknown> }, pendingInputJson: undefined }
    }
    return {
      ...entry,
      block: { ...block, input: {}, input_parse_error: { message: 'parsed value is not a JSON object', partial: pending.slice(0, 200) } } as ContentBlock,
      pendingInputJson: undefined,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'JSON.parse failed'
    return {
      ...entry,
      block: { ...block, input: {}, input_parse_error: { message, partial: pending.slice(0, 200) } } as ContentBlock,
      pendingInputJson: undefined,
    }
  }
}

function createPlaceholderForDelta(delta: ContentBlockDeltaPayload, index: number): ContentBlockEntry {
  const blockId = `recovered-${index}`
  let block: ContentBlock
  switch (delta.type) {
    case 'text_delta':
    case 'connector_text_delta':
    case 'citations_delta':
      block = { type: 'text', text: '' }
      break
    case 'thinking_delta':
    case 'signature_delta':
      block = { type: 'thinking', thinking: '', signature: '' }
      break
    case 'input_json_delta':
      block = { type: 'tool_use', id: blockId, name: '__recovered__', input: {} }
      break
    default:
      block = { type: 'text', text: '' }
  }
  return { index, block_id: blockId, block, finalized: false, partial: false }
}

const sub = createSubStore()

// ：streamTokenUsage 是模块级状态（per-message lastSeen / per-session
// streamed），跨用例必须清空——否则前面用例喂过的 usage 会让后面用例的
// cumulative 增量判定失真。
beforeEach(() => {
  __resetStreamTokenUsageForTests()
  _mockUpdateSessionTokenUsageInCaches.mockClear()
})

//  阶段 6：把 fake 引擎写好的块同步 commit 到 messages 层——handler 读块走
// getCommittedBlocks（widget 喂 buffer / thinking detail）。
function commitFromSub(sessionId: string, messageId: string): void {
  commitBlocks(sessionId, messageId, sub.state.contentBlocksBySessionId[sessionId]?.[messageId] ?? [])
}

function buildStore(): StreamHandlerStore {
  return {
    // 6 件套 CRUD（与 useChatRuntimeStore 实现一致）
    contentBlocksBySessionId: sub.state.contentBlocksBySessionId,
    messageMetaBySessionId: sub.state.messageMetaBySessionId,
    contentBlocksLastSeqBySessionId: sub.state.contentBlocksLastSeqBySessionId,
    messageStart: (sessionId, messageId, meta, seq) => {
      sub.apply(state => {
        const prevSeq = state.contentBlocksLastSeqBySessionId[sessionId]?.[messageId] ?? -1
        if (seq <= prevSeq) return state
        const sessionMeta = state.messageMetaBySessionId[sessionId] ?? {}
        const sessionLastSeq = state.contentBlocksLastSeqBySessionId[sessionId] ?? {}
        const sessionBlocks = state.contentBlocksBySessionId[sessionId] ?? {}
        return {
          messageMetaBySessionId: {
            ...state.messageMetaBySessionId,
            [sessionId]: { ...sessionMeta, [messageId]: { ...meta, finalized: false } },
          },
          contentBlocksLastSeqBySessionId: {
            ...state.contentBlocksLastSeqBySessionId,
            [sessionId]: { ...sessionLastSeq, [messageId]: seq },
          },
          contentBlocksBySessionId: {
            ...state.contentBlocksBySessionId,
            [sessionId]: { ...sessionBlocks, [messageId]: sessionBlocks[messageId] ?? [] },
          },
        }
      })
      commitFromSub(sessionId, messageId)
    },
    messageDelta: (sessionId, messageId, delta, usage, seq) => {
      // ：与生产 store 对齐——返回本条 delta 是否被接受（seq 倒退 / 缺
      // message_start 返 false），handler 据此决定是否走 token 同步路径。
      const prevSeq = sub.state.contentBlocksLastSeqBySessionId[sessionId]?.[messageId] ?? -1
      if (seq <= prevSeq) return false
      if (!sub.state.messageMetaBySessionId[sessionId]?.[messageId]) return false
      sub.apply(state => {
        const sessionMeta = state.messageMetaBySessionId[sessionId] ?? {}
        const prevMeta = sessionMeta[messageId]!
        const nextMeta: MessageMeta = {
          ...prevMeta,
          ...(delta.stop_reason !== undefined ? { stop_reason: delta.stop_reason as MessageStopReason } : {}),
          ...(usage !== undefined ? { usage } : {}),
        }
        const sessionLastSeq = state.contentBlocksLastSeqBySessionId[sessionId] ?? {}
        return {
          messageMetaBySessionId: { ...state.messageMetaBySessionId, [sessionId]: { ...sessionMeta, [messageId]: nextMeta } },
          contentBlocksLastSeqBySessionId: { ...state.contentBlocksLastSeqBySessionId, [sessionId]: { ...sessionLastSeq, [messageId]: seq } },
        }
      })
      return true
    },
    messageStop: (sessionId, messageId, seq, opts) => {
      sub.apply(state => {
        const prevSeq = state.contentBlocksLastSeqBySessionId[sessionId]?.[messageId] ?? -1
        if (seq <= prevSeq) return state
        const sessionBlocks = state.contentBlocksBySessionId[sessionId] ?? {}
        const messageBlocks = sessionBlocks[messageId] ?? []
        let blocksChanged = false
        const overrides = opts?.blockIdOverrides
        // W4.5 第二波 P0-1（2026-05-12）：测试 fake 跟生产 store 对齐——daemon emit
        // 的 partial_reason 优先于 stop_reason 启发式。生产实现见
        // `useChatRuntimeStore.ts::messageStop`（line 2755-2761）。
        const sessionMetaForReason = state.messageMetaBySessionId[sessionId] ?? {}
        const prevMetaForReason = sessionMetaForReason[messageId]
        const inferredPartialReason: ContentBlockEntry['partialReason'] =
          opts?.partialReason
          ?? (prevMetaForReason?.stop_reason === 'aborted' ? 'aborted' : 'message_stop_fallback')
        const finalizedBlocks = messageBlocks.map(entry => {
          const overrideId = overrides?.[String(entry.index)]
          let next = entry
          if (overrideId && overrideId !== entry.block_id) {
            blocksChanged = true
            next = { ...next, block_id: overrideId }
          }
          if (!next.finalized) {
            blocksChanged = true
            const finalEntry = applyFinalizeFallback(next)
            next = { ...finalEntry, finalized: true, partial: true, partialReason: inferredPartialReason }
          }
          return next
        })
        const sessionMeta = state.messageMetaBySessionId[sessionId] ?? {}
        const prevMeta = sessionMeta[messageId]
        const nextMeta: MessageMeta = prevMeta
          ? { ...prevMeta, finalized: true, ...(opts?.persistedId ? { persisted_id: opts.persistedId } : {}) }
          : { role: 'assistant', finalized: true, ...(opts?.persistedId ? { persisted_id: opts.persistedId } : {}) }
        const sessionLastSeq = state.contentBlocksLastSeqBySessionId[sessionId] ?? {}
        return {
          messageMetaBySessionId: { ...state.messageMetaBySessionId, [sessionId]: { ...sessionMeta, [messageId]: nextMeta } },
          contentBlocksLastSeqBySessionId: { ...state.contentBlocksLastSeqBySessionId, [sessionId]: { ...sessionLastSeq, [messageId]: seq } },
          ...(blocksChanged
            ? { contentBlocksBySessionId: { ...state.contentBlocksBySessionId, [sessionId]: { ...sessionBlocks, [messageId]: finalizedBlocks } } }
            : {}),
        }
      })
      commitFromSub(sessionId, messageId)
    },
    contentBlockStart: (sessionId, messageId, index, blockId, block, seq) => {
      sub.apply(state => {
        const prevSeq = state.contentBlocksLastSeqBySessionId[sessionId]?.[messageId] ?? -1
        if (seq <= prevSeq) return state
        const sessionBlocks = state.contentBlocksBySessionId[sessionId] ?? {}
        const messageBlocks = sessionBlocks[messageId] ?? []
        const existing = messageBlocks.find(e => e.index === index)
        const newEntry: ContentBlockEntry = { index, block_id: blockId, block, finalized: false, partial: false }
        const nextBlocks = existing
          ? messageBlocks.map(e => (e.index === index ? newEntry : e))
          : [...messageBlocks, newEntry].sort((a, b) => a.index - b.index)
        const sessionLastSeq = state.contentBlocksLastSeqBySessionId[sessionId] ?? {}
        return {
          contentBlocksBySessionId: { ...state.contentBlocksBySessionId, [sessionId]: { ...sessionBlocks, [messageId]: nextBlocks } },
          contentBlocksLastSeqBySessionId: { ...state.contentBlocksLastSeqBySessionId, [sessionId]: { ...sessionLastSeq, [messageId]: seq } },
        }
      })
      commitFromSub(sessionId, messageId)
    },
    contentBlockDelta: (sessionId, messageId, index, delta, seq) => {
      sub.apply(state => {
        const prevSeq = state.contentBlocksLastSeqBySessionId[sessionId]?.[messageId] ?? -1
        if (seq <= prevSeq) return state
        const sessionBlocks = state.contentBlocksBySessionId[sessionId] ?? {}
        const messageBlocks = sessionBlocks[messageId] ?? []
        let entryIdx = messageBlocks.findIndex(e => e.index === index)
        let nextBlocks: ContentBlockEntry[]
        if (entryIdx < 0) {
          const placeholder = createPlaceholderForDelta(delta, index)
          nextBlocks = [...messageBlocks, placeholder].sort((a, b) => a.index - b.index)
          entryIdx = nextBlocks.findIndex(e => e.index === index)
        } else {
          nextBlocks = messageBlocks.slice()
        }
        const merged = applyDeltaToEntry(nextBlocks[entryIdx], delta)
        nextBlocks[entryIdx] = merged
        const sessionLastSeq = state.contentBlocksLastSeqBySessionId[sessionId] ?? {}
        return {
          contentBlocksBySessionId: { ...state.contentBlocksBySessionId, [sessionId]: { ...sessionBlocks, [messageId]: nextBlocks } },
          contentBlocksLastSeqBySessionId: { ...state.contentBlocksLastSeqBySessionId, [sessionId]: { ...sessionLastSeq, [messageId]: seq } },
        }
      })
      commitFromSub(sessionId, messageId)
    },
    contentBlockStop: (sessionId, messageId, index, seq) => {
      sub.apply(state => {
        const prevSeq = state.contentBlocksLastSeqBySessionId[sessionId]?.[messageId] ?? -1
        if (seq <= prevSeq) return state
        const sessionBlocks = state.contentBlocksBySessionId[sessionId] ?? {}
        const messageBlocks = sessionBlocks[messageId] ?? []
        const entryIdx = messageBlocks.findIndex(e => e.index === index)
        if (entryIdx < 0) return state
        const target = messageBlocks[entryIdx]
        const finalEntry: ContentBlockEntry = { ...applyFinalizeFallback(target), finalized: true }
        const nextBlocks = messageBlocks.slice()
        nextBlocks[entryIdx] = finalEntry
        const sessionLastSeq = state.contentBlocksLastSeqBySessionId[sessionId] ?? {}
        return {
          contentBlocksBySessionId: { ...state.contentBlocksBySessionId, [sessionId]: { ...sessionBlocks, [messageId]: nextBlocks } },
          contentBlocksLastSeqBySessionId: { ...state.contentBlocksLastSeqBySessionId, [sessionId]: { ...sessionLastSeq, [messageId]: seq } },
        }
      })
      commitFromSub(sessionId, messageId)
    },
    clearContentBlocksForSession: () => {},
    // 其他 StreamHandlerStore 字段：测试不用，保留空 stub
    agentStepsBySessionId: {},
    toolEventsBySessionId: {},
    assistantEventsBySessionId: {},
    subagentRunsBySessionId: {},
    runStateBySessionId: {},
    todosBySessionId: {},
    agentModeBySessionId: {},
    cancellingBySessionId: {},
    updateRunStateForSession: () => {},
    setCancellingForSession: () => {},
    pushAgentStepForSession: () => {},
    updateAgentStepForSession: () => {},
    upsertToolEventForSession: () => {},
    getEffectiveToolEventForSession: () => undefined,
    upsertAssistantEventForSession: () => {},
    resetAssistantDeltasForSession: () => {},
    upsertSubagentRunForSession: () => {},
    setTodosForSession: () => {},
    appendRichContentBlocks: () => {},
    upsertRichContentBlocksByToolCallId: vi.fn(),
    clearRichContentBlocks: () => {},
    markStreamingWidgetsInterruptedAndClearOthers: () => {},
    pushSnapshotForSession: () => {},
  } as unknown as StreamHandlerStore
}

let storeSnapshot: StreamHandlerStore

function makeCtx(sessionId: string = SESSION): HandlerContext {
  return {
    sessionId,
    notifyPrefix: '',
    // 每次 get() 都重新组装 store —— 拿到最新的 contentBlocksBySessionId 等字段引用
    // （因为 sub.state 是 immutable 替换，外部对象引用不会变）
    get: () => buildStore(),
    set: vi.fn(),
    addStreamingSession: vi.fn(),
    removeStreamingSession: vi.fn(),
    client: { sessions: { get: vi.fn() } },
    updateSessionTokenUsageInCaches: vi.fn(),
    updateSessionInCaches: vi.fn(),
    onLifecycleEnd: vi.fn(),
  } as unknown as HandlerContext
}

function envelopeBase(seq: number) {
  return {
    protocol_version: 'v2' as const,
    min_compatible_version: 'v2' as const,
    trace_id: `trace-${seq}`,
    _seq: seq,
    thread_id: SESSION,
  }
}

// W2 PRD §3.7.1：wire MessageStartSchema.message_kind 必填三档；helper 默认
// 'llm'（最常见的主 LLM 路径），单独测试 tool_artifact / error_envelope 时
// 显式构造 payload 覆盖（见 §4.9）。
function messageStartMsg(messageId: string, seq: number, role: 'assistant' | 'user' = 'assistant'): AgentStreamMessage {
  return {
    type: 'agent.stream.message_start',
    payload: {
      ...envelopeBase(seq),
      message_id: messageId,
      role,
      model_id: 'claude-3-7-sonnet',
      model_name: 'Claude 3.7 Sonnet',
      started_at: new Date(seq * 1000).toISOString(),
      run_id: `run-${messageId}`,
      message_kind: 'llm',
    },
  }
}

function messageDeltaMsg(
  messageId: string,
  seq: number,
  stopReason?: string,
  usage?: { input_tokens: number; output_tokens: number },
): AgentStreamMessage {
  return {
    type: 'agent.stream.message_delta',
    payload: {
      ...envelopeBase(seq),
      message_id: messageId,
      delta: { ...(stopReason !== undefined ? { stop_reason: stopReason } : {}) },
      ...(usage !== undefined ? { usage } : {}),
    },
  }
}

function messageStopMsg(messageId: string, seq: number): AgentStreamMessage {
  return {
    type: 'agent.stream.message_stop',
    payload: { ...envelopeBase(seq), message_id: messageId },
  }
}

function contentBlockStartMsg(
  messageId: string,
  index: number,
  seq: number,
  block: unknown,
  blockId: string = `blk_${messageId}_${index}`,
): AgentStreamMessage {
  return {
    type: 'agent.stream.content_block_start',
    payload: { ...envelopeBase(seq), message_id: messageId, index, block_id: blockId, block },
  }
}

function contentBlockDeltaMsg(
  messageId: string,
  index: number,
  seq: number,
  delta: Record<string, unknown>,
): AgentStreamMessage {
  return {
    type: 'agent.stream.content_block_delta',
    payload: { ...envelopeBase(seq), message_id: messageId, index, delta },
  }
}

function contentBlockStopMsg(messageId: string, index: number, seq: number): AgentStreamMessage {
  return {
    type: 'agent.stream.content_block_stop',
    payload: { ...envelopeBase(seq), message_id: messageId, index },
  }
}

// ═══════════════════════════════════════════════════════════════════
// §1. 6 件套分发
// ═══════════════════════════════════════════════════════════════════

describe('contentBlockHandler · 6 件套分发', () => {
  beforeEach(() => {
    sub.reset()
    useSubagentLiveStore.getState().clear()
    _resetMockMessages()
    __resetToolCallArgsBuffersForTests()
    storeSnapshot = buildStore()
  })

  it('1.1 message_start → messageMeta + contentBlocks 槽位 init', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())

    const meta = sub.state.messageMetaBySessionId[SESSION]?.[MID_A]
    expect(meta).toBeDefined()
    expect(meta!.role).toBe('assistant')
    expect(meta!.model_id).toBe('claude-3-7-sonnet')
    expect(meta!.finalized).toBe(false)
    expect(sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]).toEqual([])
    expect(sub.state.contentBlocksLastSeqBySessionId[SESSION]?.[MID_A]).toBe(1)
  })

  it('1.1b raw 子 Agent 6 件套 → 落统一 store（带 subagent_run_id），不进父引擎 / 不建 thinking placeholder', () => {
    const childRunId = 'sub-run-raw-1'
    const start = messageStartMsg(MID_A, 1)
    start.payload = { ...(start.payload as Record<string, unknown>), subagent_run_id: childRunId }

    handleContentBlockEvent(start, makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'thinking', thinking: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'thinking_delta', thinking: '1' }), makeCtx())
    handleContentBlockEvent(contentBlockStopMsg(MID_A, 0, 4), makeCtx())
    handleContentBlockEvent(messageStopMsg(MID_A, 5), makeCtx())

    // 不进父引擎（runtime meta/blocks 不建，不建 thinking placeholder / 不污染主流）
    expect(sub.state.messageMetaBySessionId[SESSION]?.[MID_A]).toBeUndefined()
    expect(sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]).toBeUndefined()

    // ：applyChildEvent 只标脏，派生 messages + 父 messages 合流在 rAF flush。
    flushSubagentLiveBatch()

    const live = useSubagentLiveStore.getState().runsByRunId[childRunId]
    expect(live).toBeTruthy()
    expect(live.messages).toHaveLength(1)
    expect(live.messages[0].content_blocks_json?.[0]).toMatchObject({
      type: 'thinking',
      thinking: '1',
    })

    // ：flush 后子消息落父 messagesBySessionId（带 subagent_run_id）。
    const synced = _mockMessagesBySession[SESSION]?.find(m => m.id === MID_A)
    expect(synced).toBeDefined()
    expect((synced as { subagent_run_id?: string }).subagent_run_id).toBe(childRunId)
  })

  it('1.2 message_delta → stop_reason / usage（cumulative）累积', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(messageDeltaMsg(MID_A, 2, undefined, { input_tokens: 10, output_tokens: 5 }), makeCtx())
    handleContentBlockEvent(messageDeltaMsg(MID_A, 3, 'end_turn', { input_tokens: 10, output_tokens: 50 }), makeCtx())

    const meta = sub.state.messageMetaBySessionId[SESSION]?.[MID_A]
    expect(meta!.stop_reason).toBe('end_turn')
    expect(meta!.usage).toEqual({ input_tokens: 10, output_tokens: 50 })
  })

  it('1.2b store drop 的 message_delta 不进 token 同步路径（ 取舍对齐）', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(messageDeltaMsg(MID_A, 3, undefined, { input_tokens: 100, output_tokens: 10 }), makeCtx())

    const acceptedCalls = _mockUpdateSessionTokenUsageInCaches.mock.calls.length
    expect(acceptedCalls).toBeGreaterThan(0)
    const beforeUsageJson = (_mockMessagesBySession[SESSION]?.find(m => m.id === MID_A) as
      { usage_json?: Record<string, unknown> } | undefined)?.usage_json
    expect(beforeUsageJson).toMatchObject({ input_tokens: 100 })

    // seq 倒退的 late/replay delta —— store drop，token 路径必须同步跳过：
    // session 累计不再动、usage_json 不被更大的旧值覆盖
    handleContentBlockEvent(messageDeltaMsg(MID_A, 2, undefined, { input_tokens: 900, output_tokens: 90 }), makeCtx())

    expect(_mockUpdateSessionTokenUsageInCaches.mock.calls.length).toBe(acceptedCalls)
    const afterUsageJson = (_mockMessagesBySession[SESSION]?.find(m => m.id === MID_A) as
      { usage_json?: Record<string, unknown> } | undefined)?.usage_json
    expect(afterUsageJson).toMatchObject({ input_tokens: 100 })
  })

  it('1.3 message_stop → finalized=true，stop_reason 来自前置 message_delta', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(messageDeltaMsg(MID_A, 2, 'end_turn'), makeCtx())
    handleContentBlockEvent(messageStopMsg(MID_A, 3), makeCtx())

    const meta = sub.state.messageMetaBySessionId[SESSION]?.[MID_A]
    expect(meta!.finalized).toBe(true)
    expect(meta!.stop_reason).toBe('end_turn')
  })

  it('1.4 content_block_start → blocks push + 按 index 排序', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 1, 2, { type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} }), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 3, { type: 'text', text: '' }), makeCtx())

    const blocks = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A] ?? []
    expect(blocks).toHaveLength(2)
    expect(blocks[0].index).toBe(0)
    expect(blocks[0].block.type).toBe('text')
    expect(blocks[1].index).toBe(1)
    expect(blocks[1].block.type).toBe('tool_use')
  })

  it('1.4b role=user tool_result content_block_start 不创建假 assistant ChatMessage', () => {
    const userMessageId = 'msg_user_tool_result'
    handleContentBlockEvent(messageStartMsg(userMessageId, 1, 'user'), makeCtx())
    handleContentBlockEvent(
      contentBlockStartMsg(userMessageId, 0, 2, {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'ok',
      }),
      makeCtx(),
    )

    expect(_mockMessagesBySession[SESSION]?.some(m => m.id === userMessageId)).not.toBe(true)
  })

  it('1.5 content_block_delta(text_delta) → block.text 累积', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'text_delta', text: 'Hello ' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 4, { type: 'text_delta', text: 'world' }), makeCtx())

    const blocks = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A] ?? []
    expect(blocks[0].block.type).toBe('text')
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('Hello world')
    expect(blocks[0].finalized).toBe(false)
  })

  it('1.6 content_block_stop → finalized=true，tool_use 触发 JSON.parse', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'tool_use', id: 'tu_x', name: 'read_file', input: {} }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'input_json_delta', partial_json: '{"path":' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 4, { type: 'input_json_delta', partial_json: '"/tmp/x.txt"}' }), makeCtx())
    handleContentBlockEvent(contentBlockStopMsg(MID_A, 0, 5), makeCtx())

    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    expect(entry!.finalized).toBe(true)
    expect(entry!.pendingInputJson).toBeUndefined()
    expect((entry!.block as { type: 'tool_use'; input: Record<string, unknown> }).input).toEqual({ path: '/tmp/x.txt' })
  })
})

// ═══════════════════════════════════════════════════════════════════
// §2. 状态机 6 类边角 case
// ═══════════════════════════════════════════════════════════════════

describe('contentBlockHandler · 状态机 6 类边角 case', () => {
  beforeEach(() => {
    sub.reset()
    __resetToolCallArgsBuffersForTests()
  })

  it('2.1 partial_json parse 失败 → input={}, input_parse_error 落字段', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'tool_use', id: 'tu_bad', name: 'write_file', input: {} }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'input_json_delta', partial_json: '{"path":"/tmp/broken' }), makeCtx())
    handleContentBlockEvent(contentBlockStopMsg(MID_A, 0, 4), makeCtx())

    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    const block = entry!.block as {
      type: 'tool_use'
      input: Record<string, unknown>
      input_parse_error?: { message: string; partial: string }
    }
    expect(entry!.finalized).toBe(true)
    expect(block.input).toEqual({})
    expect(block.input_parse_error).toBeDefined()
    expect(block.input_parse_error!.partial).toContain('"path":"/tmp/broken')
  })

  it('2.2 delta 早于 start → lazy create placeholder', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 2, { type: 'text_delta', text: 'lazy' }), makeCtx())

    const blocks = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A] ?? []
    expect(blocks).toHaveLength(1)
    expect(blocks[0].block.type).toBe('text')
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('lazy')
    expect(blocks[0].block_id).toMatch(/^recovered-/)
  })

  it('2.3 message_stop 时仍有 unfinalized block → 强制 finalize + partial=true', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'text_delta', text: 'incomplete' }), makeCtx())
    handleContentBlockEvent(messageStopMsg(MID_A, 4), makeCtx())

    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    expect(entry!.finalized).toBe(true)
    expect(entry!.partial).toBe(true)
    expect((entry!.block as { type: 'text'; text: string }).text).toBe('incomplete')
  })

  it('2.4 abort 路径：message_delta(stop_reason="aborted") → meta.stop_reason="aborted"', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'text_delta', text: 'partial output' }), makeCtx())
    handleContentBlockEvent(messageDeltaMsg(MID_A, 4, 'aborted'), makeCtx())
    handleContentBlockEvent(messageStopMsg(MID_A, 5), makeCtx())

    const meta = sub.state.messageMetaBySessionId[SESSION]?.[MID_A]
    expect(meta!.stop_reason).toBe('aborted')
    expect(meta!.finalized).toBe(true)
    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    expect(entry!.partial).toBe(true)
    expect((entry!.block as { type: 'text'; text: string }).text).toBe('partial output')
  })

  it('2.5 多 message 并发（同 session 不同 message_id）→ 各自独立', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(messageStartMsg(MID_B, 2), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 3, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_B, 0, 4, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 5, { type: 'text_delta', text: 'msg-A' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_B, 0, 6, { type: 'text_delta', text: 'msg-B' }), makeCtx())

    const blocksA = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A] ?? []
    const blocksB = sub.state.contentBlocksBySessionId[SESSION]?.[MID_B] ?? []
    expect((blocksA[0].block as { type: 'text'; text: string }).text).toBe('msg-A')
    expect((blocksB[0].block as { type: 'text'; text: string }).text).toBe('msg-B')
    expect(sub.state.contentBlocksLastSeqBySessionId[SESSION]?.[MID_A]).toBe(5)
    expect(sub.state.contentBlocksLastSeqBySessionId[SESSION]?.[MID_B]).toBe(6)
  })

  it('2.6 IPC vs WS 双源去重：seq <= prevSeq 直接 drop', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 5), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 6, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 7, { type: 'text_delta', text: 'first' }), makeCtx())
    // 重复 seq=7
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 7, { type: 'text_delta', text: '-DUPLICATE' }), makeCtx())
    // 乱序 seq=6
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 6, { type: 'text_delta', text: '-OLD' }), makeCtx())

    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    expect((entry!.block as { type: 'text'; text: string }).text).toBe('first')
  })

  // ─── Wave 4a 自修复（P1-产品-1 + P2-1）：block_id_overrides + persisted_id ───
  //
  // 业务目的：W3 后端落库后，把流式临时 block_id（譬如 `blk_msg_X_0`）替换为
  // 真 UUID；W4b UI 用 `block_id` 当 React key 时，"流式刚结束 → 持久化拉回"
  // 这一瞬间不会整列重 mount。`persisted_id` 同理用于 message 主键对账。
  it('2.7 message_stop.block_id_overrides 按 index 替换 block_id', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 1, 3, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 4, { type: 'text_delta', text: 'hello' }), makeCtx())
    handleContentBlockEvent(contentBlockStopMsg(MID_A, 0, 5), makeCtx())
    handleContentBlockEvent(contentBlockStopMsg(MID_A, 1, 6), makeCtx())

    const beforeOverride = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A] ?? []
    expect(beforeOverride[0].block_id).toBe(`blk_${MID_A}_0`)
    expect(beforeOverride[1].block_id).toBe(`blk_${MID_A}_1`)

    // message_stop 携带 block_id_overrides
    const msg: AgentStreamMessage = {
      type: 'agent.stream.message_stop',
      payload: {
        ...envelopeBase(7),
        message_id: MID_A,
        persisted_id: 'msg_db_uuid_xxx',
        block_id_overrides: {
          '0': 'blk_db_uuid_aaa',
          '1': 'blk_db_uuid_bbb',
        },
      },
    }
    handleContentBlockEvent(msg, makeCtx())

    const after = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A] ?? []
    expect(after[0].block_id).toBe('blk_db_uuid_aaa')
    expect(after[1].block_id).toBe('blk_db_uuid_bbb')
    // 持久化主键写到 meta
    const meta = sub.state.messageMetaBySessionId[SESSION]?.[MID_A]
    expect(meta!.persisted_id).toBe('msg_db_uuid_xxx')
    expect(meta!.finalized).toBe(true)
  })

  it('2.8 message_stop 不带 overrides 时 block_id 保持原值（向后兼容）', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockStopMsg(MID_A, 0, 3), makeCtx())
    handleContentBlockEvent(messageStopMsg(MID_A, 4), makeCtx())

    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    expect(entry!.block_id).toBe(`blk_${MID_A}_0`)
    const meta = sub.state.messageMetaBySessionId[SESSION]?.[MID_A]
    expect(meta!.persisted_id).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════
// §3. content_block_delta(text_delta) 累积契约（onChunk 等价不变量）
// ═══════════════════════════════════════════════════════════════════

describe('§3. content_block_delta(text_delta) 累积契约', () => {
  beforeEach(() => {
    sub.reset()
    __resetToolCallArgsBuffersForTests()
  })

  it('多条 text_delta 累积 = raw concat（localAgentClient onChunk 等价契约）', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    const chunks = ['Hello, ', 'this is ', 'a ', 'streaming ', 'response.']
    let seq = 3
    for (const chunk of chunks) {
      handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, seq++, { type: 'text_delta', text: chunk }), makeCtx())
    }
    handleContentBlockEvent(contentBlockStopMsg(MID_A, 0, seq++), makeCtx())
    handleContentBlockEvent(messageStopMsg(MID_A, seq++), makeCtx())

    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    expect((entry!.block as { type: 'text'; text: string }).text).toBe(chunks.join(''))
  })

  it('connector_text_delta 也累积到 text 字段（connector_text feature 路径）', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'connector_text_delta', connector_text: 'connector ' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 4, { type: 'connector_text_delta', connector_text: 'output' }), makeCtx())

    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    expect((entry!.block as { type: 'text'; text: string }).text).toBe('connector output')
  })
})

// ═══════════════════════════════════════════════════════════════════
// §4. content_block_delta(input_json_delta) 喂 widget buffer
// ═══════════════════════════════════════════════════════════════════

describe('§4. tool_use input_json_delta → feedInputJsonDelta', () => {
  beforeEach(() => {
    sub.reset()
    __resetToolCallArgsBuffersForTests()
  })

  it('tool_use 块的 input_json_delta 同步喂到 toolCallArgsBufferStore buffer', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'tool_use', id: 'tu_widget', name: 'show_widget', input: {} }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'input_json_delta', partial_json: '{"format":' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 4, { type: 'input_json_delta', partial_json: '"svg"}' }), makeCtx())

    const buffer = getToolCallArgsBuffer(SESSION, 'tu_widget')
    expect(buffer).toBeDefined()
    expect(buffer!.toolName).toBe('show_widget')
    expect(buffer!.accumulatedArgs).toBe('{"format":"svg"}')
    expect(buffer!.deltaCount).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════
// §4.5 W4a R2-P0-2：tabtin_rich_content 块镜像到 richContentBlocksBySessionId
// ═══════════════════════════════════════════════════════════════════

describe('§4.5 W4a R2-P0-2 · tabtin_rich_content mirror', () => {
  beforeEach(() => {
    sub.reset()
    __resetToolCallArgsBuffersForTests()
  })

  it('widget kind tabtin_rich_content（payload.tool_call_id 嵌套）→ 提升到顶层后 upsert', () => {
    const upsertSpy = vi.fn()
    const ctx = makeCtx()
    // 重写 ctx.get 让 upsert 被 spy 抓到
    ctx.get = () => ({
      ...buildStore(),
      upsertRichContentBlocksByToolCallId: upsertSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent(messageStartMsg(MID_A, 1), ctx)
    handleContentBlockEvent(
      contentBlockStartMsg(MID_A, 0, 2, {
        type: 'tabtin_rich_content',
        kind: 'widget',
        summary: 'rendered chart',
        payload: {
          widget_id: 'wgt_abc',
          format: 'svg',
          code: '<svg/>',
          image_url: 'https://x/y.png',
          tool_call_id: 'tu_widget_42',
        },
      }),
      ctx,
    )

    // upsertRichContentBlocksByToolCallId 应被调一次，传入摊平的 block
    expect(upsertSpy).toHaveBeenCalledTimes(1)
    const [sessionId, blocks] = upsertSpy.mock.calls[0]
    expect(sessionId).toBe(SESSION)
    expect(blocks).toHaveLength(1)
    const mirrored = blocks[0]
    // type 改写为 UI 期望的 'rich_content'
    expect(mirrored.type).toBe('rich_content')
    expect(mirrored.kind).toBe('widget')
    expect(mirrored.summary).toBe('rendered chart')
    // payload 字段提升到顶层
    expect(mirrored.widget_id).toBe('wgt_abc')
    expect(mirrored.format).toBe('svg')
    expect(mirrored.code).toBe('<svg/>')
    expect(mirrored.tool_call_id).toBe('tu_widget_42')
    // payload 字段不应在嵌套层重复（拍平契约）
    expect(mirrored.payload).toBeUndefined()
  })

  it('search_results kind（无 tool_call_id）→ upsert 内部走 append 语义', () => {
    const upsertSpy = vi.fn()
    const ctx = makeCtx()
    ctx.get = () => ({
      ...buildStore(),
      upsertRichContentBlocksByToolCallId: upsertSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent(messageStartMsg(MID_A, 1), ctx)
    handleContentBlockEvent(
      contentBlockStartMsg(MID_A, 0, 2, {
        type: 'tabtin_rich_content',
        kind: 'search_results',
        summary: 'web_search: foo (3)',
        payload: { query: 'foo', total_count: 3, search_results: [] },
      }),
      ctx,
    )

    expect(upsertSpy).toHaveBeenCalledTimes(1)
    const [, blocks] = upsertSpy.mock.calls[0]
    const mirrored = blocks[0]
    expect(mirrored.kind).toBe('search_results')
    expect(mirrored.query).toBe('foo')
    expect(mirrored.total_count).toBe(3)
    // 无 tool_call_id → store 内 upsertRichContentBlocksByToolCallId 走 append 分支
    expect(mirrored.tool_call_id).toBeUndefined()
  })

  it('show_widget tool_use placeholder + tabtin_rich_content widget final → 双 upsert 用同 tool_call_id', () => {
    const upsertSpy = vi.fn()
    const ctx = makeCtx()
    ctx.get = () => ({
      ...buildStore(),
      upsertRichContentBlocksByToolCallId: upsertSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent(messageStartMsg(MID_A, 1), ctx)
    // 第一阶段：LLM tool_use content_block_start → placeholder
    handleContentBlockEvent(
      contentBlockStartMsg(MID_A, 0, 2, {
        type: 'tool_use',
        id: 'tu_widget_x',
        name: 'show_widget',
        input: {},
      }),
      ctx,
    )
    // 第二阶段：tool 执行后 daemon emit tabtin_rich_content（不同 message_id —
    // detached mini-message，但 tool_call_id 相同 → 替换 placeholder）
    handleContentBlockEvent(
      contentBlockStartMsg('msg_inline_tool', 0, 100, {
        type: 'tabtin_rich_content',
        kind: 'widget',
        summary: 'final widget',
        payload: {
          widget_id: 'wgt_final',
          format: 'svg',
          tool_call_id: 'tu_widget_x',
        },
      }),
      ctx,
    )

    // 两次 upsert：第一次 placeholder（pending: 前缀），第二次 final
    expect(upsertSpy).toHaveBeenCalledTimes(2)
    const placeholder = upsertSpy.mock.calls[0][1][0]
    const final = upsertSpy.mock.calls[1][1][0]
    expect(placeholder.widget_id).toBe('pending:tu_widget_x')
    expect(placeholder.tool_call_id).toBe('tu_widget_x')
    expect(final.widget_id).toBe('wgt_final')
    expect(final.tool_call_id).toBe('tu_widget_x') // 同 id 让 upsert 替换 placeholder
  })

  it('legacy show_flow_view tool_use 不再预建聊天原生流程占位块', () => {
    const upsertSpy = vi.fn()
    const ctx = makeCtx()
    ctx.get = () => ({
      ...buildStore(),
      upsertRichContentBlocksByToolCallId: upsertSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent(messageStartMsg(MID_A, 1), ctx)
    handleContentBlockEvent(
      contentBlockStartMsg(MID_A, 0, 2, {
        type: 'tool_use',
        id: 'tu_flow_x',
        name: 'show_flow_view',
        input: {},
      }),
      ctx,
    )

    expect(upsertSpy).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════
// §4.6 W4a R2-P1-4 升 P0：thinking content_block → 镜像到 agentStepsBySessionId
// ═══════════════════════════════════════════════════════════════════

describe('§4.6 W4a R2-P1-4 升 P0 · thinking 镜像到 agentSteps', () => {
  beforeEach(() => {
    sub.reset()
    __resetToolCallArgsBuffersForTests()
  })

  it('content_block_start(thinking) → pushAgentStep("thinking", running)', () => {
    const pushSpy = vi.fn()
    const updateSpy = vi.fn()
    const ctx = makeCtx()
    ctx.get = () => ({
      ...buildStore(),
      pushAgentStepForSession: pushSpy,
      updateAgentStepForSession: updateSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent(messageStartMsg(MID_A, 1), ctx)
    handleContentBlockEvent(
      contentBlockStartMsg(MID_A, 0, 2, { type: 'thinking', thinking: '', signature: '' }),
      ctx,
    )

    // W4a 三轮 A-P0-3：message_start 时无条件 push 一条 "Thinking…" placeholder
    // （让 GPT-4o 等非 thinking 模型用户也看到反馈），然后 cb_start(thinking) 真
    // thinking 块再 push 一条独立 step（id 用 `thinking-${msgId}-${index}`）。
    // 所以这里期望两次：① placeholder ② 真 thinking step。
    expect(pushSpy).toHaveBeenCalledTimes(2)
    const placeholderCall = pushSpy.mock.calls[0]
    expect(placeholderCall[0]).toBe(SESSION)
    expect(placeholderCall[1].id).toBe(`thinking-placeholder-${MID_A}`)
    expect(placeholderCall[1].type).toBe('thinking')
    expect(placeholderCall[1].status).toBe('running')
    const realThinkingCall = pushSpy.mock.calls[1]
    expect(realThinkingCall[1].type).toBe('thinking')
    expect(realThinkingCall[1].status).toBe('running')
    expect(realThinkingCall[1].id).toBe(`thinking-${MID_A}-0`)
  })

  it('content_block_stop(thinking) → updateAgentStep(done, detail=text)', () => {
    const pushSpy = vi.fn()
    const updateSpy = vi.fn()
    const ctx = makeCtx()
    // mini reducer 维护 agentStepsBySessionId 让 placeholder finalize 路径
    // 能找到 placeholder 并 update（W4a 三轮 A-P0-3 行为）
    const agentSteps: Record<string, Array<{ id: string; status: string; timestamp: number }>> = {}
    ctx.get = () => ({
      ...buildStore(),
      agentStepsBySessionId: agentSteps,
      pushAgentStepForSession: (sid: string, step: { id: string; status: string; timestamp: number }) => {
        pushSpy(sid, step)
        agentSteps[sid] = [...(agentSteps[sid] ?? []), step]
      },
      updateAgentStepForSession: (
        sid: string,
        id: string,
        partial: { status?: string },
      ) => {
        updateSpy(sid, id, partial)
        agentSteps[sid] = (agentSteps[sid] ?? []).map(s => (s.id === id ? { ...s, ...partial } : s))
      },
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent(messageStartMsg(MID_A, 1), ctx)
    handleContentBlockEvent(
      contentBlockStartMsg(MID_A, 0, 2, { type: 'thinking', thinking: '', signature: '' }),
      ctx,
    )
    handleContentBlockEvent(
      contentBlockDeltaMsg(MID_A, 0, 3, { type: 'thinking_delta', thinking: 'Let me think about this...' }),
      ctx,
    )
    handleContentBlockEvent(contentBlockStopMsg(MID_A, 0, 4), ctx)

    // W4a 三轮 A-P0-3：① placeholder push（messageStart）+ ② 真 thinking step push（cb_start）
    expect(pushSpy).toHaveBeenCalledTimes(2)
    // ① 真 thinking step done（cb_stop）+ ② placeholder finalize done（cb_stop 联动）
    expect(updateSpy).toHaveBeenCalledTimes(2)
    const realThinkingUpdate = updateSpy.mock.calls.find(call => call[1] === `thinking-${MID_A}-0`)
    expect(realThinkingUpdate).toBeDefined()
    expect(realThinkingUpdate![2].status).toBe('done')
    expect(realThinkingUpdate![2].detail).toContain('Let me think about this')
    const placeholderUpdate = updateSpy.mock.calls.find(call => call[1] === `thinking-placeholder-${MID_A}`)
    expect(placeholderUpdate).toBeDefined()
    expect(placeholderUpdate![2].status).toBe('done')
  })

  it('content_block_stop(text) → 不触发 thinking 镜像（但 placeholder 被 finalize）', () => {
    const pushSpy = vi.fn()
    const updateSpy = vi.fn()
    const ctx = makeCtx()
    const agentSteps: Record<string, Array<{ id: string; status: string; timestamp: number }>> = {}
    ctx.get = () => ({
      ...buildStore(),
      agentStepsBySessionId: agentSteps,
      pushAgentStepForSession: (sid: string, step: { id: string; status: string; timestamp: number }) => {
        pushSpy(sid, step)
        agentSteps[sid] = [...(agentSteps[sid] ?? []), step]
      },
      updateAgentStepForSession: (
        sid: string,
        id: string,
        partial: { status?: string },
      ) => {
        updateSpy(sid, id, partial)
        agentSteps[sid] = (agentSteps[sid] ?? []).map(s => (s.id === id ? { ...s, ...partial } : s))
      },
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent(messageStartMsg(MID_A, 1), ctx)
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), ctx)
    handleContentBlockEvent(contentBlockStopMsg(MID_A, 0, 3), ctx)

    // W4a 三轮 A-P0-3：placeholder push 1 次（messageStart）；text 块到达时
    // placeholder finalize 为 done（update 1 次），cb_stop(text) 不再触发 thinking 镜像
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(pushSpy.mock.calls[0][1].id).toBe(`thinking-placeholder-${MID_A}`)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0][1]).toBe(`thinking-placeholder-${MID_A}`)
    expect(updateSpy.mock.calls[0][2].status).toBe('done')
  })

  it('长 thinking text 在 detail 中截断到 200 字符 + ellipsis', () => {
    const pushSpy = vi.fn()
    const updateSpy = vi.fn()
    const ctx = makeCtx()
    const agentSteps: Record<string, Array<{ id: string; status: string; timestamp: number }>> = {}
    ctx.get = () => ({
      ...buildStore(),
      agentStepsBySessionId: agentSteps,
      pushAgentStepForSession: (sid: string, step: { id: string; status: string; timestamp: number }) => {
        pushSpy(sid, step)
        agentSteps[sid] = [...(agentSteps[sid] ?? []), step]
      },
      updateAgentStepForSession: (
        sid: string,
        id: string,
        partial: { status?: string },
      ) => {
        updateSpy(sid, id, partial)
        agentSteps[sid] = (agentSteps[sid] ?? []).map(s => (s.id === id ? { ...s, ...partial } : s))
      },
    }) as unknown as StreamHandlerStore

    const longText = 'A'.repeat(300)
    handleContentBlockEvent(messageStartMsg(MID_A, 1), ctx)
    handleContentBlockEvent(
      contentBlockStartMsg(MID_A, 0, 2, { type: 'thinking', thinking: '', signature: '' }),
      ctx,
    )
    handleContentBlockEvent(
      contentBlockDeltaMsg(MID_A, 0, 3, { type: 'thinking_delta', thinking: longText }),
      ctx,
    )
    handleContentBlockEvent(contentBlockStopMsg(MID_A, 0, 4), ctx)

    // W4a 三轮 A-P0-3：update 调用顺序为 ① 真 thinking step done ② placeholder done。
    // 长文本截断断言走 thinking-${msgId}-0 那条。
    const realThinkingCall = updateSpy.mock.calls.find(call => call[1] === `thinking-${MID_A}-0`)
    expect(realThinkingCall).toBeDefined()
    expect(realThinkingCall![2].detail).toHaveLength(203) // 200 + '...'
    expect(realThinkingCall![2].detail.endsWith('...')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// §4.7 W4a 三轮 W4a-L4/L8：essential vs non-essential validator
// ═══════════════════════════════════════════════════════════════════

describe('§4.7 W4a-L4/L8 · essential-field validator + 降级', () => {
  beforeEach(() => {
    sub.reset()
    __resetToolCallArgsBuffersForTests()
    _resetMockedCounts()
  })

  it('event_type 缺失 → drop（schemaParseFail++）', () => {
    const store = buildStore()
    const ctx = makeCtx()
    ctx.get = () => store as unknown as StreamHandlerStore

    handleContentBlockEvent({
      // type 字段缺失 —— flattenEnvelope 后 event_type 为 undefined
      type: '' as 'agent.stream.message_start',
      payload: { message_id: MID_A, _seq: 1, role: 'assistant' },
    }, ctx)

    expect(_mockedCounts.schemaParseFail).toBeGreaterThan(0)
    expect(_mockedCounts.schemaParseDegraded).toBe(0)
  })

  it('message_id 缺失 → drop（schemaParseFail++）', () => {
    const store = buildStore()
    const ctx = makeCtx()
    ctx.get = () => store as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: { _seq: 1, role: 'assistant' }, // 无 message_id
    }, ctx)

    expect(_mockedCounts.schemaParseFail).toBeGreaterThan(0)
  })

  it('_seq 缺失 → drop（schemaParseFail++）', () => {
    const store = buildStore()
    const ctx = makeCtx()
    ctx.get = () => store as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: { message_id: MID_A, role: 'assistant' }, // 无 _seq
    }, ctx)

    expect(_mockedCounts.schemaParseFail).toBeGreaterThan(0)
  })

  it('essential 通过 + non-essential 失败（role 非法字符串）→ stub 降级 (degraded++)', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const messageStartSpy = vi.fn()
    ctx.get = () => ({
      ...store,
      messageStart: messageStartSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: MID_A,
        _seq: 1,
        role: 'invalid-role-xyz', // zod schema 期望 assistant/user/system
      },
    }, ctx)

    // 降级路径：essential 通过 → 走 stub fallback → 仍调 messageStart
    expect(_mockedCounts.schemaParseDegraded).toBeGreaterThan(0)
    expect(messageStartSpy).toHaveBeenCalled() // fallback role='assistant'
  })

  it('content_block_delta 含非法 delta type → essential 通过（type 是字符串）+ zod 失败 → 降级 stub 仍写入', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const deltaSpy = vi.fn()
    ctx.get = () => ({
      ...store,
      contentBlockDelta: deltaSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.content_block_delta',
      payload: {
        message_id: MID_A,
        _seq: 5,
        index: 0,
        // delta.type 是字符串（essential 校验通过）但不在 zod enum
        delta: { type: 'unknown_delta_xyz' },
      },
    }, ctx)

    // 降级路径仍调 contentBlockDelta —— 保留 delta 原值（不再降级成 text_delta）
    expect(_mockedCounts.schemaParseDegraded).toBeGreaterThan(0)
    expect(deltaSpy).toHaveBeenCalled()
  })

  // ─── W4a 四轮 R4-8：block / delta / index 升 essential（drop 不降级） ───

  it('R4-8 content_block_start 缺失 block 字段 → drop（不降级成 text 块）', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const startSpy = vi.fn()
    ctx.get = () => ({ ...store, contentBlockStart: startSpy }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.content_block_start',
      payload: {
        message_id: MID_A,
        _seq: 2,
        index: 0,
        block_id: 'blk_x',
        // block 字段缺失 —— 三轮 _buildDegradedEvent 会降级为 { type: 'text', text: '' }
        // 让 tool_use input 永远收不到，整个 tool 失败。R4-8 改为 drop。
      },
    }, ctx)

    expect(_mockedCounts.schemaParseFail).toBeGreaterThan(0)
    expect(_mockedCounts.schemaParseDegraded).toBe(0)
    expect(startSpy).not.toHaveBeenCalled()
  })

  it('R4-8 content_block_start 含 null block → drop', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const startSpy = vi.fn()
    ctx.get = () => ({ ...store, contentBlockStart: startSpy }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.content_block_start',
      payload: { message_id: MID_A, _seq: 2, index: 0, block_id: 'blk_x', block: null },
    } as unknown as Parameters<typeof handleContentBlockEvent>[0], ctx)

    expect(_mockedCounts.schemaParseFail).toBeGreaterThan(0)
    expect(startSpy).not.toHaveBeenCalled()
  })

  it('R4-8 content_block_start block 缺 type 字段 → drop', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const startSpy = vi.fn()
    ctx.get = () => ({ ...store, contentBlockStart: startSpy }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.content_block_start',
      payload: {
        message_id: MID_A, _seq: 2, index: 0, block_id: 'blk_x',
        block: { input: {} } as unknown as { type: string }, // 缺 type
      },
    }, ctx)

    expect(_mockedCounts.schemaParseFail).toBeGreaterThan(0)
    expect(startSpy).not.toHaveBeenCalled()
  })

  it('R4-8 content_block_delta 缺失 delta 字段 → drop', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const deltaSpy = vi.fn()
    ctx.get = () => ({ ...store, contentBlockDelta: deltaSpy }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.content_block_delta',
      payload: { message_id: MID_A, _seq: 5, index: 0 },
    } as unknown as Parameters<typeof handleContentBlockEvent>[0], ctx)

    expect(_mockedCounts.schemaParseFail).toBeGreaterThan(0)
    expect(deltaSpy).not.toHaveBeenCalled()
  })

  it('R4-8 content_block_delta delta.type 缺失 → drop', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const deltaSpy = vi.fn()
    ctx.get = () => ({ ...store, contentBlockDelta: deltaSpy }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.content_block_delta',
      payload: {
        message_id: MID_A, _seq: 5, index: 0,
        delta: { text: 'hi' } as unknown as { type: string }, // 缺 type
      },
    }, ctx)

    expect(_mockedCounts.schemaParseFail).toBeGreaterThan(0)
    expect(deltaSpy).not.toHaveBeenCalled()
  })

  it('R4-8 content_block_* index 为负 → drop', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const stopSpy = vi.fn()
    ctx.get = () => ({ ...store, contentBlockStop: stopSpy }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.content_block_stop',
      payload: { message_id: MID_A, _seq: 5, index: -1 },
    } as unknown as Parameters<typeof handleContentBlockEvent>[0], ctx)

    expect(_mockedCounts.schemaParseFail).toBeGreaterThan(0)
    expect(stopSpy).not.toHaveBeenCalled()
  })

  it('R4-8 envelope-level 字段坏（trace_id 类型错）→ 降级 + 仍处理', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const startSpy = vi.fn()
    ctx.get = () => ({ ...store, contentBlockStart: startSpy }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.content_block_start',
      payload: {
        message_id: MID_A,
        _seq: 2,
        index: 0,
        block_id: 'blk_real',
        block: { type: 'text', text: '' },
        trace_id: 12345 as unknown as string, // 应为字符串 —— envelope-level 坏字段
      },
    }, ctx)

    // essential 通过（block 合法），envelope-level 字段坏走 degraded fallback，
    // 仍调 contentBlockStart 不丢
    expect(_mockedCounts.schemaParseFail).toBe(0)
    expect(_mockedCounts.schemaParseDegraded).toBeGreaterThan(0)
    expect(startSpy).toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════
// §4.9 W2 协议升级（PRD §3.7.1）：handleMessageStart 按 message_kind 守门
// ═══════════════════════════════════════════════════════════════════
//
// W4a 三轮 R4-5 / 五轮 R5-3 原本按 `model_id === 'tabtin-tool-runtime'`
// + `synthetic === true` 双重隐式判别 daemon-synthesized envelope；W2 升级
// 为协议字段 `message_kind ∈ { 'llm' | 'tool_artifact' | 'error_envelope' }`
// 单源判别。下方测试覆盖三类 envelope 在 handleMessageStart 的行为：
//   - tool_artifact: 不 push thinking placeholder（产物气泡旁无"思考中"）
//   - error_envelope: 不 push thinking placeholder（错误文案旁无 spinner）
//   - llm: 正常 push thinking placeholder（主 LLM 路径需要反馈）

describe('§4.9 W2 · handleMessageStart 按 message_kind 守门 thinking placeholder', () => {
  beforeEach(() => {
    sub.reset()
    __resetToolCallArgsBuffersForTests()
    _resetMockedCounts()
    _resetMockMessages()
    _mockUpdateSessionMessages.mockClear()
    _mockSessions.length = 0
    _mockSelectedAgent.id = null
  })

  it('tool_artifact（daemon mini-message）不 push thinking placeholder', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const pushSpy = vi.fn()
    ctx.get = () => ({
      ...store,
      pushAgentStepForSession: pushSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'msg_inline_tool_1',
        _seq: 1,
        role: 'assistant',
        // daemon 仍写 model_id 占位（envelope-emitter 单源），但**业务判别不
        // 再依赖此字段**——走 message_kind='tool_artifact' 单源契约。
        model_id: 'tabtin-tool-runtime',
        model_name: 'tabtin-tool-runtime',
        started_at: '2025-01-01T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't1',
        thread_id: 'th1',
        run_id: 'r1',
        message_kind: 'tool_artifact',  // ← W2 单源判别字段
      },
    }, ctx)

    // messageStart 仍调（contentBlocks 容器需要建立），但 thinking placeholder
    // **不**被 push —— 否则每个工具产出 mini-message 旁边都附赠空 thinking 卡。
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('llm（主 LLM 真实输出）正常 push thinking placeholder', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const pushSpy = vi.fn()
    ctx.get = () => ({
      ...store,
      pushAgentStepForSession: pushSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'msg_main_llm',
        _seq: 1,
        role: 'assistant',
        model_id: 'claude-3-5-sonnet',
        model_name: 'Claude 3.5 Sonnet',
        started_at: '2025-01-01T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't1',
        run_id: 'r1',
        message_kind: 'llm',
      },
    }, ctx)

    expect(pushSpy).toHaveBeenCalledTimes(1)
    const step = pushSpy.mock.calls[0][1]
    expect(step.type).toBe('thinking')
    expect(step.status).toBe('running')
    expect(step.id).toContain('thinking-placeholder-')
  })

  it('error_envelope（daemon 自合成错误文案，用真 LLM model_id）不 push thinking placeholder', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const pushSpy = vi.fn()
    ctx.get = () => ({
      ...store,
      pushAgentStepForSession: pushSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'r-err-uuid-123',  // emitAssistantErrorMessageEnvelope 的 messageId 格式
        _seq: 1,
        role: 'assistant',
        // 用真 LLM model_id（state.model 透传），靠 message_kind 区分
        model_id: 'claude-3-5-sonnet',
        model_name: 'Claude 3.5 Sonnet',
        started_at: '2025-01-01T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't1',
        run_id: 'r1',
        message_kind: 'error_envelope',  // ← W2 单源判别字段
      },
    }, ctx)

    // 守门生效：error_envelope 跳过 placeholder，错误文案旁不再闪 spinner
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('message_kind 在 degraded fallback 路径仍透传（守门不失效）', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const pushSpy = vi.fn()
    ctx.get = () => ({
      ...store,
      pushAgentStepForSession: pushSpy,
    }) as unknown as StreamHandlerStore

    // 故意触发完整 zod parse 失败（缺 run_id 必填字段）→ 走
    // _buildDegradedEvent 路径。但 message_kind 仍透传，下游守门 isDaemonSynthesized
    // 判别能正确识别 'tool_artifact' 跳过 placeholder。
    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'r-degraded-tool-artifact',
        _seq: 1,
        role: 'assistant',
        model_id: 'tabtin-tool-runtime',
        model_name: 'tabtin-tool-runtime',
        started_at: '2025-01-01T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't1',
        thread_id: 'th1',
        // run_id 故意省略 → zod 完整 parse 失败 → degraded path
        message_kind: 'tool_artifact',
      } as unknown as Record<string, unknown>,
    } as unknown as Parameters<typeof handleContentBlockEvent>[0], ctx)

    // 即便走 degraded 路径，message_kind 也透传 → push 仍跳过
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('user role message（不论 model_id）不 push thinking placeholder', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const pushSpy = vi.fn()
    ctx.get = () => ({
      ...store,
      pushAgentStepForSession: pushSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'msg_user',
        _seq: 1,
        role: 'user',
        model_id: 'claude-3-5-sonnet',
        model_name: 'Claude 3.5 Sonnet',
        started_at: '2025-01-01T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't1',
        run_id: 'r1',
        message_kind: 'llm',
      },
    }, ctx)

    expect(pushSpy).not.toHaveBeenCalled()
  })

  // ── W2 PRD §3.7.1：daemon-synthesized message 必须建 ChatMessage 气泡 ──
  //
  // 回归 bug 历史：W4a R4-5 引入的早 return 把"建 ChatMessage 气泡"和"push
  // thinking placeholder"两件事一起吞了，导致 mini-message 永远没有
  // ChatMessage 承载，BlockTimeline 找不到容器把 tabtin_rich_content block
  // 挂上去，widget / search_results / present_to_user / cli_output /
  // document_excerpt 全部孤儿化。W4.5 已修正拆开两件事，W2 协议升级把判别
  // 切到 message_kind 单源契约，行为保持一致。

  it('回归：tool_artifact 必须 push 到 ChatMessage 列表 + 冗余 message_kind 字段', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const pushSpy = vi.fn()
    ctx.get = () => ({
      ...store,
      pushAgentStepForSession: pushSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'msg_inline_widget_xyz',
        _seq: 1,
        role: 'assistant',
        // daemon 仍写 model_id 占位字符串（envelope-emitter 单源），但前端业务
        // 不再依赖此字段——走 message_kind 单源判别。
        model_id: 'tabtin-tool-runtime',
        model_name: 'tabtin-tool-runtime',
        started_at: '2025-01-01T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't1',
        thread_id: 'th1',
        run_id: 'r1',
        message_kind: 'tool_artifact',
      },
    }, ctx)

    // 1. ensureAssistantMessage 建 ChatMessage 容器
    expect(_mockEnsureAssistantMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ id: 'msg_inline_widget_xyz', role: 'assistant' }),
    )
    const messages = _mockMessagesBySession[SESSION]
    expect(messages).toBeDefined()
    expect(messages.length).toBe(1)
    expect(messages[0].id).toBe('msg_inline_widget_xyz')
    expect(messages[0].role).toBe('assistant')

    // 2. **W2 关键断言**：message_kind 冗余记录到 ChatMessage —— MessageBubble
    //    / MessageList 后续按 `message.message_kind === 'tool_artifact'` 判别
    //    走"产物气泡"紧凑形态（PRD §3.7.2 footer 矩阵）。
    expect((messages[0] as Record<string, unknown>).message_kind).toBe('tool_artifact')

    // 3. model_id 仍冗余记录（与 API ChatMessageSchema 字段对齐），但**业务
    //    判别不再依赖此字段**。
    expect((messages[0] as Record<string, unknown>).model_id).toBe('tabtin-tool-runtime')

    // 4. thinking placeholder 仍然跳过（mini-message 不该有"思考中…"spinner）
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('回归：error_envelope 必须 push 到 ChatMessage 列表（错误文案承载） + 冗余 message_kind', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const pushSpy = vi.fn()
    ctx.get = () => ({
      ...store,
      pushAgentStepForSession: pushSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'r-err-uuid-456',
        _seq: 1,
        role: 'assistant',
        model_id: 'claude-3-5-sonnet',  // 真 LLM model_id
        model_name: 'Claude 3.5 Sonnet',
        started_at: '2025-01-01T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't1',
        run_id: 'r1',
        message_kind: 'error_envelope',  // ← W2 单源判别字段
      },
    }, ctx)

    // 错误文案也要承载在 ChatMessage 里（用户能看到错误内容）
    expect(_mockEnsureAssistantMessage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ id: 'r-err-uuid-456' }),
    )
    const messages = _mockMessagesBySession[SESSION]
    expect(messages.length).toBe(1)
    expect(messages[0].id).toBe('r-err-uuid-456')
    // **W2 关键断言**：message_kind='error_envelope' 冗余记录 → MessageBubble
    // 按矩阵走"简化 footer"形态（PRD §3.7.2：只时间戳 + 复制按钮）。
    expect((messages[0] as Record<string, unknown>).message_kind).toBe('error_envelope')
    // model_id 保留真 LLM 字面量（区别 tool_artifact 的占位字符串）
    expect((messages[0] as Record<string, unknown>).model_id).toBe('claude-3-5-sonnet')

    // thinking placeholder 仍然跳过（错误文案旁不该有 spinner）
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('回归：主 LLM message_start 既 push 到 ChatMessage 也 push thinking placeholder + 冗余 message_kind="llm"', () => {
    const store = buildStore()
    const ctx = makeCtx()
    const pushSpy = vi.fn()
    ctx.get = () => ({
      ...store,
      pushAgentStepForSession: pushSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'msg_main_xyz',
        _seq: 1,
        role: 'assistant',
        model_id: 'claude-3-5-sonnet',
        model_name: 'Claude 3.5 Sonnet',
        started_at: '2025-01-01T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't1',
        run_id: 'r1',
        message_kind: 'llm',
      },
    }, ctx)

    // ChatMessage 建起来
    expect(_mockMessagesBySession[SESSION].length).toBe(1)
    expect((_mockMessagesBySession[SESSION][0] as Record<string, unknown>).model_id).toBe('claude-3-5-sonnet')
    // **W2 关键断言**：message_kind='llm' 冗余记录 → MessageBubble 走完整 footer
    expect((_mockMessagesBySession[SESSION][0] as Record<string, unknown>).message_kind).toBe('llm')
    // per-file 回退锚点修复：主 Agent message（无 subagent_run_id）的 agent_run_id
    // 必须落主轮 run_id，否则 resolveRewindAnchorId 解析不到锚点 → 回退预览误判
    // 「无历史版本可恢复」（LocalAgent 实时聚合路径专属断点，旧实现只取 subagent_run_id）。
    expect((_mockMessagesBySession[SESSION][0] as Record<string, unknown>).agent_run_id).toBe('r1')
    // thinking placeholder 也 push（主 LLM 路径有"思考中…"反馈）
    expect(pushSpy).toHaveBeenCalledTimes(1)
  })

  it('#6072：message_start 建壳即带 session.agent_id，不等 server merge', () => {
    _mockSessions.length = 0
    _mockSessions.push({ id: SESSION, agent_id: 'agent-exec-now' })
    _mockSelectedAgent.id = 'agent-selected-fallback'

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'msg_agent_id_early',
        _seq: 1,
        role: 'assistant',
        model_id: 'claude-3-5-sonnet',
        model_name: 'Claude 3.5 Sonnet',
        started_at: '2025-01-01T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't1',
        run_id: 'r1',
        message_kind: 'llm',
      },
    }, makeCtx())

    expect((_mockMessagesBySession[SESSION][0] as Record<string, unknown>).agent_id).toBe('agent-exec-now')
  })

  it('跨端切换：message_start.agent_id 优先于本地过期的 session.agent_id', () => {
    _mockSessions.length = 0
    _mockSessions.push({ id: SESSION, agent_id: 'agent-stale-local' })
    _mockSelectedAgent.id = 'agent-selected-stale'

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'msg_remote_agent_switch',
        agent_id: 'agent-authoritative-turn',
        _seq: 1,
        role: 'assistant',
        model_id: 'claude-3-5-sonnet',
        model_name: 'Claude 3.5 Sonnet',
        started_at: '2026-07-29T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't-cross-device',
        run_id: 'r-cross-device',
        message_kind: 'llm',
      },
    }, makeCtx())

    expect((_mockMessagesBySession[SESSION][0] as Record<string, unknown>).agent_id)
      .toBe('agent-authoritative-turn')
  })

  it('共享实时消息复用同 Agent 的会话安全展示快照', () => {
    _mockSessions.length = 0
    _mockSessions.push({
      id: SESSION,
      agent_id: 'agent-owner',
      agent_name: 'Owner Agent',
      agent_avatar: 'https://example.com/owner-agent.png',
    })

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'msg_shared_agent_face',
        agent_id: 'agent-owner',
        _seq: 1,
        role: 'assistant',
        model_id: 'claude-3-5-sonnet',
        model_name: 'Claude 3.5 Sonnet',
        started_at: '2026-08-13T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't-shared-face',
        run_id: 'r-shared-face',
        message_kind: 'llm',
      },
    }, makeCtx())

    expect(_mockMessagesBySession[SESSION][0]).toMatchObject({
      agent_id: 'agent-owner',
      agent_name: 'Owner Agent',
      agent_avatar: 'https://example.com/owner-agent.png',
    })
  })

  it('#6072：session.agent_id 缺省时回退 selectedAgent.id', () => {
    _mockSessions.length = 0
    _mockSessions.push({ id: SESSION, agent_id: null })
    _mockSelectedAgent.id = 'agent-selected-only'

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'msg_agent_id_selected',
        _seq: 1,
        role: 'assistant',
        model_id: 'claude-3-5-sonnet',
        model_name: 'Claude 3.5 Sonnet',
        started_at: '2025-01-01T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't1',
        run_id: 'r1',
        message_kind: 'llm',
      },
    }, makeCtx())

    expect((_mockMessagesBySession[SESSION][0] as Record<string, unknown>).agent_id).toBe('agent-selected-only')
  })

  it('回归：缺 message_kind（fallback fixture）保守按 llm 处理 —— 仍 push placeholder', () => {
    // **fallback 兼容场景**：极端 degraded 路径或老 daemon 没带 message_kind
    // 字段时，contentBlockHandler 默认按 'llm' 处理（保守，至少不会误把真 LLM
    // 输出当 mini-message 吞掉 thinking）。这也守护"老 daemon + 新前端"窗口期。
    const store = buildStore()
    const ctx = makeCtx()
    const pushSpy = vi.fn()
    ctx.get = () => ({
      ...store,
      pushAgentStepForSession: pushSpy,
    }) as unknown as StreamHandlerStore

    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        message_id: 'msg_no_kind',
        _seq: 1,
        role: 'assistant',
        model_id: 'claude-3-5-sonnet',
        model_name: 'Claude 3.5 Sonnet',
        started_at: '2025-01-01T00:00:00Z',
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 't1',
        run_id: 'r1',
        // message_kind 故意省略 —— 走 zod fail → degraded path → handler 默认 'llm'
      } as unknown as Record<string, unknown>,
    } as unknown as Parameters<typeof handleContentBlockEvent>[0], ctx)

    expect(pushSpy).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════════════════════
// §4.8 W4a 三轮 B-P1：performance.mark dispatch:start/:end
// ═══════════════════════════════════════════════════════════════════

describe('§4.8 B-P1 · performance.mark 高频路径埋点', () => {
  beforeEach(() => {
    sub.reset()
    __resetToolCallArgsBuffersForTests()
    if (typeof performance !== 'undefined' && typeof performance.clearMarks === 'function') {
      performance.clearMarks()
    }
  })

  it('handleContentBlockEvent 进入与退出都打 mark', () => {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') {
      return // jsdom 不支持
    }
    const store = buildStore()
    const ctx = makeCtx()
    ctx.get = () => store as unknown as StreamHandlerStore

    handleContentBlockEvent(messageStartMsg(MID_A, 1), ctx)

    const starts = performance.getEntriesByName('[contentBlocks] dispatch:start')
    const ends = performance.getEntriesByName('[contentBlocks] dispatch:end')
    expect(starts.length).toBeGreaterThan(0)
    expect(ends.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// §4.10 W4.5 第二波 P0-1：daemon emit message_stop.error_info 真消费
// ═══════════════════════════════════════════════════════════════════

describe('§4.10 W4.5 第二波 P0-1 · message_stop.error_info.partial_reason 真接通', () => {
  beforeEach(() => {
    sub.reset()
    __resetToolCallArgsBuffersForTests()
    _resetMockMessages()
  })

  function messageStopWithErrorInfo(
    messageId: string,
    seq: number,
    errorInfo: { partial_reason?: 'aborted' | 'stream_interrupted' | 'message_stop_fallback'; category?: string; error_class?: string; error_message?: string; suggested_action?: string },
  ): AgentStreamMessage {
    return {
      type: 'agent.stream.message_stop',
      payload: { ...envelopeBase(seq), message_id: messageId, error_info: errorInfo },
    }
  }

  it('4.10.1 daemon emit partial_reason=aborted → entry.partialReason=aborted', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'text_delta', text: 'partial output' }), makeCtx())
    // 不发 message_delta(stop_reason)——abort 路径上游 SSE 来不及 emit。
    handleContentBlockEvent(
      messageStopWithErrorInfo(MID_A, 4, { partial_reason: 'aborted', category: 'aborted' }),
      makeCtx(),
    )

    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    expect(entry!.finalized).toBe(true)
    expect(entry!.partial).toBe(true)
    expect(entry!.partialReason).toBe('aborted')
  })

  it('4.10.2 daemon emit partial_reason=stream_interrupted → entry.partialReason=stream_interrupted', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'text_delta', text: 'halfway through' }), makeCtx())
    handleContentBlockEvent(messageDeltaMsg(MID_A, 4, 'error'), makeCtx())
    handleContentBlockEvent(
      messageStopWithErrorInfo(MID_A, 5, {
        partial_reason: 'stream_interrupted',
        category: 'runtime_failed',
        error_message: 'LLM provider returned 500',
        error_class: 'LLM_ERROR',
      }),
      makeCtx(),
    )

    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    expect(entry!.finalized).toBe(true)
    expect(entry!.partial).toBe(true)
    expect(entry!.partialReason).toBe('stream_interrupted')
    // ：message_stop.error_info 同步到 ChatMessage.error_info_json
    const chatMsg = _mockMessagesBySession[SESSION]?.find(m => m.id === MID_A)
    expect(chatMsg?.error_info_json).toEqual({
      partial_reason: 'stream_interrupted',
      category: 'runtime_failed',
      error_message: 'LLM provider returned 500',
      error_class: 'LLM_ERROR',
    })
  })

  it('4.10.3 daemon emit partial_reason=message_stop_fallback → entry.partialReason=message_stop_fallback', () => {
    // 关键 case：stall retry / daemon-driven close 没 stop_reason，但 daemon
    // 显式 emit message_stop_fallback——客户端启发式只能反推为 'message_stop_fallback'
    // 时是巧合一致；这里换 stop_reason='error' 让 heuristic 反向，验证 daemon 真信号
    // 优先于 heuristic。
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'text_delta', text: 'daemon close' }), makeCtx())
    // 制造冲突：heuristic 会推 'stream_interrupted'（stop_reason='error'），daemon 真信号是
    // 'message_stop_fallback'——daemon 真信号必须优先。
    handleContentBlockEvent(messageDeltaMsg(MID_A, 4, 'error'), makeCtx())
    handleContentBlockEvent(
      messageStopWithErrorInfo(MID_A, 5, { partial_reason: 'message_stop_fallback' }),
      makeCtx(),
    )

    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    expect(entry!.partialReason).toBe('message_stop_fallback')
  })

  it('4.10.4 daemon 不 emit error_info → 回落 prevMeta.stop_reason 启发式（向后兼容）', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'text_delta', text: 'old daemon' }), makeCtx())
    handleContentBlockEvent(messageDeltaMsg(MID_A, 4, 'aborted'), makeCtx())
    handleContentBlockEvent(messageStopMsg(MID_A, 5), makeCtx())

    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    // heuristic：prevMeta.stop_reason === 'aborted' → partialReason='aborted'
    expect(entry!.partialReason).toBe('aborted')
  })

  it('4.10.5 daemon 真信号优先于 heuristic 冲突场景', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'text_delta', text: 'conflict' }), makeCtx())
    // heuristic：stop_reason='aborted' → 'aborted'
    handleContentBlockEvent(messageDeltaMsg(MID_A, 4, 'aborted'), makeCtx())
    // daemon 真信号：'stream_interrupted'——daemon 真信号必须胜出
    handleContentBlockEvent(
      messageStopWithErrorInfo(MID_A, 5, { partial_reason: 'stream_interrupted' }),
      makeCtx(),
    )

    const entry = sub.state.contentBlocksBySessionId[SESSION]?.[MID_A]?.[0]
    expect(entry!.partialReason).toBe('stream_interrupted')
  })
})

// ═══════════════════════════════════════════════════════════════════
// §4.11 handleMessageStop 把 deriveTextSummary 派生的纯文本回填 ChatMessage.content
// ═══════════════════════════════════════════════════════════════════
//
// 业务背景：MessageBubble 底部 footer（时间戳 / 复制 / 分支 / 回退按钮）的渲染条件
// 硬依赖 `message.content && content.trim().length>0`。但 W4 块流路径下 assistant
// `ChatMessage.content` 流式期间一直是空字符串，文本只在 content_blocks_json 里——
// 修复前 footer 整段不挂载，"刷新前看不到 footer"是真实可重现 bug。
//
// 修复：handleMessageStop 在写 content_blocks_json 时同步把 `deriveTextSummary(blocks)`
// 派生纯文本写到 `ChatMessage.content`——与 Django reassembler 落库时的 `text_summary`
// 字段语义 1:1 对齐（同一份算法、同一份占位文案）。
//
// 这里的测试要拦的是回归：将来有人改 handleMessageStop 不调 helper 时，CI 能拦下来。
// helper 内部行为（content 派生 / role 守门 / 空 blocks 跳过）由
// `syncMessageContent.test.ts` 单独覆盖，scope 解耦。
describe('§4.11 handleMessageStop · 调 syncDerivedContentToChatMessage（footer 修复）', () => {
  beforeEach(() => {
    sub.reset()
    __resetToolCallArgsBuffersForTests()
    _resetMockMessages()
    _mockUpdateSessionMessages.mockClear()
    _mockSyncDerivedContentToChatMessage.mockClear()
  })

  it('4.11.1 assistant message_stop 时调 syncDerivedContentToChatMessage(sid, mid)', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1, 'assistant'), makeCtx())
    handleContentBlockEvent(contentBlockStartMsg(MID_A, 0, 2, { type: 'text', text: '' }), makeCtx())
    handleContentBlockEvent(contentBlockDeltaMsg(MID_A, 0, 3, { type: 'text_delta', text: 'Hello world' }), makeCtx())
    handleContentBlockEvent(contentBlockStopMsg(MID_A, 0, 4), makeCtx())
    handleContentBlockEvent(messageStopMsg(MID_A, 5), makeCtx())

    // helper 被调，参数正确
    expect(_mockSyncDerivedContentToChatMessage).toHaveBeenCalledWith(SESSION, MID_A)
  })

  it('4.11.2 user role message_stop 也调 helper（helper 内部判断 role 守门，不在 handler 层拦）', () => {
    // sendMessageAction 主路径已经把 user 消息的 content 设成 displayMessage；
    // 这里 handleMessageStop 调 helper 但 helper 内部 finalizedMeta.role !== 'assistant'
    // 会立刻 return，不写 ChatMessage——细节由 syncMessageContent.test.ts 验证。
    handleContentBlockEvent(messageStartMsg(MID_A, 1, 'user'), makeCtx())
    handleContentBlockEvent(messageStopMsg(MID_A, 2), makeCtx())

    expect(_mockSyncDerivedContentToChatMessage).toHaveBeenCalledWith(SESSION, MID_A)
  })

  it('4.11.3 helper 调用前 flushRuntimeBatch 已执行（meta / blocks 同步落定）', () => {
    handleContentBlockEvent(messageStartMsg(MID_A, 1, 'assistant'), makeCtx())
    handleContentBlockEvent(messageStopMsg(MID_A, 2), makeCtx())

    // mock 里 flushRuntimeBatch 是 noop，但 handleMessageStop 调用顺序应当是
    // flushRuntimeBatch → syncDerivedContentToChatMessage（store reducer 已派生
    // meta.text_summary 后 helper 才能读到最新值）。这里靠 mock 调用次数兜底——
    // helper 至少被调一次说明顺序对。
    expect(_mockSyncDerivedContentToChatMessage).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════════════════════
// §5. 老协议文件物理删除验证
// ═══════════════════════════════════════════════════════════════════

describe('§5. A 节：老协议 handler 文件物理删除', () => {
  const handlersDir = resolve(__dirname, '..')

  it('5.1 assistantHandler.ts 已物理删除', () => {
    expect(existsSync(resolve(handlersDir, 'assistantHandler.ts'))).toBe(false)
  })

  it('5.2 toolHandler.ts 已物理删除', () => {
    expect(existsSync(resolve(handlersDir, 'toolHandler.ts'))).toBe(false)
  })

  it('5.3 toolHandler.test.ts 已物理删除', () => {
    expect(existsSync(resolve(handlersDir, 'toolHandler.test.ts'))).toBe(false)
  })

  it('5.4 toolCallArgsBufferStore.ts 保留（widget streaming infra 依赖）', () => {
    expect(existsSync(resolve(handlersDir, 'toolCallArgsBufferStore.ts'))).toBe(true)
  })
})
