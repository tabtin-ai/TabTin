import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, MessageBlock } from '@tabtin/chat-client'

const runtimeHarness = vi.hoisted(() => ({
  reconcile: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../messageBlocks', () => ({
  hydrateSessionBlocksFromJson: (messages: ChatMessage[]) => ({
    messages,
    hydratedMids: [],
    changed: false,
  }),
}))

vi.mock('../../../useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => ({
      evictSession: vi.fn(),
      reconcileSubagentRunsFromArchive: runtimeHarness.reconcile,
    }),
  },
}))

vi.mock('../../../useWsConnectionStore', () => ({
  useWsConnectionStore: { getState: () => ({ removeSuspendedSession: vi.fn() }) },
}))

vi.mock('../../execution/sessionRunProjection', () => ({ isSessionBusy: () => false }))
vi.mock('../messageCache', () => ({ cacheMessages: vi.fn() }))
vi.mock('@/services/agentService/sessionMessages', () => ({
  getSessionMessagesFacade: () => ({ getMessages: () => [], advanceWatermark: vi.fn() }),
}))

import { createMessageCacheActions } from '../messageCacheSlice'
import { deriveSubagentRunsFromMessages } from '../../subagent/utils/subagentRunsFromMessages'

type Root = {
  messagesBySessionId: Record<string, ChatMessage[]>
  sessions: []
  sessionsBySpaceId: Record<string, never>
  sessionsHydrated: boolean
  currentSessionId: string | null
  currentSessionIdBySpaceId: Record<string, never>
  draftSessionBySpaceId: Record<string, never>
  restoringSessionId: string | null
  pendingApprovalBySessionId: Record<string, never>
  pendingAskUserBySessionId: Record<string, never>
}

const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    id,
    role: 'assistant',
    content: '',
    created_at: '2026-08-07T00:00:00.000Z',
    ...overrides,
  }) as ChatMessage

function blockEntry(block: MessageBlock) {
  return { id: `${(block as { id?: string }).id ?? 'b'}`, block }
}

describe('messageCacheSlice 子代理历史投影', () => {
  let state: Root

  beforeEach(() => {
    runtimeHarness.reconcile.mockClear()
    state = {
      messagesBySessionId: {},
      sessions: [],
      sessionsBySpaceId: {},
      sessionsHydrated: false,
      currentSessionId: 'session-1',
      currentSessionIdBySpaceId: {},
      draftSessionBySpaceId: {},
      restoringSessionId: null,
      pendingApprovalBySessionId: {},
      pendingAskUserBySessionId: {},
    }
  })

  const actions = () =>
    createMessageCacheActions(
      () => state,
      (partial) => Object.assign(state, typeof partial === 'function' ? partial(state) : partial),
    )

  it('首屏历史消息规范化写入后统一投影 SubagentRun', () => {
    actions().applyLoadedMessages('session-1', [message('newer')])
    expect(runtimeHarness.reconcile).toHaveBeenCalledWith('session-1')
  })

  it('分页 prepend 旧消息后重新投影 SubagentRun', () => {
    state.messagesBySessionId['session-1'] = [message('newer')]
    actions().prependOlderMessages('session-1', [message('older')])
    expect(runtimeHarness.reconcile).toHaveBeenCalledWith('session-1')
  })

  it('seed 追加缺页子消息后可 derive 孙代理 run', () => {
    state.messagesBySessionId['session-1'] = [message('parent')]
    runtimeHarness.reconcile.mockClear()
    const childWithGrandchild = message('child-1', {
      subagent_run_id: 'child-run',
      blocks: [
        blockEntry({
          type: 'tool_use',
          id: 'toolu_child_0',
          name: 'agent',
          input: { description: '孙代理' },
        } as MessageBlock),
        blockEntry({
          type: 'tool_result',
          tool_use_id: 'toolu_child_0',
          content: 'ok\n\n[子 Agent ID: grandchild-0]',
        } as MessageBlock),
      ],
    })

    actions().mergeSubagentMessages(
      'session-1',
      (dm) => ({ ...dm, subagent_run_id: dm.subagent_run_id ?? 'child-run' }),
      [childWithGrandchild],
      'seed',
    )

    const msgs = state.messagesBySessionId['session-1'] ?? []
    expect(msgs.map((m) => m.id)).toEqual(['parent', 'child-1'])
    expect(runtimeHarness.reconcile).toHaveBeenCalledWith('session-1')

    const runs = deriveSubagentRunsFromMessages(msgs)
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subagentRunId: 'grandchild-0',
          parentToolCallId: 'toolu_child_0',
          label: '孙代理',
        }),
      ]),
    )
  })

  it('seed 不覆盖已有同 id 行（保护 live）', () => {
    const live = message('child-1', {
      content: 'live-rich',
      content_blocks_json: [{ type: 'text' }, { type: 'text' }],
      subagent_run_id: 'child-run',
    })
    state.messagesBySessionId['session-1'] = [live]
    runtimeHarness.reconcile.mockClear()

    actions().mergeSubagentMessages(
      'session-1',
      (dm) => ({ ...dm, content: 'archive-stale' }),
      [message('child-1', { content: 'archive-stale', content_blocks_json: [{ type: 'text' }] })],
      'seed',
    )

    expect(state.messagesBySessionId['session-1']?.[0]?.content).toBe('live-rich')
    expect(runtimeHarness.reconcile).not.toHaveBeenCalled()
  })

  it('seed 幂等：再次 seed 相同缺页不 project', () => {
    state.messagesBySessionId['session-1'] = [message('parent')]
    const child = message('child-1')
    actions().mergeSubagentMessages('session-1', (dm) => dm, [child], 'seed')
    runtimeHarness.reconcile.mockClear()
    actions().mergeSubagentMessages('session-1', (dm) => dm, [child], 'seed')
    expect(runtimeHarness.reconcile).not.toHaveBeenCalled()
  })

  it('flush 覆盖已有 id 且不追加缺页', () => {
    state.messagesBySessionId['session-1'] = [
      message('child-1', { content: 'old', content_blocks_json: [{ type: 'text' }] }),
    ]
    runtimeHarness.reconcile.mockClear()
    actions().mergeSubagentMessages(
      'session-1',
      (dm) => ({ ...dm, content: 'flushed' }),
      [
        message('child-1', { content: 'flushed', content_blocks_json: [{ type: 'text' }, { type: 'text' }] }),
        message('orphan-new'),
      ],
      'flush',
    )
    const msgs = state.messagesBySessionId['session-1'] ?? []
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.content).toBe('flushed')
    expect(runtimeHarness.reconcile).toHaveBeenCalledWith('session-1')
  })
})
