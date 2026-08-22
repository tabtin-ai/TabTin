/**
 * useChatRuntimeStore — ContentBlock 防御契约测试（W4a 二轮 R1-P0/R3-P0）。
 *
 * **守的不变量**：
 *
 *   1. **R1-P0-1**：finalized=true 的 block 不接受后续 delta（log.warn + drop），
 *      防 daemon retry attempt 2 重发污染已完成 block。
 *   2. **R1-P0-2**：messageStart 在 prevSeq>=0（"曾经处理过"）时显式重置该
 *      messageId 的 blocks 槽位，防 WS 重连续传两轮内容混在同一数组里。
 *   3. **R3-P0-1**：6 个 ContentBlock CRUD 走 `_scheduleBatchFlush()` —— 单帧
 *      多事件合并为一次 setState，60-90% 主线程占用回归 0。
 *
 * 直接 import 真实 `useChatRuntimeStore`（与 `useChatRuntimeStore.tool-event-merge.test.ts`
 * 同模式），rAF batch 行为通过 `await requestAnimationFrame(...)` 触发 flush。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ChatMessage } from '@tabtin/chat-client'

//  / ：内容块单一 store = message.blocks。commit 经 Zustand setState
// 不可变写入，故 mock 须提供 getState + setState；引擎测试先 seedShell 建壳。
const { _mockChatState, _useChatStore, _chatStoreListeners } = vi.hoisted(() => {
  const { useSyncExternalStore } = require('react') as typeof import('react')
  const _mockChatState: { messagesBySessionId: Record<string, ChatMessage[]> } = {
    messagesBySessionId: {},
  }
  const _chatStoreListeners = new Set<() => void>()

  function useChatStoreMock<T>(
    selector: (state: typeof _mockChatState) => T,
  ): T {
    return useSyncExternalStore(
      (onStoreChange) => {
        _chatStoreListeners.add(onStoreChange)
        return () => { _chatStoreListeners.delete(onStoreChange) }
      },
      () => selector(_mockChatState),
      () => selector(_mockChatState),
    )
  }

  const _useChatStore = Object.assign(useChatStoreMock, {
    getState: () => _mockChatState,
    setState: (
      partial:
        | Partial<typeof _mockChatState>
        | ((state: typeof _mockChatState) => Partial<typeof _mockChatState>),
    ) => {
      const patch = typeof partial === 'function' ? partial(_mockChatState) : partial
      if (!patch || Object.keys(patch).length === 0) return
      Object.assign(_mockChatState, patch)
      for (const listener of Array.from(_chatStoreListeners)) listener()
    },
    subscribe: (listener: () => void) => {
      _chatStoreListeners.add(listener)
      return () => { _chatStoreListeners.delete(listener) }
    },
  })

  return { _mockChatState, _useChatStore, _chatStoreListeners }
})

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: _useChatStore,
}))

/** 建消息壳（镜像生产 message_start 建壳），让 commit 能写 message.blocks。 */
function seedShell(sessionId: string, messageId: string): void {
  const arr = (_mockChatState.messagesBySessionId[sessionId] ??= [])
  if (!arr.some((m) => m.id === messageId)) {
    arr.push({ id: messageId, role: 'assistant', content: '', created_at: '2025-01-01T00:00:00Z' } as ChatMessage)
  }
}

import {
  useChatRuntimeStore,
  flushRuntimeBatch,
  TOOL_USE_PENDING_TOOL_CALL_ID,
  __testTickWatchdog,
  __resetWatchdogState,
  __setWatchdogReconcileFnForTest,
  getDroppedEventCount,
  resetDroppedEventCount,
  startContentBlockWatchdog,
  stopContentBlockWatchdog,
  deriveTextSummary,
  deriveTextClipboardContent,
  __testTrimContentBlocksLRU,
  __MAX_CONTENT_BLOCKS_PER_SESSION,
  __MAX_CONTENT_BLOCK_TRIM_BATCH,
} from './useChatRuntimeStore'
import { applyRuntimeRunSync, isSessionBusy } from './chat/execution/sessionRunProjection'

function setRuntimeBusy(sessionId: string, busy: boolean, seq = 1): void {
  applyRuntimeRunSync(sessionId, {
    session_id: sessionId,
    run_id: busy ? 'run-cb' : null,
    status: busy ? 'running' : 'idle',
    seq,
    queued_run_ids: [],
  })
}

import type { ContentBlockEntry } from './useChatRuntimeStore'
// 导入 messageBlocks 注册 bridge（引擎 flush 经它 commit 到 messages 层）。
import {
  getCommittedBlocks,
  getSessionBlocksRecord,
  useMessageBlocksById,
  __resetMessageBlocks,
} from './chat/messages/messageBlocks'
import type { ContentBlock } from '@tabtin/agent-wire'

const SESSION = 'sess-cb-defense'
const MID = 'msg_defense_1'

/** 已提交块的 session 视图（兼容旧 `contentBlocksBySessionId[sid]` 形态）。 */
function runtimeCb(sessionId: string): Record<string, ContentBlockEntry[]> {
  return getSessionBlocksRecord(sessionId) ?? {}
}

function resetStore(): void {
  // 先 flush 一遍把上一个 case 的 pending 清空，再 reset state——否则跨 case
  // 残留的 _pendingContentBlocks 会在下一 case rAF 时被 patch 进 state。
  flushRuntimeBatch()
  stopContentBlockWatchdog()
  __resetWatchdogState()
  __setWatchdogReconcileFnForTest(null)
  setRuntimeBusy(SESSION, false)
  resetDroppedEventCount()
  __resetMessageBlocks()
  _mockChatState.messagesBySessionId = {}
  _chatStoreListeners.clear()
  seedShell(SESSION, MID)
  useChatRuntimeStore.setState({
    messageMetaBySessionId: {},
    contentBlocksLastSeqBySessionId: {},
    richContentBlocksBySessionId: {},
    agentStepsBySessionId: {},
  })
}

async function awaitRaf(): Promise<void> {
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
}

const TEXT_BLOCK: ContentBlock = { type: 'text', text: '' }
const TOOL_BLOCK: ContentBlock = { type: 'tool_use', id: 'tu_defense', name: 'read_file', input: {} }

describe('useChatRuntimeStore · ContentBlock R1-P0-1 finalized 防御', () => {
  beforeEach(resetStore)

  it('contentBlockStop 之后 contentBlockDelta 同 index → drop（text 不变）', async () => {
    const store = useChatRuntimeStore.getState()

    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_0', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'Hello' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)

    await awaitRaf()

    // attempt 2：retry 重发同 index 的 delta（seq 严格大于 lastSeq=4）
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'attempt2content' }, 5)
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect(blocks).toHaveLength(1)
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('Hello')
    expect((blocks[0].block as Record<string, unknown>).arrival_seq).toBeGreaterThan(1_000_000_000_000_000)
    expect(typeof (blocks[0].block as Record<string, unknown>).arrived_at).toBe('string')
    expect(blocks[0].finalized).toBe(true)
    // seq 仍前进，不会反复重试
    expect(useChatRuntimeStore.getState().contentBlocksLastSeqBySessionId[SESSION]?.[MID]).toBe(5)
  })

  it('contentBlockStop 之后 contentBlockStart 同 index → drop（block_id / block 不变）', async () => {
    const store = useChatRuntimeStore.getState()

    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_original', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'Hello' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    await awaitRaf()

    // retry attempt 2 重发 start
    store.contentBlockStart(SESSION, MID, 0, 'blk_retry', { type: 'text', text: '' }, 5)
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect(blocks[0].block_id).toBe('blk_original')
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('Hello')
    expect(blocks[0].finalized).toBe(true)
  })

  it('finalized block 防御不影响其他 index 的正常 delta', async () => {
    const store = useChatRuntimeStore.getState()

    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_0', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'first' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    // index=1 仍然在 streaming
    store.contentBlockStart(SESSION, MID, 1, 'blk_1', TEXT_BLOCK, 5)
    store.contentBlockDelta(SESSION, MID, 1, { type: 'text_delta', text: 'second' }, 6)
    // 误发的 retry 到 index=0（已 finalized）
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'POLLUTE' }, 7)
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('first') // 未被污染
    expect((blocks[1].block as { type: 'text'; text: string }).text).toBe('second') // 正常累积
  })
})

describe('useChatRuntimeStore · ContentBlock R1-P0-2 messageStart 重放重置', () => {
  beforeEach(resetStore)

  it('同 messageId 第二次 messageStart（prevSeq>=0）显式重置 blocks 槽位', async () => {
    const store = useChatRuntimeStore.getState()

    // attempt 1
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_0', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'attempt1' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    store.messageStop(SESSION, MID, 5)
    await awaitRaf()

    expect(runtimeCb(SESSION)?.[MID]).toHaveLength(1)

    // attempt 2：daemon 同 messageId 重发（譬如 WS 重连续传）
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 10)
    await awaitRaf()

    // 重放检测应清空 blocks 槽位，让 attempt 2 的内容从干净的 [] 开始累积
    expect(runtimeCb(SESSION)?.[MID]).toEqual([])
    // meta finalized 也回到 false（开始新一轮 stream）
    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.finalized).toBe(false)
  })

  it('首次 messageStart（prevSeq=-1）保持现有空数组占位语义不变', async () => {
    const store = useChatRuntimeStore.getState()

    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    await awaitRaf()

    expect(runtimeCb(SESSION)?.[MID]).toEqual([])
    expect(useChatRuntimeStore.getState().contentBlocksLastSeqBySessionId[SESSION]?.[MID]).toBe(1)
  })

  it('重放后两轮内容不混在一起（R1-P0-1 + R1-P0-2 联动）', async () => {
    const store = useChatRuntimeStore.getState()

    // attempt 1
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_a1', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'first attempt' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    store.messageStop(SESSION, MID, 5)

    // attempt 2：完全重发
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 10)
    store.contentBlockStart(SESSION, MID, 0, 'blk_a2', TEXT_BLOCK, 11)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'second attempt' }, 12)
    store.contentBlockStop(SESSION, MID, 0, 13)
    store.messageStop(SESSION, MID, 14)
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect(blocks).toHaveLength(1) // 不是 2 个、不是混在同一个 block 里
    expect(blocks[0].block_id).toBe('blk_a2')
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('second attempt')
  })
})

describe('useChatRuntimeStore · ContentBlock R3-P0-1 rAF batch', () => {
  beforeEach(resetStore)

  it('单帧多条 delta 合并为单次 flush（rAF 之前 state 未变）', () => {
    const store = useChatRuntimeStore.getState()

    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_raf', TEXT_BLOCK, 2)
    // 同帧内 1000 token：3 条 delta
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'chunk1 ' }, 3)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'chunk2 ' }, 4)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'chunk3' }, 5)

    // rAF 未触发前，已提交块仍空（走的是 pending，没每条都 commit）
    expect(getCommittedBlocks(SESSION, MID) ?? []).toEqual([])
  })

  it('await raf 后 pending 一次性合并到 state（最终文本完整）', async () => {
    const store = useChatRuntimeStore.getState()

    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_raf', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'A' }, 3)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'B' }, 4)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'C' }, 5)
    store.contentBlockStop(SESSION, MID, 0, 6)
    store.messageStop(SESSION, MID, 7)

    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect(blocks).toHaveLength(1)
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('ABC')
    expect(blocks[0].finalized).toBe(true)
    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.finalized).toBe(true)
  })

  it('pending-first 单帧读路径：delta-之间 contentBlockStop 内部能拿到累积值', async () => {
    const store = useChatRuntimeStore.getState()

    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_pf', TOOL_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'input_json_delta', partial_json: '{"path":' }, 3)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'input_json_delta', partial_json: '"/etc/hosts"}' }, 4)
    store.contentBlockStop(SESSION, MID, 0, 5)

    // rAF 之前调用第二轮 setState 内部应已正确读到 pending 数据，
    // contentBlockStop 触发 applyFinalizeFallback → 完整 JSON 被 parse
    await awaitRaf()

    const entry = runtimeCb(SESSION)?.[MID]?.[0]
    expect(entry?.finalized).toBe(true)
    expect((entry?.block as { type: 'tool_use'; input: Record<string, unknown> }).input).toEqual({ path: '/etc/hosts' })
  })

  it('flushRuntimeBatch 同步触发可立刻读到 state（无需 await raf）', () => {
    const store = useChatRuntimeStore.getState()

    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_fl', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'sync' }, 3)

    flushRuntimeBatch()

    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('sync')
  })
})

describe('useChatRuntimeStore · MessageMeta R3-额外 B stop_sequence', () => {
  beforeEach(resetStore)

  it('message_delta(stop_reason="stop_sequence", stop_sequence="</done>") → meta 同时写两个字段', async () => {
    const store = useChatRuntimeStore.getState()

    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.messageDelta(SESSION, MID, { stop_reason: 'stop_sequence', stop_sequence: '</done>' }, undefined, 2)
    await awaitRaf()

    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]
    expect(meta?.stop_reason).toBe('stop_sequence')
    expect(meta?.stop_sequence).toBe('</done>')
  })
})

// ：setTodosForSession / todosBySessionId 已移除——待办改由 deriveTodoTimeline
// 从 message.blocks 纯派生，合并语义的用例见 todoTimeline.test.ts。

// ═══════════════════════════════════════════════════════════════════
// W4a 三轮 W4a-L17：text_delta 走 ensureClosedFences
// ═══════════════════════════════════════════════════════════════════

describe('useChatRuntimeStore · W4a-L17 fence 闭合', () => {
  beforeEach(resetStore)

  it('text_delta 期间未闭合 ``` 块 → block.text 自动补 fence', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_md', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: '```python\ndef foo():' }, 3)
    await awaitRaf()

    const entry = runtimeCb(SESSION)?.[MID]?.[0]
    const blockText = (entry?.block as { text: string }).text
    // 自动补尾部 ``` —— 流式中途代码块不断 fence
    expect(blockText.endsWith('\n```')).toBe(true)
    expect(blockText).toContain('```python\ndef foo():')
  })

  it('后续 delta 累积基于 raw 而非 display text → 不会把临时 fence 当真实文本', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_md', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: '```js\nconst a' }, 3)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: ' = 1\n```\nDone.' }, 4)
    store.contentBlockStop(SESSION, MID, 0, 5)
    await awaitRaf()

    const entry = runtimeCb(SESSION)?.[MID]?.[0]
    const blockText = (entry?.block as { text: string }).text
    // raw 累积 = '```js\nconst a = 1\n```\nDone.'，display fence 已闭合
    expect(blockText).toBe('```js\nconst a = 1\n```\nDone.')
  })

  it('finalize 后 _rawText 清空 + block.text 等价于 LLM raw（已闭合）', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_done', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'Hello world' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    await awaitRaf()

    const entry = runtimeCb(SESSION)?.[MID]?.[0]
    expect((entry as { _rawText?: string })._rawText).toBeUndefined()
    expect((entry?.block as { text: string }).text).toBe('Hello world')
    expect(entry?.finalized).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// W4a 三轮 A-P0-2：__pending__ placeholder + delta fragments replay
// ═══════════════════════════════════════════════════════════════════

describe('useChatRuntimeStore · A-P0-2 widget placeholder + fragments replay', () => {
  beforeEach(resetStore)

  it('input_json_delta 早于 cb_start → entry.block.id = __pending__ + 暂存 fragments', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    // delta 早于 start —— store 内 lazy-create placeholder
    store.contentBlockDelta(SESSION, MID, 0, { type: 'input_json_delta', partial_json: '{"pat' }, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'input_json_delta', partial_json: 'h":"/' }, 3)
    await awaitRaf()

    const entry = runtimeCb(SESSION)?.[MID]?.[0]
    expect(entry).toBeDefined()
    expect((entry?.block as { id?: string }).id).toBe(TOOL_USE_PENDING_TOOL_CALL_ID)
    expect((entry as { _pendingInputJsonFragments?: string[] })._pendingInputJsonFragments).toEqual([
      '{"pat',
      'h":"/',
    ])
  })

  it('cb_start 到达替换 placeholder → fragments 被 replay 到真 toolCallId widget buffer', async () => {
    const { subscribeToolCallArgsDelta, clearToolCallArgsBuffers } = await import(
      './chat/stream/handlers/toolCallArgsBufferStore'
    )
    clearToolCallArgsBuffers(SESSION, 'session_ended')

    const buffers: Array<{ toolCallId: string; accumulatedArgs: string }> = []
    const unsub = subscribeToolCallArgsDelta(SESSION, b => {
      buffers.push({ toolCallId: b.toolCallId, accumulatedArgs: b.accumulatedArgs })
    })

    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    // delta 早于 start，先暂存
    store.contentBlockDelta(SESSION, MID, 0, { type: 'input_json_delta', partial_json: '{"x":' }, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'input_json_delta', partial_json: '1}' }, 3)
    // 真 cb_start 到达：触发 replay
    store.contentBlockStart(SESSION, MID, 0, 'blk_t', {
      type: 'tool_use', id: 'toolu_REAL', name: 'read_file', input: {},
    }, 4)
    await awaitRaf()

    unsub()
    // widget buffer 收到 fragments —— accumulatedArgs 应至少包含完整 partial JSON
    const realBufferStates = buffers.filter(b => b.toolCallId === 'toolu_REAL')
    expect(realBufferStates.length).toBeGreaterThanOrEqual(2)
    expect(realBufferStates[realBufferStates.length - 1].accumulatedArgs).toBe('{"x":1}')
  })
})

// ═══════════════════════════════════════════════════════════════════
// W4a 三轮 C-P0-1：messageStart WS replay 判定（seq<=prev + finalized）
// ═══════════════════════════════════════════════════════════════════

describe('useChatRuntimeStore · C-P0-1 messageStart WS replay 判定', () => {
  beforeEach(resetStore)

  it('seq<=prev + finalized=true → WS replay 触发重置', async () => {
    const store = useChatRuntimeStore.getState()
    // attempt 1：完整一轮
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_first', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'attempt1' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    store.messageStop(SESSION, MID, 5)
    await awaitRaf()
    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.finalized).toBe(true)

    // WS replay：daemon 用同 _seq=1 重发 message_start
    const droppedBefore = getDroppedEventCount().replayReset
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    await awaitRaf()

    // 重置触发：blocks 槽位回到空、meta finalized=false
    expect(runtimeCb(SESSION)?.[MID]).toEqual([])
    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.finalized).toBe(false)
    expect(getDroppedEventCount().replayReset).toBeGreaterThan(droppedBefore)
  })

  it('seq<=prev + finalized=false → 真乱序/重复 drop（不重置）', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 10)
    store.contentBlockStart(SESSION, MID, 0, 'blk_inflight', TEXT_BLOCK, 11)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'inflight' }, 12)
    await awaitRaf()

    // 中途同/倒退 seq messageStart —— message 还没 finalized
    const droppedBefore = getDroppedEventCount().seqDrop
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 5)
    await awaitRaf()

    // 不应重置 —— 流式中的内容保留
    const entry = runtimeCb(SESSION)?.[MID]?.[0]
    expect((entry?.block as { text?: string }).text).toBe('inflight')
    expect(getDroppedEventCount().seqDrop).toBeGreaterThan(droppedBefore)
  })

  it('seq>prev + prevSeq>=0 → daemon retry attempt 触发重置（保持现行覆盖）', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_x', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'attempt1' }, 3)
    await awaitRaf()

    // attempt 2：更大 seq，但 message 仍未 finalized（譬如 attempt 1 中途 error 不发 message_stop）
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 10)
    await awaitRaf()

    expect(runtimeCb(SESSION)?.[MID]).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════
// W4a 三轮 C-P0-2：messageStart reset 同步清旁路状态
// ═══════════════════════════════════════════════════════════════════

describe('useChatRuntimeStore · C-P0-2 reset 同步清旁路状态', () => {
  beforeEach(resetStore)

  it('replay 重置时清 widget buffer + richContent placeholder', async () => {
    const { subscribeToolCallArgsDelta, clearToolCallArgsBuffers, feedInputJsonDelta } = await import(
      './chat/stream/handlers/toolCallArgsBufferStore'
    )
    clearToolCallArgsBuffers(SESSION, 'session_ended')

    const sentinelHits: Array<{ toolCallId: string; deltaCount: number }> = []
    const unsub = subscribeToolCallArgsDelta(SESSION, b => {
      sentinelHits.push({ toolCallId: b.toolCallId, deltaCount: b.deltaCount })
    })

    const store = useChatRuntimeStore.getState()
    // attempt 1：完整一轮含 tool_use 块 + richContent placeholder
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_tool', {
      type: 'tool_use', id: 'toolu_attempt1', name: 'show_widget', input: {},
    }, 2)
    feedInputJsonDelta(SESSION, 'toolu_attempt1', 'show_widget', '{"a":1}')
    store.upsertRichContentBlocksByToolCallId(SESSION, [{
      type: 'rich_content', kind: 'widget', widget_id: 'pending:toolu_attempt1',
      tool_call_id: 'toolu_attempt1', format: 'svg', summary: '',
    }])
    store.contentBlockStop(SESSION, MID, 0, 3)
    store.messageStop(SESSION, MID, 4)
    await awaitRaf()

    expect(useChatRuntimeStore.getState().richContentBlocksBySessionId[SESSION]).toHaveLength(1)

    // WS replay：触发重置 → 应清 widget buffer + richContent placeholder
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    await awaitRaf()
    unsub()

    // widget buffer sentinel —— deltaCount=0 表示清掉
    const cleared = sentinelHits.find(h => h.toolCallId === 'toolu_attempt1' && h.deltaCount === 0)
    expect(cleared).toBeDefined()
    // richContent placeholder 也清空（toolu_attempt1 关联的 placeholder 没了）
    const remainingRich = useChatRuntimeStore.getState().richContentBlocksBySessionId[SESSION] ?? []
    expect(remainingRich.find((b: unknown) => (b as { tool_call_id?: string }).tool_call_id === 'toolu_attempt1')).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════
// W4a 三轮 C-P0-3：messageDelta + contentBlockStop finalized 防御
// ═══════════════════════════════════════════════════════════════════

describe('useChatRuntimeStore · C-P0-3 message + entry 层 finalized 防御', () => {
  beforeEach(resetStore)

  it('messageDelta after messageStop finalized → drop + 不覆盖 stop_reason', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.messageDelta(SESSION, MID, { stop_reason: 'end_turn' }, undefined, 2)
    store.messageStop(SESSION, MID, 3)
    await awaitRaf()
    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.stop_reason).toBe('end_turn')

    // retry 重发 messageDelta —— 应被 finalized 防御 drop
    const droppedBefore = getDroppedEventCount().finalizedAfterStop
    store.messageDelta(SESSION, MID, { stop_reason: 'tool_use' }, undefined, 10)
    await awaitRaf()

    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.stop_reason).toBe('end_turn')
    expect(getDroppedEventCount().finalizedAfterStop).toBeGreaterThan(droppedBefore)
  })

  it('contentBlockStop after entry finalized → noop（不重复 finalize）', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_xyz', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'done' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    await awaitRaf()

    const droppedBefore = getDroppedEventCount().finalizedAfterStop
    // retry：再发 cb_stop
    store.contentBlockStop(SESSION, MID, 0, 5)
    await awaitRaf()
    expect(getDroppedEventCount().finalizedAfterStop).toBeGreaterThan(droppedBefore)
    // text 仍是 done
    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect((blocks[0].block as { text: string }).text).toBe('done')
  })
})

// ═══════════════════════════════════════════════════════════════════
// ：contentBlock watchdog 静默只对账（不本地 force finalize）
// ═══════════════════════════════════════════════════════════════════

describe('useChatRuntimeStore ·  watchdog reconcile-only', () => {
  beforeEach(() => {
    resetStore()
    stopContentBlockWatchdog()
  })
  afterEach(() => {
    stopContentBlockWatchdog()
    __setWatchdogReconcileFnForTest(null)
  })

  async function tickAfterSilence(): Promise<void> {
    const originalNow = Date.now
    try {
      ;(globalThis as { Date: { now: () => number } }).Date.now = () => originalNow() + 200_000
      await __testTickWatchdog(() => useChatRuntimeStore.getState())
      flushRuntimeBatch()
    } finally {
      ;(globalThis as { Date: { now: () => number } }).Date.now = originalNow
    }
  }

  it('静默 >120s + reconcile 保持 busy → 消息不 finalize、不写 timeout', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_stuck', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'partial' }, 3)
    await awaitRaf()

    const reconcileCalls: string[] = []
    __setWatchdogReconcileFnForTest(async (sessionId, reason) => {
      reconcileCalls.push(`${sessionId}:${reason}`)
      setRuntimeBusy(sessionId, true, Date.now())
      return true
    })

    await tickAfterSilence()

    expect(reconcileCalls).toEqual([`${SESSION}:watchdog`])
    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]
    expect(meta?.finalized).toBe(false)
    expect(meta?.stop_reason).not.toBe('timeout')
    expect(isSessionBusy(SESSION)).toBe(true)
    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect(blocks[0]?.partial).not.toBe(true)
  })

  it('静默 >120s + reconcile 本机 idle 收口 → 不经 stop_reason=timeout', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_stuck', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'partial' }, 3)
    await awaitRaf()

    let reconciled = false
    __setWatchdogReconcileFnForTest(async (sessionId) => {
      reconciled = true
      // 模拟 reconcile idle 收口：结束投影 busy，但不伪造 timeout finalize
      setRuntimeBusy(sessionId, false, Date.now())
      return true
    })

    await tickAfterSilence()

    expect(reconciled).toBe(true)
    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]
    // watchdog 本身不再写 timeout；收口由 reconcile/endSessionRun 负责
    expect(meta?.stop_reason).not.toBe('timeout')
  })

  it('finalized=true 的 message 不会触发 reconcile', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.messageStop(SESSION, MID, 2)
    await awaitRaf()

    const reconcileCalls: string[] = []
    __setWatchdogReconcileFnForTest(async (sessionId) => {
      reconcileCalls.push(sessionId)
      return true
    })

    await tickAfterSilence()
    expect(reconcileCalls).toEqual([])
  })

  it('startContentBlockWatchdog 无需 setter 即可启动', () => {
    stopContentBlockWatchdog()
    expect(startContentBlockWatchdog(() => useChatRuntimeStore.getState())).toBe(true)
    expect(startContentBlockWatchdog(() => useChatRuntimeStore.getState())).toBe(true)
    stopContentBlockWatchdog()
  })
})

// ═══════════════════════════════════════════════════════════════════
// W4a-L27：text_summary client 端派生（与 Django reassembler 1:1 对齐）
// ═══════════════════════════════════════════════════════════════════

describe('useChatRuntimeStore · W4a-L27 deriveTextSummary 与 Django 对齐', () => {
  beforeEach(resetStore)

  function entry(index: number, block: ContentBlock, finalized = true): ContentBlockEntry {
    return { index, block_id: `blk_${index}`, block, finalized, partial: false }
  }

  it('全部都是 text 块 → 拼接所有 text、用 \\n 连接', () => {
    const entries = [
      entry(0, { type: 'text', text: 'Hello' }),
      entry(1, { type: 'text', text: 'World' }),
    ]
    expect(deriveTextSummary(entries)).toBe('Hello\nWorld')
  })

  it('text 块 + tool_use 块 → 仅取 text 内容', () => {
    const entries = [
      entry(0, { type: 'text', text: 'I will read the file' }),
      entry(1, { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} }),
      entry(2, { type: 'text', text: 'Done.' }),
    ]
    expect(deriveTextSummary(entries)).toBe('I will read the file\nDone.')
  })

  it('全部都是 tool_use 块 → [工具调用] 占位', () => {
    const entries = [
      entry(0, { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} }),
      entry(1, { type: 'tool_use', id: 'tu2', name: 'write_file', input: {} }),
    ]
    expect(deriveTextSummary(entries)).toBe('[工具调用]')
  })

  it('全部都是 thinking 块（用户极早期 abort）→ [思考中] 占位', () => {
    const entries = [
      entry(0, { type: 'thinking', thinking: 'Let me think...', signature: '' }),
    ]
    expect(deriveTextSummary(entries)).toBe('[思考中]')
  })

  it('全部都是 tabtin_rich_content 块 → [富内容] 占位', () => {
    const entries = [
      entry(0, { type: 'tabtin_rich_content' as 'text', text: '' } as unknown as ContentBlock),
    ]
    // 由于 ContentBlock union 不直接包含 tabtin_rich_content，强转
    expect(deriveTextSummary(entries)).toBe('[富内容]')
  })

  it('#7728：全部都是 video 块 → [富内容] 占位', () => {
    const entries = [
      entry(0, { type: 'video' as 'text', text: '' } as unknown as ContentBlock),
    ]
    expect(deriveTextSummary(entries)).toBe('[富内容]')
  })

  it('优先级 tool_use > rich > thinking（与 Django reassembler 严格一致）', () => {
    const entries = [
      entry(0, { type: 'thinking', thinking: 'x', signature: '' }),
      entry(1, { type: 'tool_use', id: 'tu1', name: 'r', input: {} }),
      entry(2, { type: 'tabtin_rich_content' as 'text', text: '' } as unknown as ContentBlock),
    ]
    expect(deriveTextSummary(entries)).toBe('[工具调用]')
  })

  it('text 长度 > 200 字 → 截前 200 字（无省略号）', () => {
    const longText = 'a'.repeat(500)
    const entries = [entry(0, { type: 'text', text: longText })]
    const result = deriveTextSummary(entries)
    expect(result).toHaveLength(200)
    expect(result).toBe('a'.repeat(200))
  })

  it('多 text 块累计 > 200 字 → 截前 200（含 \\n）', () => {
    const entries = [
      entry(0, { type: 'text', text: 'a'.repeat(150) }),
      entry(1, { type: 'text', text: 'b'.repeat(150) }),
    ]
    const result = deriveTextSummary(entries)
    expect(result).toHaveLength(200)
    expect(result.startsWith('a'.repeat(150) + '\n')).toBe(true)
  })

  it('W4.5-A1 Review · P1-4 emoji surrogate pair：长度按 code point 计（与 Python len 一致）', () => {
    // 200 个 emoji（每个 emoji JS string.length=2 但 Python len=1）
    const emojiText = '😀'.repeat(300)
    const entries = [entry(0, { type: 'text', text: emojiText })]
    const result = deriveTextSummary(entries)
    // 关键断言：按 code point 截取 200 个 emoji（JS string.length 是 400）
    expect(Array.from(result).length).toBe(200)
    // string.length 应为 400（每个 emoji UTF-16 surrogate pair = 2 code units）
    expect(result.length).toBe(400)
    // 全部都是 emoji，最后一个完整 code point 仍是 😀（不被切到 surrogate pair 中间）
    expect(Array.from(result).slice(-1)[0]).toBe('😀')
    // 不应有孤立 high surrogate（U+D800-U+DBFF）—— 完整 surrogate pair 的
    // high surrogate 后面必须紧跟 low surrogate
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('W4.5-A1 Review · P1-4 emoji + 中文混合：截取按 code point + Python len 对齐', () => {
    // 100 个中文 + 100 个 emoji + 100 个英文字母 = 300 code points，截 200
    const text = '中'.repeat(100) + '😀'.repeat(100) + 'a'.repeat(100)
    const entries = [entry(0, { type: 'text', text })]
    const result = deriveTextSummary(entries)
    expect(Array.from(result).length).toBe(200)
    // 前 100 个中文 + 后 100 个 emoji 全保留
    expect(Array.from(result).slice(0, 100).every(c => c === '中')).toBe(true)
    expect(Array.from(result).slice(100, 200).every(c => c === '😀')).toBe(true)
  })

  it('空 entries / undefined → 返回空字符串', () => {
    expect(deriveTextSummary([])).toBe('')
    expect(deriveTextSummary(undefined)).toBe('')
  })

  it('#1218 复制全文不使用 200 字 text_summary 截断', () => {
    const longText = 'a'.repeat(500)
    const entries = [entry(0, { type: 'text', text: longText })]

    expect(deriveTextSummary(entries)).toBe('a'.repeat(200))
    expect(deriveTextClipboardContent(entries)).toBe(longText)
  })

  it('#1218 复制全文按 content block 顺序拼接所有 text 块', () => {
    const entries = [
      entry(2, { type: 'text', text: '整体结论' }),
      entry(0, { type: 'text', text: '第一部分' }),
      entry(1, { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} }),
      entry(3, { type: 'text', text: '补充说明' }),
    ]

    expect(deriveTextClipboardContent(entries)).toBe('第一部分\n整体结论\n补充说明')
  })

  it('messageStop 时写入 messageMeta.text_summary（端到端契约）', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_0', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'Hello world' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    store.messageStop(SESSION, MID, 5)
    await awaitRaf()

    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]
    expect(meta?.text_summary).toBe('Hello world')
    expect(meta?.finalized).toBe(true)
  })

  it('content_block_stop（text 块 finalize）增量更新 text_summary —— 流式期间预览不空白', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_0', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'partial preview' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    await awaitRaf() // 注意：尚未到 messageStop

    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]
    expect(meta?.text_summary).toBe('partial preview')
    // 此时 message 还未 finalize；UI 预览已可显示
    expect(meta?.finalized).toBe(false)
  })

  it('纯 tool_use 流式 + messageStop → text_summary = [工具调用]', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_tu', { type: 'tool_use', id: 'tu_x', name: 'read_file', input: {} }, 2)
    store.contentBlockStop(SESSION, MID, 0, 3)
    store.messageStop(SESSION, MID, 4)
    await awaitRaf()

    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]
    expect(meta?.text_summary).toBe('[工具调用]')
  })
})

// ═══════════════════════════════════════════════════════════════════
// W4a-L23：内存 LRU trim（按 message_count 限额 200，trim batch 50）
// ═══════════════════════════════════════════════════════════════════

describe('useChatRuntimeStore · W4a-L23 contentBlocks LRU trim', () => {
  beforeEach(resetStore)

  it('< 阈值 + batch（250 message）→ noop（不 trim）', async () => {
    const store = useChatRuntimeStore.getState()
    // 写入 200 个 finalized message
    for (let i = 0; i < 200; i++) {
      const mid = `msg_${i}`
      store.messageStart(SESSION, mid, {
        role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z',
      }, i * 10 + 1)
      store.messageStop(SESSION, mid, i * 10 + 2)
    }
    await awaitRaf()

    // 还没超阈值（200 ≤ 250），noop
    const sessionMeta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION] ?? {}
    expect(Object.keys(sessionMeta)).toHaveLength(200)
  })

  it('> 阈值 + batch（251 message）→ trim 最早 50 个 finalized message', async () => {
    const store = useChatRuntimeStore.getState()
    // 写入 251 个 finalized message —— 第 251 个 messageStart 触发 trim
    for (let i = 0; i < 251; i++) {
      const mid = `msg_${i.toString().padStart(3, '0')}`
      store.messageStart(SESSION, mid, {
        role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z',
      }, i * 10 + 1)
      store.messageStop(SESSION, mid, i * 10 + 2)
    }
    await awaitRaf()

    const sessionMeta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION] ?? {}
    // 251 - 50 = 201
    expect(Object.keys(sessionMeta)).toHaveLength(201)
    // 最早 50 个被 trim：msg_000 到 msg_049
    expect(sessionMeta['msg_000']).toBeUndefined()
    expect(sessionMeta['msg_049']).toBeUndefined()
    // msg_050+ 仍在
    expect(sessionMeta['msg_050']).toBeDefined()
    expect(sessionMeta['msg_250']).toBeDefined()
    // 同步清了 contentBlocks 和 lastSeq
    const cb = runtimeCb(SESSION) ?? {}
    expect(cb['msg_000']).toBeUndefined()
    expect(cb['msg_049']).toBeUndefined()
    const cs = useChatRuntimeStore.getState().contentBlocksLastSeqBySessionId[SESSION] ?? {}
    expect(cs['msg_000']).toBeUndefined()
    expect(cs['msg_049']).toBeUndefined()
  })

  it('trim 不影响 active streaming 中的 message（finalized=false）', async () => {
    const store = useChatRuntimeStore.getState()
    // 写入 100 个 finalized message + 200 个 active streaming
    for (let i = 0; i < 100; i++) {
      const mid = `done_${i.toString().padStart(3, '0')}`
      store.messageStart(SESSION, mid, {
        role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z',
      }, i * 10 + 1)
      store.messageStop(SESSION, mid, i * 10 + 2)
    }
    for (let i = 0; i < 200; i++) {
      const mid = `active_${i.toString().padStart(3, '0')}`
      store.messageStart(SESSION, mid, {
        role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z',
      }, 5000 + i * 10 + 1)
      // 不调 messageStop —— 保持 finalized=false
    }
    await awaitRaf()

    // 总数 300 > 250 阈值；应 trim 50 个
    // 但只有 100 个 finalized 候选 —— 应只 trim 最早 50 个 done_*，active_* 全保留
    const sessionMeta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION] ?? {}
    // 250 = 300 - 50 trimmed
    expect(Object.keys(sessionMeta)).toHaveLength(250)
    // 所有 active_ 仍在
    expect(Object.keys(sessionMeta).filter(k => k.startsWith('active_'))).toHaveLength(200)
    // done_000 - done_049 被 trim，done_050+ 保留
    expect(sessionMeta['done_000']).toBeUndefined()
    expect(sessionMeta['done_049']).toBeUndefined()
    expect(sessionMeta['done_050']).toBeDefined()
  })

  it('trim 保留 messageMeta 完整性（被保留的 message 字段不丢）', async () => {
    const store = useChatRuntimeStore.getState()
    for (let i = 0; i < 251; i++) {
      const mid = `msg_${i.toString().padStart(3, '0')}`
      store.messageStart(SESSION, mid, {
        role: 'assistant',
        model_id: `model_${i}`,
        model_name: `Model ${i}`,
        started_at: `2025-01-01T00:00:${(i % 60).toString().padStart(2, '0')}Z`,
      }, i * 10 + 1)
      store.messageStop(SESSION, mid, i * 10 + 2)
    }
    await awaitRaf()

    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.['msg_100']
    expect(meta).toBeDefined()
    expect(meta?.role).toBe('assistant')
    expect(meta?.model_id).toBe('model_100')
    expect(meta?.model_name).toBe('Model 100')
    expect(meta?.finalized).toBe(true)
  })

  it('多次触发 trim：每次都按最新 lastSeq 扫描', async () => {
    const store = useChatRuntimeStore.getState()
    // 写入 251 → trim 一次（剩 201）
    for (let i = 0; i < 251; i++) {
      const mid = `m1_${i.toString().padStart(3, '0')}`
      store.messageStart(SESSION, mid, {
        role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z',
      }, i * 10 + 1)
      store.messageStop(SESSION, mid, i * 10 + 2)
    }
    await awaitRaf()
    expect(Object.keys(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION] ?? {})).toHaveLength(201)

    // 再加 50 个 → 仍 ≤ 251 不触发（251）（>250 触发）
    for (let i = 0; i < 50; i++) {
      const mid = `m2_${i.toString().padStart(3, '0')}`
      store.messageStart(SESSION, mid, {
        role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z',
      }, 10000 + i * 10 + 1)
      store.messageStop(SESSION, mid, 10000 + i * 10 + 2)
    }
    await awaitRaf()
    // 现在 201 + 50 = 251，最后一个 messageStart 触发 trim → 251 - 50 = 201
    const final = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION] ?? {}
    expect(Object.keys(final)).toHaveLength(201)
  })

  it('其他 session 的 message 不被本 session trim 影响', async () => {
    const store = useChatRuntimeStore.getState()
    const SID_A = 'sess-A'
    const SID_B = 'sess-B'
    for (let i = 0; i < 251; i++) {
      const mid = `msg_${i.toString().padStart(3, '0')}`
      store.messageStart(SID_A, mid, {
        role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z',
      }, i * 10 + 1)
      store.messageStop(SID_A, mid, i * 10 + 2)
    }
    // 同时 SID_B 只有 5 个 message
    for (let i = 0; i < 5; i++) {
      const mid = `b_${i}`
      store.messageStart(SID_B, mid, {
        role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z',
      }, i * 10 + 1)
      store.messageStop(SID_B, mid, i * 10 + 2)
    }
    await awaitRaf()

    expect(Object.keys(useChatRuntimeStore.getState().messageMetaBySessionId[SID_A] ?? {})).toHaveLength(201)
    expect(Object.keys(useChatRuntimeStore.getState().messageMetaBySessionId[SID_B] ?? {})).toHaveLength(5)
  })

  it('exposed const 与实际阈值一致（防回归）', () => {
    expect(__MAX_CONTENT_BLOCKS_PER_SESSION).toBe(200)
    expect(__MAX_CONTENT_BLOCK_TRIM_BATCH).toBe(50)
  })

  it('__testTrimContentBlocksLRU 直接调用：< 阈值时 noop', async () => {
    const store = useChatRuntimeStore.getState()
    for (let i = 0; i < 100; i++) {
      const mid = `m_${i}`
      store.messageStart(SESSION, mid, {
        role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z',
      }, i * 10 + 1)
      store.messageStop(SESSION, mid, i * 10 + 2)
    }
    await awaitRaf()
    __testTrimContentBlocksLRU(SESSION)
    await awaitRaf()
    expect(Object.keys(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION] ?? {})).toHaveLength(100)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  阶段 6：useMessageBlocksById per-(sid,mid) listener Set 隔离
// （旧 useContentBlocks 已迁至 messages 层 messageBlocks.ts）
// ═══════════════════════════════════════════════════════════════════

describe('useMessageBlocksById · per-(sid,mid) Zustand selector 隔离', () => {
  beforeEach(resetStore)

  it('100 个 subscriber 订阅不同 (sid, mid) → 针对单个 (sid, mid) flush 只唤醒该 subscriber', async () => {
    const SESSIONS = 10
    const MESSAGES_PER_SESSION = 10 // 共 100 个 subscriber

    const renderSpy: Record<string, number> = {}
    const hooks: Array<{ unmount: () => void; key: string }> = []

    for (let s = 0; s < SESSIONS; s++) {
      for (let m = 0; m < MESSAGES_PER_SESSION; m++) {
        const sid = `sess-${s}`
        const mid = `msg-${s}-${m}`
        const key = `${sid}::${mid}`
        renderSpy[key] = 0
        seedShell(sid, mid)
        const { unmount } = renderHook(() => {
          renderSpy[key]++
          return useMessageBlocksById(sid, mid)
        })
        hooks.push({ unmount, key })
      }
    }

    // 初始挂载所有 hook 都各 render 一次（初始 render）
    const initialRenders = { ...renderSpy }

    // flood 100 条 delta 到 (sess-3, msg-3-5)
    const targetSid = 'sess-3'
    const targetMid = 'msg-3-5'
    const targetKey = `${targetSid}::${targetMid}`
    const store = useChatRuntimeStore.getState()
    seedShell(targetSid, targetMid)
    store.messageStart(targetSid, targetMid, {
      role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z',
    }, 1)
    store.contentBlockStart(targetSid, targetMid, 0, 'blk_target', TEXT_BLOCK, 2)
    for (let i = 0; i < 100; i++) {
      store.contentBlockDelta(targetSid, targetMid, 0, { type: 'text_delta', text: `t${i}` }, 3 + i)
    }
    await act(async () => {
      await awaitRaf()
    })

    // 关键断言：只有 target (sid, mid) 的 subscriber 被唤醒，其他 99 个 render 次数不变
    const targetRendered = renderSpy[targetKey] - initialRenders[targetKey]
    expect(targetRendered).toBeGreaterThanOrEqual(1) // 至少 1 次（rAF 合并）

    let othersRerendered = 0
    for (const key of Object.keys(renderSpy)) {
      if (key === targetKey) continue
      const diff = renderSpy[key] - initialRenders[key]
      if (diff > 0) othersRerendered++
    }
    // 99 个其它 subscriber 应该 0 次重渲染（selector 返回同引用）
    expect(othersRerendered).toBe(0)

    for (const h of hooks) h.unmount()
  })

  it('useContentBlocks 返回稳定空数组引用 + 真数据时返回 store 切片', async () => {
    const { result, rerender } = renderHook(
      ({ sid, mid }: { sid: string; mid: string }) => useMessageBlocksById(sid, mid),
      { initialProps: { sid: SESSION, mid: MID } },
    )
    expect(result.current).toEqual([])

    const store = useChatRuntimeStore.getState()
    act(() => {
      store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
      store.contentBlockStart(SESSION, MID, 0, 'blk_test', TEXT_BLOCK, 2)
      store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'Hi' }, 3)
    })
    await act(async () => { await awaitRaf() })

    rerender({ sid: SESSION, mid: MID })
    expect(result.current).toHaveLength(1)
    expect((result.current[0].block as { text: string }).text).toBe('Hi')
  })

  it('sessionId / messageId 为 null/undefined → 返回稳定空数组（不订阅）', () => {
    const { result } = renderHook(() => useMessageBlocksById(null, null))
    expect(result.current).toEqual([])
    const { result: r2 } = renderHook(() => useMessageBlocksById(undefined, undefined))
    expect(r2.current).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════
// W4a 四轮 R4-4：pushAgentStepForSession 同 id upsert（防 placeholder 重复堆积）
// ═══════════════════════════════════════════════════════════════════

describe('useChatRuntimeStore · R4-4 pushAgentStepForSession 同 id upsert', () => {
  beforeEach(resetStore)

  it('同 id push 两次 → 后到的字段覆盖前到，列表不重复', async () => {
    const store = useChatRuntimeStore.getState()
    store.pushAgentStepForSession(SESSION, {
      id: 'thinking-placeholder-msg_1',
      type: 'thinking',
      title: 'Thinking…',
      status: 'running',
      timestamp: 1000,
    })
    store.pushAgentStepForSession(SESSION, {
      id: 'thinking-placeholder-msg_1',
      type: 'thinking',
      title: 'Updated title',
      status: 'running',
      timestamp: 2000,
    })
    await awaitRaf()

    const steps = useChatRuntimeStore.getState().agentStepsBySessionId[SESSION] ?? []
    const placeholders = steps.filter(s => s.id === 'thinking-placeholder-msg_1')
    expect(placeholders).toHaveLength(1)
    expect(placeholders[0].title).toBe('Updated title')
    expect(placeholders[0].timestamp).toBe(2000)
  })

  it('WS replay / daemon retry 重发同 messageId 的 placeholder → 不重复堆积', async () => {
    const store = useChatRuntimeStore.getState()
    // attempt 1
    store.pushAgentStepForSession(SESSION, {
      id: 'thinking-placeholder-msg_replay',
      type: 'thinking',
      title: 'Thinking…',
      status: 'running',
      timestamp: 1000,
    })
    // WS replay / retry 重发——前一条 store 调用未 flush 前批内同 id upsert
    store.pushAgentStepForSession(SESSION, {
      id: 'thinking-placeholder-msg_replay',
      type: 'thinking',
      title: 'Thinking…',
      status: 'running',
      timestamp: 2000,
    })
    await awaitRaf()
    // attempt 2 跨 flush 边界
    store.pushAgentStepForSession(SESSION, {
      id: 'thinking-placeholder-msg_replay',
      type: 'thinking',
      title: 'Thinking…',
      status: 'running',
      timestamp: 3000,
    })
    await awaitRaf()

    const steps = useChatRuntimeStore.getState().agentStepsBySessionId[SESSION] ?? []
    expect(steps.filter(s => s.id === 'thinking-placeholder-msg_replay')).toHaveLength(1)
    expect(steps[0].timestamp).toBe(3000)
  })

  it('不同 id push 仍正常 append（不影响其它调用方）', async () => {
    const store = useChatRuntimeStore.getState()
    store.pushAgentStepForSession(SESSION, {
      id: 'step-a',
      type: 'thinking',
      title: 'A',
      status: 'running',
      timestamp: 1000,
    })
    store.pushAgentStepForSession(SESSION, {
      id: 'step-b',
      type: 'thinking',
      title: 'B',
      status: 'running',
      timestamp: 2000,
    })
    await awaitRaf()
    const steps = useChatRuntimeStore.getState().agentStepsBySessionId[SESSION] ?? []
    expect(steps).toHaveLength(2)
    expect(steps.map(s => s.id)).toEqual(['step-a', 'step-b'])
  })

  it('R5-4 不降级守门：done step 不被 running 覆盖（WS replay 场景）', async () => {
    const store = useChatRuntimeStore.getState()
    // 完整一轮：placeholder push → 升级到 done
    store.pushAgentStepForSession(SESSION, {
      id: 'thinking-placeholder-msg_x',
      type: 'thinking',
      title: 'Thinking…',
      status: 'running',
      timestamp: 1000,
    })
    store.updateAgentStepForSession(SESSION, 'thinking-placeholder-msg_x', {
      status: 'done',
      durationMs: 500,
    })
    await awaitRaf()

    // WS replay：再次 push 同 id placeholder（status='running'）—— 应被守门拒绝
    store.pushAgentStepForSession(SESSION, {
      id: 'thinking-placeholder-msg_x',
      type: 'thinking',
      title: 'Thinking…',
      status: 'running',
      timestamp: 9000,
    })
    await awaitRaf()

    const steps = useChatRuntimeStore.getState().agentStepsBySessionId[SESSION] ?? []
    const placeholder = steps.find(s => s.id === 'thinking-placeholder-msg_x')
    expect(placeholder?.status).toBe('done')
    expect(placeholder?.timestamp).toBe(1000) // 旧 timestamp 保留
  })

  it('R5-4 不降级守门：error step 不被 running 覆盖', async () => {
    const store = useChatRuntimeStore.getState()
    store.pushAgentStepForSession(SESSION, {
      id: 'step-x',
      type: 'thinking',
      title: 'X',
      status: 'error',
      timestamp: 1000,
    })
    await awaitRaf()
    store.pushAgentStepForSession(SESSION, {
      id: 'step-x',
      type: 'thinking',
      title: 'X retry',
      status: 'running',
      timestamp: 2000,
    })
    await awaitRaf()
    const step = useChatRuntimeStore.getState().agentStepsBySessionId[SESSION]?.[0]
    expect(step?.status).toBe('error')
  })

  it('R5-4 不降级守门：running → running 字段升级仍走 upsert（非降级）', async () => {
    const store = useChatRuntimeStore.getState()
    store.pushAgentStepForSession(SESSION, {
      id: 'step-x',
      type: 'thinking',
      title: 'old title',
      status: 'running',
      timestamp: 1000,
    })
    await awaitRaf()
    store.pushAgentStepForSession(SESSION, {
      id: 'step-x',
      type: 'thinking',
      title: 'new title',
      status: 'running',
      timestamp: 2000,
    })
    await awaitRaf()
    const step = useChatRuntimeStore.getState().agentStepsBySessionId[SESSION]?.[0]
    expect(step?.title).toBe('new title')
    expect(step?.status).toBe('running')
  })
})

// ═══════════════════════════════════════════════════════════════════
// W4a 四轮 R4-7：messageStop 漏 finalized 防御（重发 retry）
// ═══════════════════════════════════════════════════════════════════

describe('useChatRuntimeStore · R4-7 messageStop finalized 防御', () => {
  beforeEach(resetStore)

  it('已 finalized 的 message 再来 messageStop → reconcile metric（W4a 五轮 R5-5 拆分）', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_x', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'Hello' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    store.messageStop(SESSION, MID, 5)
    await awaitRaf()

    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.finalized).toBe(true)
    // W4a 五轮 R5-5：messageStop 重发走 reconcile 路径，不再自增 finalizedAfterStop
    const finalizedBefore = getDroppedEventCount().finalizedAfterStop
    const reconcileBefore = getDroppedEventCount().reconcileMessageStop

    // retry 重发 messageStop —— 走 reconcile-only 路径
    store.messageStop(SESSION, MID, 10)
    await awaitRaf()

    // finalizedAfterStop 保持不变（W4a 五轮：reconcile 不算 drop）
    expect(getDroppedEventCount().finalizedAfterStop).toBe(finalizedBefore)
    // reconcileMessageStop 自增
    expect(getDroppedEventCount().reconcileMessageStop).toBeGreaterThan(reconcileBefore)
    // 内容不变
    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect((blocks[0].block as { text: string }).text).toBe('Hello')
    expect(blocks[0].partial).toBeFalsy()
  })

  it('R5-8 first-persistedId-wins：首次 reconcile persistedId 接受', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.messageStop(SESSION, MID, 2)
    await awaitRaf()

    // 首次 reconcile：接受
    store.messageStop(SESSION, MID, 3, { persistedId: 'srv_uuid_first' })
    await awaitRaf()
    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.persisted_id).toBe('srv_uuid_first')
  })

  it('R5-8 first-persistedId-wins：daemon retry 重发同值 noop', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.messageStop(SESSION, MID, 2)
    store.messageStop(SESSION, MID, 3, { persistedId: 'srv_uuid_x' })
    await awaitRaf()

    // 同值重发：noop（合法 daemon retry）
    store.messageStop(SESSION, MID, 4, { persistedId: 'srv_uuid_x' })
    await awaitRaf()
    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.persisted_id).toBe('srv_uuid_x')
  })

  it('R5-8 first-persistedId-wins：不同 UUID（daemon bug）→ drop + 不覆盖 + persistedIdConflict metric 自增', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.messageStop(SESSION, MID, 2)
    store.messageStop(SESSION, MID, 3, { persistedId: 'srv_uuid_first' })
    await awaitRaf()

    // W4a 六轮收尾：persistedIdConflict 是 daemon bug 强信号，必须 metric 可见
    const conflictBefore = getDroppedEventCount().persistedIdConflict

    // daemon bug：retry 用了不同的 UUID —— 应被守门 drop
    store.messageStop(SESSION, MID, 4, { persistedId: 'srv_uuid_conflict' })
    await awaitRaf()

    // 仍是 first
    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.persisted_id).toBe('srv_uuid_first')
    // metric 自增让 DevPanel 可见 silent bug
    expect(getDroppedEventCount().persistedIdConflict).toBeGreaterThan(conflictBefore)
  })

  it('已 finalized 的 message 再来 messageStop 带 persistedId reconcile → 允许更新 persisted_id', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.messageStop(SESSION, MID, 2)
    await awaitRaf()

    // W3 后端落库回填真 UUID —— 走 reconcile-only 路径
    store.messageStop(SESSION, MID, 3, { persistedId: 'srv_uuid_abc' })
    await awaitRaf()
    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.persisted_id).toBe('srv_uuid_abc')
  })

  it('已 finalized 的 message 再来 messageStop 带 blockIdOverrides reconcile → 允许更新 block_id', async () => {
    const store = useChatRuntimeStore.getState()
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_old', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'X' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    store.messageStop(SESSION, MID, 5)
    await awaitRaf()

    // 后端 reconcile 回填真 UUID
    store.messageStop(SESSION, MID, 6, { blockIdOverrides: { '0': 'blk_real_uuid' } })
    await awaitRaf()
    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect(blocks[0].block_id).toBe('blk_real_uuid')
  })
})

// ═══════════════════════════════════════════════════════════════════
// W4a 四轮 R4-10：C-P0-1 attempt 2 完整 replay 链路端到端
// ═══════════════════════════════════════════════════════════════════

describe('useChatRuntimeStore · R4-10 attempt 2 replay 完整链路', () => {
  beforeEach(resetStore)

  it('WS replay 完整链路：reset 后 cb_start + cb_delta + cb_stop + message_stop 内容正确累积', async () => {
    const store = useChatRuntimeStore.getState()
    // attempt 1：完整一轮，daemon emit 真 _seq 1..5
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_attempt1', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'attempt 1 content' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    store.messageStop(SESSION, MID, 5)
    await awaitRaf()
    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.finalized).toBe(true)

    // WS 断线重连 → main 进程 replay 整条事件流（同 _seq 1..5 + 第二轮真内容）
    // C-P0-1：messageStart(seq=1 + finalized=true) 触发 reset，不 drop
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    await awaitRaf()
    expect(useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]?.finalized).toBe(false)
    expect(runtimeCb(SESSION)?.[MID]).toEqual([])

    // attempt 2 完整链路：cb_start + cb_delta + cb_stop + message_stop
    // 注意 _seq 仍走原 1..5 序列（WS replay 用同 _seq）—— reset 后 prevSeq
    // 被清零，这些事件应正常被消费
    store.contentBlockStart(SESSION, MID, 0, 'blk_attempt2', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'attempt 2 content' }, 3)
    store.contentBlockStop(SESSION, MID, 0, 4)
    store.messageStop(SESSION, MID, 5)
    await awaitRaf()

    // 端到端断言：attempt 2 内容真正累积，不与 attempt 1 串扰
    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect(blocks).toHaveLength(1)
    expect(blocks[0].block_id).toBe('blk_attempt2')
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('attempt 2 content')
    expect(blocks[0].finalized).toBe(true)
    expect(blocks[0].partial).toBeFalsy()

    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]
    expect(meta?.finalized).toBe(true)
  })

  it('daemon retry attempt 2 完整链路（更大 _seq）：reset 后内容正确累积', async () => {
    const store = useChatRuntimeStore.getState()
    // attempt 1：未 finalized（中途 error）
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SESSION, MID, 0, 'blk_attempt1', TEXT_BLOCK, 2)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'attempt1 partial' }, 3)
    await awaitRaf()

    // attempt 2：更大 _seq（譬如 daemon retry 后真新 envelope counter）
    store.messageStart(SESSION, MID, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 100)
    store.contentBlockStart(SESSION, MID, 0, 'blk_attempt2', TEXT_BLOCK, 101)
    store.contentBlockDelta(SESSION, MID, 0, { type: 'text_delta', text: 'attempt 2 fresh' }, 102)
    store.contentBlockStop(SESSION, MID, 0, 103)
    store.messageStop(SESSION, MID, 104)
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect(blocks).toHaveLength(1)
    expect(blocks[0].block_id).toBe('blk_attempt2')
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('attempt 2 fresh')
    expect(blocks[0].finalized).toBe(true)
  })
})
