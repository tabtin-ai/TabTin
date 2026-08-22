/**
 * `AgentHost` 门面契约测（阶段 4）：验证 `isBusy` / `abort` /
 * `abortConversationRuns` / `submitRun` 行为，保证 Electron / Daemon
 * 不用再直连 `this.core.*` 也能拿到同款语义。
 *
 * ：host 停路径 = `abort`（abortActiveRun）+ `abortConversationRuns`
 * （强制 clearQueued）；不能只调其中之一。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AgentHost,
  type AgentPlatformAdapter,
  ConversationRunCancelledError,
} from '../src/index.js'
import type {
  AgentTransportEnvelope,
  AgentTransportPort,
} from '../src/realtime/agent-realtime.js'

function createTransport() {
  let envelopeHandler: ((envelope: AgentTransportEnvelope) => void) | undefined
  const transport: AgentTransportPort = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    onEnvelope: vi.fn((handler) => {
      envelopeHandler = handler
      return () => { envelopeHandler = undefined }
    }),
    onReady: vi.fn(() => () => undefined),
  }
  return { transport, emit: (e: AgentTransportEnvelope) => envelopeHandler?.(e) }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

async function startHost() {
  const { transport } = createTransport()
  const adapter: AgentPlatformAdapter<unknown, unknown, unknown> = {
    transport,
    deviceId: 'device-facade',
    logger: { debug: vi.fn(), warn: vi.fn() },
    commands: {
      forward: vi.fn(),
      cancel: vi.fn(),
      cancelSubagent: vi.fn(),
      userResponse: vi.fn(),
      permission: vi.fn(),
      actionRequest: vi.fn(),
    },
  }
  const host = await AgentHost.start(adapter)
  return { host }
}

describe('AgentHost facade — isBusy', () => {
  it('is false for unknown conversations', async () => {
    const { host } = await startHost()
    expect(host.isBusy('unknown-conversation')).toBe(false)
    await host.stop()
  })

  it('turns true while a submitRun is running and back to false after it settles', async () => {
    const { host } = await startHost()
    const gate = deferred<void>()

    const running = host.submitRun({
      conversationId: 'conv-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-1',
      execute: async () => {
        await gate.promise
        return 'done'
      },
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(host.isBusy('conv-1')).toBe(true)
    expect(host.isBusy('conv-2')).toBe(false)

    gate.resolve()
    await running
    expect(host.isBusy('conv-1')).toBe(false)

    await host.stop()
  })
})

describe('AgentHost facade — abortConversationRuns', () => {
  it('cancels queued runs only — does not settle the active submitRun ', async () => {
    const { host } = await startHost()
    const gate = deferred<void>()
    let activeReject!: (reason?: unknown) => void
    const activeAbort = new Promise<void>((_, reject) => { activeReject = reject })

    const active = host.submitRun({
      conversationId: 'conv-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-1',
      execute: async () => {
        await activeAbort
        return 'active:aborted'
      },
    })
    const queued = host.submitRun({
      conversationId: 'conv-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-2',
      execute: async () => {
        await gate.promise
        return 'queued:ok'
      },
    })
    await Promise.resolve()
    await Promise.resolve()

    const cancelled = host.abortConversationRuns({
      conversationId: 'conv-1',
      sessionId: 'session-1',
    })
    expect(cancelled).toEqual(['run-2'])
    await expect(queued).rejects.toBeInstanceOf(ConversationRunCancelledError)
    // 仍 busy：running slot 未清；这就是 host 不能只调 abortConversationRuns 的原因。
    expect(host.isBusy('conv-1')).toBe(true)

    gate.resolve()
    activeReject(new Error('active-aborted'))
    await expect(active).rejects.toThrow(/active-aborted/)
    expect(host.isBusy('conv-1')).toBe(false)

    await host.stop()
  })
})

describe('AgentHost facade — abort', () => {
  it('clears same-session queued runs via abort ', async () => {
    const { host } = await startHost()
    let activeReject!: (reason?: unknown) => void
    const activeAbort = new Promise<void>((_, reject) => { activeReject = reject })

    const active = host.submitRun({
      conversationId: 'conv-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-1',
      execute: async () => {
        await activeAbort
        return 'active:done'
      },
    })
    const queued = host.submitRun({
      conversationId: 'conv-1',
      lifecycleScopeId: 'owner-1',
      runId: 'run-2',
      execute: async () => 'queued:must-not-run',
    })
    await Promise.resolve()
    await Promise.resolve()

    const cancelled = host.abort({
      conversationId: 'conv-1',
      sessionId: 'session-1',
    })
    expect(cancelled).toEqual(['run-2'])
    await expect(queued).rejects.toBeInstanceOf(ConversationRunCancelledError)

    // submitRun 旁路不登记 activeRuns；abortActiveRun 对它是 no-op。
    // abortActiveRun + 混 session 清队见 conversation-supervisor  组合测。
    expect(host.isBusy('conv-1')).toBe(true)
    activeReject(new Error('active-settled'))
    await expect(active).rejects.toThrow(/active-settled/)
    expect(host.isBusy('conv-1')).toBe(false)

    await host.stop()
  })
})

describe('AgentHost facade — submitRun', () => {
  it('routes an ad-hoc execute closure through the coordinator FIFO', async () => {
    const { host } = await startHost()
    const trace: string[] = []
    const runningGate = deferred<void>()

    const first = host.submitRun({
      conversationId: 'conv-1',
      lifecycleScopeId: 'owner-1',
      runId: 'r-1',
      execute: async () => {
        trace.push('first-start')
        await runningGate.promise
        trace.push('first-end')
        return 'first' as const
      },
    })
    const second = host.submitRun({
      conversationId: 'conv-1',
      lifecycleScopeId: 'owner-1',
      runId: 'r-2',
      execute: async () => {
        trace.push('second-start')
        return 'second' as const
      },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(trace).toEqual(['first-start'])

    runningGate.resolve()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(trace).toEqual(['first-start', 'first-end', 'second-start'])

    await host.stop()
  })

  it('throws after AgentHost.stop()', async () => {
    const { host } = await startHost()
    await host.stop()
    expect(() =>
      host.submitRun({
        conversationId: 'conv-1',
        lifecycleScopeId: 'owner-1',
        runId: 'r-1',
        execute: async () => 'ok' as const,
      }),
    ).toThrow('AgentHost is stopped')
  })
})
