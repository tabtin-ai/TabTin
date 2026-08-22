/**
 * messageBlocks ——  /  单一 SSoT + Zustand 原生绑定单测。
 *
 * 守的不变量：
 *   1. `commitBlocks` 不可变更新 message.blocks（换 session 数组与该条消息对象）。
 *   2. `useMessageBlocksById` / `useSessionBlocksRecord` 经 Zustand selector 自动跟上。
 *   3. 改 mid-A 时 mid-B 的 hook 不重渲。
 *   4. 无手写 notify / listener map。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ChatMessage } from '@tabtin/chat-client'

type ChatMockState = { messagesBySessionId: Record<string, ChatMessage[]> }

const { mockState, useChatStore, storeListeners } = vi.hoisted(() => {
  const { useSyncExternalStore } = require('react') as typeof import('react')
  const mockState: ChatMockState = { messagesBySessionId: {} }
  const storeListeners = new Set<() => void>()

  function useChatStoreMock<T>(
    selector: (state: ChatMockState) => T,
  ): T {
    return useSyncExternalStore(
      (onStoreChange) => {
        storeListeners.add(onStoreChange)
        return () => { storeListeners.delete(onStoreChange) }
      },
      () => selector(mockState),
      () => selector(mockState),
    )
  }

  const useChatStore = Object.assign(useChatStoreMock, {
    getState: () => mockState,
    setState: (
      partial:
        | Partial<ChatMockState>
        | ((state: ChatMockState) => Partial<ChatMockState>),
    ) => {
      const patch = typeof partial === 'function' ? partial(mockState) : partial
      if (!patch || Object.keys(patch).length === 0) return
      Object.assign(mockState, patch)
      for (const listener of Array.from(storeListeners)) listener()
    },
    subscribe: (listener: () => void) => {
      storeListeners.add(listener)
      return () => { storeListeners.delete(listener) }
    },
  })

  return { mockState, useChatStore, storeListeners }
})

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore,
}))

import {
  commitBlocks,
  getCommittedBlocks,
  getSessionBlocksRecord,
  hydrateSessionBlocksFromJson,
  clearSessionBlocks,
  clearMessageBlocks,
  useMessageBlocksById,
  useSessionBlocksRecord,
  getMessageBlocksSnapshot,
  __resetMessageBlocks,
} from '../messageBlocks'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { deriveSubagentRunsFromMessages } from '../../subagent/utils/subagentRunsFromMessages'

/** 模拟 store 入口：不可变 hydrate + setState（生产走 setSessionMessages）。 */
function hydrateIntoStore(sessionId: string, messages: ChatMessage[]): void {
  const { messages: next } = hydrateSessionBlocksFromJson(messages)
  useChatStore.setState((state) => ({
    messagesBySessionId: {
      ...state.messagesBySessionId,
      [sessionId]: next,
    },
  }))
}

const SID = 'sess-mb'
const MID = 'msg-mb-1'

function makeMessage(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    created_at: '2025-01-01T00:00:00Z',
    ...overrides,
  } as ChatMessage
}

function makeEntry(index: number, text: string): ContentBlockEntry {
  return {
    index,
    block_id: `blk_${index}`,
    block: { type: 'text', text },
    finalized: true,
    partial: false,
  }
}

beforeEach(() => {
  mockState.messagesBySessionId = {}
  storeListeners.clear()
  __resetMessageBlocks()
})

describe('messageBlocks · commitBlocks Zustand 不可变更新', () => {
  it('换消息对象与 session 数组引用，写入 message.blocks', () => {
    const msg = makeMessage(MID)
    const arr = [msg]
    mockState.messagesBySessionId[SID] = arr

    const next = [makeEntry(0, 'hi')]
    commitBlocks(SID, MID, next)

    expect(getCommittedBlocks(SID, MID)).toBe(next)
    expect(mockState.messagesBySessionId[SID]).not.toBe(arr)
    expect(mockState.messagesBySessionId[SID][0]).not.toBe(msg)
    expect(mockState.messagesBySessionId[SID][0].blocks).toBe(next)
  })

  it('壳不存在时 commit 为 no-op，不抛错', () => {
    expect(() => commitBlocks(SID, 'ghost', [makeEntry(0, 'orphan')])).not.toThrow()
    expect(getCommittedBlocks(SID, 'ghost')).toBeUndefined()
  })

  it('session 块记录随 commit 换新引用（触发跨消息重算）', () => {
    mockState.messagesBySessionId[SID] = [makeMessage(MID)]
    const { result } = renderHook(() => useSessionBlocksRecord(SID))
    const before = result.current
    act(() => commitBlocks(SID, MID, [makeEntry(0, 'a')]))
    expect(result.current).not.toBe(before)
    expect(result.current[MID]?.[0]).toEqual(makeEntry(0, 'a'))
  })

  it('无块变化时 useSessionBlocksRecord 返回同一引用（快照稳定）', () => {
    mockState.messagesBySessionId[SID] = [makeMessage(MID)]
    const { result, rerender } = renderHook(() => useSessionBlocksRecord(SID))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})

describe('messageBlocks · getSessionBlocksRecord', () => {
  it('展平 session 全部已提交块为 Record<mid, entries>', () => {
    mockState.messagesBySessionId[SID] = [makeMessage('m1'), makeMessage('m2')]
    commitBlocks(SID, 'm1', [makeEntry(0, 'a')])
    commitBlocks(SID, 'm2', [makeEntry(0, 'b')])
    const rec = getSessionBlocksRecord(SID)
    expect(Object.keys(rec ?? {}).sort()).toEqual(['m1', 'm2'])
  })

  it('无 session → undefined', () => {
    expect(getSessionBlocksRecord('none')).toBeUndefined()
  })
})

describe('messageBlocks · clear', () => {
  it('clearSessionBlocks 清整 session 的 blocks', () => {
    mockState.messagesBySessionId[SID] = [makeMessage('m1')]
    commitBlocks(SID, 'm1', [makeEntry(0, 'a')])
    expect(getCommittedBlocks(SID, 'm1')).toBeDefined()
    clearSessionBlocks(SID)
    expect(getCommittedBlocks(SID, 'm1')).toBeUndefined()
  })

  it('clearMessageBlocks 清指定消息的 blocks（store 内）', () => {
    mockState.messagesBySessionId[SID] = [makeMessage('m1')]
    commitBlocks(SID, 'm1', [makeEntry(0, 'a')])
    clearMessageBlocks(SID, ['m1'])
    expect(getCommittedBlocks(SID, 'm1')).toBeUndefined()
    expect(mockState.messagesBySessionId[SID][0].blocks).toBeUndefined()
  })
})

describe('messageBlocks · hydrateSessionBlocksFromJson 入口反序列化', () => {
  it('历史 content_blocks_json → message.blocks（保 arrival_seq）', () => {
    const msg = makeMessage(MID, {
      content_blocks_json: [{ type: 'text', text: 'hist', arrival_seq: 42 }],
    })
    mockState.messagesBySessionId[SID] = [msg]
    hydrateIntoStore(SID, [msg])
    const committed = getCommittedBlocks(SID, MID)
    expect(committed).toBeDefined()
    expect((committed![0].block as { text: string }).text).toBe('hist')
    expect((committed![0].block as { arrival_seq?: number }).arrival_seq).toBe(42)
  })

  it('守门：已有 realtime blocks → 不被落库快照覆盖', () => {
    const live = [makeEntry(0, 'live')]
    const msg = makeMessage(MID, { content_blocks_json: [{ type: 'text', text: 'hist' }] })
    mockState.messagesBySessionId[SID] = [msg]
    commitBlocks(SID, MID, live)
    const afterCommit = mockState.messagesBySessionId[SID][0]
    hydrateIntoStore(SID, [afterCommit])
    expect(getCommittedBlocks(SID, MID)).toBe(live)
  })

  it('assistant 的 runtime blocks 非空但缺结果时，从 Agent Runtime 持久化块补齐', () => {
    const toolUse = {
      index: 0,
      block_id: 'tool-use-1',
      block: { type: 'tool_use', id: 'agent:0', name: 'agent', input: { description: '历史任务' } },
      finalized: true,
      partial: false,
    } as never
    const msg = makeMessage(MID, {
      role: 'assistant',
      blocks: [toolUse],
      content_blocks_json: [
        (toolUse as { block: unknown }).block,
        { type: 'tool_result', tool_use_id: 'agent:0', content: 'done\n\n[子 Agent ID: child-1]' },
      ],
    })

    const result = hydrateSessionBlocksFromJson([msg])

    expect(result.changed).toBe(true)
    expect(result.messages[0].blocks?.map((entry) => (entry.block as { type: string }).type)).toEqual([
      'tool_use',
      'tool_result',
    ])
    expect(result.messages[0].content_blocks_json).toBe(msg.content_blocks_json)
    expect(deriveSubagentRunsFromMessages(result.messages)).toMatchObject([
      { subagentRunId: 'child-1', status: 'completed' },
    ])
    expect(hydrateSessionBlocksFromJson(result.messages).changed).toBe(false)
  })

  it('用户消息：blocks 仅 text 时从 content_blocks_json 补回 image（切会话附件）', () => {
    const textOnly = [makeEntry(0, '你知道这个形象是谁吗')]
    const msg = makeMessage(MID, {
      role: 'user',
      content: '你知道这个形象是谁吗',
      blocks: textOnly,
      content_blocks_json: [
        { type: 'text', text: '你知道这个形象是谁吗' },
        {
          type: 'image',
          file_id: 'b4d78785-326c-4638-8f8d-0555c964919f',
          filename: 'image.png',
          mime_type: 'image/png',
          source: {
            type: 'url',
            url: 'http://127.0.0.1:6061/api/services/oss/local-object?object_key=chat%2Fx.png',
          },
        },
      ],
    })
    const result = hydrateSessionBlocksFromJson([msg])
    expect(result.changed).toBe(true)
    expect(result.messages[0]).not.toBe(msg)
    const blocks = result.messages[0].blocks!
    expect(blocks.map((e) => (e.block as { type?: string }).type)).toEqual(['text', 'image'])
    expect((blocks[1].block as { file_id?: string }).file_id).toBe(
      'b4d78785-326c-4638-8f8d-0555c964919f',
    )
    // 入参不被原地改
    expect(msg.blocks).toBe(textOnly)

    // 二次 hydrate 幂等
    const again = hydrateSessionBlocksFromJson(result.messages)
    expect(again.changed).toBe(false)
    expect(again.messages).toBe(result.messages)
  })

  it('用户消息：json 含 composer_preset 不触发反复 hydrate', () => {
    const textOnly = [makeEntry(0, 'hi')]
    const msg = makeMessage(MID, {
      role: 'user',
      content: 'hi',
      blocks: textOnly,
      content_blocks_json: [
        { type: 'text', text: 'hi' },
        { type: 'composer_preset', preset_id: 'p1', params: {} },
      ],
    })
    const first = hydrateSessionBlocksFromJson([msg])
    expect(first.changed).toBe(false)
    expect(first.messages).toBeInstanceOf(Array)
    expect(first.messages[0]).toBe(msg)
  })

  it('旁挂 blocks（replay 直设）→ 保留', () => {
    const preset = [makeEntry(0, 'replay')]
    const msg = makeMessage(MID, { blocks: preset })
    mockState.messagesBySessionId[SID] = [msg]
    hydrateIntoStore(SID, [msg])
    expect(getCommittedBlocks(SID, MID)).toBe(preset)
  })

  it('reload：新消息对象无 blocks → 从 json 水合', () => {
    const first = makeMessage(MID, { content_blocks_json: [{ type: 'text', text: 'hist' }] })
    mockState.messagesBySessionId[SID] = [first]
    hydrateIntoStore(SID, [first])
    expect(getCommittedBlocks(SID, MID)).toBeTruthy()

    const reloaded = makeMessage(MID, { content_blocks_json: [{ type: 'text', text: 'hist' }] })
    expect(reloaded.blocks).toBeUndefined()
    mockState.messagesBySessionId[SID] = [reloaded]
    hydrateIntoStore(SID, [reloaded])
    expect(getCommittedBlocks(SID, MID)!.length).toBe(1)
  })

  it('无 content_blocks_json → 跳过', () => {
    const msg = makeMessage(MID)
    mockState.messagesBySessionId[SID] = [msg]
    hydrateIntoStore(SID, [msg])
    expect(getCommittedBlocks(SID, MID)).toBeUndefined()
    expect(msg.blocks).toBeUndefined()
  })

  it('水合块 → useSessionBlocksRecord 换新引用', () => {
    const msg = makeMessage(MID, { content_blocks_json: [{ type: 'text', text: 'hist' }] })
    mockState.messagesBySessionId[SID] = [msg]
    const { result } = renderHook(() => useSessionBlocksRecord(SID))
    const before = result.current
    act(() => hydrateIntoStore(SID, [msg]))
    expect(result.current).not.toBe(before)
    expect(result.current[MID]).toBeDefined()
  })

  it('无块可水合（已有 blocks）→ hydrate 不改 blocks 引用', () => {
    const live = [makeEntry(0, 'live')]
    const msg = makeMessage(MID, { blocks: live })
    const input = [msg]
    mockState.messagesBySessionId[SID] = input
    const result = hydrateSessionBlocksFromJson(input)
    expect(result.changed).toBe(false)
    expect(result.hydratedMids).toEqual([])
    expect(result.messages).toBe(input)
    expect(result.messages[0]).toBe(msg)
    expect(msg.blocks).toBe(live)
  })

  it('#7794 方案 A：hydrate 不可变，入参对象不被原地改', () => {
    const msg = makeMessage(MID, {
      content_blocks_json: [{ type: 'text', text: 'hist', arrival_seq: 1 }],
    })
    const input = [msg]
    const result = hydrateSessionBlocksFromJson(input)
    expect(result.changed).toBe(true)
    expect(result.hydratedMids).toEqual([MID])
    expect(result.messages).not.toBe(input)
    expect(result.messages[0]).not.toBe(msg)
    expect(msg.blocks).toBeUndefined()
    expect(result.messages[0].blocks).toHaveLength(1)
  })

  it('入口反序列化后 getSessionBlocksRecord 展开该消息', () => {
    const msg = makeMessage(MID, { content_blocks_json: [{ type: 'text', text: 'hist' }] })
    mockState.messagesBySessionId[SID] = [msg]
    hydrateIntoStore(SID, [msg])
    const record = getSessionBlocksRecord(SID)
    expect((record![MID][0].block as { text: string }).text).toBe('hist')
  })
})

describe('messageBlocks · getMessageBlocksSnapshot', () => {
  it('读旁挂 message.blocks', () => {
    const entries = [makeEntry(0, 'live')]
    const msg = makeMessage(MID, { blocks: entries })
    expect(getMessageBlocksSnapshot(msg)).toBe(entries)
  })

  it('无 blocks → 稳定空引用', () => {
    const msg = makeMessage(MID, { content_blocks_json: [{ type: 'text', text: 'hist' }] })
    expect(getMessageBlocksSnapshot(msg)).toHaveLength(0)
    expect(getMessageBlocksSnapshot(msg)).toBe(getMessageBlocksSnapshot(msg))
  })
})

describe('messageBlocks · useMessageBlocksById Zustand selector', () => {
  it('commit 后切到已提交块', () => {
    mockState.messagesBySessionId[SID] = [makeMessage(MID)]
    const { result } = renderHook(() => useMessageBlocksById(SID, MID))
    expect(result.current).toHaveLength(0)
    act(() => commitBlocks(SID, MID, [makeEntry(0, 'live-1'), makeEntry(1, 'live-2')]))
    expect(result.current).toHaveLength(2)
    expect((result.current[0].block as { text: string }).text).toBe('live-1')
  })

  it('null sid → 稳定空引用', () => {
    const { result } = renderHook(() => useMessageBlocksById(null, MID))
    expect(result.current).toHaveLength(0)
  })

  it('两条 bubble 订阅不同 mid，单条 commit 只唤醒目标', () => {
    mockState.messagesBySessionId[SID] = [makeMessage('mid-A'), makeMessage('mid-B')]
    let rendersA = 0
    let rendersB = 0
    renderHook(() => { rendersA++; return useMessageBlocksById(SID, 'mid-A') })
    renderHook(() => { rendersB++; return useMessageBlocksById(SID, 'mid-B') })
    const baseA = rendersA
    const baseB = rendersB
    act(() => commitBlocks(SID, 'mid-A', [makeEntry(0, 'a')]))
    expect(rendersA).toBeGreaterThan(baseA)
    expect(rendersB).toBe(baseB)
  })

  it('#7794 hydrate+setState 后 useMessageBlocksById 拿到新 blocks', () => {
    const fullText = `${'全文段落。'.repeat(40)}结尾标记`
    const summary = Array.from(fullText).slice(0, 200).join('')
    const msg = makeMessage(MID, {
      content: summary,
      content_blocks_json: [{ type: 'text', text: fullText, arrival_seq: 1 }],
    })
    mockState.messagesBySessionId[SID] = [msg]
    const { result } = renderHook(() => useMessageBlocksById(SID, MID))
    expect(result.current).toHaveLength(0)
    act(() => hydrateIntoStore(SID, [msg]))
    expect(result.current).toHaveLength(1)
    expect((result.current[0].block as { text: string }).text).toBe(fullText)
    expect(Array.from((result.current[0].block as { text: string }).text).length).toBeGreaterThan(200)
  })

  it('#7794 blocks: [] 不挡 content_blocks_json 水合', () => {
    const msg = makeMessage(MID, {
      blocks: [],
      content_blocks_json: [{ type: 'text', text: 'from-json', arrival_seq: 1 }],
    })
    mockState.messagesBySessionId[SID] = [msg]
    hydrateIntoStore(SID, [msg])
    expect(getCommittedBlocks(SID, MID)).toHaveLength(1)
    expect((getCommittedBlocks(SID, MID)![0].block as { text: string }).text).toBe('from-json')
  })

  it('仅 hydrate 不 setState 时 selector 不醒，且不污染 store 内对象', () => {
    const msg = makeMessage(MID, {
      content_blocks_json: [{ type: 'text', text: 'pre-set', arrival_seq: 1 }],
    })
    mockState.messagesBySessionId[SID] = [msg]
    const { result } = renderHook(() => useMessageBlocksById(SID, MID))
    expect(result.current).toHaveLength(0)
    const hydrated = hydrateSessionBlocksFromJson([msg])
    expect(hydrated.changed).toBe(true)
    expect(msg.blocks).toBeUndefined()
    expect(hydrated.messages[0].blocks).toHaveLength(1)
    expect(result.current).toHaveLength(0)
  })

  it('#7794 方案 A：同数组引用上灌块后换新数组，selector 醒', () => {
    const msg = makeMessage(MID, {
      content_blocks_json: [{ type: 'text', text: 'wake', arrival_seq: 1 }],
    })
    const arr = [msg]
    mockState.messagesBySessionId[SID] = arr
    const { result } = renderHook(() => useMessageBlocksById(SID, MID))
    expect(result.current).toHaveLength(0)
    act(() => {
      const hydrated = hydrateSessionBlocksFromJson(arr)
      useChatStore.setState((state) => ({
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [SID]: hydrated.messages,
        },
      }))
    })
    expect(mockState.messagesBySessionId[SID]).not.toBe(arr)
    expect(msg.blocks).toBeUndefined()
    expect(result.current).toHaveLength(1)
    expect((result.current[0].block as { text: string }).text).toBe('wake')
  })
})
