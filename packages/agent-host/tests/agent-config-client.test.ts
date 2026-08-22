/**
 * agent-config-client.test.ts — 共享权威 agent_config 拉取客户端的核心契约。
 *
 * 覆盖 Electron / Daemon 双端共同依赖的语义：
 *   - C1 组织天花板 ∩ Agent grant 归一
 *   - C2 fetch 失败 / 401 / envelope 非法 / 无 token → deny-by-default
 *   - C3 5s cache 命中不再发 HTTP
 *   - C4 TTL 过期后触发新 fetch
 *   - C5 不同 agentId 独立 cache
 *   - C6 clearCache(agentId) 精确清一条 vs 全清
 *
 * Electron 侧的宿主特化 wrapper 有自己的一份 spec
 * (`apps/tabtin-electron/src/main/agent/policy/__tests__/*`), Daemon 侧不额
 * 外重复，本 spec 是 agent-host 层次的合同锁。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CACHE_TTL_MS,
  createAgentConfigClient,
} from '../src/policy/agent-config-client.js'

// ─── Helpers ─────────────────────────────────────────────────────────

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ success: false }),
  } as unknown as Response
}

const buildAgentDetailUrl = (agentId: string) => `https://api.test.local/agents/${agentId}`

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── C1 组织天花板 ∩ Agent grant ────────────────────────────────────

describe('createAgentConfigClient / normalize', () => {
  it('组织开放 + Agent grant=auto → 透传 auto', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkResponse({
        success: true,
        data: {
          agent_config: { schema_version: 3, security: { approval_grant: 'auto' } },
          organization_allow_member_yolo: true,
        },
      }),
    )
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => 1_000_000,
    })
    const config = await client.fetchAuthoritativeAgentConfig('agent-1')
    expect(config.security.allow_yolo_mode).toBe(true)
    expect(config.security.approval_grant).toBe('auto')
  })

  it('组织关闭 + Agent grant=full_access → 夹回 always_ask', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkResponse({
        success: true,
        data: {
          agent_config: { schema_version: 3, security: { approval_grant: 'full_access' } },
          organization_allow_member_yolo: false,
        },
      }),
    )
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => 1_000_000,
    })
    const config = await client.fetchAuthoritativeAgentConfig('agent-clamp')
    expect(config.security.allow_yolo_mode).toBe(false)
    expect(config.security.approval_grant).toBe('always_ask')
  })

  it('组织开放但 Agent 没 grant（仅 legacy allow_yolo=true）→ 显式写 auto', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkResponse({
        success: true,
        data: {
          agent_config: { schema_version: 3, security: { allow_yolo_mode: true } },
          organization_allow_member_yolo: true,
        },
      }),
    )
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => 1_000_000,
    })
    const config = await client.fetchAuthoritativeAgentConfig('agent-legacy')
    expect(config.security.allow_yolo_mode).toBe(true)
    expect(config.security.approval_grant).toBe('auto')
  })

  it('organization_allow_member_yolo 非 boolean → 兜底 false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkResponse({
        success: true,
        data: {
          agent_config: { schema_version: 3 },
          organization_allow_member_yolo: 'yes',
        },
      }),
    )
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => 1_000_000,
    })
    const config = await client.fetchAuthoritativeAgentConfig('agent-invalid-org')
    expect(config.security.allow_yolo_mode).toBe(false)
    expect(config.security.approval_grant).toBe('always_ask')
  })
})

// ─── C2 fallback deny-by-default ─────────────────────────────────────

describe('createAgentConfigClient / fallback', () => {
  it('无 access token → 直接 fallback，不发 HTTP', async () => {
    const fetchMock = vi.fn()
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => null,
      buildAgentDetailUrl,
      now: () => 1_000_000,
    })
    const config = await client.fetchAuthoritativeAgentConfig('agent-A')
    expect(config.security.allow_yolo_mode).toBe(false)
    expect(config.security.approval_grant).toBe('always_ask')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('网络错误 → fallback deny 且不抛错', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => 1_000_000,
    })
    const config = await client.fetchAuthoritativeAgentConfig('agent-B')
    expect(config.security.allow_yolo_mode).toBe(false)
    expect(config.security.approval_grant).toBe('always_ask')
  })

  it('HTTP 401 → fallback deny', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeErrorResponse(401))
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => 1_000_000,
    })
    const config = await client.fetchAuthoritativeAgentConfig('agent-C')
    expect(config.security.allow_yolo_mode).toBe(false)
  })

  it('envelope success=false → fallback deny', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkResponse({ success: false, message: 'not found' }),
    )
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => 1_000_000,
    })
    const config = await client.fetchAuthoritativeAgentConfig('agent-D')
    expect(config.security.allow_yolo_mode).toBe(false)
  })
})

// ─── C3-C6 cache ─────────────────────────────────────────────────────

describe('createAgentConfigClient / cache', () => {
  it('TTL 内命中 cache 不再发 HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkResponse({
        success: true,
        data: {
          agent_config: { schema_version: 3 },
          organization_allow_member_yolo: true,
        },
      }),
    )
    let t = 1_000_000
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => t,
    })
    await client.fetchAuthoritativeAgentConfig('agent-cache')
    t += CACHE_TTL_MS - 1
    await client.fetchAuthoritativeAgentConfig('agent-cache')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期后再调触发新 fetch', async () => {
    let orgOpen = true
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        makeOkResponse({
          success: true,
          data: {
            agent_config: { schema_version: 3 },
            organization_allow_member_yolo: orgOpen,
          },
        }),
      ),
    )
    let t = 1_000_000
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => t,
    })
    const first = await client.fetchAuthoritativeAgentConfig('agent-ttl')
    expect(first.security.allow_yolo_mode).toBe(true)

    orgOpen = false
    t += CACHE_TTL_MS + 100
    const second = await client.fetchAuthoritativeAgentConfig('agent-ttl')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(second.security.allow_yolo_mode).toBe(false)
  })

  it('不同 agentId 独立 cache', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeOkResponse({
          success: true,
          data: { agent_config: { schema_version: 3 }, organization_allow_member_yolo: true },
        }),
      )
      .mockResolvedValueOnce(
        makeOkResponse({
          success: true,
          data: { agent_config: { schema_version: 3 }, organization_allow_member_yolo: false },
        }),
      )
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => 1_000_000,
    })
    const a = await client.fetchAuthoritativeAgentConfig('agent-independent-A')
    const b = await client.fetchAuthoritativeAgentConfig('agent-independent-B')
    expect(a.security.allow_yolo_mode).toBe(true)
    expect(b.security.allow_yolo_mode).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clearCache(agentId) 精确清一条', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkResponse({
        success: true,
        data: { agent_config: { schema_version: 3 }, organization_allow_member_yolo: true },
      }),
    )
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => 1_000_000,
    })
    await client.fetchAuthoritativeAgentConfig('agent-keep')
    await client.fetchAuthoritativeAgentConfig('agent-drop')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    client.clearCache('agent-drop')
    await client.fetchAuthoritativeAgentConfig('agent-keep')
    await client.fetchAuthoritativeAgentConfig('agent-drop')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

// ─── Auth / URL / logger 桩正确注入 ────────────────────────────────

describe('createAgentConfigClient / injection contract', () => {
  it('fetch 得到 buildAgentDetailUrl 拼好的 URL + Bearer + Organization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkResponse({
        success: true,
        data: { agent_config: { schema_version: 3 }, organization_allow_member_yolo: false },
      }),
    )
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: async () => 'auth-token-123',
      getOrganizationId: () => 'org-42',
      buildAgentDetailUrl: (id: string) => `https://api.test.local/agents/${id}`,
      now: () => 1_000_000,
    })
    await client.fetchAuthoritativeAgentConfig('agent-headers')
    const call = fetchMock.mock.calls[0]
    expect(call?.[0]).toBe('https://api.test.local/agents/agent-headers')
    const headers = (call?.[1] as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer auth-token-123')
    expect(headers['X-Organization-Id']).toBe('org-42')
  })

  it('无 organization getter → 不写 X-Organization-Id header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeOkResponse({
        success: true,
        data: { agent_config: { schema_version: 3 }, organization_allow_member_yolo: false },
      }),
    )
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => 1_000_000,
    })
    await client.fetchAuthoritativeAgentConfig('agent-no-org')
    const headers = (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers
    expect(headers['X-Organization-Id']).toBeUndefined()
  })

  it('logger.warn 在 fallback 时收到通知', async () => {
    const warn = vi.fn()
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    const client = createAgentConfigClient({
      fetch: fetchMock,
      getAccessToken: () => 'tok',
      buildAgentDetailUrl,
      now: () => 1_000_000,
      logger: { warn },
    })
    await client.fetchAuthoritativeAgentConfig('agent-log')
    expect(warn).toHaveBeenCalled()
    const msg = String(warn.mock.calls[0]?.[0] ?? '')
    expect(msg).toContain('fallback deny')
  })
})
