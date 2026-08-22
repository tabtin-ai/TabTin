import { describe, expect, it, vi } from 'vitest'

import {
  AgentHost,
  type AgentPlatformAdapter,
} from '../src/index.js'
import type { HostQuery } from '../src/conversation/host-query.js'
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
  return {
    transport,
    emit: (envelope: AgentTransportEnvelope) => envelopeHandler?.(envelope),
  }
}

describe('AgentHost public contract', () => {
  it('query() requires composeQueryEngine and routes through submitHostQuery', async () => {
    const gateway = createTransport()
    const adapter: AgentPlatformAdapter<string, string, unknown> = {
      transport: gateway.transport,
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
    const host = await AgentHost.start(adapter)

    const hostQuery = {
      identity: {
        conversationId: 'conversation-1',
        sessionId: 'session-1',
        runId: 'run-1',
        owner: { userId: 'u', organizationId: 'o', agentId: 'a' },
      },
      runtime: {
        sessionId: 'session-1',
        mode: 'agent',
        cacheKey: { modelId: 'm', owner: { userId: 'u', organizationId: 'o' } },
        input: { label: 'x' },
      },
      turn: { prompt: 'hello' },
    } satisfies HostQuery<{ label: string }, 'agent', never>

    expect(() => host.query(hostQuery as HostQuery<unknown, string, never>))
      .toThrow('AgentHost query pipeline is not installed')

    await host.stop()
  })

  it('owns normalized realtime command routing', async () => {
    const gateway = createTransport()
    const forward = vi.fn()
    const cancel = vi.fn()
    const adapter: AgentPlatformAdapter<string, string, unknown> = {
      transport: gateway.transport,
      deviceId: 'device-1',
      logger: { debug: vi.fn(), warn: vi.fn() },
      commands: {
        forward,
        cancel,
        cancelSubagent: vi.fn(),
        userResponse: vi.fn(),
        permission: vi.fn(),
        actionRequest: vi.fn(),
      },
    }
    const host = await AgentHost.start(adapter)

    gateway.emit({
      type: 'agent.prompt.forward',
      thread_id: 'chat-session-business-1',
      payload: {
        task_id: 'task-1',
        prompt: 'forward me',
        agent_config: { type: 'local' },
        workspace_id: 'workspace-1',
      },
    })
    gateway.emit({
      type: 'agent.prompt.cancel',
      payload: { session_id: 'session-1', task_id: 'task-1' },
    })
    await Promise.resolve()

    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'forward me',
        threadId: 'task-1',
        businessThreadId: 'business-1',
      }),
      expect.objectContaining({ type: 'agent.prompt.forward' }),
    )
    expect(cancel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      taskId: 'task-1',
      envelope: expect.objectContaining({ type: 'agent.prompt.cancel' }),
    })

    await host.stop()
    expect(gateway.transport.unsubscribe).toHaveBeenCalledWith([
      'agent.action.device.device-1',
    ])
  })

  it('invokes adapter.onConversationIdle after the run queue drains to idle', async () => {
    // push 通知 drain 兜底链路：turn 收尾时排的 drain 会被 isBusy 闸吞掉，
    // AgentHost 必须把 queue 转 idle 的事件透传给平台（平台据此补 schedule）。
    const gateway = createTransport()
    const onConversationIdle = vi.fn()
    const adapter: AgentPlatformAdapter<string, string, unknown> = {
      transport: gateway.transport,
      deviceId: 'device-1',
      logger: { debug: vi.fn(), warn: vi.fn() },
      onConversationIdle,
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

    await host.submitRun({
      conversationId: 'conversation-1',
      runId: 'run-1',
      execute: async () => 'done',
    })

    expect(onConversationIdle).toHaveBeenCalledTimes(1)
    expect(onConversationIdle).toHaveBeenCalledWith('conversation-1')
    // 回调触发时 queue 必须已不 busy（否则补排的 drain 会再被 isBusy 吞掉）
    expect(host.isBusy('conversation-1')).toBe(false)

    await host.stop()
  })
})
