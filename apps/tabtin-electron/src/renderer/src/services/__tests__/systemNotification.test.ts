import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SystemNotification } from '../systemNotification'

const mockShow = vi.fn()

beforeEach(() => {
  mockShow.mockClear()
  ;(globalThis as any).window = {
    tabtin: {
      notification: { show: mockShow },
    },
  }
})

afterEach(() => {
  delete (globalThis as any).window
})

describe('SystemNotification.agentCompleted', () => {
  it('should send correct payload', () => {
    SystemNotification.agentCompleted({
      title: 'Done',
      body: 'Task finished',
      sessionId: 'sess-1',
      messageRef: 'message-ref-1',
      dedupRef: 'trace-1',
      suppressWhenSourceWindowFocused: true,
    })
    expect(mockShow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent.task.completed',
        priority: 'normal',
        title: 'Done',
        body: 'Task finished',
        metadata: { message_ref: 'message-ref-1', dedup_ref: 'trace-1' },
        suppressWhenSourceWindowFocused: true,
        navigateTo: expect.objectContaining({ type: 'chat-session', id: 'sess-1' }),
      }),
    )
  })

  it('should carry spaceId in navigateTo when provided', () => {
    SystemNotification.agentCompleted({
      title: 'Done',
      body: 'Task finished',
      sessionId: 'sess-1',
      spaceId: 'as-42',
    })
    const payload = mockShow.mock.calls[0][0]
    expect(payload.navigateTo).toEqual({
      type: 'chat-session',
      id: 'sess-1',
      spaceId: 'as-42',
    })
  })
})

describe('SystemNotification.agentHitlWaiting', () => {
  it('should send urgent priority', () => {
    SystemNotification.agentHitlWaiting({
      title: 'Review',
      body: 'Need approval',
      sessionId: 's-2',
    })
    expect(mockShow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent.hitl.waiting',
        priority: 'urgent',
      }),
    )
  })
})

describe('SystemNotification.imMention', () => {
  it('should send navigateTo with conversation id', () => {
    SystemNotification.imMention({
      title: 'Alice',
      body: 'mentioned you',
      conversationId: 'conv-123',
    })
    expect(mockShow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'im.mention',
        priority: 'high',
        navigateTo: { type: 'im-conversation', id: 'conv-123' },
      }),
    )
  })
})

describe('SystemNotification.imMessage', () => {
  it('should use normal priority', () => {
    SystemNotification.imMessage({
      title: 'Bob',
      body: 'New message',
      conversationId: 'conv-456',
      messageRef: 'message-ref-456',
    })
    expect(mockShow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'im.message',
        priority: 'normal',
        metadata: { message_ref: 'message-ref-456' },
      }),
    )
  })
})

describe('SystemNotification.trackerCompleted', () => {
  it('should navigate to tracker', () => {
    SystemNotification.trackerCompleted({
      title: 'Tracker Done',
      body: 'All tasks complete',
      trackerId: 't-1',
      organizationId: 'ws-1',
      spaceId: 'as-1',
    })
    expect(mockShow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tracker.run.completed',
        navigateTo: {
          type: 'tracker',
          id: 't-1',
          organizationId: 'ws-1',
          spaceId: 'as-1',
        },
      }),
    )
  })
})

describe('SystemNotification.extensionEvent', () => {
  it('透传 Desktop 不可用时的 Toast 回退策略', () => {
    SystemNotification.extensionEvent({
      type: 'account.degradation_alert',
      title: '服务降级提醒',
      body: '部分能力暂时受限',
      toastFallback: 'desktop-unavailable',
    })

    expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({
      toastFallback: 'desktop-unavailable',
    }))
  })

  it('透传服务端通知关联 metadata', () => {
    SystemNotification.extensionEvent({
      type: 'agent.task.completed',
      title: 'Done',
      body: 'Task complete',
      metadata: { trace_id: 'trace-1', dedup_ref: 'trace-1' },
    })

    expect(mockShow).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { trace_id: 'trace-1', dedup_ref: 'trace-1' },
    }))
  })

  it('should use provided priority', () => {
    SystemNotification.extensionEvent({
      title: 'Email',
      body: 'New mail',
      priority: 'high',
    })
    expect(mockShow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'extension.event',
        priority: 'high',
      }),
    )
  })

  it('should default to normal priority', () => {
    SystemNotification.extensionEvent({
      title: 'Event',
      body: 'Something happened',
    })
    expect(mockShow).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'normal' }),
    )
  })
})

describe('SystemNotification.agentInterrupted', () => {
  it('should include navigateTo when sessionId is provided', () => {
    SystemNotification.agentInterrupted({
      title: 'Interrupted',
      body: 'Agent stopped',
      sessionId: 'sess-int',
      spaceId: 'as-99',
    })
    const payload = mockShow.mock.calls[0][0]
    expect(payload.navigateTo).toEqual({
      type: 'chat-session',
      id: 'sess-int',
      spaceId: 'as-99',
    })
  })

  it('should omit navigateTo when sessionId is absent', () => {
    SystemNotification.agentInterrupted({
      title: 'Interrupted',
      body: 'Agent stopped',
    })
    const payload = mockShow.mock.calls[0][0]
    expect(payload.navigateTo).toBeUndefined()
  })
})

describe('SystemNotification.agentSessionInterrupted', () => {
  it('should use the dedicated session interrupted type', () => {
    SystemNotification.agentSessionInterrupted({
      title: 'Session interrupted',
      body: 'Runtime restarted',
      sessionId: 'sess-restart',
    })
    expect(mockShow).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent.task.session_interrupted',
        priority: 'low',
        navigateTo: expect.objectContaining({ type: 'chat-session', id: 'sess-restart' }),
      }),
    )
  })
})

describe('SystemNotification space normalization', () => {
  it('should pass through spaceId to payload and navigateTo', () => {
    SystemNotification.extensionEvent({
      title: 'Organization Event',
      body: 'Body',
      spaceId: 'as-7',
      navigateTo: { type: 'tracker', id: 't-1' },
    })
    const payload = mockShow.mock.calls[0][0]
    expect(payload.spaceId).toBe('as-7')
    expect(payload.navigateTo).toEqual({
      type: 'tracker',
      id: 't-1',
      spaceId: 'as-7',
    })
  })

  it('should backfill navigateTo.organizationId from top-level organizationId', () => {
    SystemNotification.extensionEvent({
      title: 'Organization Event',
      body: 'Body',
      organizationId: 'ws-9',
      navigateTo: { type: 'tracker', id: 't-1' },
    })
    const payload = mockShow.mock.calls[0][0]
    expect(payload.navigateTo).toEqual({
      type: 'tracker',
      id: 't-1',
      organizationId: 'ws-9',
    })
  })

  it('should backfill navigateTo.spaceId from top-level spaceId', () => {
    SystemNotification.extensionEvent({
      title: 'Space Event',
      body: 'Body',
      spaceId: 'as-9',
      navigateTo: { type: 'tracker', id: 't-1' },
    })
    const payload = mockShow.mock.calls[0][0]
    expect(payload.navigateTo).toEqual({
      type: 'tracker',
      id: 't-1',
      spaceId: 'as-9',
    })
  })
})

describe('SystemNotification graceful degradation', () => {
  it('should not throw when tabtin is unavailable', () => {
    ;(globalThis as any).window = {}
    expect(() => {
      SystemNotification.agentCompleted({ title: 'x', body: 'y' })
    }).not.toThrow()
  })
})
