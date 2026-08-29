/**
 * SD-009 / SD-010 / SD-029 +  回归测试
 *
 * 验证 registerLocalMcpIPC 注册的全部 localMcp IPC handler 都对不可信来源
 * 的调用拒绝（返回 UNAUTHORIZED envelope）。此前仅断言其中 3 个，其余被误标为
 * "UNGUARDED" 未断言——实际全部走 guardedHandle，此处补齐。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTrustedSender: vi.fn(),
  handle: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/userData') },
  ipcMain: { handle: mocks.handle },
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

vi.mock('../bundled-mcp-remote-transport', () => ({
  BundledMcpRemoteTransport: vi.fn(),
  extractBundledMcpRemoteArgs: vi.fn(() => null),
}))

vi.mock('../mcp-oauth-window', () => ({
  closeConnectorOAuthWindow: vi.fn(),
  createOAuthAuthorizeUrlParser: vi.fn(() => vi.fn()),
  openConnectorOAuthWindow: vi.fn(),
  restoreConnectorOAuthClient: vi.fn(),
  waitForPlatformOAuthTicket: vi.fn(),
  withMcpOpenShimPath: vi.fn((env: Record<string, string>) => env),
}))

vi.mock('../mcp-remote-client', () => ({
  ensureMcpRemoteClientName: vi.fn(),
  extractMcpRemoteServerUrl: vi.fn(),
  clearMcpRemoteAuth: vi.fn(() => 0),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('@tabtin/terminal-core', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../../auth', () => ({
  isTrustedSender: mocks.isTrustedSender,
  TokenManager: {
    getAccessToken: vi.fn(async () => null),
  },
}))

vi.mock('../../config/api', () => ({
  API_BASE_URL: 'http://127.0.0.1:6060',
}))

import {
  LocalMcpService,
  localMcpHandlers,
  registerLocalMcpIPC,
} from '../LocalMcpService'

// Wave 0 contract: guardedHandle 改返 envelope 形状 ({ok, error.code/message})。
const REJECT_RESPONSE = {
  ok: false,
  error: {
    code: 'UNAUTHORIZED',
    message: 'Unauthorized: untrusted origin',
    retryable: false,
  },
}

// registerLocalMcpIPC 对全部 channel 统一套 guardedHandle——不存在"未 guard"
// 的 localMcp channel。旧测试曾把部分标为 UNGUARDED_CHANNELS 且不断言拒绝，属分类
// 误导；这里改为对全部 channel 断言不可信来源被拒。
const ALL_CHANNELS = [
  'localMcp:discover',
  'localMcp:listConnections',
  'localMcp:getConnectionDetail',
  'localMcp:shareConnectionToOrganization',
  'localMcp:importCandidate',
  'localMcp:saveManualConnection',
  'localMcp:upsertOrganizationMirror',
  'localMcp:attachConnection',
  'localMcp:setConnectionEnabled',
  'localMcp:deleteConnection',
  'localMcp:probeConnection',
  'localMcp:cancelProbe',
  'localMcp:waitForPlatformOAuthTicket',
  'localMcp:closePlatformOAuthWindow',
]

function findHandler(channel: string) {
  const call = mocks.handle.mock.calls.find((c: unknown[]) => c[0] === channel)
  if (!call) throw new Error(`${channel} handler not registered`)
  return call[1] as (...args: unknown[]) => Promise<unknown>
}

describe('SD-009/SD-010/SD-029: LocalMcp IPC senderFrame 防护', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerLocalMcpIPC()
  })

  for (const channel of ALL_CHANNELS) {
    it(`${channel}: 不可信来源（外部页面）被拒绝`, async () => {
      mocks.isTrustedSender.mockReturnValue(false)
      const handler = findHandler(channel)
      const event = { senderFrame: { url: 'https://evil.com/attack' } }
      const result = await handler(event, 'dummy-arg')
      // W1 D3：envelope 现在自动 stamp per-call trace_id
      expect(result).toMatchObject(REJECT_RESPONSE)
      expect(result).toHaveProperty('trace_id')
    })
  }

  it('所有 localMcp handler 均已注册', () => {
    expect(ALL_CHANNELS).toHaveLength(14)
    for (const channel of ALL_CHANNELS) {
      const call = mocks.handle.mock.calls.find((c: unknown[]) => c[0] === channel)
      expect(call, `${channel} 未注册`).toBeDefined()
    }
  })

  it('删除 IPC 必须等连接会话关闭完成后才返回成功', async () => {
    let resolveDelete!: () => void
    const deleteSpy = vi.spyOn(LocalMcpService.prototype, 'deleteConnection')
      .mockImplementationOnce(() => new Promise<void>(resolve => {
        resolveDelete = resolve
      }))
    const handler = localMcpHandlers['localMcp:deleteConnection'] as (
      event: unknown,
      connectionId: string,
    ) => Promise<{ ok: true }>

    let settled = false
    const resultPromise = handler({}, 'connection-1').then(result => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('connection-1'))
    expect(settled).toBe(false)

    resolveDelete()
    await expect(resultPromise).resolves.toEqual({ ok: true })
  })
})
