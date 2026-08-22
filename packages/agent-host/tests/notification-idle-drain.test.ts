import { describe, expect, it, vi } from 'vitest'
import {
  NotificationQueue,
  SHELL_NOTIFICATION_KIND,
  type NotificationEnvelope,
  type BackgroundTaskCompletedPayload,
} from '@tabtin/terminal-core'

import {
  NotificationIdleDrain,
  type NotificationDrainContext,
} from '../src/delivery/notification-idle-drain.js'

const THREAD_ID = 'thread-123456789'

function shellEnvelope(dedupKey: string): NotificationEnvelope<BackgroundTaskCompletedPayload> {
  return {
    kind: SHELL_NOTIFICATION_KIND,
    target: { spaceId: 'space-1', threadId: THREAD_ID },
    priority: 'later',
    enqueuedAt: Date.now(),
    dedupKey,
    payload: {
      agent_session_id: dedupKey,
      tool_use_id: `tool-${dedupKey}`,
      command: 'echo hi',
      exit_code: 0,
      exited_by: 'normal_exit',
      duration_ms: 10,
      output_file_path: '/tmp/out.log',
      cwd: '/tmp',
    },
  }
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

async function flushMicrotasks(): Promise<void> {
  // Give queueMicrotask + runTurn's async chain a chance to settle.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('NotificationIdleDrain', () => {
  it('drains items and calls runTurn with composed prompt text', async () => {
    const queue = new NotificationQueue({})
    const logger = createLogger()
    const runTurn = vi.fn<[NotificationDrainContext], Promise<{ success: boolean }>>(
      async () => ({ success: true }),
    )
    const drain = new NotificationIdleDrain({
      getQueue: () => queue,
      isBusy: () => false,
      hasSession: () => true,
      runTurn,
      logger,
    })

    queue.enqueue(shellEnvelope('sess-1'))
    drain.schedule(THREAD_ID)
    await flushMicrotasks()

    expect(runTurn).toHaveBeenCalledOnce()
    const ctx = runTurn.mock.calls[0][0]
    expect(ctx.threadId).toBe(THREAD_ID)
    expect(ctx.items).toHaveLength(1)
    expect(ctx.promptText).toContain('background command completed')
    expect(queue.peekByThreadId(THREAD_ID)).toBe(0)
  })

  it('skips when session is busy', async () => {
    const queue = new NotificationQueue({})
    const runTurn = vi.fn(async () => ({ success: true }))
    const drain = new NotificationIdleDrain({
      getQueue: () => queue,
      isBusy: () => true,
      hasSession: () => true,
      runTurn,
      logger: createLogger(),
    })
    queue.enqueue(shellEnvelope('sess-1'))
    await drain.tryDrain(THREAD_ID)
    expect(runTurn).not.toHaveBeenCalled()
    // Items stay in the queue.
    expect(queue.peekByThreadId(THREAD_ID)).toBe(1)
  })

  it('logs error and drops items when session is missing (no requeue)', async () => {
    const queue = new NotificationQueue({})
    const logger = createLogger()
    const runTurn = vi.fn(async () => ({ success: true }))
    const drain = new NotificationIdleDrain({
      getQueue: () => queue,
      isBusy: () => false,
      hasSession: () => false,
      runTurn,
      logger,
      logPrefix: 'Test',
    })
    queue.enqueue(shellEnvelope('sess-1'))
    await drain.tryDrain(THREAD_ID)
    expect(runTurn).not.toHaveBeenCalled()
    expect(queue.peekByThreadId(THREAD_ID)).toBe(0) // drained, not requeued
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error.mock.calls[0][0]).toMatch(/NOT requeued/i)
    expect(logger.error.mock.calls[0][0]).toContain('[Test]')
  })

  it('requeues items on transient busy race (already has a running query)', async () => {
    const queue = new NotificationQueue({})
    const logger = createLogger()
    const runTurn = vi.fn(async () => ({
      success: false,
      error: 'Session already has a running query',
    }))
    const drain = new NotificationIdleDrain({
      getQueue: () => queue,
      isBusy: () => false,
      hasSession: () => true,
      runTurn,
      logger,
    })
    queue.enqueue(shellEnvelope('sess-1'))
    await drain.tryDrain(THREAD_ID)
    // Items should be back in the queue.
    expect(queue.peekByThreadId(THREAD_ID)).toBe(1)
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.info.mock.calls[0][0]).toMatch(/requeuing/)
  })

  it('requeues items when runTurn throws', async () => {
    const queue = new NotificationQueue({})
    const logger = createLogger()
    const runTurn = vi.fn(async () => {
      throw new Error('boom')
    })
    const drain = new NotificationIdleDrain({
      getQueue: () => queue,
      isBusy: () => false,
      hasSession: () => true,
      runTurn,
      logger,
    })
    queue.enqueue(shellEnvelope('sess-1'))
    await drain.tryDrain(THREAD_ID)
    expect(queue.peekByThreadId(THREAD_ID)).toBe(1)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('short-circuits when queue unavailable and logs warn', async () => {
    const logger = createLogger()
    const drain = new NotificationIdleDrain({
      getQueue: () => undefined,
      isBusy: () => false,
      hasSession: () => true,
      runTurn: vi.fn(async () => ({ success: true })),
      logger,
    })
    await drain.tryDrain(THREAD_ID)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('logs error when getQueue throws', async () => {
    const logger = createLogger()
    const drain = new NotificationIdleDrain({
      getQueue: () => {
        throw new Error('bridge missing')
      },
      isBusy: () => false,
      hasSession: () => true,
      runTurn: vi.fn(async () => ({ success: true })),
      logger,
    })
    await drain.tryDrain(THREAD_ID)
    expect(logger.error).toHaveBeenCalled()
  })

  it('drainText returns null when session missing or queue empty', () => {
    const queue = new NotificationQueue({})
    const drain = new NotificationIdleDrain({
      getQueue: () => queue,
      isBusy: () => false,
      hasSession: () => true,
      runTurn: vi.fn(async () => ({ success: true })),
      logger: createLogger(),
    })
    expect(drain.drainText(THREAD_ID)).toBeNull()

    queue.enqueue(shellEnvelope('sess-1'))
    const drainMissing = new NotificationIdleDrain({
      getQueue: () => queue,
      isBusy: () => false,
      hasSession: () => false,
      runTurn: vi.fn(async () => ({ success: true })),
      logger: createLogger(),
    })
    expect(drainMissing.drainText(THREAD_ID)).toBeNull()
    // Missing session: item NOT drained (still in queue).
    expect(queue.peekByThreadId(THREAD_ID)).toBe(1)
  })

  it('drainText can explicitly drain a non-session target for subagent runtimes', () => {
    const queue = new NotificationQueue({})
    const drain = new NotificationIdleDrain({
      getQueue: () => queue,
      isBusy: () => false,
      hasSession: () => false,
      runTurn: vi.fn(async () => ({ success: true })),
      logger: createLogger(),
    })

    queue.enqueue(shellEnvelope('sess-1'))
    const text = drain.drainText(THREAD_ID, { allowMissingSession: true })

    expect(text).toContain('background command completed')
    expect(queue.peekByThreadId(THREAD_ID)).toBe(0)
  })

  it('drainText returns composed text when items present', () => {
    const queue = new NotificationQueue({})
    const drain = new NotificationIdleDrain({
      getQueue: () => queue,
      isBusy: () => false,
      hasSession: () => true,
      runTurn: vi.fn(async () => ({ success: true })),
      logger: createLogger(),
    })
    queue.enqueue(shellEnvelope('sess-1'))
    const text = drain.drainText(THREAD_ID)
    expect(text).toContain('background command completed')
    expect(queue.peekByThreadId(THREAD_ID)).toBe(0)
  })
})
