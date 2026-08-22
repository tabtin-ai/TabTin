import { describe, expect, it, vi } from 'vitest'

import {
  AgentHost,
  type AgentPlatformAdapter,
} from '../src/index.js'
import type { AgentTransportPort } from '../src/realtime/agent-realtime.js'

function createAdapter(): AgentPlatformAdapter<string, string, unknown> {
  const transport: AgentTransportPort = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    onEnvelope: vi.fn(() => () => undefined),
    onReady: vi.fn(() => () => undefined),
  }
  return {
    transport,
    deviceId: 'device-1',
    logger: { debug: vi.fn(), warn: vi.fn() },
    conversation: { execute: async request => request },
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

describe('AgentHost platform approval', () => {
  it('publishes a standard approval batch and resolves through the interaction registry', async () => {
    const adapter = createAdapter()
    adapter.publishHumanInteractionResolution = vi.fn(async () => true)
    const host = await AgentHost.start(adapter)
    host.watch('11111111-1111-4111-8111-111111111111', {
      id: 1,
      isDestroyed: () => false,
      send: (envelope) => {
        if (!('event' in envelope)) throw new Error('expected approval event')
        const payload = envelope.event.payload as {
          batch_id: string
          approval_source: string
          runtime_mode: string
          action_requests: Array<{
            tool_name: string
            tool_input: { detail: string }
          }>
        }
        expect(envelope.event.type).toBe('agent.stream.approval_requested')
        expect(payload.approval_source).toBe('platform')
        expect(payload.runtime_mode).toBe('interactive')
        expect(payload.action_requests).toEqual([
          expect.objectContaining({
            tool_name: 'desktop_control',
            tool_input: { detail: 'control desktop' },
          }),
        ])
        queueMicrotask(() => {
          host.resolveApprovalBatch(
            payload.batch_id,
            [{
              request_id: payload.batch_id,
              tool_call_id: payload.batch_id,
              outcome: 'allow',
              scope: 'thread',
            }],
            { mirrorPlatformResolution: true },
          )
        })
      },
    })

    await expect(host.requestPlatformApproval(
      {
        threadId: 'chat-session-11111111-1111-4111-8111-111111111111',
        interactionMode: 'interactive',
      },
      {
        actionType: 'desktop_control',
        detail: 'control desktop',
        timeoutMs: 1_000,
      },
    )).resolves.toEqual({ approved: true, scope: 'thread' })
    await vi.waitFor(() => {
      expect(adapter.publishHumanInteractionResolution).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'chat-session-11111111-1111-4111-8111-111111111111',
        }),
        expect.objectContaining({ type: 'agent.stream.approval_resolved' }),
      )
    })
    await host.stop()
  })

  it('limits strict approvals to once and rejects a forged persistent scope', async () => {
    const adapter = createAdapter()
    adapter.publishHumanInteractionResolution = vi.fn(async () => true)
    const host = await AgentHost.start(adapter)
    host.watch('66666666-6666-4666-8666-666666666666', {
      id: 6,
      isDestroyed: () => false,
      send: (envelope) => {
        if (!('event' in envelope)) throw new Error('expected approval event')
        const payload = envelope.event.payload as {
          batch_id: string
          action_requests: Array<{ allowed_scopes: string[] }>
        }
        expect(payload.action_requests[0]?.allowed_scopes).toEqual(['once'])
        queueMicrotask(() => {
          host.resolveApprovalBatch(payload.batch_id, [{
            request_id: payload.batch_id,
            tool_call_id: payload.batch_id,
            outcome: 'allow',
            scope: 'always',
          }])
        })
      },
    })

    await expect(host.requestPlatformApproval(
      {
        threadId: 'chat-session-66666666-6666-4666-8666-666666666666',
        interactionMode: 'interactive',
      },
      {
        actionType: 'desktop_extend_allowlist',
        detail: 'control another app',
        isStrict: true,
        timeoutMs: 1_000,
      },
    )).resolves.toEqual({ approved: false })
    await vi.waitFor(() => {
      expect(adapter.publishHumanInteractionResolution).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: 'agent.stream.approval_resolved',
          payload: expect.objectContaining({
            decisions: [expect.objectContaining({ outcome: 'deny' })],
          }),
        }),
      )
    })
    await host.stop()
  })

  it('rejects strict approval responses that omit scope', async () => {
    const host = await AgentHost.start(createAdapter())
    host.watch('77777777-7777-4777-8777-777777777777', {
      id: 7,
      isDestroyed: () => false,
      send: (envelope) => {
        if (!('event' in envelope)) throw new Error('expected approval event')
        const payload = envelope.event.payload as { batch_id: string }
        queueMicrotask(() => {
          host.resolveApprovalBatch(payload.batch_id, [{
            request_id: payload.batch_id,
            tool_call_id: payload.batch_id,
            outcome: 'allow',
          }])
        })
      },
    })

    await expect(host.requestPlatformApproval(
      {
        threadId: 'chat-session-77777777-7777-4777-8777-777777777777',
        interactionMode: 'interactive',
      },
      {
        actionType: 'interactive_command',
        detail: 'run interactive command',
        isStrict: true,
        timeoutMs: 1_000,
      },
    )).resolves.toEqual({ approved: false })
    await host.stop()
  })

  it('fails closed when no local or remote delivery target accepted the request', async () => {
    const adapter = createAdapter()
    adapter.publishHumanInteraction = vi.fn(async () => false)
    const host = await AgentHost.start(adapter)

    await expect(host.requestPlatformApproval(
      {
        threadId: 'chat-session-22222222-2222-4222-8222-222222222222',
        interactionMode: 'interactive',
      },
      { actionType: 'terminal_execute', detail: 'rm file', timeoutMs: 100 },
    )).resolves.toEqual({ approved: false })
    await host.stop()
  })

  it('does not accept an allow decision for a different request', async () => {
    const host = await AgentHost.start(createAdapter())
    host.watch('33333333-3333-4333-8333-333333333333', {
      id: 2,
      isDestroyed: () => false,
      send: (envelope) => {
        if (!('event' in envelope)) throw new Error('expected approval event')
        const payload = envelope.event.payload as { batch_id: string }
        queueMicrotask(() => {
          host.resolveApprovalBatch(payload.batch_id, [{
            request_id: 'unrelated-request',
            tool_call_id: 'unrelated-tool-call',
            outcome: 'allow',
          }])
        })
      },
    })

    await expect(host.requestPlatformApproval(
      {
        threadId: 'chat-session-33333333-3333-4333-8333-333333333333',
        interactionMode: 'interactive',
      },
      { actionType: 'file_delete', detail: 'delete file', timeoutMs: 1_000 },
    )).resolves.toEqual({ approved: false })
    await host.stop()
  })

  it('cleans the pending interaction at the deadline', async () => {
    const adapter = createAdapter()
    adapter.publishHumanInteraction = vi.fn(async () => true)
    adapter.publishHumanInteractionResolution = vi.fn(async () => true)
    const host = await AgentHost.start(adapter)

    await expect(host.requestPlatformApproval(
      {
        threadId: 'chat-session-44444444-4444-4444-8444-444444444444',
        interactionMode: 'interactive',
      },
      { actionType: 'terminal_execute', detail: 'run command', timeoutMs: 10 },
    )).resolves.toEqual({ approved: false })
    expect(host.interactions.registry.size).toBe(0)
    await vi.waitFor(() => {
      expect(adapter.publishHumanInteractionResolution).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'agent.stream.approval_resolved' }),
      )
    })
    await host.stop()
  })

  it('resolves pending platform approvals when the host stops', async () => {
    const adapter = createAdapter()
    adapter.publishHumanInteraction = vi.fn(async () => true)
    const host = await AgentHost.start(adapter)
    const approval = host.requestPlatformApproval(
      {
        threadId: 'chat-session-55555555-5555-4555-8555-555555555555',
        interactionMode: 'interactive',
      },
      { actionType: 'desktop_control', detail: 'control desktop', timeoutMs: 60_000 },
    )
    await vi.waitFor(() => {
      expect(host.interactions.registry.size).toBe(1)
    })

    await host.stop()
    await expect(approval).resolves.toEqual({ approved: false })
  })
})
