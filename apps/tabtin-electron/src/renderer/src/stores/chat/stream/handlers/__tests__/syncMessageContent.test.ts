/**
 * `syncDerivedContentToChatMessage` helper 单测。
 *
 * 这个 helper 是「侧边栏 + footer 修复 v2」的核心——保证 cancel/error 路径下
 * 被中断的 assistant 消息也能写入 derived `content`，footer 不会重新消失。
 *
 * 验证维度：
 *   - assistant role + 非空 blocks → 写 ChatMessage.content + content_blocks_json
 *   - user role → 不写（不覆盖 sendMessageAction 主路径设置的 content）
 *   - 空 blocks → 不写（极端 case：message_start 后立即 stop）
 *   - 优先用 meta.text_summary 避免重复派生（性能 + 一致性）
 *   - meta.text_summary 缺失时 fallback 到 deriveTextSummary
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const _mockMessagesBySession: Record<string, Array<{
  id: string
  role: string
  content: string
  content_blocks_json?: unknown[]
}>> = {}

const _mockUpdateSessionMessages = vi.fn(
  (sessionId: string, updater: (prev: typeof _mockMessagesBySession[string]) => typeof _mockMessagesBySession[string]) => {
    const prev = _mockMessagesBySession[sessionId] ?? []
    _mockMessagesBySession[sessionId] = updater(prev)
  },
)

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      patchMessageById: (sid: string, messageId: string, patcher: (m: typeof _mockMessagesBySession[string][number]) => typeof _mockMessagesBySession[string][number]) =>
        _mockUpdateSessionMessages(sid, (prev: typeof _mockMessagesBySession[string]) =>
          prev.map(m => m.id === messageId ? patcher(m) : m)),
    }),
  },
}))

const _runtimeState = {
  contentBlocksBySessionId: {} as Record<string, Record<string, Array<{ index: number; block: unknown }>>>,
  messageMetaBySessionId: {} as Record<string, Record<string, { role: string; finalized: boolean; text_summary?: string }>>,
}

vi.mock('@/stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => _runtimeState,
  },
}))

//  阶段 6：syncDerivedContentToChatMessage 改读 messages 层 getCommittedBlocks。
// mock 成从既有 _runtimeState fixture 取，测试其余部分不变。
vi.mock('@/stores/chat/messages/messageBlocks', () => ({
  getCommittedBlocks: (sid: string, mid: string) =>
    _runtimeState.contentBlocksBySessionId[sid]?.[mid],
}))

// deriveTextSummary 给一个最小化 mock——只验"meta 缺 text_summary 时是否调到本函数"。
const _mockDerive = vi.fn((entries?: ReadonlyArray<{ index: number; block: { type?: string; text?: unknown } }>) => {
  if (!entries || entries.length === 0) return ''
  const parts: string[] = []
  for (const entry of [...entries].sort((a, b) => a.index - b.index)) {
    if (entry.block?.type === 'text' && typeof entry.block.text === 'string') {
      parts.push(entry.block.text)
    }
  }
  return parts.join('')
})
vi.mock('@/utils/contentBlockSummary', () => ({
  deriveTextSummary: (entries: unknown) => _mockDerive(entries as never),
}))

import { syncDerivedContentToChatMessage } from '../syncMessageContent'

const SESSION = 'sess-1'
const MID = 'msg-1'

function resetState(): void {
  for (const key of Object.keys(_mockMessagesBySession)) delete _mockMessagesBySession[key]
  _runtimeState.contentBlocksBySessionId = {}
  _runtimeState.messageMetaBySessionId = {}
  _mockUpdateSessionMessages.mockClear()
  _mockDerive.mockClear()
  // SESSION 槽位预设——updateSessionMessages 的 updater 需要一个起点
  _mockMessagesBySession[SESSION] = [
    { id: MID, role: 'assistant', content: '', content_blocks_json: [] },
  ]
}

describe('syncDerivedContentToChatMessage', () => {
  beforeEach(resetState)
  afterEach(() => vi.clearAllMocks())

  it('assistant + 非空 blocks → 写 content + content_blocks_json', () => {
    _runtimeState.contentBlocksBySessionId[SESSION] = {
      [MID]: [
        { index: 0, block: { type: 'text', text: 'Hello' } },
      ],
    }
    _runtimeState.messageMetaBySessionId[SESSION] = {
      [MID]: { role: 'assistant', finalized: true, text_summary: 'Hello' },
    }

    syncDerivedContentToChatMessage(SESSION, MID)

    const msg = _mockMessagesBySession[SESSION].find(m => m.id === MID)
    expect(msg!.content).toBe('Hello')
    expect(Array.isArray(msg!.content_blocks_json)).toBe(true)
    expect(msg!.content_blocks_json).toHaveLength(1)
  })

  it('优先用 meta.text_summary 避免重复派生（不调 deriveTextSummary）', () => {
    _runtimeState.contentBlocksBySessionId[SESSION] = {
      [MID]: [{ index: 0, block: { type: 'text', text: 'Hello' } }],
    }
    _runtimeState.messageMetaBySessionId[SESSION] = {
      [MID]: { role: 'assistant', finalized: true, text_summary: 'cached summary' },
    }

    syncDerivedContentToChatMessage(SESSION, MID)

    expect(_mockDerive).not.toHaveBeenCalled()
    const msg = _mockMessagesBySession[SESSION].find(m => m.id === MID)
    expect(msg!.content).toBe('cached summary') // 用的 cached 值不是 derive 的
  })

  it('meta.text_summary 缺失时 fallback 到 deriveTextSummary', () => {
    _runtimeState.contentBlocksBySessionId[SESSION] = {
      [MID]: [{ index: 0, block: { type: 'text', text: 'fresh derive' } }],
    }
    _runtimeState.messageMetaBySessionId[SESSION] = {
      [MID]: { role: 'assistant', finalized: true /* no text_summary */ },
    }

    syncDerivedContentToChatMessage(SESSION, MID)

    expect(_mockDerive).toHaveBeenCalledTimes(1)
    const msg = _mockMessagesBySession[SESSION].find(m => m.id === MID)
    expect(msg!.content).toBe('fresh derive')
  })

  it('user role → 跳过（不覆盖 sendMessageAction 设置的 content）', () => {
    _runtimeState.contentBlocksBySessionId[SESSION] = {
      [MID]: [{ index: 0, block: { type: 'text', text: 'should not write' } }],
    }
    _runtimeState.messageMetaBySessionId[SESSION] = {
      [MID]: { role: 'user', finalized: true, text_summary: 'should not write' },
    }

    syncDerivedContentToChatMessage(SESSION, MID)

    expect(_mockUpdateSessionMessages).not.toHaveBeenCalled()
    // 原始 content 保持不变
    const msg = _mockMessagesBySession[SESSION].find(m => m.id === MID)
    expect(msg!.content).toBe('')
  })

  it('finalizedBlocks 为空时跳过（极端 case：start 后立即 stop）', () => {
    _runtimeState.contentBlocksBySessionId[SESSION] = { [MID]: [] }
    _runtimeState.messageMetaBySessionId[SESSION] = {
      [MID]: { role: 'assistant', finalized: true },
    }

    syncDerivedContentToChatMessage(SESSION, MID)

    expect(_mockUpdateSessionMessages).not.toHaveBeenCalled()
  })

  it('finalizedMeta 缺失时跳过', () => {
    _runtimeState.contentBlocksBySessionId[SESSION] = {
      [MID]: [{ index: 0, block: { type: 'text', text: 'orphan' } }],
    }
    // 没设 messageMetaBySessionId

    syncDerivedContentToChatMessage(SESSION, MID)

    expect(_mockUpdateSessionMessages).not.toHaveBeenCalled()
  })

  it('blocks 按 index 升序写入（即便 store 里是乱序的也能 sort）', () => {
    _runtimeState.contentBlocksBySessionId[SESSION] = {
      [MID]: [
        { index: 2, block: { type: 'text', text: 'world' } },
        { index: 0, block: { type: 'text', text: 'hello ' } },
        { index: 1, block: { type: 'text', text: 'big ' } },
      ],
    }
    _runtimeState.messageMetaBySessionId[SESSION] = {
      [MID]: { role: 'assistant', finalized: true, text_summary: 'hello big world' },
    }

    syncDerivedContentToChatMessage(SESSION, MID)

    const msg = _mockMessagesBySession[SESSION].find(m => m.id === MID)
    const blocksJson = msg!.content_blocks_json as Array<{ type?: string; text?: string }>
    expect(blocksJson[0].text).toBe('hello ') // index 0 在前
    expect(blocksJson[1].text).toBe('big ')   // index 1 中间
    expect(blocksJson[2].text).toBe('world')  // index 2 最后
  })
})
