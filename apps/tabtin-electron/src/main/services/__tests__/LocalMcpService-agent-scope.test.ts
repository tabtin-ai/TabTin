import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  atomicWriteFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  assertCurrentUserCanAccessAgent: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/userData'),
    getVersion: vi.fn(() => '0.0.0-test'),
  },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

vi.mock('../../auth', () => ({
  isTrustedSender: vi.fn(() => true),
  TokenManager: { getAccessToken: vi.fn(async () => null) },
}))
vi.mock('../../config/api', () => ({
  API_BASE_URL: 'http://127.0.0.1:6060',
}))
vi.mock('@tabtin/terminal-core', () => ({ atomicWriteFileSync: mocks.atomicWriteFileSync }))
vi.mock('@tabtin/storage-manager', () => ({ registerStorageBucket: vi.fn() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const overrides = {
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
    mkdirSync: mocks.mkdirSync,
  }
  return {
    ...actual,
    ...overrides,
    default: { ...actual, ...overrides },
  }
})

vi.mock('../../security/agent-access-guard', () => ({
  assertCurrentUserCanAccessAgent: mocks.assertCurrentUserCanAccessAgent,
  AgentAccessDeniedError: class AgentAccessDeniedError extends Error {},
}))

import { LocalMcpService } from '../LocalMcpService'

const baseConnection = {
  id: 'conn-1',
  name: 'github',
  source: { kind: 'manual', label: 'Manual' },
  transport: { kind: 'stdio', command: 'node' },
  enabled: true,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

describe('LocalMcpService Agent scope store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.existsSync.mockReturnValue(true)
  })

  it('升级旧 Space 绑定时不自动授权给任何 Agent', () => {
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      version: 1,
      connections: [{
        ...baseConnection,
        attachedSpaceIds: ['workspace-1', 'workspace-1'],
      }],
    }))

    const connections = new LocalMcpService().listConnections()

    expect(connections).toEqual([
      expect.objectContaining({
        attachedAgentIds: [],
        requiresAgentSelection: true,
      }),
    ])
    expect(mocks.atomicWriteFileSync).toHaveBeenCalledWith(
      '/tmp/userData/mcp/connections.json',
      expect.stringContaining('"version": 2'),
      0o600,
    )
    const persisted = JSON.parse(mocks.atomicWriteFileSync.mock.calls[0][1] as string)
    expect(persisted.connections[0]).toMatchObject({
      attachedAgentIds: [],
      legacyAttachedSpaceIds: ['workspace-1'],
    })
    expect(persisted.connections[0]).not.toHaveProperty('attachedSpaceIds')
  })

  it('读取 v2 store 时不重复迁移或落盘', () => {
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      connections: [{
        ...baseConnection,
        attachedAgentIds: ['agent-1'],
      }],
    }))

    const connections = new LocalMcpService().listConnections()

    expect(connections[0]).toMatchObject({
      attachedAgentIds: ['agent-1'],
      requiresAgentSelection: false,
    })
    expect(mocks.atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('listConnections 按 createdAt 稳定排序，不因 updatedAt / 挂载数变化而重排', () => {
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      connections: [
        {
          ...baseConnection,
          id: 'older',
          name: 'Cloudflare',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-08-03T12:00:00.000Z',
          attachedAgentIds: ['agent-1', 'agent-2'],
        },
        {
          ...baseConnection,
          id: 'newer',
          name: 'vercel-mcp',
          createdAt: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:00:00.000Z',
          attachedAgentIds: ['agent-1'],
        },
        {
          ...baseConnection,
          id: 'middle',
          name: 'GitHub',
          createdAt: '2026-07-10T00:00:00.000Z',
          updatedAt: '2026-08-03T18:00:00.000Z',
          attachedAgentIds: [],
        },
      ],
    }))

    const ids = new LocalMcpService().listConnections().map(connection => connection.id)

    // 新建靠前；挂载多、updatedAt 更新的 older 仍应排在最后，不能被顶到列表头。
    expect(ids).toEqual(['newer', 'middle', 'older'])
  })

  it('listAttachedServers 只返回目标 Agent 已启用的连接', () => {
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      connections: [
        { ...baseConnection, id: 'conn-a', attachedAgentIds: ['agent-A'] },
        { ...baseConnection, id: 'conn-b', name: 'other', attachedAgentIds: ['agent-B'] },
        { ...baseConnection, id: 'conn-off', enabled: false, attachedAgentIds: ['agent-A'] },
      ],
    }))

    expect(new LocalMcpService().listAttachedServers('agent-A')).toEqual([
      expect.objectContaining({ connectionId: 'conn-a', serverName: 'github' }),
    ])
  })
})
