/**
 * MCP Agent scope 回归：attach 路径的 Agent 权限校验（fail-closed）。
 *
 * attachConnection / saveManualConnection / importCandidate 在启用给某 Agent 前，
 * 必须校验当前用户拥有该 Agent；校验不通过统一抛 MCP_ERR:AGENT_ACCESS_DENIED，
 * 且不得修改本地 store（不半写）。解绑（attached=false）不需要权限。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpErrorCode } from '@shared/types/mcp'

const { mocks, AgentAccessDeniedError } = vi.hoisted(() => {
  class AgentAccessDeniedError extends Error {
    readonly agentId: string
    readonly reason: string
    constructor(agentId: string, reason: string, message: string) {
      super(message)
      this.name = 'AgentAccessDeniedError'
      this.agentId = agentId
      this.reason = reason
    }
  }
  return {
    mocks: {
      assertCurrentUserCanAccessAgent: vi.fn(),
      atomicWriteFileSync: vi.fn(),
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    AgentAccessDeniedError,
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/userData') },
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
  AgentAccessDeniedError,
}))

import { LocalMcpService } from '../LocalMcpService'

const AGENT_ID = 'agent-1'

function seedStore(connections: unknown[]): void {
  mocks.readFileSync.mockReturnValue(JSON.stringify({ version: 2, connections }))
}

const baseConnection = {
  id: 'conn-1',
  name: 'demo',
  source: { kind: 'manual', label: 'Manual' },
  transport: { kind: 'stdio', command: 'node' },
  enabled: true,
  attachedAgentIds: [],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

describe('LocalMcpService attach 路径 Agent 权限校验', () => {
  let service: LocalMcpService

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.existsSync.mockReturnValue(true)
    service = new LocalMcpService()
  })

  it('attachConnection：有权限 → 写入 attachedAgentIds', async () => {
    seedStore([{ ...baseConnection }])
    mocks.assertCurrentUserCanAccessAgent.mockResolvedValue(undefined)

    const summary = await service.attachConnection('conn-1', AGENT_ID, true)

    expect(mocks.assertCurrentUserCanAccessAgent).toHaveBeenCalledWith(AGENT_ID)
    expect(summary.attachedAgentIds).toContain(AGENT_ID)
    expect(mocks.atomicWriteFileSync).toHaveBeenCalledTimes(1)
  })

  it('attachConnection：无权限 → 抛 AGENT_ACCESS_DENIED 且不落盘', async () => {
    seedStore([{ ...baseConnection }])
    mocks.assertCurrentUserCanAccessAgent.mockRejectedValue(
      new AgentAccessDeniedError(AGENT_ID, 'forbidden', 'denied'),
    )

    await expect(service.attachConnection('conn-1', AGENT_ID, true)).rejects.toThrow(
      McpErrorCode.AGENT_ACCESS_DENIED,
    )
    expect(mocks.atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('attachConnection：解绑（attached=false）不校验权限', async () => {
    seedStore([{ ...baseConnection, attachedAgentIds: [AGENT_ID] }])

    const summary = await service.attachConnection('conn-1', AGENT_ID, false)

    expect(mocks.assertCurrentUserCanAccessAgent).not.toHaveBeenCalled()
    expect(summary.attachedAgentIds).not.toContain(AGENT_ID)
  })

  it('saveManualConnection：attachToAgentId 无权限 → 抛 AGENT_ACCESS_DENIED 且不落盘', async () => {
    seedStore([])
    mocks.assertCurrentUserCanAccessAgent.mockRejectedValue(
      new AgentAccessDeniedError(AGENT_ID, 'unverifiable', 'backend down'),
    )

    await expect(
      service.saveManualConnection({
        name: 'demo',
        transport: { kind: 'stdio', command: 'node' },
        attachToAgentId: AGENT_ID,
      }),
    ).rejects.toThrow(McpErrorCode.AGENT_ACCESS_DENIED)
    expect(mocks.atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('非 AgentAccessDeniedError 的错误原样抛出（不吞成权限错误）', async () => {
    seedStore([{ ...baseConnection }])
    mocks.assertCurrentUserCanAccessAgent.mockRejectedValue(new Error('boom'))

    await expect(service.attachConnection('conn-1', AGENT_ID, true)).rejects.toThrow('boom')
  })
})
