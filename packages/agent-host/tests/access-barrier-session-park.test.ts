import { describe, expect, it, vi } from 'vitest'

import { AgentHost, type AgentPlatformAdapter } from '../src/index.js'
import { SessionPauseController } from '../src/delivery/session-pause-controller.js'
import type { AgentTransportPort } from '../src/realtime/agent-realtime.js'

const SESSION_UUID = '11111111-1111-4111-8111-111111111111'

function createTransport() {
  const transport: AgentTransportPort = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    onEnvelope: vi.fn(() => () => undefined),
    onReady: vi.fn(() => () => undefined),
  }
  return transport
}

function minimalAdapter(): AgentPlatformAdapter<string, string, { pauseController: SessionPauseController }> {
  return {
    transport: createTransport(),
    deviceId: 'device-1',
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
}

function sampleBarrier() {
  return {
    kind: 'login' as const,
    reason: 'login wall',
    domain: 'zhihu.com',
    detectedAt: new Date().toISOString(),
    actions: ['resume_same_tab', 'alternate_source', 'abort_this_target'] as const,
  }
}

describe('AgentHost.presentAccessBarrier session park', () => {
  it('acquireHitlPark while waiting；resolve 后 finally 释放（双清）', async () => {
    const host = await AgentHost.start(minimalAdapter())
    const pauseController = new SessionPauseController()
    host.sessions.set(SESSION_UUID, { pauseController })

    const pending = host.presentAccessBarrier(
      { threadId: SESSION_UUID, interactionMode: 'interactive' },
      sampleBarrier(),
    )

    await Promise.resolve()
    expect(pauseController.isHitlParked).toBe(true)
    expect(pauseController.shouldBlock).toBe(true)

    const entries = [...host.interactions.registry.keys()]
    expect(entries).toHaveLength(1)
    host.interactions.resolveAnswer(entries[0]!, { action: 'resume_same_tab' })

    await expect(pending).resolves.toEqual({ action: 'resume_same_tab' })
    expect(pauseController.isHitlParked).toBe(false)
    expect(pauseController.shouldBlock).toBe(false)

    await host.stop()
  })

  it('abort cancelConversation 也释放 park（假死双清）', async () => {
    const host = await AgentHost.start(minimalAdapter())
    const pauseController = new SessionPauseController()
    host.sessions.set(SESSION_UUID, { pauseController })

    const pending = host.presentAccessBarrier(
      { threadId: `chat-session-${SESSION_UUID}`, interactionMode: 'interactive' },
      sampleBarrier(),
    )

    await Promise.resolve()
    expect(pauseController.isHitlParked).toBe(true)

    host.interactions.cancelConversation(
      SESSION_UUID,
      'Pending interaction cancelled because the Agent query was aborted.',
    )

    const resolution = await pending
    expect(resolution.action).toBe('host_unavailable')
    expect(pauseController.isHitlParked).toBe(false)

    await host.stop()
  })

  it('park 期间 waitIfPaused 挡住，release 后放行', async () => {
    const host = await AgentHost.start(minimalAdapter())
    const pauseController = new SessionPauseController()
    host.sessions.set(SESSION_UUID, { pauseController })

    const pending = host.presentAccessBarrier(
      { threadId: SESSION_UUID, interactionMode: 'interactive' },
      sampleBarrier(),
    )
    await Promise.resolve()

    let released = false
    const waiting = pauseController.waitIfPaused().then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)

    const entries = [...host.interactions.registry.keys()]
    host.interactions.resolveAnswer(entries[0]!, { action: 'abort_this_target' })
    await pending
    await waiting
    expect(released).toBe(true)

    await host.stop()
  })
})
