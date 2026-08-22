/**
 * 回归：人正盯着该会话时，lifecycle 终态不得发系统通知，且必须 markViewed。
 *
 * 症状：停留在会话页 → Agent 完成仍弹系统通知 + 侧栏蓝点。
 * 根因分叉：
 *   1) 系统通知：lifecycle 终态无条件 SystemNotification.*（HITL 已有 presence 门闩）
 *   2) 未读蓝点：last_message_at 刷新后未 markViewed
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerChatStoreCallbacks,
} from '../../../shared/storeAccessRegistry'

const chatStoreState = vi.hoisted(() => ({
  currentSessionId: null as string | null,
}))

const markViewed = vi.hoisted(() => vi.fn())

vi.mock('@/services/systemNotification', () => ({
  SystemNotification: {
    agentCompleted: vi.fn(),
    agentError: vi.fn(),
    agentInterrupted: vi.fn(),
    agentSessionInterrupted: vi.fn(),
  },
}))

vi.mock('@/stores/useSessionReadStore', () => ({
  useSessionReadStore: {
    getState: () => ({ markViewed }),
  },
}))

import { SystemNotification } from '@/services/systemNotification'
import {
  ackLifecycleSessionViewedIfPresent,
  emitOrAckLifecycleTerminalNotification,
} from '../lifecycleTerminalNotify'

function focusForegroundSession(sessionId: string): void {
  chatStoreState.currentSessionId = sessionId
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible' as DocumentVisibilityState,
  })
}

describe('lifecycleTerminalNotify — 前台当前会话', () => {
  beforeEach(() => {
    chatStoreState.currentSessionId = null
    markViewed.mockClear()
    vi.mocked(SystemNotification.agentCompleted).mockClear()
    vi.mocked(SystemNotification.agentError).mockClear()
    vi.mocked(SystemNotification.agentInterrupted).mockClear()
    vi.mocked(SystemNotification.agentSessionInterrupted).mockClear()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden' as DocumentVisibilityState,
    })
    registerChatStoreCallbacks({
      isSessionBusy: () => false,
      getStreamingSessionIds: () => [],
      getCurrentSessionId: () => chatStoreState.currentSessionId,
      syncSessionMessagesFromServer: vi.fn(),
      getSessionsBySpaceId: () => ({}),
      updateSessionTitleInCaches: vi.fn(),
      upsertSessionInSpace: vi.fn(),
      injectErrorBubble: vi.fn(),
      upsertObservedUserMessage: vi.fn(),
      linkServerMessageId: vi.fn(),
      rebindMessageIds: vi.fn(),
    })
  })

  it('前台盯着该会话完成 → 交给主进程原生焦点门闩确认已读', () => {
    focusForegroundSession('sess-viewing')

    const result = emitOrAckLifecycleTerminalNotification({
      phase: 'end',
      sessionId: 'sess-viewing',
      spaceId: 'space-1',
      notifyPrefix: '',
      completedTitle: 'Agent 任务完成',
      completedBody: '对话已完成处理',
      errorTitle: 'err',
      interruptedTitle: 'int',
    })

    expect(result).toBe('notified')
    expect(SystemNotification.agentCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        suppressWhenSourceWindowFocused: true,
        markSessionViewedWhenSuppressed: true,
      }),
    )
    expect(markViewed).not.toHaveBeenCalled()
  })

  it('payload sessionId 与 currentSessionId 不一致 → 仍通知（id 语义）', () => {
    focusForegroundSession('sess-viewing')

    const result = emitOrAckLifecycleTerminalNotification({
      phase: 'end',
      sessionId: 'sess-other',
      notifyPrefix: 'Space · ',
      completedTitle: 'Agent 任务完成',
      completedBody: '对话已完成处理',
      errorTitle: 'err',
      interruptedTitle: 'int',
    })

    expect(result).toBe('notified')
    expect(SystemNotification.agentCompleted).toHaveBeenCalledTimes(1)
    expect(markViewed).not.toHaveBeenCalled()
  })

  it('失焦时即使 currentSessionId 匹配也发通知', () => {
    chatStoreState.currentSessionId = 'sess-1'
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible' as DocumentVisibilityState,
    })

    const result = emitOrAckLifecycleTerminalNotification({
      phase: 'end',
      sessionId: 'sess-1',
      dedupRef: 'trace-1',
      notifyPrefix: '',
      completedTitle: 'done',
      completedBody: 'body',
      errorTitle: 'err',
      interruptedTitle: 'int',
    })

    expect(result).toBe('notified')
    expect(SystemNotification.agentCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupRef: 'trace-1',
        suppressWhenSourceWindowFocused: true,
      }),
    )
  })

  it('运行时服务器重启中断 → 走 session_interrupted 专用通知类型', () => {
    const result = emitOrAckLifecycleTerminalNotification({
      phase: 'session_interrupted',
      sessionId: 'sess-2',
      notifyPrefix: '',
      completedTitle: 'done',
      completedBody: 'body',
      errorTitle: 'err',
      interruptedTitle: 'Agent 会话已中断',
      sessionInterruptedBody: '运行时服务器重启，会话已中断',
    })

    expect(result).toBe('notified')
    expect(SystemNotification.agentSessionInterrupted).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Agent 会话已中断',
        body: '运行时服务器重启，会话已中断',
        sessionId: 'sess-2',
      }),
    )
  })

  it('session 刷新后仍在前台 → ackLifecycleSessionViewedIfPresent 再 markViewed', () => {
    focusForegroundSession('sess-viewing')
    expect(ackLifecycleSessionViewedIfPresent('sess-viewing')).toBe(true)
    expect(markViewed).toHaveBeenCalledWith('sess-viewing')
  })
})
