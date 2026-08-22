/**
 * ：HITL 面板从持久化 hitl_interaction 消息派生的对账测试。
 *
 * 核心回归锚点（对应  事故）：本地有面板、消息里**没有**对应事实
 * （sync 尚未落地 / relay 延迟）时必须**不动**——旧 pendingInteractions
 * 快照对账在这里「缺失即清」误杀了等待中的活审批。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { registerHitlStoreAccess, __resetHitlStoreAccessForTest } from '../../../shared/storeAccessRegistry'
import {
  recordHitlResolvedKey,
  __resetHitlResolvedTombstoneForTest,
} from '../hitlStreamHandlers'
import { reconcileHitlPanelsFromMessages } from '../hitlMessageReconcile'

vi.mock('@/services/systemNotification', () => ({
  SystemNotification: {
    agentHitlWaiting: vi.fn(),
  },
}))

const SESSION = 'session-hitl-msg'

function hitlMessage(hitl: Record<string, unknown>, id = `hitl-${String(hitl.request_key)}`): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    created_at: new Date().toISOString(),
    message_kind: 'hitl_interaction',
    metadata: { hitl },
  } as unknown as ChatMessage
}

function approvalFact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'tool_approval',
    request_key: 'batch-1',
    status: 'pending',
    payload: {
      batch_id: 'batch-1',
      action_requests: [
        { request_id: 'req-1', tool_call_id: 'tc-1', tool_name: 'run_terminal_command' },
      ],
    },
    expires_at: Date.now() + 60_000,
    ...overrides,
  }
}

function askFact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'ask_choice',
    request_key: 'ask-1',
    status: 'pending',
    payload: {
      request_id: 'ask-1',
      questions: [{ id: 'q1', prompt: '选一个', options: [] }],
    },
    expires_at: Date.now() + 60_000,
    ...overrides,
  }
}

describe('reconcileHitlPanelsFromMessages', () => {
  const updateSessionMessages = vi.fn((_sid: string, updater: (prev: unknown[]) => unknown[]) => {
    updater([])
  })
  let pendingApprovalBySessionId: Record<string, unknown> = {}
  let approvalSubmittingBySessionId: Record<string, boolean> = {}
  let pendingAskUserBySessionId: Record<string, unknown> = {}
  let askUserSubmittingBySessionId: Record<string, boolean> = {}

  beforeEach(() => {
    pendingApprovalBySessionId = {}
    approvalSubmittingBySessionId = {}
    pendingAskUserBySessionId = {}
    askUserSubmittingBySessionId = {}
    updateSessionMessages.mockClear()
    __resetHitlResolvedTombstoneForTest()
    __resetHitlStoreAccessForTest?.()
    registerHitlStoreAccess({
      getState: () => ({
        pendingApprovalBySessionId,
        approvalSubmittingBySessionId,
        pendingAskUserBySessionId,
        askUserSubmittingBySessionId,
      }),
      applyState: (partial) => {
        const slice = {
          pendingApprovalBySessionId,
          approvalSubmittingBySessionId,
          pendingAskUserBySessionId,
          askUserSubmittingBySessionId,
        }
        const patch = typeof partial === 'function' ? partial(slice) : partial
        if (patch.pendingApprovalBySessionId) {
          pendingApprovalBySessionId = patch.pendingApprovalBySessionId
        }
        if (patch.approvalSubmittingBySessionId) {
          approvalSubmittingBySessionId = patch.approvalSubmittingBySessionId
        }
        if (patch.pendingAskUserBySessionId) {
          pendingAskUserBySessionId = patch.pendingAskUserBySessionId
        }
        if (patch.askUserSubmittingBySessionId) {
          askUserSubmittingBySessionId = patch.askUserSubmittingBySessionId
        }
      },
      injectSystemMessage: vi.fn(),
      patchMessages: vi.fn(),
      rewriteSessionMessages: (sid: string, _reason: string, updater: (prev: never[]) => never[]) => updateSessionMessages(sid, updater),
    })
  })

  it('pending 审批消息 + 本地无面板 → 恢复打开审批面板（重载/晚进入）', () => {
    reconcileHitlPanelsFromMessages(SESSION, [hitlMessage(approvalFact())])

    expect(pendingApprovalBySessionId[SESSION]).toMatchObject({ batchId: 'batch-1' })
    // ：恢复路径永不 append 气泡（事实消息已在列表；防重载累积）
    expect(updateSessionMessages).not.toHaveBeenCalled()
  })

  it('pending ask 消息 + 本地无面板 → 恢复打开追问面板', () => {
    reconcileHitlPanelsFromMessages(SESSION, [hitlMessage(askFact())])

    expect(pendingAskUserBySessionId[SESSION]).toMatchObject({ kind: 'choice', interruptId: 'ask-1' })
  })

  it('resolved 审批消息 + 本地面板 → 清面板并记墓碑（重放不复活）', () => {
    pendingApprovalBySessionId[SESSION] = { batchId: 'batch-1', sessionId: SESSION }

    const resolved = hitlMessage(approvalFact({ status: 'resolved' }))
    reconcileHitlPanelsFromMessages(SESSION, [resolved])
    expect(pendingApprovalBySessionId[SESSION]).toBeUndefined()

    // 墓碑生效：同一消息哪怕缓存回退成 pending（乱序重放），也不回开
    reconcileHitlPanelsFromMessages(SESSION, [hitlMessage(approvalFact())])
    expect(pendingApprovalBySessionId[SESSION]).toBeUndefined()
  })

  it('expired ask 消息 + 本地面板 → 清面板', () => {
    pendingAskUserBySessionId[SESSION] = {
      kind: 'choice',
      interruptId: 'ask-1',
      toolCallId: 'ask-1',
      messageId: 'ask-1',
      sessionId: SESSION,
    }

    reconcileHitlPanelsFromMessages(SESSION, [hitlMessage(askFact({ status: 'expired' }))])

    expect(pendingAskUserBySessionId[SESSION]).toBeUndefined()
  })

  it('历史终态事实与当前面板 key 不匹配 → 不清、不记无关墓碑（含无 batchId 面板）', () => {
    // 无 batchId 的面板（action approval 形态）——terminal handler 的宽匹配
    // （`!pending.batchId ||`）若不预过滤，任意历史 resolved 事实都会误清它。
    const panel = { batchId: undefined, sessionId: SESSION }
    pendingApprovalBySessionId[SESSION] = panel

    reconcileHitlPanelsFromMessages(SESSION, [
      hitlMessage(approvalFact({ request_key: 'batch-history-old', status: 'resolved' })),
    ])

    expect(pendingApprovalBySessionId[SESSION]).toBe(panel)
  })

  it('【#4999 回归锚点】本地有面板、消息里无对应事实 → 不动', () => {
    const panel = { batchId: 'batch-live', sessionId: SESSION }
    pendingApprovalBySessionId[SESSION] = panel

    // 只有普通消息，没有任何 hitl_interaction 事实（relay 落库延迟场景）
    reconcileHitlPanelsFromMessages(SESSION, [
      { id: 'm1', role: 'assistant', content: 'hi', message_kind: 'llm' } as unknown as ChatMessage,
    ])

    expect(pendingApprovalBySessionId[SESSION]).toBe(panel)
  })

  it('本地已有面板时 pending 事实不覆盖（stream 快路径优先）', () => {
    const panel = { batchId: 'batch-newer', sessionId: SESSION }
    pendingApprovalBySessionId[SESSION] = panel

    reconcileHitlPanelsFromMessages(SESSION, [hitlMessage(approvalFact())])

    expect(pendingApprovalBySessionId[SESSION]).toBe(panel)
  })

  it('pending 事实已过本地墓碑（用户刚提交）→ 不回开', () => {
    recordHitlResolvedKey(SESSION, 'batch-1')

    reconcileHitlPanelsFromMessages(SESSION, [hitlMessage(approvalFact())])

    expect(pendingApprovalBySessionId[SESSION]).toBeUndefined()
  })

  it('【#6744】ask pending 事实已过墓碑（single_hitl_resolved 竞态）→ lifecycle 对账不回开', () => {
    recordHitlResolvedKey(SESSION, 'ask-1')

    reconcileHitlPanelsFromMessages(SESSION, [hitlMessage(askFact())])

    expect(pendingAskUserBySessionId[SESSION]).toBeUndefined()
  })

  it('【#6744】resolved ask 消息清面板后记墓碑，缓存回退 pending 也不复活', () => {
    pendingAskUserBySessionId[SESSION] = {
      kind: 'choice',
      interruptId: 'ask-1',
      toolCallId: 'ask-1',
      messageId: 'ask-1',
      sessionId: SESSION,
    }

    reconcileHitlPanelsFromMessages(SESSION, [hitlMessage(askFact({ status: 'resolved' }))])
    expect(pendingAskUserBySessionId[SESSION]).toBeUndefined()

    reconcileHitlPanelsFromMessages(SESSION, [hitlMessage(askFact())])
    expect(pendingAskUserBySessionId[SESSION]).toBeUndefined()
  })

  it('pending 事实已过期（expires_at <= now）→ 不开', () => {
    reconcileHitlPanelsFromMessages(SESSION, [
      hitlMessage(approvalFact({ expires_at: Date.now() - 1 })),
    ])

    expect(pendingApprovalBySessionId[SESSION]).toBeUndefined()
  })

  it('已过期的 pending 审批事实清除同 request_key 的历史面板', () => {
    pendingApprovalBySessionId[SESSION] = { batchId: 'batch-1', sessionId: SESSION }

    reconcileHitlPanelsFromMessages(SESSION, [
      hitlMessage(approvalFact({ expires_at: Date.now() - 1 })),
    ])

    expect(pendingApprovalBySessionId[SESSION]).toBeUndefined()
  })

  it('已过期的 pending ask 事实清除同 request_key 的历史面板', () => {
    pendingAskUserBySessionId[SESSION] = {
      kind: 'choice',
      interruptId: 'ask-1',
      toolCallId: 'ask-1',
      messageId: 'ask-1',
      sessionId: SESSION,
    }

    reconcileHitlPanelsFromMessages(SESSION, [
      hitlMessage(askFact({ expires_at: Date.now() - 1 })),
    ])

    expect(pendingAskUserBySessionId[SESSION]).toBeUndefined()
  })

  it('多条 pending 审批事实取最后一条（消息升序 = 最新）', () => {
    reconcileHitlPanelsFromMessages(SESSION, [
      hitlMessage(approvalFact({ request_key: 'batch-old', payload: { batch_id: 'batch-old', action_requests: [] } })),
      hitlMessage(approvalFact({ request_key: 'batch-new', payload: { batch_id: 'batch-new', action_requests: [] } })),
    ])

    expect(pendingApprovalBySessionId[SESSION]).toMatchObject({ batchId: 'batch-new' })
  })

  it('非 hitl_interaction 消息与缺 metadata.hitl 的消息被忽略', () => {
    reconcileHitlPanelsFromMessages(SESSION, [
      { id: 'm1', role: 'user', content: 'hello', message_kind: 'llm' } as unknown as ChatMessage,
      { id: 'm2', role: 'assistant', content: '', message_kind: 'hitl_interaction', metadata: {} } as unknown as ChatMessage,
    ])

    expect(pendingApprovalBySessionId[SESSION]).toBeUndefined()
    expect(pendingAskUserBySessionId[SESSION]).toBeUndefined()
  })
})
