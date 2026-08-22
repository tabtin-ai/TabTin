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

const AGENT_A = 'agent-a'
const AGENT_B = 'agent-b'

function storeWith(connections: Array<Record<string, unknown>>) {
  mocks.readFileSync.mockReturnValue(JSON.stringify({
    version: 2,
    connections,
  }))
}

describe('LocalMcpService.listAgentAttachedSummaries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.existsSync.mockReturnValue(true)
  })

  it('只返回 enabled 且已挂载到目标 agent 的连接', () => {
    storeWith([
      {
        id: 'enabled-attached',
        name: 'GitHub',
        description: 'gh tools',
        source: { kind: 'manual', label: 'Manual' },
        transport: { kind: 'stdio', command: 'npx', args: ['-y', 'github'], env: { TOKEN: 'secret' } },
        enabled: true,
        attachedAgentIds: [AGENT_A],
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'enabled-other-agent',
        name: 'Notion',
        source: { kind: 'manual', label: 'Manual' },
        transport: { kind: 'http', url: 'https://mcp.example/notion', headers: { Authorization: 'Bearer x' } },
        enabled: true,
        attachedAgentIds: [AGENT_B],
        createdAt: '2026-07-02T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:00.000Z',
      },
      {
        id: 'disabled-attached',
        name: 'Stripe',
        source: { kind: 'manual', label: 'Manual' },
        transport: { kind: 'stdio', command: 'stripe-mcp' },
        enabled: false,
        attachedAgentIds: [AGENT_A],
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
      },
    ])

    const summaries = new LocalMcpService().listAgentAttachedSummaries(AGENT_A)

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: 'enabled-attached',
      name: 'GitHub',
      description: 'gh tools',
      transportKind: 'stdio',
      command: 'npx',
      enabled: true,
      source: expect.objectContaining({ kind: 'manual', label: 'Manual' }),
      attachedAgentIds: [AGENT_A],
    })
    // 安全摘要：只暴露 env key，不泄露凭据值
    expect(summaries[0].envKeys).toEqual(['TOKEN'])
    expect(JSON.stringify(summaries[0])).not.toContain('secret')
  })

  it('未挂载任何连接的 agent 返回空数组', () => {
    storeWith([
      {
        id: 'conn-1',
        name: 'Vercel',
        source: { kind: 'manual', label: 'Manual' },
        transport: { kind: 'stdio', command: 'vercel-mcp' },
        enabled: true,
        attachedAgentIds: [AGENT_B],
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ])

    expect(new LocalMcpService().listAgentAttachedSummaries(AGENT_A)).toEqual([])
  })

  it('disabled 连接即使已挂载也不出现', () => {
    storeWith([
      {
        id: 'disabled',
        name: 'Cloudflare',
        source: { kind: 'manual', label: 'Manual' },
        transport: { kind: 'http', url: 'https://mcp.example/cf' },
        enabled: false,
        attachedAgentIds: [AGENT_A],
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'enabled',
        name: 'Neon',
        source: { kind: 'manual', label: 'Manual' },
        transport: { kind: 'http', url: 'https://mcp.example/neon' },
        enabled: true,
        attachedAgentIds: [AGENT_A],
        createdAt: '2026-07-02T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:00.000Z',
      },
    ])

    const summaries = new LocalMcpService().listAgentAttachedSummaries(AGENT_A)
    expect(summaries.map(item => item.id)).toEqual(['enabled'])
    expect(summaries.every(item => item.enabled)).toBe(true)
  })
})
