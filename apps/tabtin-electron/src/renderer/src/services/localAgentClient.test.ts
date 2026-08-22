/**
 * LocalAgentClient.stream IPC payload 单测 —— W4.1（dogfood fix）。
 *
 * 主要验证：
 *   1. 调用方传 `options.agentId` 时，IPC payload.agentId 必须等于该值
 *   2. 不传 `options.agentId` 时，IPC payload.agentId 必须为 undefined
 *      （让主进程装配点的 `if (agentId && ...)` 守卫触发并打 warn）
 *
 * 本测试聚焦 LocalAgentClient ↔ window.tabtin.agentEngine IPC 的字段透传协议，
 * 不验证主进程装配链 —— 装配链由 ElectronAgentHost 单测 + 三视角 review 覆盖。
 *
 * 历史背景：W2.3 装配 7 Capability 时假设"agentId 必有"（agent home 路径
 * 按 ~/.tabtin/agents/{agentId}/ 隔离），但 Renderer IPC payload 22 个字段唯独
 * 漏 agentId —— W4 dogfood 第一个用户实测调 read_file/list_directory/
 * run_terminal_command 立刻撞 "capability not bound to a BackendSession"。本测试
 * 锁死 agentId 透传协议，避免回归。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalAgentClient } from './localAgentClient'

// 模拟 window.tabtin.agentEngine —— 单测只关心 IPC payload 字段透传，所以 stub
// invoke 的同时还要 stub 主进程发 sentinel 让 stream 退出（否则 IpcStream 会
// 永远等业务终态 / sentinel）。
let capturedEnvelopeHandler: ((env: { sessionId: string; terminal?: { reason: string }; event?: unknown }) => void) | null = null

const queryMock = vi.fn()
const abortMock = vi.fn()
const compactSessionMock = vi.fn()
const onStreamEventMock = vi.fn((handler: typeof capturedEnvelopeHandler) => {
  capturedEnvelopeHandler = handler
  return () => {
    capturedEnvelopeHandler = null
  }
})

describe('LocalAgentClient.stream — IPC payload', () => {
  beforeEach(() => {
    capturedEnvelopeHandler = null
    onStreamEventMock.mockClear()
    abortMock.mockReset().mockResolvedValue(undefined)
    queryMock
      .mockReset()
      .mockImplementation((req: { threadId: string }) => {
        // §17.6 D4：IPC payload sessionId → threadId（业务对话 thread）。
        // 模拟主进程：query 调起后立刻发 sentinel 让 stream 自然退出。
        // envelope sessionId 字段对应 sender route key（renderer 内部仍用 sessionId
        // 表示 "chat session"，与 host QueryRequest.threadId 同源同值）。
        setTimeout(() => {
          capturedEnvelopeHandler?.({
            sessionId: req.threadId,
            terminal: { reason: 'completed' },
          })
        }, 0)
        return Promise.resolve({ success: true })
      })
    compactSessionMock
      .mockReset()
      .mockResolvedValue({ success: true, summary: 'summary', stats: {} })
    ;(globalThis as unknown as { window: { tabtin: { agentEngine: unknown } } }).window =
      (globalThis as unknown as { window?: unknown }).window as { tabtin: { agentEngine: unknown } }
        ?? ({} as { tabtin: { agentEngine: unknown } })
    ;(globalThis as unknown as { window: { tabtin: { agentEngine: { query: typeof queryMock; abort: typeof abortMock; onStreamEvent: typeof onStreamEventMock } } } })
      .window.tabtin = {
        agentEngine: {
          query: queryMock,
          abort: abortMock,
          compactSession: compactSessionMock,
          onStreamEvent: onStreamEventMock,
        },
      }
  })

  it('compactSession 透传 runtime 初始化字段，支持历史会话 lazy init', async () => {
    const client = new LocalAgentClient()
    await client.compactSession(
      'session-compact',
      [{ role: 'user', content: 'old context' }],
      '保留接口设计',
      4,
      {
        modelId: 'model-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-1',
        agentMode: 'agent',
        spaceId: 'space-1',
        organizationId: 'team-1',
        modelContextWindow: 128000,
        modelMaxOutput: 4096,
        modelSupportsVision: true,
        modelSupportsFunctionCalling: true,
        modelProvider: 'moonshot',
        isByokMode: false,
      },
    )

    expect(compactSessionMock).toHaveBeenCalledTimes(1)
    expect(compactSessionMock.mock.calls[0][0]).toMatchObject({
      threadId: 'session-compact',
      summaryFocus: '保留接口设计',
      keepLastN: 4,
      modelId: 'model-1',
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
      agentMode: 'agent',
      spaceId: 'space-1',
      organizationId: 'team-1',
      modelContextWindow: 128000,
      modelMaxOutput: 4096,
      modelSupportsVision: true,
      modelSupportsFunctionCalling: true,
      modelProvider: 'moonshot',
      isByokMode: false,
    })
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('options.agentId="test-agent-123" 时 IPC payload.agentId === "test-agent-123"', async () => {
    const client = new LocalAgentClient()
    await client.stream(
      'session-1',
      'hello',
      {
        onChunk: vi.fn(),
        onMessage: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      },
      {
        agentId: 'test-agent-123',
      },
    )

    expect(queryMock).toHaveBeenCalledTimes(1)
    const payload = queryMock.mock.calls[0][0] as Record<string, unknown>
    expect(payload.agentId).toBe('test-agent-123')
    // 同时确认其它必传字段没被本次改动破坏（§17.6 D4：sessionId → threadId）
    expect(payload.prompt).toBe('hello')
    expect(payload.threadId).toBe('session-1')
  })

  it('options.agentId 缺失时 IPC payload.agentId === undefined（让主进程装配点守卫触发）', async () => {
    const client = new LocalAgentClient()
    await client.stream(
      'session-2',
      'hi',
      {
        onChunk: vi.fn(),
        onMessage: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      },
      {
        // 故意不传 agentId，模拟旧 client / 测试桩
      },
    )

    expect(queryMock).toHaveBeenCalledTimes(1)
    const payload = queryMock.mock.calls[0][0] as Record<string, unknown>
    expect(payload.agentId).toBeUndefined()
  })

  it('options.userMessageBlocks 会透传到 IPC payload', async () => {
    const client = new LocalAgentClient()
    const userMessageBlocks = [
      {
        type: 'webpage',
        preview: '当前浏览器窗口',
        url: 'https://example.com/current',
        tab_type: 'tabweb',
      },
    ]

    await client.stream(
      'session-context-ref',
      '请总结当前页面',
      {
        onChunk: vi.fn(),
        onMessage: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      },
      { userMessageBlocks },
    )

    expect(queryMock).toHaveBeenCalledTimes(1)
    const payload = queryMock.mock.calls[0][0] as Record<string, unknown>
    expect(payload.userMessageBlocks).toBe(userMessageBlocks)
  })

  it('options 整个不传时 IPC payload.agentId === undefined', async () => {
    const client = new LocalAgentClient()
    await client.stream(
      'session-3',
      'hi',
      {
        onChunk: vi.fn(),
        onMessage: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      },
      // 不传 options
    )

    expect(queryMock).toHaveBeenCalledTimes(1)
    const payload = queryMock.mock.calls[0][0] as Record<string, unknown>
    expect(payload.agentId).toBeUndefined()
  })

  it('abort(sessionId) 透传目标会话，避免 stop 退化成无参全局中止', () => {
    const client = new LocalAgentClient()

    client.abort('session-stop-1')

    expect(abortMock).toHaveBeenCalledTimes(1)
    expect(abortMock).toHaveBeenCalledWith({ sessionId: 'session-stop-1' })
  })

  it('abort() 不带 sessionId 时保留旧的全局中止语义', () => {
    const client = new LocalAgentClient()

    client.abort()

    expect(abortMock).toHaveBeenCalledTimes(1)
    expect(abortMock).toHaveBeenCalledWith(undefined)
  })

  it('preload 同步 throw 时立即触发 onError，不等待 watchdog', async () => {
    const error = new Error('Invalid agentEngine.query payload: prompt or attachments must contain user content')
    queryMock.mockImplementationOnce(() => {
      throw error
    })
    const onError = vi.fn()

    const client = new LocalAgentClient()
    await expect(client.stream(
      'session-preload-fail',
      '',
      {
        onChunk: vi.fn(),
        onMessage: vi.fn(),
        onDone: vi.fn(),
        onError,
      },
    )).rejects.toThrow('prompt or attachments must contain user content')

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(error)
    expect(capturedEnvelopeHandler).toBeNull()
  })

  it('invoke rejected Promise 时也立即触发 onError，不等待 watchdog', async () => {
    const error = new Error('agent-engine:query failed before stream envelope')
    queryMock.mockRejectedValueOnce(error)
    const onError = vi.fn()

    const client = new LocalAgentClient()
    await expect(client.stream(
      'session-invoke-reject',
      'hello',
      {
        onChunk: vi.fn(),
        onMessage: vi.fn(),
        onDone: vi.fn(),
        onError,
      },
    )).rejects.toThrow('agent-engine:query failed before stream envelope')

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(error)
    expect(capturedEnvelopeHandler).toBeNull()
  })
})
