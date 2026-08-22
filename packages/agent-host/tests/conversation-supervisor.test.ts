import { describe, expect, it, vi } from 'vitest'
import { ConversationSupervisor } from '../src/conversation/conversation-supervisor.js'
import { HumanInteractionRegistry } from '../src/interaction/human-interaction-registry.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('ConversationSupervisor', () => {
  it('跨会话 @ 先于同一 Agent 的旧队列执行且不与旧 run 重叠', async () => {
    const mentionGate = deferred()
    const order: string[] = []
    const interactions = new HumanInteractionRegistry()
    const supervisor = new ConversationSupervisor<string, string>({
      execute: async (request, context) => {
        if (request === 'mention') {
          order.push('mention:start')
          await mentionGate.promise
          order.push('mention:end')
          return request
        }
        if (request === 'queued-task') {
          order.push('queued-task:start')
          order.push('queued-task:end')
          return request
        }
        order.push('current-task:start')
        return new Promise((_, reject) => {
          context.signal.addEventListener('abort', () => {
            order.push('current-task:abort')
            reject(new Error('interrupted by mention'))
          }, { once: true })
        })
      },
    }, interactions)
    const running = supervisor.submit({
      conversationId: 'direct-chat',
      sessionId: 'direct-session',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      runId: 'run-1',
      request: 'current-task',
    })
    const queued = supervisor.submit({
      conversationId: 'direct-chat',
      sessionId: 'direct-session',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      runId: 'run-queued',
      request: 'queued-task',
    })
    const pendingInteraction = interactions.waitForInput({
      requestId: 'approval-1',
      conversationId: 'direct-session',
      timeoutMs: 1_000,
    })
    const mention = supervisor.submit({
      conversationId: 'group-chat',
      sessionId: 'group-session',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      interruptActive: true,
      runId: 'run-2',
      request: 'mention',
    })

    await expect(running).rejects.toThrow('interrupted by mention')
    await vi.waitFor(() => {
      expect(order).toContain('mention:start')
    })
    expect(order).toEqual([
      'current-task:start',
      'current-task:abort',
      'mention:start',
    ])

    mentionGate.resolve()
    await expect(mention).resolves.toBe('mention')
    await expect(queued).resolves.toBe('queued-task')
    expect(order).toEqual([
      'current-task:start',
      'current-task:abort',
      'mention:start',
      'mention:end',
      'queued-task:start',
      'queued-task:end',
    ])
    expect(interactions.resolve('approval-1', { approved: true })).toBe(false)
    await expect(pendingInteraction).resolves.toMatchObject({
      decisions: [expect.objectContaining({ outcome: 'cancelled' })],
    })
  })

  it('连续跨会话高优先级 run 串行，且后续普通 run 等最后一条结束', async () => {
    const firstMentionGate = deferred()
    const secondMentionGate = deferred()
    const normalGate = deferred()
    const order: string[] = []
    const supervisor = new ConversationSupervisor<string, string>({
      execute: async (request) => {
        order.push(`${request}:start`)
        if (request === 'mention-1') await firstMentionGate.promise
        if (request === 'mention-2') await secondMentionGate.promise
        if (request === 'normal') await normalGate.promise
        order.push(`${request}:end`)
        return request
      },
    })

    const firstMention = supervisor.submit({
      conversationId: 'group-chat-1',
      sessionId: 'group-session-1',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      interruptActive: true,
      runId: 'mention-run-1',
      request: 'mention-1',
    })
    await vi.waitFor(() => expect(order).toEqual(['mention-1:start']))

    const secondMention = supervisor.submit({
      conversationId: 'group-chat-2',
      sessionId: 'group-session-2',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      interruptActive: true,
      runId: 'mention-run-2',
      request: 'mention-2',
    })
    const normal = supervisor.submit({
      conversationId: 'direct-chat',
      sessionId: 'direct-session',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      runId: 'normal-run',
      request: 'normal',
    })
    await Promise.resolve()
    expect(order).toEqual(['mention-1:start'])

    firstMentionGate.resolve()
    await expect(firstMention).resolves.toBe('mention-1')
    await vi.waitFor(() => {
      expect(order).toEqual(['mention-1:start', 'mention-1:end', 'mention-2:start'])
    })

    secondMentionGate.resolve()
    await expect(secondMention).resolves.toBe('mention-2')
    await vi.waitFor(() => {
      expect(order).toEqual([
        'mention-1:start',
        'mention-1:end',
        'mention-2:start',
        'mention-2:end',
        'normal:start',
      ])
    })

    normalGate.resolve()
    await expect(normal).resolves.toBe('normal')
  })

  it('普通 run 先等待旧高优先级 run 时，不会穿透后到的高优先级 run', async () => {
    const firstMentionGate = deferred()
    const secondMentionGate = deferred()
    const normalGate = deferred()
    const order: string[] = []
    const supervisor = new ConversationSupervisor<string, string>({
      execute: async (request) => {
        order.push(`${request}:start`)
        if (request === 'mention-1') await firstMentionGate.promise
        if (request === 'mention-2') await secondMentionGate.promise
        if (request === 'normal') await normalGate.promise
        order.push(`${request}:end`)
        return request
      },
    })

    const firstMention = supervisor.submit({
      conversationId: 'group-chat-1',
      sessionId: 'group-session-1',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      interruptActive: true,
      runId: 'mention-run-1',
      request: 'mention-1',
    })
    await vi.waitFor(() => expect(order).toEqual(['mention-1:start']))

    const normal = supervisor.submit({
      conversationId: 'direct-chat',
      sessionId: 'direct-session',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      runId: 'normal-run',
      request: 'normal',
    })
    const secondMention = supervisor.submit({
      conversationId: 'group-chat-2',
      sessionId: 'group-session-2',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      interruptActive: true,
      runId: 'mention-run-2',
      request: 'mention-2',
    })

    firstMentionGate.resolve()
    await expect(firstMention).resolves.toBe('mention-1')
    await vi.waitFor(() => {
      expect(order).toEqual(['mention-1:start', 'mention-1:end', 'mention-2:start'])
    })

    secondMentionGate.resolve()
    await expect(secondMention).resolves.toBe('mention-2')
    await vi.waitFor(() => expect(order.at(-1)).toBe('normal:start'))
    normalGate.resolve()
    await expect(normal).resolves.toBe('normal')
  })

  it('等待高优先级 run 的普通 run 可被停止且之后不会执行', async () => {
    const mentionGate = deferred()
    const normalExecute = vi.fn(async () => 'normal')
    const supervisor = new ConversationSupervisor<string, string>({
      execute: async (request) => {
        if (request === 'mention') {
          await mentionGate.promise
          return request
        }
        return normalExecute()
      },
    })

    const mention = supervisor.submit({
      conversationId: 'group-chat',
      sessionId: 'group-session',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      interruptActive: true,
      runId: 'mention-run',
      request: 'mention',
    })
    const normal = supervisor.submit({
      conversationId: 'direct-chat',
      sessionId: 'direct-session',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      runId: 'normal-run',
      request: 'normal',
    })

    supervisor.abort({ conversationId: 'direct-chat', sessionId: 'direct-session' })
    await expect(normal).rejects.toThrow('cancelled before execution')
    mentionGate.resolve()
    await expect(mention).resolves.toBe('mention')
    expect(normalExecute).not.toHaveBeenCalled()
  })

  it('dispose 不会唤醒等待高优先级 run 的普通 run', async () => {
    const mentionGate = deferred()
    const normalExecute = vi.fn(async () => 'normal')
    const supervisor = new ConversationSupervisor<string, string>({
      execute: async (request) => {
        if (request === 'mention') {
          await mentionGate.promise
          return request
        }
        return normalExecute()
      },
    })

    const mention = supervisor.submit({
      conversationId: 'group-chat',
      sessionId: 'group-session',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      interruptActive: true,
      runId: 'mention-run',
      request: 'mention',
    })
    const normal = supervisor.submit({
      conversationId: 'direct-chat',
      sessionId: 'direct-session',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      runId: 'normal-run',
      request: 'normal',
    })

    supervisor.dispose()
    await expect(normal).rejects.toThrow('cancelled before execution')
    mentionGate.resolve()
    await expect(mention).resolves.toBe('mention')
    expect(normalExecute).not.toHaveBeenCalled()
  })

  it('同一 Agent 的普通 run 可在不同会话并发执行', async () => {
    const firstGate = deferred()
    const secondGate = deferred()
    const started: string[] = []
    const supervisor = new ConversationSupervisor<string, string>({
      execute: async (request) => {
        started.push(request)
        if (request === 'first') await firstGate.promise
        if (request === 'second') await secondGate.promise
        return request
      },
    })

    const first = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      runId: 'run-1',
      request: 'first',
    })
    const second = supervisor.submit({
      conversationId: 'conversation-2',
      sessionId: 'session-2',
      lifecycleScopeId: 'owner',
      interruptScopeId: 'agent-1',
      runId: 'run-2',
      request: 'second',
    })

    await vi.waitFor(() => {
      expect(started).toEqual(['first', 'second'])
    })
    expect(supervisor.getState('conversation-1').running).toBe(true)
    expect(supervisor.getState('conversation-2').running).toBe(true)

    firstGate.resolve()
    secondGate.resolve()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
  })

  it('executes one conversation in FIFO order and exposes running state', async () => {
    const gate = deferred()
    const order: string[] = []
    const onQueued = vi.fn()
    const onDequeued = vi.fn()
    const supervisor = new ConversationSupervisor<string, string>({
      onQueued,
      onDequeued,
      execute: async (request) => {
        order.push(`${request}:start`)
        if (request === 'first') await gate.promise
        order.push(`${request}:end`)
        return request
      },
    })

    const first = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-1',
      request: 'first',
    })
    const second = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-2',
      request: 'second',
    })

    expect(supervisor.getState('conversation-1')).toEqual({
      running: true,
      busy: true,
      queuedRunIds: ['run-2'],
    })
    expect(onQueued).toHaveBeenCalledOnce()

    gate.resolve()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(onDequeued).toHaveBeenCalledOnce()
    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ])
    expect(supervisor.getState('conversation-1').busy).toBe(false)
  })

  it('aborts the active query and cancels queued queries', async () => {
    let activeSignal: AbortSignal | undefined
    const queuedExecute = vi.fn()
    const supervisor = new ConversationSupervisor<string, string>({
      execute: (request, context) => {
        if (request === 'queued') {
          queuedExecute()
          return Promise.resolve(request)
        }
        activeSignal = context.signal
        return new Promise((_, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(new Error('active aborted')),
            { once: true },
          )
        })
      },
    })

    const running = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-1',
      request: 'active',
    })
    const queued = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-2',
      request: 'queued',
    })

    expect(supervisor.abort({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
    })).toEqual(['run-2'])
    expect(activeSignal?.aborted).toBe(true)
    await expect(running).rejects.toThrow('active aborted')
    await expect(queued).rejects.toThrow('cancelled before execution')
    expect(queuedExecute).not.toHaveBeenCalled()
  })

  it('does not let queue observer failures alter execution', async () => {
    const gate = deferred()
    const executed: string[] = []
    const supervisor = new ConversationSupervisor<string, string>({
      onQueued: () => { throw new Error('observer failed') },
      onDequeued: () => { throw new Error('observer failed') },
      execute: async (request) => {
        if (request === 'first') await gate.promise
        executed.push(request)
        return request
      },
    })
    const first = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-1',
      request: 'first',
    })
    const second = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-2',
      request: 'second',
    })

    gate.resolve()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(executed).toEqual(['first', 'second'])
  })

  it('Map-miss 兜底：identity 两字段同为业务 sessionId 时仍掐断 task_id 在途 run', async () => {
    let activeSignal: AbortSignal | undefined
    const businessSessionId = '16ab3a0e-0575-48b4-8e41-e44a7e1beb13'
    const taskId = 'prompt_abc123def456'
    const supervisor = new ConversationSupervisor<string, string>({
      execute: (_request, context) => {
        activeSignal = context.signal
        return new Promise((_, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(new Error('active aborted')),
            { once: true },
          )
        })
      },
    })
    const running = supervisor.submit({
      conversationId: businessSessionId,
      sessionId: taskId,
      lifecycleScopeId: 'owner-1',
      runId: 'run-1',
      request: 'active',
    })

    // Electron handleAbort 在 sessions Map miss 时用 { conversationId: sessionId, sessionId }
    expect(supervisor.abort({
      conversationId: businessSessionId,
      sessionId: businessSessionId,
    })).toEqual([])
    expect(activeSignal?.aborted).toBe(true)
    await expect(running).rejects.toThrow('active aborted')
  })

  it('does not let an old session identity cancel a new session queue', async () => {
    const supervisor = new ConversationSupervisor<string, string>({
      execute: (request, context) => {
        if (request === 'new') return Promise.resolve(request)
        return new Promise((_, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(new Error('old aborted')),
            { once: true },
          )
        })
      },
    })
    const oldRun = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'old-session',
      lifecycleScopeId: 'owner-1',
      runId: 'old-run',
      request: 'old',
    })
    const newRun = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'new-session',
      lifecycleScopeId: 'owner-1',
      runId: 'new-run',
      request: 'new',
    })

    expect(supervisor.abort({
      conversationId: 'conversation-1',
      sessionId: 'old-session',
    })).toEqual([])
    await expect(oldRun).rejects.toThrow('old aborted')
    await expect(newRun).resolves.toBe('new')
  })

  it('#6582 host stop composition: abort + abortConversationRuns clears mixed-session queue and aborts active', async () => {
    // 模拟 abortSessionByKey：abort（掐 active）后再 abortConversationRuns（强制清整队）。
    // abort alone 在混 session 排队时不清队（上一条用例）；组合后 task-B 不得执行。
    const supervisor = new ConversationSupervisor<string, string>({
      execute: (request, context) => {
        if (request === 'task-b') return Promise.resolve(request)
        return new Promise((_, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(new Error('task-a aborted')),
            { once: true },
          )
        })
      },
    })
    const active = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'task-a',
      lifecycleScopeId: 'owner-1',
      runId: 'run-a',
      request: 'task-a',
    })
    const queued = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'task-b',
      lifecycleScopeId: 'owner-1',
      runId: 'run-b',
      request: 'task-b',
    })

    expect(supervisor.abort({
      conversationId: 'conversation-1',
      sessionId: 'task-a',
    })).toEqual([])
    expect(supervisor.abortConversationRuns({
      conversationId: 'conversation-1',
      sessionId: 'task-a',
    })).toEqual(['run-b'])

    await expect(active).rejects.toThrow('task-a aborted')
    await expect(queued).rejects.toThrow('cancelled before execution')
    expect(supervisor.getState('conversation-1')).toEqual({
      running: false,
      busy: false,
      queuedRunIds: [],
    })
  })

  // ─── FIFO run submission (migrated from the removed AgentHostCoordinator) ──

  it('does not let one failed run block the next run (submitRun)', async () => {
    const supervisor = new ConversationSupervisor<string, string>()
    const first = supervisor.submitRun({
      conversationId: 'conversation-1',
      runId: 'run-1',
      execute: async () => {
        throw new Error('failed')
      },
    })
    const second = supervisor.submitRun({
      conversationId: 'conversation-1',
      runId: 'run-2',
      execute: async () => 'ok',
    })

    await expect(first).rejects.toThrow('failed')
    await expect(second).resolves.toBe('ok')
  })

  it('cancels queued runs by conversation id and pending HITL by session id', async () => {
    const interactions = new HumanInteractionRegistry()
    const supervisor = new ConversationSupervisor<string, string>(undefined, interactions)
    const gate = deferred()
    const running = supervisor.submitRun({
      conversationId: 'conversation-1',
      runId: 'run-1',
      execute: async () => gate.promise,
    })
    const queued = supervisor.submitRun({
      conversationId: 'conversation-1',
      runId: 'run-2',
      execute: async () => 'must-not-run',
    })
    const interaction = interactions.waitForInput({
      requestId: 'request-1',
      conversationId: 'task-1',
      timeoutMs: 1_000,
    })

    // conversationId cancels the queue; sessionId cancels pending interactions.
    expect(supervisor.abortConversationRuns({
      conversationId: 'conversation-1',
      sessionId: 'task-1',
    })).toEqual(['run-2'])
    await expect(queued).rejects.toThrow('cancelled before execution')
    expect(interactions.resolve('request-1', { approved: true })).toBe(false)
    await expect(interaction).resolves.toMatchObject({
      decisions: [expect.objectContaining({ outcome: 'cancelled' })],
    })

    gate.resolve()
    await running
  })

  it('quiesces queued runs before restore re-opens the conversation', async () => {
    const supervisor = new ConversationSupervisor<string, string>()
    const runningGate = deferred()
    let queuedRunStarted = false
    const running = supervisor.submitRun({
      conversationId: 'conversation-1',
      runId: 'run-1',
      execute: async () => runningGate.promise,
    })
    const queued = supervisor.submitRun({
      conversationId: 'conversation-1',
      runId: 'run-2',
      execute: async () => {
        queuedRunStarted = true
        return 'unexpected'
      },
    })

    supervisor.quiesceConversation({
      conversationId: 'conversation-1',
      sessionId: 'task-1',
    })
    await expect(queued).rejects.toThrow('cancelled before execution')

    const submittedDuringCleanup = supervisor.submitRun({
      conversationId: 'conversation-1',
      runId: 'run-during-cleanup',
      execute: async () => {
        queuedRunStarted = true
        return 'unexpected'
      },
    })
    await expect(submittedDuringCleanup).rejects.toThrow('cancelled before execution')

    supervisor.restore('conversation-1')
    expect(queuedRunStarted).toBe(false)

    runningGate.resolve()
    await running
  })

  it('quiesces an owner scope, signals idle, and restores it', async () => {
    const supervisor = new ConversationSupervisor<string, string>()
    const runningGate = deferred()
    let queuedRunStarted = false
    const running = supervisor.submitRun({
      conversationId: 'conversation-1',
      lifecycleScopeId: 'user-1|org-1',
      runId: 'run-1',
      execute: async () => runningGate.promise,
    })
    const queued = supervisor.submitRun({
      conversationId: 'conversation-1',
      lifecycleScopeId: 'user-1|org-1',
      runId: 'run-2',
      execute: async () => {
        queuedRunStarted = true
      },
    })

    supervisor.quiesceScope('user-1|org-1')
    await expect(queued).rejects.toThrow('cancelled before execution')

    let scopeIdle = false
    const idleBarrier = supervisor.waitForScopeIdle('user-1|org-1').then(() => {
      scopeIdle = true
    })
    await Promise.resolve()
    expect(scopeIdle).toBe(false)

    // Runs submitted into the quiesced scope are rejected up front (the guard
    // throws synchronously before the run is ever enqueued).
    expect(() => supervisor.submitRun({
      conversationId: 'conversation-2',
      lifecycleScopeId: 'user-1|org-1',
      runId: 'run-during-reset',
      execute: async () => {
        queuedRunStarted = true
      },
    })).toThrow('cancelled before execution')

    runningGate.resolve()
    await running
    await idleBarrier
    expect(scopeIdle).toBe(true)

    supervisor.restoreScope('user-1|org-1')
    await expect(supervisor.submitRun({
      conversationId: 'conversation-2',
      lifecycleScopeId: 'user-1|org-1',
      runId: 'run-after-reset',
      execute: async () => 'resumed',
    })).resolves.toBe('resumed')
    expect(queuedRunStarted).toBe(false)
  })

  it('notifies onIdle hooks only after the queue slot is released', async () => {
    // push 通知 drain 的时序缺陷回归测试：onTurnFinally 触发的 schedule 会赶在
    // slot 释放前被 isBusy 闸吞掉，因此必须在 queue 真正转 idle 后补一次回调，
    // 且回调触发时 busy 必须已经是 false。
    const idleEvents: Array<{ conversationId: string; busyAtIdle: boolean }> = []
    const supervisor = new ConversationSupervisor<string, string>(
      { execute: async (request) => request },
      undefined,
      {
        onIdle: (conversationId) => {
          idleEvents.push({
            conversationId,
            busyAtIdle: supervisor.getState(conversationId).busy,
          })
        },
      },
    )

    await supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-1',
      request: 'only',
    })

    expect(idleEvents).toEqual([
      { conversationId: 'conversation-1', busyAtIdle: false },
    ])
  })

  it('does not fire onIdle hooks while queued runs remain', async () => {
    const onIdle = vi.fn()
    const gate = deferred()
    const supervisor = new ConversationSupervisor<string, string>(
      {
        execute: async (request) => {
          if (request === 'first') await gate.promise
          return request
        },
      },
      undefined,
      { onIdle },
    )

    const first = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-1',
      request: 'first',
    })
    const second = supervisor.submit({
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-2',
      request: 'second',
    })

    gate.resolve()
    await first
    // first 释放后 second 接力，queue 未空 → 不能报 idle
    expect(onIdle).not.toHaveBeenCalled()
    await second
    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(onIdle).toHaveBeenCalledWith('conversation-1')
  })
})
