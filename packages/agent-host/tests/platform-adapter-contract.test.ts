/**
 * Electron / Daemon 共用的 AgentPlatformAdapter 契约：
 * 同一组入站 envelope 经 AgentHost 后触发相同 command 形状。
 * 主 query 路径不得再经 adapter.conversation.execute —— 平台走
 * composeQueryEngine + submitHostQuery。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { AgentHost } from '../src/agent-host.js'
import type { AgentPlatformAdapter } from '../src/agent-platform-adapter.js'
import type {
  AgentTransportEnvelope,
  AgentTransportPort,
  AgentTransportReadyInfo,
} from '../src/realtime/agent-realtime.js'

class FakeTransport implements AgentTransportPort {
  readonly subscribe = vi.fn(async () => undefined)
  readonly unsubscribe = vi.fn(async () => undefined)
  private handlers = new Set<(envelope: AgentTransportEnvelope) => void>()

  onEnvelope(handler: (envelope: AgentTransportEnvelope) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  onReady(_handler: (info: AgentTransportReadyInfo) => void): () => void {
    return () => undefined
  }

  emit(envelope: AgentTransportEnvelope): void {
    for (const handler of this.handlers) handler(envelope)
  }
}

async function startAdapterHost(
  transport: FakeTransport,
  overrides: Partial<AgentPlatformAdapter<{ ok: true }, { ok: true }>> = {},
) {
  const forward = vi.fn(async () => undefined)
  const cancel = vi.fn()
  const cancelSubagent = vi.fn()
  const userResponse = vi.fn(async () => undefined)
  const permission = vi.fn()
  const actionRequest = vi.fn(async () => undefined)

  const host = await AgentHost.start({
    transport,
    deviceId: 'device-contract',
    logger: { debug: vi.fn(), warn: vi.fn() },
    commands: {
      forward,
      cancel,
      cancelSubagent,
      userResponse,
      permission,
      actionRequest,
    },
    ...overrides,
  })

  return { host, forward, cancel, cancelSubagent, userResponse, permission, actionRequest }
}

describe('AgentPlatformAdapter contract parity', () => {
  it('removes the platform-owned coordinator seam and marks the legacy conversation seam deprecated', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/agent-platform-adapter.ts', import.meta.url)),
      'utf8',
    )
    // Block 3: the platform-owned coordinator leak is physically gone — AgentHost
    // now self-owns the registry, so the adapter no longer exposes `coordinator?`.
    expect(source).not.toMatch(/coordinator\?/)
    expect(source).toMatch(/@deprecated[\s\S]*conversation\?/)
  })

  it('normalizes forward / cancel / HITL / memo into the same command shapes', async () => {
    const transport = new FakeTransport()
    const { host, forward, cancel, userResponse } = await startAdapterHost(transport)

    transport.emit({
      type: 'agent.prompt.forward',
      thread_id: 'chat-session-biz-1',
      payload: {
        task_id: 'task-9',
        prompt: 'hi',
        agent_config: { type: 'local' },
        workspace_id: 'ws-1',
      },
    })
    transport.emit({
      type: 'agent.prompt.cancel',
      payload: { session_id: 'sess-1', task_id: 'task-9' },
    })
    transport.emit({
      type: 'localrt.user_response',
      thread_id: 'chat-session-biz-1',
      payload: {
        request_id: 'ask-1',
        submit_id: 'sub-1',
        response: { answer: 'yes' },
      },
    })
    transport.emit({
      type: 'agent.action.approval_memo_updated',
      payload: { agent_id: 'agent-1', generation: 3 },
    })
    await Promise.resolve()

    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'hi',
        threadId: 'biz-1',
        taskId: 'task-9',
      }),
      expect.objectContaining({ type: 'agent.prompt.forward' }),
    )
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        taskId: 'task-9',
        envelope: expect.objectContaining({ type: 'agent.prompt.cancel' }),
      }),
    )
    expect(userResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'ask-1',
        submitId: 'sub-1',
        response: { answer: 'yes' },
      }),
    )

    await host.stop()
  })

  it('routes the legacy approval bridge through the shared localrt batch contract', async () => {
    const transport = new FakeTransport()
    const { host, userResponse } = await startAdapterHost(transport)
    const decisions = [{
      request_id: 'legacy-approval-1',
      tool_call_id: 'legacy-approval-1',
      outcome: 'allow',
      scope: 'once',
    }]

    transport.emit({
      type: 'localrt.user_response',
      thread_id: 'chat-session-biz-legacy',
      payload: {
        request_id: 'legacy-approval-1',
        submit_id: 'submit-legacy-1',
        response: {
          batch_id: 'legacy-approval-1',
          decisions,
          schema_version: 1,
        },
      },
    })
    await Promise.resolve()

    expect(userResponse).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'chat-session-biz-legacy',
      requestId: 'legacy-approval-1',
      batchId: 'legacy-approval-1',
      decisions,
      submitId: 'submit-legacy-1',
    }))

    await host.stop()
  })

  it('legacy: forward(null) when shared decode fails and no onForwardDecodeFailed adapter is provided', async () => {
    const transport = new FakeTransport()
    const { host, forward } = await startAdapterHost(transport)

    transport.emit({
      type: 'agent.prompt.forward',
      thread_id: 'chat-session-biz-1',
      // 缺 task_id + 空 prompt → missing_content 分支。schema_invalid 与
      // missing_content 都走 fallback commands.forward(null) 兼容路径。
      payload: { prompt: '' },
    })
    await Promise.resolve()

    expect(forward).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ type: 'agent.prompt.forward' }),
    )

    await host.stop()
  })

  it('routes decode failure to onForwardDecodeFailed when the adapter implements it', async () => {
    const transport = new FakeTransport()
    const onForwardDecodeFailed = vi.fn(async () => undefined)
    const { host, forward } = await startAdapterHost(transport, {
      onForwardDecodeFailed,
    })

    transport.emit({
      type: 'agent.prompt.forward',
      thread_id: 'chat-session-biz-2',
      payload: { task_id: 'prompt-99', prompt: 'hi', agent_config: 'not-an-object' },
    })
    await Promise.resolve()

    // commands.forward 完全不被调用（宿主用 hook 替代 legacy null-forward）
    expect(forward).not.toHaveBeenCalled()
    expect(onForwardDecodeFailed).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent.prompt.forward' }),
      expect.objectContaining({ ok: false, reason: 'schema_invalid' }),
    )

    await host.stop()
  })

  it('rejects invalid prompt.cancel / subagent.cancel payloads inside AgentHost (zod)', async () => {
    const transport = new FakeTransport()
    const { host, cancel, cancelSubagent } = await startAdapterHost(transport)

    transport.emit({
      type: 'agent.prompt.cancel',
      thread_id: 'chat-session-biz-3',
      payload: { task_id: 123 },
    })
    transport.emit({
      type: 'agent.subagent.cancel',
      thread_id: 'chat-session-biz-3',
      payload: { child_id: '' },
    })
    await Promise.resolve()

    expect(cancel).not.toHaveBeenCalled()
    expect(cancelSubagent).not.toHaveBeenCalled()

    await host.stop()
  })
})
