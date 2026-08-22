import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../auth.js', () => ({
  TokenManager: { getAccessToken: vi.fn().mockResolvedValue('tok') },
}))

vi.mock('../../config/api.js', () => ({
  API_BASE_URL: 'https://api.test.local/api',
}))

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}))

vi.mock('@tabtin/config', () => ({
  joinApiPath: (base: string, path: string) => `${base}${path}`,
  API_ENDPOINTS: {
    AGENT: { DETAIL: (id: string) => `/agents/${id}` },
    WORKSPACE: { DETAIL: (id: string) => `/context/workspaces/${id}` },
  },
}))

vi.mock('@tabtin/app-shell/agent-config-v2', () => ({
  isExecutionLimitsEnabled: (limits: { enabled?: boolean | null } | null | undefined) => {
    if (!limits) return false
    if (typeof limits.enabled === 'boolean') return limits.enabled
    return true
  },
}))

import { HostTurnStore } from '@tabtin/agent-host/policy'
import {
  bindHostStateReconciler,
  bindHostTurnStore,
  assertHostTurnAgentResolved,
  clearHostTurnBundleCache,
  fetchHostTurnBundle,
  loadHostTurnBundle,
  unbindHostTurnStoreForTests,
} from '../host-turn-bundle'

let turnStore: HostTurnStore

beforeEach(() => {
  vi.clearAllMocks()
  turnStore = new HostTurnStore()
  bindHostTurnStore(() => turnStore)
  clearHostTurnBundleCache({ turnStore })
})

afterEach(() => {
  unbindHostTurnStoreForTests()
})

function makeFetchImpl(opts?: { workspaceLimitsEnabled?: boolean }) {
  const workspaceLimitsEnabled = opts?.workspaceLimitsEnabled ?? true
  return vi.fn(async (url: string) => {
    if (String(url).includes('/agents/')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            display_name: 'Tin',
            custom_rules: '说中文',
            personal_rules: '简洁',
            organization_allow_member_yolo: true,
            agent_config: {
              schema_version: 3,
              runtime_plane: 'local',
              security: { approval_grant: 'auto' },
              capabilities: {
                overrides: {
                  cost: {
                    execution_limits: { enabled: true, max_iterations_per_run: 20 },
                  },
                },
              },
            },
          },
        }),
      }
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: {
          custom_rules: '禁止 force push',
          approval_grant: 'full_access',
          execution_limits: {
            enabled: workspaceLimitsEnabled,
            max_iterations_per_run: workspaceLimitsEnabled ? 88 : 99,
            max_credits_per_run: '12',
          },
        },
      }),
    }
  })
}

describe('host-turn-bundle', () => {
  it('renderer 只推局部状态时由 Host 主动拉完整权威快照', async () => {
    turnStore.upsertAgent({
      agentId: 'agent-1',
      agentConfigRaw: { schema_version: 3, security: {} },
      organizationAllowMemberYolo: false,
    })
    turnStore.upsertWorkspace({
      workspaceId: 'ws-1',
      approvalGrant: 'always_ask',
    })
    const reconcile = vi.fn(async () => {
      turnStore.replaceSnapshots([{
        organizationId: 'org-1',
        organizationDetail: { id: 'org-1', name: 'Organization' },
        agentDetail: {
          id: 'agent-1',
          organization_id: 'org-1',
          agent_config: { schema_version: 3, security: {} },
          organization_allow_member_yolo: false,
        },
        workspaceDetail: {
          id: 'ws-1',
          organization_id: 'org-1',
          working_dir: '/tmp/ws-1',
          working_dir_type: 'code',
          approval_grant: 'always_ask',
        },
        runtimeConfig: {
          operationSwitches: {},
          memoryCapability: true,
          enabledApps: [],
        },
      }])
      expect(turnStore.getAgent('agent-1')?.operationSwitches).toEqual({})
      expect(turnStore.getWorkspace('ws-1')?.runtimeConfig).toEqual({
        memoryCapability: true,
        enabledApps: [],
      })
      return true
    })
    bindHostStateReconciler(reconcile)
    const fetchImpl = vi.fn()

    const bundle = await loadHostTurnBundle({
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    })

    expect(reconcile).toHaveBeenCalledOnce()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(bundle.workspaceDetail?.working_dir).toBe('/tmp/ws-1')
    expect(bundle.runtimeConfig?.memoryCapability).toBe(true)
  })

  it('权威 Host 对账失败时阻断，不降级到旧 DETAIL', async () => {
    bindHostStateReconciler(vi.fn(async () => false))
    const fetchImpl = vi.fn()

    await expect(loadHostTurnBundle({
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    })).rejects.toThrow('Authoritative Host state is unavailable')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('权威 Host 对账成功但缺少三元组时阻断', async () => {
    bindHostStateReconciler(vi.fn(async () => true))
    const fetchImpl = vi.fn()

    await expect(loadHostTurnBundle({
      agentId: 'missing-agent',
      workspaceId: 'missing-workspace',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    })).rejects.toThrow('Authoritative Host state is incomplete')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('一次并行 DETAIL 同时产出 grant 叠层与 profile', async () => {
    const fetchImpl = makeFetchImpl()
    const bundle = await fetchHostTurnBundle({
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(bundle.resolvedAgentId).toBe('agent-1')
    expect(bundle.profile.agentName).toBe('Tin')
    expect(bundle.profile.customRules).toBe('说中文')
    expect(bundle.profile.personalRules).toBe('简洁')
    expect(bundle.profile.workspaceRules).toBe('禁止 force push')
    expect(bundle.profile.executionLimits?.max_iterations_per_run).toBe(88)
    expect(bundle.agentConfig.security.allow_yolo_mode).toBe(true)
    expect(bundle.agentConfig.security.approval_grant).toBe('full_access')
  })

  it('Workspace 未启用执行限制时不回落 Agent', async () => {
    const fetchImpl = makeFetchImpl({ workspaceLimitsEnabled: false })
    const bundle = await fetchHostTurnBundle({
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    })
    expect(bundle.profile.executionLimits).toBeUndefined()
  })

  it('Agent DETAIL 未解析时不标记 resolvedAgentId', async () => {
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: !String(url).includes('/agents/'),
      json: async () => ({ success: true, data: {} }),
    }))

    const bundle = await fetchHostTurnBundle({
      agentId: 'missing-agent',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    })

    expect(bundle.resolvedAgentId).toBeUndefined()
    expect(bundle.profile).toEqual({})
    expect(() => assertHostTurnAgentResolved(bundle, 'missing-agent')).toThrow(
      'Selected Agent could not be resolved',
    )
  })

  it('loadHostTurnBundle 同 key 并发只打一轮 HTTP', async () => {
    const fetchImpl = makeFetchImpl()
    const deps = {
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    }

    const [a, b] = await Promise.all([
      loadHostTurnBundle(deps),
      loadHostTurnBundle(deps),
    ])

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(a).toBe(b)
    expect(a.profile.customRules).toBe('说中文')
  })

  it('hydrate 后再次 load 零 HTTP', async () => {
    const fetchImpl = makeFetchImpl()
    const deps = {
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getAccessToken: async () => 'tok',
    }
    await loadHostTurnBundle(deps)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    fetchImpl.mockClear()
    const again = await loadHostTurnBundle(deps)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(again.profile.agentName).toBe('Tin')
    expect(again.agentConfig.security.approval_grant).toBe('full_access')
  })
})
