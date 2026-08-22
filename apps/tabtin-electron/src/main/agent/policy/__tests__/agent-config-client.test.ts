/**
 * agent-config-client.test.ts — Electron Main 进程权威 agent_config 拉取的单测
 *
 * 锁的契约（PRD M2）：
 *   - C1：成功响应（Django envelope）→ 返回该 AgentConfigV3
 *   - C2：HTTP 失败 / 401 / 网络断 → 返回 fallback `allow_yolo_mode=false` + log warn
 *   - C3：TTL 内同 agentId 第二次调用走 cache（仅一次 HTTP）
 *   - C4：TTL 过期后再调触发新 fetch
 *
 * 不启动完整的 ElectronAgentHost — 直接对 `createAgentConfigClient` 工厂
 * 注入 mock fetch / getAccessToken / now 做断言。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 必须先 mock main 依赖再 import 被测模块。
vi.mock('../../../auth', () => ({
  TokenManager: { getAccessToken: vi.fn().mockResolvedValue('test-token') },
}))
vi.mock('../../../config/api', () => ({
  API_BASE_URL: 'https://api.test.local',
}))
vi.mock('electron-log', () => {
  const noop = () => {}
  const logObj = {
    info: noop, warn: noop, error: noop, debug: noop,
    log: noop, verbose: noop, silly: noop,
  }
  return {
    default: {
      transports: { file: { level: 'info' }, console: { level: 'info' } },
      create: () => logObj,
      scope: () => logObj,
      ...logObj,
    },
  }
})
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
}))

const { createAgentConfigClient, CACHE_TTL_MS } = await import('../agent-config-client')

// ─── Helpers ─────────────────────────────────────────────────────────

function makeOkResponse(allowMemberYolo: boolean): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        id: 'agent-1',
        agent_config: {
          schema_version: 3,
          runtime_plane: 'local',
        },
        organization_allow_member_yolo: allowMemberYolo,
      },
    }),
  } as unknown as Response
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ success: false, error: 'mock' }),
  } as unknown as Response
}

function makeWorkspaceResponse(grant: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: { id: 'workspace-1', approval_grant: grant },
    }),
  } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── C1 ──────────────────────────────────────────────────────────────

describe('agent-config-client / fetch authoritative', () => {
  it('Workspace 审批档位从 Workspace 详情读取', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeWorkspaceResponse('full_access'))
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    await expect(
      client.fetchAuthoritativeWorkspaceApprovalGrant('workspace-A'),
    ).resolves.toBe('full_access')
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/context/workspaces/workspace-A')
  })

  it('Workspace 返回非法审批档位时 fail-closed', async () => {
    const client = createAgentConfigClient({
      fetch: vi.fn().mockResolvedValue(makeWorkspaceResponse('unknown')),
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    await expect(
      client.fetchAuthoritativeWorkspaceApprovalGrant('workspace-B'),
    ).resolves.toBe('always_ask')
  })

  // ：切档 IPC / query 共用合成入口，禁止 Agent grant 覆盖 Workspace grant
  it('组织开放时 ForWorkspace 用 Workspace grant 覆盖 Agent grant', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/context/workspaces/')) {
        return makeWorkspaceResponse('full_access')
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            agent_config: {
              schema_version: 3,
              security: { approval_grant: 'always_ask' },
            },
            organization_allow_member_yolo: true,
          },
        }),
      }
    })
    const client = createAgentConfigClient({
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const config = await client.fetchAuthoritativeAgentConfigForWorkspace(
      'agent-ws',
      'workspace-full',
    )
    expect(config.security.allow_yolo_mode).toBe(true)
    expect(config.security.approval_grant).toBe('full_access')
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/agents/agent-ws'))).toBe(true)
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('/context/workspaces/workspace-full')),
    ).toBe(true)
  })

  it('组织开放但无 workspaceId 时 ForWorkspace fail-closed 为 always_ask', async () => {
    const client = createAgentConfigClient({
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            agent_config: {
              schema_version: 3,
              security: { approval_grant: 'auto' },
            },
            organization_allow_member_yolo: true,
          },
        }),
      }) as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const config = await client.fetchAuthoritativeAgentConfigForWorkspace('agent-no-ws', null)
    expect(config.security.allow_yolo_mode).toBe(true)
    expect(config.security.approval_grant).toBe('always_ask')
  })

  it('组织关闭时 ForWorkspace 不读 Workspace，grant 保持 always_ask', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/context/workspaces/')) {
        return makeWorkspaceResponse('full_access')
      }
      return makeOkResponse(false)
    })
    const client = createAgentConfigClient({
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const config = await client.fetchAuthoritativeAgentConfigForWorkspace(
      'agent-org-off',
      'workspace-full',
    )
    expect(config.security.allow_yolo_mode).toBe(false)
    expect(config.security.approval_grant).toBe('always_ask')
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('/context/workspaces/')),
    ).toBe(false)
  })

  it('Django 返回 organization_allow_member_yolo=true → client 返回 true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse(true))
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const config = await client.fetchAuthoritativeAgentConfig('agent-A')
    expect(config.security.allow_yolo_mode).toBe(true)
    // 组织开放 ≠ Agent 已授权：无 grant 时显式 always_ask，避免 legacy 回落误升档
    expect(config.security.approval_grant).toBe('always_ask')
    expect(config.schema_version).toBe(3)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const calledUrl = (fetchMock.mock.calls[0]?.[0] as string) ?? ''
    expect(calledUrl).toContain('/agents/agent-A')
  })

  it('Django 返回 organization_allow_member_yolo=false → client 返回 false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse(false))
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const config = await client.fetchAuthoritativeAgentConfig('agent-B')
    expect(config.security.allow_yolo_mode).toBe(false)
    expect(config.security.approval_grant).toBe('always_ask')
  })

  it('组织开放 + Agent approval_grant=auto → 透传 auto', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          agent_config: {
            schema_version: 3,
            security: { approval_grant: 'auto' },
          },
          organization_allow_member_yolo: true,
        },
      }),
    })
    const client = createAgentConfigClient({
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })
    const config = await client.fetchAuthoritativeAgentConfig('agent-grant')
    expect(config.security.allow_yolo_mode).toBe(true)
    expect(config.security.approval_grant).toBe('auto')
  })

  it('组织关闭 + Agent approval_grant=full_access → 夹回 always_ask', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          agent_config: {
            schema_version: 3,
            security: { approval_grant: 'full_access' },
          },
          organization_allow_member_yolo: false,
        },
      }),
    })
    const client = createAgentConfigClient({
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })
    const config = await client.fetchAuthoritativeAgentConfig('agent-clamp')
    expect(config.security.allow_yolo_mode).toBe(false)
    expect(config.security.approval_grant).toBe('always_ask')
  })

  it('Django 返回 organization_allow_member_yolo 非 boolean → 兜底为 false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          agent_config: { schema_version: 3 },
          organization_allow_member_yolo: 'yes',
        },
      }),
    })
    const client = createAgentConfigClient({
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const config = await client.fetchAuthoritativeAgentConfig('agent-X')
    expect(config.security.allow_yolo_mode).toBe(false)
  })
})

// ─── C2 ──────────────────────────────────────────────────────────────

describe('agent-config-client / fallback when fetch fails', () => {
  it('fetch reject（网络断）→ 返回 fallback allow_yolo_mode=false', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const config = await client.fetchAuthoritativeAgentConfig('agent-C')
    expect(config.security.allow_yolo_mode).toBe(false)
    expect(config.schema_version).toBe(3)
  })

  it('HTTP 401 → 返回 fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeErrorResponse(401))
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const config = await client.fetchAuthoritativeAgentConfig('agent-D')
    expect(config.security.allow_yolo_mode).toBe(false)
  })

  it('Django envelope success=false → 返回 fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: false, message: 'not found' }),
    })
    const client = createAgentConfigClient({
      fetch: fetchMock as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const config = await client.fetchAuthoritativeAgentConfig('agent-E')
    expect(config.security.allow_yolo_mode).toBe(false)
  })

  it('无 access token → 直接 fallback，不发 HTTP', async () => {
    const fetchMock = vi.fn()
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => null,
      now: () => 1_000_000,
    })

    const config = await client.fetchAuthoritativeAgentConfig('agent-F')
    expect(config.security.allow_yolo_mode).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── C3 / C4 cache ───────────────────────────────────────────────────

describe('agent-config-client / cache TTL', () => {
  it('TTL 内同 agentId 第二次调用走 cache（仅一次 HTTP）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse(true))
    let t = 1_000_000
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => t,
    })

    await client.fetchAuthoritativeAgentConfig('agent-G')
    t += CACHE_TTL_MS - 1 // 仍在 TTL 内
    const second = await client.fetchAuthoritativeAgentConfig('agent-G')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second.security.allow_yolo_mode).toBe(true)
  })

  it('TTL 过期后再调触发新 fetch', async () => {
    let allowYolo = true
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(makeOkResponse(allowYolo)))
    let t = 1_000_000
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => t,
    })

    const first = await client.fetchAuthoritativeAgentConfig('agent-H')
    expect(first.security.allow_yolo_mode).toBe(true)

    // 模拟 Settings 改完，Django 现在返回 false
    allowYolo = false
    t += CACHE_TTL_MS + 100 // 超过 TTL
    const second = await client.fetchAuthoritativeAgentConfig('agent-H')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(second.security.allow_yolo_mode).toBe(false)
  })

  it('不同 agentId 独立 cache', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeOkResponse(true)) // agent-I
      .mockResolvedValueOnce(makeOkResponse(false)) // agent-J
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    const i = await client.fetchAuthoritativeAgentConfig('agent-I')
    const j = await client.fetchAuthoritativeAgentConfig('agent-J')

    expect(i.security.allow_yolo_mode).toBe(true)
    expect(j.security.allow_yolo_mode).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clearCache 后下一次调用强制 refetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse(true))
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'tok',
      now: () => 1_000_000,
    })

    await client.fetchAuthoritativeAgentConfig('agent-K')
    client.clearCache()
    await client.fetchAuthoritativeAgentConfig('agent-K')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
