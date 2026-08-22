import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// contract Wave 1-B：skills query 已迁出直 fetch，统一走 services/electronFetch。
// 测试相应改为 mock 该 helper（语义等价于原先 stubGlobal('fetch')）。
const electronFetchMock = vi.hoisted(() => vi.fn())
const mockSpaceStoreState = vi.hoisted(() => ({
  spaces: [] as Array<{ id: string; organization_id: string; working_dir?: string }>,
  selectedAgent: null as { id: string; is_default?: boolean } | null,
  agentCache: {} as Record<string, { is_default?: boolean }>,
}))
const mockOrganizationStoreState = vi.hoisted(() => ({
  selectedOrganization: { id: 'wt-1' } as { id: string } | null,
  pendingOrganizationId: null as string | null,
}))

vi.mock('@/services/electronFetch', () => ({
  electronFetch: electronFetchMock,
}))

vi.mock('@/config/api', () => ({
  API_CONFIG: { baseURL: 'http://localhost:6060' },
  API_ENDPOINTS: {
    AGENT: {
      SKILLS: (agentId: string) => `/agents/${agentId}/skills`,
      SKILL: (agentId: string, key: string) =>
        `/agents/${agentId}/skills/${encodeURIComponent(key)}`,
    },
    SKILLS: {
      VISIBLE: (organizationId: string, agentId?: string | null) => {
        const qs = new URLSearchParams({ organization_id: organizationId })
        if (agentId) qs.set('agent_id', agentId)
        return `/skills/visible?${qs.toString()}`
      },
      CONFIG_LIST: (organizationId: string, agentId?: string | null) => {
        const qs = new URLSearchParams({ organization_id: organizationId })
        if (agentId) qs.set('agent_id', agentId)
        return `/skills/config?${qs.toString()}`
      },
      MARKET: () => '/skills/market',
      ENABLE: (key: string) => `/skills/${encodeURIComponent(key)}/enable`,
      DISABLE: (key: string) => `/skills/${encodeURIComponent(key)}/disable`,
      UPDATE_CATEGORY: (skillId: string) => `/skills/${skillId}/category`,
      CREATE: '/skills/create',
      PUBLISH: (skillId: string) => `/skills/${skillId}/publish`,
      UPGRADE: (skillId: string) => `/skills/${skillId}/upgrade`,
    },
  },
}))

/** ：list 查询并行拉 visible + agent skills，按 URL 分流避免串台。 */
function mockSkillsListHttp(options: {
  visible?: Record<string, unknown>
  agentSkills?: Array<Record<string, unknown>>
}) {
  const visibleData = options.visible ?? { skills: [] }
  const agentSkills = options.agentSkills ?? []
  electronFetchMock.mockImplementation((url: string) => {
    const href = String(url)
    if (href.includes('/agents/') && href.includes('/skills')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: { skills: agentSkills, total: agentSkills.length },
        }),
      })
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: visibleData }),
    })
  })
}

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({
      accessToken: 'token-1',
      user: { id: 'user-1' },
    }),
  },
}))

vi.mock('@/stores/useSpaceStore', () => {
  const useSpaceStore = (selector: (state: typeof mockSpaceStoreState) => unknown) =>
    selector(mockSpaceStoreState)
  useSpaceStore.getState = () => mockSpaceStoreState
  return { useSpaceStore }
})

vi.mock('@/stores/useOrganizationStore', () => {
  const useOrganizationStore = (
    selector: (state: typeof mockOrganizationStoreState) => unknown,
  ) => selector(mockOrganizationStoreState)
  useOrganizationStore.getState = () => mockOrganizationStoreState
  return { useOrganizationStore }
})


function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
}

function makeWrapper(queryClient = makeQueryClient()) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)
}

describe('useSkillsListQuery local runtime catalog merge', () => {
  beforeEach(() => {
    electronFetchMock.mockReset()
    mockSpaceStoreState.spaces = [{ id: 'space-1', organization_id: 'wt-1' }]
    mockSpaceStoreState.selectedAgent = { id: 'agent-1', is_default: true }
    mockSpaceStoreState.agentCache = {}
    mockOrganizationStoreState.selectedOrganization = { id: 'wt-1' }
    mockOrganizationStoreState.pendingOrganizationId = null
    ;(window as unknown as {
      tabtin?: {
        skill?: {
          list?: ReturnType<typeof vi.fn>
        }
      }
    }).tabtin = {
      skill: {
        list: vi.fn().mockResolvedValue({
          skills: [
            {
              skill_id: 'files-operator',
              skill_key: 'app:tabfiles/files-operator',
              name: 'Files Operator',
              source: 'app',
              tags: ['device', 'automation'],
              requires: { bins: ['adb'] },
              install: [
                {
                  id: 'android-platform-tools',
                  kind: 'brew',
                  formula: 'android-platform-tools',
                  bins: ['adb'],
                },
              ],
              os_filter: ['darwin', 'linux'],
              agents: [
                {
                  filename: 'files-agent.md',
                  name: 'Files Agent',
                },
              ],
              emoji: ':phone:',
              homepage: 'https://tabtin.example/files',
              always: true,
            },
            {
              skill_id: 'operations',
              skill_key: 'platform:device/operations',
              name: 'Device Operations',
              source: 'platform',
            },
            {
              skill_id: 'lark-approval',
              skill_key: 'device:lark-approval',
              name: 'Lark Approval',
              source: 'device',
            },
          ],
        }),
      },
    }
    mockSkillsListHttp({
      visible: {
        skills: [
          {
            skill_id: 'backend-app',
            skill_key: 'app:backend/should-not-render',
            name: 'Backend App Skill',
            source: 'app',
            installed: false,
            agent_enabled: false,
          },
          {
            skill_id: 'installed-marketplace-app',
            skill_key: 'app:tabtin-office-skills-pack/meeting-notes-to-actions',
            name: 'Meeting Notes',
            source: 'app',
            distribution: 'marketplace',
            installed: true,
            enabled: true,
            agent_enabled: true,
          },
          {
            // ：未安装 marketplace 也可进组织目录浏览
            skill_id: 'browse-marketplace-app',
            skill_key: 'app:browse-pack/uninstalled-skill',
            name: 'Browse Pack',
            source: 'app',
            distribution: 'marketplace',
            installed: false,
            enabled: true,
          },
          {
            skill_id: 'backend-platform',
            skill_key: 'platform:backend/should-not-render',
            name: 'Backend Platform Skill',
            source: 'platform',
            installed: false,
            agent_enabled: false,
          },
          // 本地 catalog 对应的 Agent 携带态：回填到 IPC 扫描结果上
          {
            skill_id: 'files-operator',
            skill_key: 'app:tabfiles/files-operator',
            name: 'Files Operator',
            source: 'app',
            installed: true,
            agent_enabled: true,
          },
          {
            skill_id: 'operations',
            skill_key: 'platform:device/operations',
            name: 'Device Operations',
            source: 'platform',
            installed: true,
            agent_enabled: true,
          },
          {
            skill_id: 'lark-approval',
            skill_key: 'device:lark-approval',
            name: 'Lark Approval',
            source: 'device',
            installed: true,
            agent_enabled: false,
          },
          {
            skill_id: 'user-skill',
            skill_key: 'user:user-skill',
            name: 'User Skill',
            source: 'user',
            installed: true,
            agent_enabled: true,
          },
        ],
        user_gates: {
          'device:lark-approval': true,
          'app:tabfiles/files-operator': false,
        },
      },
      // 空携带集是有效快照：本机发现 device 缺行时默认可用。
      agentSkills: [],
    })
  })

  afterEach(() => {
    delete (window as unknown as { tabtin?: unknown }).tabtin
    mockSpaceStoreState.selectedAgent = { id: 'agent-1', is_default: true }
    mockSpaceStoreState.agentCache = {}
    vi.restoreAllMocks()
  })

  it('keeps local runtime builtins, backend user skills, and browsable marketplace app skills', async () => {
    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect((window as unknown as {
      tabtin: { skill: { list: ReturnType<typeof vi.fn> } }
    }).tabtin.skill.list).toHaveBeenCalledWith({
      spaceId: 'space-1',
      organizationId: 'wt-1',
    })
    // ：技能库目录只按 organization_id，不带 agent_id / 不拉携带集
    expect(electronFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/skills/visible?'),
      expect.any(Object),
    )
    const visibleUrl = String(electronFetchMock.mock.calls[0]?.[0] ?? '')
    expect(visibleUrl).toContain('organization_id=wt-1')
    expect(visibleUrl).not.toContain('agent_id=')
    expect(electronFetchMock.mock.calls.every(call => !String(call[0] ?? '').includes('/agents/'))).toBe(true)
    expect(result.current.data?.map(skill => skill.skill_key)).toEqual([
      'app:tabfiles/files-operator',
      'platform:device/operations',
      'device:lark-approval',
      'app:tabtin-office-skills-pack/meeting-notes-to-actions',
      'app:browse-pack/uninstalled-skill',
      'user:user-skill',
    ])
    expect(result.current.data?.find(skill =>
      skill.skill_key === 'app:tabtin-office-skills-pack/meeting-notes-to-actions',
    )).toMatchObject({
      distribution: 'marketplace',
      installed: true,
      enabled: true,
    })
    expect(result.current.data?.find(skill =>
      skill.skill_key === 'app:browse-pack/uninstalled-skill',
    )).toMatchObject({
      distribution: 'marketplace',
      installed: false,
    })
    // ：无 agentId 时只回填用户总闸 / acquired，不回填 Agent 携带态
    expect(result.current.data?.find(skill => skill.skill_key === 'device:lark-approval')).toMatchObject({
      enabled: true,
      acquired: true,
    })
    expect(result.current.data?.find(skill => skill.skill_key === 'platform:device/operations')).toMatchObject({
      acquired: false,
    })
    expect(result.current.data?.find(skill => skill.skill_key === 'app:tabfiles/files-operator')).toMatchObject({
      enabled: false,
      acquired: true,
      tags: ['device', 'automation'],
      requires: { bins: ['adb'] },
      install: [
        expect.objectContaining({
          id: 'android-platform-tools',
          kind: 'brew',
          bins: ['adb'],
        }),
      ],
      os_filter: ['darwin', 'linux'],
      agents: [
        expect.objectContaining({
          filename: 'files-agent.md',
          name: 'Files Agent',
        }),
      ],
      emoji: ':phone:',
      homepage: 'https://tabtin.example/files',
      always: true,
    })
  })

  it('reuses a fresh live catalog when the Skill page remounts', async () => {
    const { useSkillsListQuery } = await import('./skills')
    const queryClient = makeQueryClient()
    const wrapper = makeWrapper(queryClient)
    const first = renderHook(
      () => useSkillsListQuery('space-1', undefined, { liveCatalog: true }),
      { wrapper },
    )

    await waitFor(() => expect(first.result.current.isSuccess).toBe(true))
    first.unmount()

    const second = renderHook(
      () => useSkillsListQuery('space-1', undefined, { liveCatalog: true }),
      { wrapper },
    )

    expect(second.result.current.data?.length).toBeGreaterThan(0)
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true))
    expect((window as unknown as {
      tabtin: { skill: { list: ReturnType<typeof vi.fn> } }
    }).tabtin.skill.list).toHaveBeenCalledTimes(1)
    expect(electronFetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not scan the current Workspace when the catalog shelf does not need it', async () => {
    mockSpaceStoreState.spaces = [{
      id: 'space-1',
      organization_id: 'wt-1',
      working_dir: '/workspace/current',
    }]
    const workspaceScan = vi.fn().mockResolvedValue({ skills: [] })
    ;(window as unknown as {
      tabtin: { skill: { workspaceScan: typeof workspaceScan } }
    }).tabtin.skill.workspaceScan = workspaceScan

    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(
      () => useSkillsListQuery('space-1', undefined, { includeWorkspaceSkills: false }),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(workspaceScan).not.toHaveBeenCalled()
  })

  it('获取物化后仍保留 marketplace 货架身份（推荐不丢卡）', async () => {
    // 获取会 materializeApp → 本地 skill:list 出现同 key 的 app 行，但通常不带
    // distribution。若合并时丢后端 marketplace 行，推荐过滤会认不出。
    ;(window as unknown as {
      tabtin: { skill: { list: ReturnType<typeof vi.fn> } }
    }).tabtin = {
      skill: {
        list: vi.fn().mockResolvedValue({
          skills: [
            {
              skill_id: 'humanizer-zh',
              skill_key: 'app:tabtin-writing-tools-pack/humanizer-zh',
              name: '去除 AI 写作痕迹',
              source: 'app',
              app_id: 'tabtin-writing-tools-pack',
              // 本地物化行：无 distribution
            },
            {
              skill_id: 'files-operator',
              skill_key: 'app:tabfiles/files-operator',
              name: 'Files Operator',
              source: 'app',
              distribution: 'builtin',
            },
          ],
        }),
      },
    }
    mockSkillsListHttp({
      visible: {
        skills: [
          {
            skill_id: 'humanizer-zh',
            skill_key: 'app:tabtin-writing-tools-pack/humanizer-zh',
            name: '去除 AI 写作痕迹',
            source: 'app',
            distribution: 'marketplace',
            app_id: 'tabtin-writing-tools-pack',
            category: 'writing',
          },
        ],
        user_gates: {
          'app:tabtin-writing-tools-pack/humanizer-zh': true,
        },
      },
      agentSkills: [],
    })

    const { useSkillsListQuery } = await import('./skills')
    const { isRecommendedMarketCatalogSkill } = await import(
      '@/components/context-space/skills/skillSourceGroups'
    )
    const { result } = renderHook(() => useSkillsListQuery('space-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const writing = result.current.data?.find(
      skill => skill.skill_key === 'app:tabtin-writing-tools-pack/humanizer-zh',
    )
    expect(writing).toMatchObject({
      distribution: 'marketplace',
      app_id: 'tabtin-writing-tools-pack',
      acquired: true,
    })
    expect(isRecommendedMarketCatalogSkill(writing!)).toBe(true)
  })

  it('#8759 uses the selected organization while an old Space is pending cleanup', async () => {
    mockSpaceStoreState.spaces = [{ id: 'space-1', organization_id: 'wt-1' }]
    mockOrganizationStoreState.selectedOrganization = { id: 'wt-2' }
    mockOrganizationStoreState.pendingOrganizationId = 'wt-2'

    const {
      skillKeys,
      useSkillConfigsQuery,
      useSkillsListQuery,
    } = await import('./skills')
    const queryClient = makeQueryClient()
    const { result } = renderHook(() => useSkillsListQuery('space-1'), {
      wrapper: makeWrapper(queryClient),
    })
    const configHook = renderHook(
      () => useSkillConfigsQuery('space-1', 'agent-from-session'),
      { wrapper: makeWrapper(queryClient) },
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await waitFor(() => expect(configHook.result.current.isSuccess).toBe(true))

    expect((window as unknown as {
      tabtin: { skill: { list: ReturnType<typeof vi.fn> } }
    }).tabtin.skill.list).toHaveBeenCalledWith({
      spaceId: 'space-1',
      organizationId: 'wt-2',
    })
    const urls = electronFetchMock.mock.calls.map(call => String(call[0] ?? ''))
    expect(urls.some(url => url.includes('/skills/visible?') && url.includes('organization_id=wt-2'))).toBe(true)
    expect(urls.some(url => url.includes('/skills/config?') && url.includes('organization_id=wt-2'))).toBe(true)
    expect(queryClient.getQueryData(skillKeys.list('wt-2'))).toBeDefined()
    expect(queryClient.getQueryData(skillKeys.list('wt-1'))).toBeUndefined()
    expect(queryClient.getQueryData(skillKeys.configs('wt-2', 'agent-from-session'))).toBeDefined()
  })

  it('#8706 degrades to visible carry when agent skills fetch fails', async () => {
    electronFetchMock.mockImplementation((url: string) => {
      const href = String(url)
      if (href.includes('/agents/') && href.includes('/skills')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: () => Promise.resolve({ message: 'boom' }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: {
            skills: [
              {
                skill_id: 'lark-approval',
                skill_key: 'device:lark-approval',
                name: 'Lark Approval',
                source: 'device',
                installed: true,
                agent_enabled: false,
              },
              {
                skill_id: 'operations',
                skill_key: 'platform:device/operations',
                name: 'Device Operations',
                source: 'platform',
                installed: true,
                agent_enabled: true,
              },
              {
                skill_id: 'files-operator',
                skill_key: 'app:tabfiles/files-operator',
                name: 'Files Operator',
                source: 'app',
                installed: true,
                agent_enabled: true,
              },
            ],
            user_gates: { 'device:lark-approval': true },
          },
        }),
      })
    })

    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1', 'agent-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.find(skill => skill.skill_key === 'device:lark-approval')).toMatchObject({
      agent_enabled: false,
      installed: true,
    })
  })

  it('defaults a locally discovered device skill on when 小Tin has no carry link', async () => {
    mockSkillsListHttp({
      visible: { skills: [], user_gates: {} },
      agentSkills: [],
    })

    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1', 'agent-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.find(skill => skill.skill_key === 'device:lark-approval')).toMatchObject({
      enabled: true,
      agent_enabled: true,
    })
  })

  it('keeps an unassigned device skill off for other personas', async () => {
    mockSpaceStoreState.selectedAgent = { id: 'agent-2', is_default: false }
    mockSkillsListHttp({
      visible: { skills: [], user_gates: {} },
      agentSkills: [],
    })

    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1', 'agent-2'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.find(skill => skill.skill_key === 'device:lark-approval')).toMatchObject({
      enabled: true,
      agent_enabled: false,
    })
  })

  it('#8706 backfills device agent_enabled from agent carry links even when visible says false', async () => {
    mockSkillsListHttp({
      visible: {
        skills: [
          {
            skill_id: 'lark-approval',
            skill_key: 'device:lark-approval',
            name: 'Lark Approval',
            source: 'device',
            installed: false,
            agent_enabled: false,
          },
          {
            skill_id: 'operations',
            skill_key: 'platform:device/operations',
            name: 'Device Operations',
            source: 'platform',
            installed: true,
            agent_enabled: true,
          },
          {
            skill_id: 'files-operator',
            skill_key: 'app:tabfiles/files-operator',
            name: 'Files Operator',
            source: 'app',
            installed: true,
            agent_enabled: true,
          },
        ],
        user_gates: {
          'device:lark-approval': true,
        },
      },
      agentSkills: [
        {
          skill_canonical_key: 'device:lark-approval',
          source: 'device',
          skill_id: null,
          enabled: true,
          agent_enabled: true,
          user_enabled: true,
          name: 'Lark Approval',
          description: '',
          emoji: '',
          config_json: {},
          created_at: null,
          updated_at: null,
        },
      ],
    })

    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1', 'agent-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.find(skill => skill.skill_key === 'device:lark-approval')).toMatchObject({
      enabled: true,
      installed: true,
      agent_enabled: true,
    })
  })

  it('#8706 keeps agent_enabled false when carry link sub-switch is off', async () => {
    mockSkillsListHttp({
      visible: {
        skills: [
          {
            skill_id: 'lark-approval',
            skill_key: 'device:lark-approval',
            name: 'Lark Approval',
            source: 'device',
            installed: true,
            // visible 误报 true 时仍应以携带集子开关为准
            agent_enabled: true,
          },
          {
            skill_id: 'operations',
            skill_key: 'platform:device/operations',
            name: 'Device Operations',
            source: 'platform',
            installed: true,
            agent_enabled: true,
          },
          {
            skill_id: 'files-operator',
            skill_key: 'app:tabfiles/files-operator',
            name: 'Files Operator',
            source: 'app',
            installed: true,
            agent_enabled: true,
          },
        ],
        user_gates: { 'device:lark-approval': true },
      },
      agentSkills: [
        {
          skill_canonical_key: 'device:lark-approval',
          source: 'device',
          skill_id: null,
          enabled: false,
          agent_enabled: false,
          user_enabled: true,
          name: 'Lark Approval',
          description: '',
          emoji: '',
          config_json: {},
          created_at: null,
          updated_at: null,
        },
      ],
    })

    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1', 'agent-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.find(skill => skill.skill_key === 'device:lark-approval')).toMatchObject({
      installed: true,
      agent_enabled: false,
    })
  })

  it('#8706 does not treat link.enabled (user∧agent) as agent sub-switch', async () => {
    mockSkillsListHttp({
      visible: {
        skills: [
          {
            skill_id: 'lark-approval',
            skill_key: 'device:lark-approval',
            name: 'Lark Approval',
            source: 'device',
            installed: false,
            agent_enabled: false,
          },
          {
            skill_id: 'operations',
            skill_key: 'platform:device/operations',
            name: 'Device Operations',
            source: 'platform',
            installed: true,
            agent_enabled: true,
          },
          {
            skill_id: 'files-operator',
            skill_key: 'app:tabfiles/files-operator',
            name: 'Files Operator',
            source: 'app',
            installed: true,
            agent_enabled: true,
          },
        ],
        user_gates: { 'device:lark-approval': true },
      },
      agentSkills: [
        {
          skill_canonical_key: 'device:lark-approval',
          source: 'device',
          skill_id: null,
          // 旧/残缺响应只有 AND 语义的 enabled，缺 agent_enabled → 不得当成子开关开
          enabled: true,
          name: 'Lark Approval',
          description: '',
          emoji: '',
          config_json: {},
          created_at: null,
          updated_at: null,
        },
      ],
    })

    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1', 'agent-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.find(skill => skill.skill_key === 'device:lark-approval')).toMatchObject({
      installed: true,
      agent_enabled: false,
    })
  })

  it('#5353 hides all temporarily unavailable App Skills from local and backend catalogs', async () => {
    const hiddenAppIds = [
      'tabsite',
    ]
    const retainedAppIds = ['tabslide', 'tabfiles', 'tabcode']
    const makeAppSkill = (appId: string) => ({
      skill_id: `${appId}-operator`,
      skill_key: `app:${appId}/${appId}-operator`,
      app_id: appId,
      name: `${appId} Operator`,
      source: 'app',
    })
    ;(window as unknown as {
      tabtin: { skill: { list: ReturnType<typeof vi.fn> } }
    }).tabtin.skill.list.mockResolvedValue({
      skills: [...hiddenAppIds.map(makeAppSkill), ...retainedAppIds.map(makeAppSkill)],
    })
    mockSkillsListHttp({
      visible: {
        skills: [
          ...hiddenAppIds.map(makeAppSkill),
          ...retainedAppIds.map(makeAppSkill),
          {
            skill_id: 'user-skill',
            skill_key: 'user:user-skill',
            name: 'User Skill',
            source: 'user',
            installed: true,
          },
        ],
      },
      agentSkills: [],
    })

    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.map(skill => skill.skill_key)).toEqual([
      'app:tabslide/tabslide-operator',
      'app:tabfiles/tabfiles-operator',
      'app:tabcode/tabcode-operator',
      'user:user-skill',
    ])
  })


  it('keeps Personal Plugin runtime skills visible when backend user skills share the same key', async () => {
    ;(window as unknown as {
      tabtin: { skill: { list: ReturnType<typeof vi.fn> } }
    }).tabtin.skill.list.mockResolvedValue({
      skills: [
        {
          skill_id: 'systematic-debugging',
          skill_key: 'user:systematic-debugging',
          name: 'Superpowers Systematic Debugging',
          source: 'user',
          meta: { personal_plugin_id: 'superpowers' },
        },
      ],
    })
    mockSkillsListHttp({
      visible: {
        skills: [
          {
            skill_id: 'systematic-debugging',
            skill_key: 'user:systematic-debugging',
            name: 'Backend Systematic Debugging',
            source: 'user',
          },
        ],
      },
      agentSkills: [],
    })

    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toHaveLength(1)
    expect(result.current.data?.[0]).toMatchObject({
      skill_key: 'user:systematic-debugging',
      name: 'Superpowers Systematic Debugging',
      meta: { personal_plugin_id: 'superpowers' },
    })
  })

  it('does not cache a backend-only partial builtin list when local bundled catalog is not ready yet', async () => {
    ;(window as unknown as {
      tabtin: { skill: { list: ReturnType<typeof vi.fn> } }
    }).tabtin.skill.list
      .mockResolvedValueOnce({ skills: [] })
      .mockResolvedValueOnce({
        skills: [
          {
            skill_id: 'table-association',
            skill_key: 'app:tabdata/table-association',
            name: 'Table Association',
            source: 'app',
          },
          {
            skill_id: 'tabtin-project',
            skill_key: 'platform:tabtin-project/tabtin-project',
            name: 'Tabtin Project',
            source: 'platform',
          },
          ...Array.from({ length: 18 }, (_, index) => ({
            skill_id: `builtin-${index}`,
            skill_key: `platform:test/builtin-${index}`,
            name: `Builtin ${index}`,
            source: 'platform',
          })),
        ],
      })
    mockSkillsListHttp({
      visible: {
        skills: [
          {
            skill_id: 'table-association',
            skill_key: 'app:tabdata/table-association',
            name: 'Table Association (backend slim row)',
            source: 'app',
            installed: true,
            agent_enabled: true,
          },
          {
            skill_id: 'user-skill',
            skill_key: 'user:user-skill',
            name: 'User Skill',
            source: 'user',
            installed: true,
            agent_enabled: true,
          },
          ...Array.from({ length: 3 }, (_, index) => ({
            skill_id: `backend-builtin-${index}`,
            skill_key: `platform:test/backend-builtin-${index}`,
            name: `Backend Builtin ${index}`,
            source: 'platform',
            installed: true,
            agent_enabled: true,
          })),
        ],
      },
      agentSkills: [],
    })

    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 3_000 })

    expect((window as unknown as {
      tabtin: { skill: { list: ReturnType<typeof vi.fn> } }
    }).tabtin.skill.list).toHaveBeenCalledTimes(2)
    expect(result.current.data?.map(skill => skill.skill_key)).toEqual([
      'app:tabdata/table-association',
      'platform:tabtin-project/tabtin-project',
      ...Array.from({ length: 18 }, (_, index) => `platform:test/builtin-${index}`),
      'user:user-skill',
    ])
    // ：组织目录不回填携带态；本地元数据优先，不被后端瘦条目覆盖
    expect(result.current.data?.find(skill => skill.skill_key === 'app:tabdata/table-association')).toMatchObject({
      name: 'Table Association',
    })
  })

  it('keeps retrying local catalog warmup instead of surfacing the Skill list failure page', async () => {
    const localBundledSkills = Array.from({ length: 20 }, (_, index) => ({
      skill_id: `builtin-${index}`,
      skill_key: `platform:test/builtin-${index}`,
      name: `Builtin ${index}`,
      source: 'platform',
    }))
    ;(window as unknown as {
      tabtin: { skill: { list: ReturnType<typeof vi.fn> } }
    }).tabtin.skill.list
      .mockRejectedValueOnce(new Error('registry warming 1'))
      .mockRejectedValueOnce(new Error('registry warming 2'))
      .mockRejectedValueOnce(new Error('registry warming 3'))
      .mockRejectedValueOnce(new Error('registry warming 4'))
      .mockResolvedValueOnce({ skills: localBundledSkills })
    mockSkillsListHttp({
      visible: {
        skills: [
          ...Array.from({ length: 4 }, (_, index) => ({
            skill_id: `backend-builtin-${index}`,
            skill_key: `platform:test/backend-builtin-${index}`,
            name: `Backend Builtin ${index}`,
            source: 'platform',
            installed: true,
            agent_enabled: true,
          })),
        ],
      },
      agentSkills: [],
    })

    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 8_000 })
    expect((window as unknown as {
      tabtin: { skill: { list: ReturnType<typeof vi.fn> } }
    }).tabtin.skill.list).toHaveBeenCalledTimes(5)
    expect(result.current.isError).toBe(false)
    expect(result.current.data?.map(skill => skill.skill_key)).toEqual(
      localBundledSkills.map(skill => skill.skill_key),
    )
  }, 10_000)

  it('surfaces a real failure when local skill IPC is unavailable', async () => {
    ;(window as unknown as { tabtin?: unknown }).tabtin = {}
    mockSkillsListHttp({ visible: { skills: [] }, agentSkills: [] })

    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5_000 })
    expect(result.current.error).toMatchObject({
      name: 'LocalRuntimeSkillIpcUnavailableError',
    })
    // ：组织目录只打 visible；IPC 不可用 failureCount<3 → 共 4 次 HTTP
    expect(electronFetchMock).toHaveBeenCalledTimes(4)
  }, 7_000)

  it('#8698 loads org catalog when selectedAgent is null', async () => {
    mockSpaceStoreState.selectedAgent = null
    const { useSkillsListQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillsListQuery('space-1'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const visibleUrl = String(electronFetchMock.mock.calls[0]?.[0] ?? '')
    expect(visibleUrl).toContain('/skills/visible?')
    expect(visibleUrl).toContain('organization_id=wt-1')
    expect(visibleUrl).not.toContain('agent_id=')
    expect(result.current.data?.some(skill => skill.skill_key === 'platform:device/operations')).toBe(true)
  })

  it('#8706 explicit agentId loads carry; configs still require agent', async () => {
    electronFetchMock.mockImplementation((url: string) => {
      const href = String(url)
      if (href.includes('/skills/config?')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { configs: { 'user:a': { enabled: true } } } }),
        })
      }
      if (href.includes('/agents/') && href.includes('/skills')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { skills: [], total: 0 } }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { skills: [] } }),
      })
    })

    const { useSkillsListQuery, useSkillConfigsQuery } = await import('./skills')
    const listHook = renderHook(
      () => useSkillsListQuery('space-1', 'agent-from-session'),
      { wrapper: makeWrapper() },
    )
    const configHook = renderHook(
      () => useSkillConfigsQuery('space-1', 'agent-from-session'),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => expect(listHook.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(configHook.result.current.isSuccess).toBe(true))

    const urls = electronFetchMock.mock.calls.map(call => String(call[0] ?? ''))
    expect(urls.some(url => url.includes('/skills/visible?') && url.includes('agent_id=agent-from-session'))).toBe(true)
    expect(urls.some(url => url.includes('/agents/agent-from-session/skills'))).toBe(true)
    expect(urls.some(url => url.includes('/skills/config?') && url.includes('agent_id=agent-from-session'))).toBe(true)
    expect(urls.every(url => !url.includes('agent_id=agent-1') || url.includes('agent_id=agent-from-session'))).toBe(true)
  })
})

describe('useCreateSkillMutation Agent 携带集刷新', () => {
  beforeEach(() => {
    electronFetchMock.mockReset()
  })

  it('创建并启用成功后立即失效所有目标 Agent 的携带集缓存', async () => {
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          skill_id: 'skill-created',
          skill_key: 'user:created',
          name: 'Created',
          source: 'user',
          enabled_agent_ids: ['agent-default', 'agent-project'],
        },
      }),
    })
    const queryClient = makeQueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { useCreateSkillMutation, agentSkillKeys } = await import('./skills')
    const { result } = renderHook(() => useCreateSkillMutation(), {
      wrapper: makeWrapper(queryClient),
    })

    await act(async () => {
      await result.current.mutateAsync({
        organization_id: 'wt-1',
        name: 'Created',
        enable_agent_ids: ['agent-default', 'agent-project'],
      })
    })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: agentSkillKeys.list('agent-default') })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agentSkillKeys.list('agent-project') })
  })
})

describe('useSkillMarketQuery backend-owned filtering', () => {
  beforeEach(() => {
    electronFetchMock.mockReset()
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          skills: [
            {
              skill_id: 'legacy-app',
              skill_key: 'app:spacelayout/spacelayout-operator',
              name: 'Space Layout Operator',
              source: 'app',
            },
            {
              skill_id: 'briefing-to-slides',
              skill_key: 'app:briefing-skills/briefing-to-slides',
              name: '简报转演示稿',
              source: 'app',
              app_id: 'briefing-skills',
              distribution: 'marketplace',
            },
            {
              skill_id: 'legacy-platform',
              skill_key: 'platform:device/operations',
              name: 'Device Operations',
              source: 'platform',
            },
            {
              skill_id: 'public-user',
              skill_key: 'user:public-user',
              name: 'Public User Skill',
              source: 'user',
              package_id: 'pkg-1',
            },
            {
              skill_id: 'cowart-image-edit',
              skill_key: 'app:cowart/cowart-image-edit',
              name: 'Cowart Image Edit',
              source: 'app',
              app_id: 'cowart',
              distribution: 'marketplace',
            },
            {
              skill_id: 'plugin-user-skill',
              skill_key: 'user:plugin-user-skill',
              name: 'Plugin User Skill',
              source: 'user',
              meta: { personal_plugin_id: 'superpowers' },
            },
            {
              skill_id: 'local-device',
              skill_key: 'device:local-tool',
              name: 'Local Device Skill',
              source: 'device',
            },
          ],
        },
      }),
    })
  })

  it('keeps standalone app/package rows and filters runtime/plugin rows', async () => {
    const { useSkillMarketQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillMarketQuery({ search: '', category: 'all' }), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.map(skill => skill.skill_key)).toEqual([
      'app:briefing-skills/briefing-to-slides',
      'user:public-user',
    ])
  })
})

describe('usePublishSkillMutation Mine publish content', () => {
  beforeEach(() => {
    electronFetchMock.mockReset()
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { skill_id: 'skill-1', skill_key: 'user:demo' } }),
    })
  })

  it('sends the renderer-provided SKILL.md files with the publish request', async () => {
    const { usePublishSkillMutation } = await import('./skills')
    const { result } = renderHook(() => usePublishSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        skillId: 'skill-1',
        organization_id: 'wt-1',
        version_label: '0.1.0',
        visibility: 'public',
        change_note: 'Initial release',
        files: [
          {
            path: 'SKILL.md',
            content: '---\nname: Demo\nversion: 0.1.0\n---\n\n# Demo\n',
          },
        ],
      })
    })

    expect(electronFetchMock).toHaveBeenCalledWith(
      'http://localhost:6060/skills/skill-1/publish',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          organization_id: 'wt-1',
          version_label: '0.1.0',
          visibility: 'public',
          change_note: 'Initial release',
          files: [
            {
              path: 'SKILL.md',
              content: '---\nname: Demo\nversion: 0.1.0\n---\n\n# Demo\n',
            },
          ],
        }),
      }),
    )
  })
})

describe('useDisableSkillMutation (Wave 1)', () => {
  beforeEach(() => {
    electronFetchMock.mockReset()
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { skill_canonical_key: 'user:demo', enabled: false, found: true } }),
    })
  })

  afterEach(() => {
    delete (window as unknown as { tabtin?: unknown }).tabtin
    vi.restoreAllMocks()
  })

  it('sends POST /skills/{key}/disable with organization_id', async () => {
    const { useDisableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useDisableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        canonicalKey: 'user:demo',
        spaceId: 'space-1',
      })
    })

    expect(electronFetchMock).toHaveBeenCalledWith(
      'http://localhost:6060/skills/user%3Ademo/disable',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
      }),
    )
  })

  it('removes backend-owned package skills from the local Space sandbox on uninstall (removeLocal)', async () => {
    // disable 本身只停用、保留本地文件；只有 uninstall 路径（removeLocal:true）才删本地，
    // 避免误删 owner 已发布 skill 的本地工作副本。
    const uninstall = vi.fn().mockResolvedValue({})
    ;(window as unknown as {
      tabtin?: { skill?: { uninstall?: typeof uninstall } }
    }).tabtin = {
      skill: { uninstall },
    }

    const { useDisableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useDisableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        canonicalKey: 'user:demo',
        spaceId: 'space-1',
        removeLocal: true,
        skill: {
          skill_id: 'skill-1',
          skill_key: 'user:demo',
          name: 'Demo',
          source: 'user',
          package_id: 'pkg-1',
        },
      })
    })

    expect(uninstall).toHaveBeenCalledWith({
      skillKey: 'demo',
      spaceId: 'space-1',
      userId: 'user-1',
      organizationId: 'wt-1',
    })
  })

  it('forgets the acquisition when deleting an acquired skill from My Skills', async () => {
    const { useDisableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useDisableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        canonicalKey: 'user:demo',
        spaceId: 'space-1',
        removeLocal: true,
        forgetAcquisition: true,
      })
    })

    expect(electronFetchMock).toHaveBeenCalledWith(
      'http://localhost:6060/skills/user%3Ademo/disable',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          organization_id: 'wt-1',
          remove: true,
          forget_acquisition: true,
        }),
      }),
    )
  })

  it('keeps local files on a plain disable (no removeLocal)', async () => {
    // 纯停用：不传 removeLocal → 不动本地文件（owner 工作副本应保留）。
    const uninstall = vi.fn().mockResolvedValue({})
    ;(window as unknown as {
      tabtin?: { skill?: { uninstall?: typeof uninstall } }
    }).tabtin = {
      skill: { uninstall },
    }

    const { useDisableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useDisableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        canonicalKey: 'user:demo',
        spaceId: 'space-1',
        skill: {
          skill_id: 'skill-1',
          skill_key: 'user:demo',
          name: 'Demo',
          source: 'user',
          package_id: 'pkg-1',
        },
      })
    })

    expect(uninstall).not.toHaveBeenCalled()
  })

  it('does not remove local runtime skills from the package sandbox even with removeLocal', async () => {
    const uninstall = vi.fn().mockResolvedValue({})
    ;(window as unknown as {
      tabtin?: { skill?: { uninstall?: typeof uninstall } }
    }).tabtin = {
      skill: { uninstall },
    }

    const { useDisableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useDisableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        canonicalKey: 'platform:device/operations',
        spaceId: 'space-1',
        removeLocal: true,
        skill: {
          skill_id: 'device-operations',
          skill_key: 'platform:device/operations',
          name: 'Device Operations',
          source: 'platform',
          package_id: 'pkg-should-not-matter',
        },
      })
    })

    expect(uninstall).not.toHaveBeenCalled()
  })
})

describe('useEnableSkillMutation (Wave 1)', () => {
  beforeEach(() => {
    electronFetchMock.mockReset()
    mockSpaceStoreState.spaces = [{ id: 'space-1', organization_id: 'wt-1' }]
    mockSpaceStoreState.selectedAgent = { id: 'agent-1', is_default: true }
    mockSpaceStoreState.agentCache = {}
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          skill_canonical_key: 'user:demo',
          enabled: true,
          installed_version_seq: 1,
          install_content_hash: 'abc',
        },
      }),
    })
  })

  afterEach(() => {
    delete (window as unknown as { tabtin?: unknown }).tabtin
    vi.restoreAllMocks()
  })

  it('sends POST /skills/{key}/enable with organization_id', async () => {
    const { useEnableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useEnableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        canonicalKey: 'user:demo',
        spaceId: 'space-1',
      })
    })

    expect(electronFetchMock).toHaveBeenCalledWith(
      'http://localhost:6060/skills/user%3Ademo/enable',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('requests an owned copy for organization skills and returns the new identity', async () => {
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          skill_canonical_key: 'user:demo-copy',
          enabled: true,
          skill: {
            skill_id: 'copy-1',
            skill_key: 'user:demo-copy',
            name: 'Demo',
            source: 'user',
            visibility: 'private',
            owner_user_id: 'user-1',
          },
        },
      }),
    })
    const { useEnableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useEnableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    let response: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined
    await act(async () => {
      response = await result.current.mutateAsync({
        canonicalKey: 'user:demo',
        spaceId: 'space-1',
        skill: {
          skill_id: 'organization-snapshot-1',
          skill_key: 'user:demo',
          name: 'Demo',
          source: 'user',
          visibility: 'organization',
        },
      })
    })

    const request = electronFetchMock.mock.calls[0]?.[1] as { body?: string }
    expect(JSON.parse(request.body || '{}')).toEqual(expect.objectContaining({
      organization_id: 'wt-1',
      source_skill_id: 'organization-snapshot-1',
      acquire_as_copy: true,
    }))
    expect(response?.skill_canonical_key).toBe('user:demo-copy')
    expect(response?.skill?.skill_id).toBe('copy-1')
  })

  it('optimistically flips list.enabled and configs before enable network settles', async () => {
    let resolveEnable!: (value: unknown) => void
    electronFetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/skills/user%3Ademo/enable')) {
        return new Promise((resolve) => {
          resolveEnable = resolve
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const queryClient = makeQueryClient()
    const { skillKeys, useEnableSkillMutation } = await import('./skills')
    queryClient.setQueryData(skillKeys.configs('wt-1'), {
      'user:demo': { enabled: false },
    })
    queryClient.setQueryData(skillKeys.list('wt-1', 'agent-1'), [
      {
        skill_id: 'skill-1',
        skill_key: 'user:demo',
        name: 'Demo',
        version: '1.0.0',
        source: 'user',
        enabled: false,
        installed: false,
        acquired: false,
        agent_enabled: false,
      },
    ])

    const { result } = renderHook(() => useEnableSkillMutation(), {
      wrapper: makeWrapper(queryClient),
    })

    let mutatePromise!: Promise<unknown>
    act(() => {
      mutatePromise = result.current.mutateAsync({
        canonicalKey: 'user:demo',
        spaceId: 'space-1',
      })
    })

    await waitFor(() => {
      expect(queryClient.getQueryData(skillKeys.configs('wt-1'))).toEqual({
        'user:demo': { enabled: true },
      })
      expect(queryClient.getQueryData(skillKeys.list('wt-1', 'agent-1'))).toEqual([
        expect.objectContaining({
          skill_key: 'user:demo',
          enabled: true,
          acquired: true,
          // 仅获取：不得把 Agent 携带态一并乐观打开
          installed: false,
          agent_enabled: false,
        }),
      ])
    })

    resolveEnable({
      ok: true,
      json: () => Promise.resolve({
        data: {
          skill_canonical_key: 'user:demo',
          enabled: true,
          installed_version_seq: 1,
        },
      }),
    })
    await act(async () => {
      await mutatePromise
    })
  })

  it('optimistically marks installed only when enable also targets an agent', async () => {
    let resolveEnable!: (value: unknown) => void
    electronFetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/skills/user%3Ademo/enable')) {
        return new Promise((resolve) => {
          resolveEnable = resolve
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const queryClient = makeQueryClient()
    const { skillKeys, useEnableSkillMutation } = await import('./skills')
    queryClient.setQueryData(skillKeys.list('wt-1', 'agent-1'), [
      {
        skill_id: 'skill-1',
        skill_key: 'user:demo',
        name: 'Demo',
        version: '1.0.0',
        source: 'user',
        enabled: false,
        installed: false,
        acquired: false,
        agent_enabled: false,
      },
    ])

    const { result } = renderHook(() => useEnableSkillMutation(), {
      wrapper: makeWrapper(queryClient),
    })

    let mutatePromise!: Promise<unknown>
    act(() => {
      mutatePromise = result.current.mutateAsync({
        canonicalKey: 'user:demo',
        spaceId: 'space-1',
        agentId: 'agent-1',
      })
    })

    await waitFor(() => {
      expect(queryClient.getQueryData(skillKeys.list('wt-1', 'agent-1'))).toEqual([
        expect.objectContaining({
          skill_key: 'user:demo',
          enabled: true,
          acquired: true,
          installed: true,
          agent_enabled: true,
        }),
      ])
    })

    resolveEnable({
      ok: true,
      json: () => Promise.resolve({
        data: {
          skill_canonical_key: 'user:demo',
          enabled: true,
        },
      }),
    })
    await act(async () => {
      await mutatePromise
    })
  })

  it('rolls back optimistic enable caches when enable request fails', async () => {
    electronFetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.resolve({ message: 'boom' }),
    })

    const queryClient = makeQueryClient()
    const { skillKeys, useEnableSkillMutation } = await import('./skills')
    const previousConfigs = { 'user:demo': { enabled: false } }
    const previousList = [
      {
        skill_id: 'skill-1',
        skill_key: 'user:demo',
        name: 'Demo',
        version: '1.0.0',
        source: 'user',
        enabled: false,
        installed: true,
      },
    ]
    queryClient.setQueryData(skillKeys.configs('wt-1'), previousConfigs)
    queryClient.setQueryData(skillKeys.list('wt-1', 'agent-1'), previousList)

    const { result } = renderHook(() => useEnableSkillMutation(), {
      wrapper: makeWrapper(queryClient),
    })

    await act(async () => {
      await expect(result.current.mutateAsync({
        canonicalKey: 'user:demo',
        spaceId: 'space-1',
      })).rejects.toThrow()
    })

    expect(queryClient.getQueryData(skillKeys.configs('wt-1'))).toEqual(previousConfigs)
    expect(queryClient.getQueryData(skillKeys.list('wt-1', 'agent-1'))).toEqual(previousList)
  })

  it('materializes backend-owned package skills into the local Space sandbox after enable', async () => {
    const install = vi.fn().mockResolvedValue({ filesWritten: 2 })
    ;(window as unknown as {
      tabtin?: { skill?: { install?: typeof install } }
    }).tabtin = {
      skill: { install },
    }
    electronFetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/skills/user%3Ademo/enable')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              skill_canonical_key: 'user:demo',
              enabled: true,
              installed_version_seq: 3,
              install_content_hash: 'bundle-hash',
            },
          }),
        })
      }
      if (url.endsWith('/services/package-registry/packages/pkg-1/versions/3/files')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              version_seq: 3,
              version_label: '1.0.0',
              bundle_sha256: 'bundle-hash',
              files: [
                {
                  path: 'SKILL.md',
                  sha256: 'a'.repeat(64),
                  size: 12,
                  download_url: 'https://example.test/skill',
                  content_type: 'text/markdown',
                },
              ],
            },
          }),
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { useEnableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useEnableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        canonicalKey: 'user:demo',
        spaceId: 'space-1',
        skill: {
          skill_id: 'skill-1',
          skill_key: 'user:demo',
          name: 'Demo',
          version: '1.0.0',
          source: 'user',
          package_id: 'pkg-1',
          latest_approved_version_seq: 8,
          latest_version_seq: 9,
        },
      })
    })

    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      skillKey: 'demo',
      spaceId: 'space-1',
      userId: 'user-1',
      organizationId: 'wt-1',
      files: [
        expect.objectContaining({
          path: 'SKILL.md',
          download_url: 'https://example.test/skill',
        }),
      ],
      meta: expect.objectContaining({
        source: 'user',
        slug: 'demo',
        canonicalKey: 'user:demo',
        version: '1.0.0',
        packageId: 'pkg-1',
        versionSeq: 3,
        bundleSha256: 'bundle-hash',
      }),
    }))
    expect(electronFetchMock).toHaveBeenCalledWith(
      'http://localhost:6060/services/package-registry/packages/pkg-1/versions/3/files',
      expect.anything(),
    )
  })

  it('skips registry install when local SKILL.md already has real imported content', async () => {
    const install = vi.fn().mockResolvedValue({ filesWritten: 2 })
    const readContent = vi.fn().mockResolvedValue({
      content: `---
name: algorithmic-art
description: Creating algorithmic art using p5.js
---

# Algorithmic Art

Use seeded randomness. Do not copy existing artists.
`,
    })
    ;(window as unknown as {
      tabtin?: { skill?: { install?: typeof install; readContent?: typeof readContent } }
    }).tabtin = {
      skill: { install, readContent },
    }
    electronFetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/skills/user%3Aalgorithmic-art/enable')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              skill_canonical_key: 'user:algorithmic-art',
              enabled: true,
              installed_version_seq: 1,
              install_content_hash: 'skeleton-hash',
            },
          }),
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { useEnableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useEnableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        canonicalKey: 'user:algorithmic-art',
        spaceId: 'space-1',
        skill: {
          skill_id: 'skill-art',
          skill_key: 'user:algorithmic-art',
          name: 'algorithmic-art',
          version: '0.0.1',
          source: 'user',
          package_id: 'pkg-skeleton',
          latest_version_seq: 1,
        },
      })
    })

    expect(readContent).toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })

  // ：本地已有 SKILL.md（含骨架）即跳过 Registry，避免 OSS 404 阻断启用
  it('skips registry install when local content is only the empty skeleton', async () => {
    const install = vi.fn().mockResolvedValue({ filesWritten: 1 })
    const readContent = vi.fn().mockResolvedValue({
      content: `---
name: demo
description: "demo"
metadata:
  tabtin:
    displayName: "demo"
---

# demo

## 什么时候用这个 Skill

<!-- tip -->

## 步骤

1. ...

## 注意事项

- ...
`,
    })
    ;(window as unknown as {
      tabtin?: { skill?: { install?: typeof install; readContent?: typeof readContent } }
    }).tabtin = {
      skill: { install, readContent },
    }
    electronFetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/skills/user%3Ademo/enable')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              skill_canonical_key: 'user:demo',
              enabled: true,
              installed_version_seq: 3,
            },
          }),
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { useEnableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useEnableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        canonicalKey: 'user:demo',
        spaceId: 'space-1',
        skill: {
          skill_id: 'skill-1',
          skill_key: 'user:demo',
          name: 'Demo',
          version: '1.0.0',
          source: 'user',
          package_id: 'pkg-1',
          latest_version_seq: 3,
        },
      })
    })

    expect(readContent).toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })

  it('materializes marketplace app skills locally after enable ( app 子案)', async () => {
    // 商店安装闭环：app 来源技能 enable 后走 materializeApp 落本地盘（不是 install，
    // 那是 Package Registry 下载路径）。appId/slug 从 app:<appId>/<slug> 解析。
    const install = vi.fn().mockResolvedValue({ filesWritten: 1 })
    const materializeApp = vi.fn().mockResolvedValue({ installed: 1, skipped: 0 })
    ;(window as unknown as {
      tabtin?: { skill?: { install?: typeof install; materializeApp?: typeof materializeApp } }
    }).tabtin = {
      skill: { install, materializeApp },
    }

    const { useEnableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useEnableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        canonicalKey: 'app:tabdoc/operator',
        spaceId: 'space-1',
        skill: {
          skill_id: 'operator',
          skill_key: 'app:tabdoc/operator',
          name: 'TabDoc Operator',
          source: 'app',
          app_id: 'tabdoc',
        },
      })
    })

    expect(install).not.toHaveBeenCalled()
    expect(materializeApp).toHaveBeenCalledWith({
      spaceId: 'space-1',
      organizationId: 'wt-1',
      userId: 'user-1',
      appId: 'tabdoc',
      slug: 'operator',
    })
  })

  // ：本机 app 物化失败不再回滚后端总闸（组织级 enablement 是权威）。
  it('keeps backend enable gate on when local app materialization fails', async () => {
    const materializeApp = vi.fn().mockRejectedValue(new Error('copy failed'))
    ;(window as unknown as {
      tabtin?: { skill?: { materializeApp?: typeof materializeApp } }
    }).tabtin = {
      skill: { materializeApp },
    }
    electronFetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/skills/app%3Atabdoc%2Foperator/enable')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: { skill_canonical_key: 'app:tabdoc/operator', enabled: true },
          }),
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { useEnableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useEnableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    const outcome = await result.current.mutateAsync({
      canonicalKey: 'app:tabdoc/operator',
      spaceId: 'space-1',
      skill: {
        skill_id: 'operator',
        skill_key: 'app:tabdoc/operator',
        name: 'TabDoc Operator',
        source: 'app',
        app_id: 'tabdoc',
      },
    })
    expect(outcome).toMatchObject({ enabled: true, local_install: 'failed' })
    // 不能有 disable 兜底请求（回滚已废除）。
    expect(electronFetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/skills/app%3Atabdoc%2Foperator/disable'),
      expect.anything(),
    )
  })

  // ：本机 Registry 装包失败不再回滚后端总闸；返回 local_install: 'failed' 让 UI 感知。
  it('keeps backend enable gate on when local package materialization fails', async () => {
    const install = vi.fn().mockRejectedValue(new Error('disk full'))
    ;(window as unknown as {
      tabtin?: { skill?: { install?: typeof install } }
    }).tabtin = {
      skill: { install },
    }
    electronFetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/skills/user%3Ademo/enable')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              skill_canonical_key: 'user:demo',
              enabled: true,
              installed_version_seq: 3,
            },
          }),
        })
      }
      if (url.endsWith('/services/package-registry/packages/pkg-1/versions/3/files')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              version_seq: 3,
              files: [
                {
                  path: 'SKILL.md',
                  sha256: 'a'.repeat(64),
                  size: 12,
                  download_url: 'https://example.test/skill',
                  content_type: 'text/markdown',
                },
              ],
            },
          }),
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { useEnableSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useEnableSkillMutation(), {
      wrapper: makeWrapper(),
    })

    const outcome = await result.current.mutateAsync({
      canonicalKey: 'user:demo',
      spaceId: 'space-1',
      skill: {
        skill_id: 'skill-1',
        skill_key: 'user:demo',
        name: 'Demo',
        version: '1.0.0',
        source: 'user',
        package_id: 'pkg-1',
      },
    })
    expect(outcome).toMatchObject({ enabled: true, local_install: 'failed' })
    expect(electronFetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/skills/user%3Ademo/disable'),
      expect.anything(),
    )
  })
})

describe('useUpgradeSkillMutation local materialization', () => {
  beforeEach(() => {
    electronFetchMock.mockReset()
  })

  afterEach(() => {
    delete (window as unknown as { tabtin?: unknown }).tabtin
    vi.restoreAllMocks()
  })

  it('updates the local Space sandbox when backend upgrade accepts the new package version', async () => {
    const install = vi.fn().mockResolvedValue({ filesWritten: 1 })
    ;(window as unknown as {
      tabtin?: { skill?: { install?: typeof install } }
    }).tabtin = {
      skill: { install },
    }
    electronFetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/skills/skill-1/upgrade')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              status: 'upgraded',
              installed_version_seq: 4,
            },
          }),
        })
      }
      if (url.endsWith('/services/package-registry/packages/pkg-1/versions/4/files')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              version_seq: 4,
              version_label: '1.1.0',
              bundle_sha256: 'new-hash',
              files: [
                {
                  path: 'SKILL.md',
                  sha256: 'b'.repeat(64),
                  size: 34,
                  download_url: 'https://example.test/skill-new',
                  content_type: 'text/markdown',
                },
              ],
            },
          }),
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { useUpgradeSkillMutation } = await import('./skills')
    const { result } = renderHook(() => useUpgradeSkillMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        skillId: 'skill-1',
        spaceId: 'space-1',
        organization_id: 'wt-1',
        agent_id: 'agent-1',
        skill: {
          skill_id: 'skill-1',
          skill_key: 'user:demo',
          name: 'Demo',
          version: '1.0.0',
          source: 'user',
          package_id: 'pkg-1',
        },
      })
    })

    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      skillKey: 'demo',
      spaceId: 'space-1',
      userId: 'user-1',
      organizationId: 'wt-1',
      meta: expect.objectContaining({
        slug: 'demo',
        canonicalKey: 'user:demo',
        version: '1.1.0',
        versionSeq: 4,
        bundleSha256: 'new-hash',
      }),
    }))
  })

  it.each(['conflict', 'kept_local', 'forked'] as const)(
    'does not overwrite local bundle when upgrade returns %s',
    async (status) => {
      const install = vi.fn().mockResolvedValue({ filesWritten: 1 })
      ;(window as unknown as {
        tabtin?: { skill?: { install?: typeof install } }
      }).tabtin = {
        skill: { install },
      }
      electronFetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            status,
            installed_version_seq: 4,
            latest_version_seq: 5,
          },
        }),
      })

      const { useUpgradeSkillMutation } = await import('./skills')
      const { result } = renderHook(() => useUpgradeSkillMutation(), {
        wrapper: makeWrapper(),
      })

      await act(async () => {
        await result.current.mutateAsync({
          skillId: 'skill-1',
          spaceId: 'space-1',
          organization_id: 'wt-1',
          agent_id: 'agent-1',
          skill: {
            skill_id: 'skill-1',
            skill_key: 'user:demo',
            name: 'Demo',
            source: 'user',
            package_id: 'pkg-1',
          },
        })
      })

      expect(install).not.toHaveBeenCalled()
    },
  )

  it('updates skill category through PATCH and sends organization id', async () => {
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          skill_id: 'skill-1',
          skill_key: 'user:demo',
          name: 'Demo',
          source: 'user',
          category: 'finance',
        },
      }),
    })

    const { useUpdateSkillCategoryMutation } = await import('./skills')
    const { result } = renderHook(() => useUpdateSkillCategoryMutation(), {
      wrapper: makeWrapper(),
    })

    await act(async () => {
      await result.current.mutateAsync({
        skillId: 'skill-1',
        spaceId: 'space-1',
        category: 'finance',
      })
    })

    expect(electronFetchMock).toHaveBeenCalledWith(
      'http://localhost:6060/skills/skill-1/category',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ organization_id: 'wt-1', category: 'finance' }),
      }),
    )
  })

  it('rejects skill category update when organization id cannot be resolved', async () => {
    mockSpaceStoreState.spaces = []
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
    })

    const { useUpdateSkillCategoryMutation } = await import('./skills')
    const { result } = renderHook(() => useUpdateSkillCategoryMutation(), {
      wrapper: makeWrapper(),
    })

    await expect(result.current.mutateAsync({
      skillId: 'skill-1',
      spaceId: 'space-1',
      category: 'finance',
    })).rejects.toThrow('organizationId not resolved for space')

    expect(electronFetchMock).not.toHaveBeenCalled()
  })
})

describe('concurrent skill toggles in the same space (regression for  review)', () => {
  beforeEach(() => {
    mockSpaceStoreState.spaces = [{ id: 'space-1', organization_id: 'wt-1' }]
  })

  // 复现 review 指出的并发 bug：第一个切换请求失败时，onError/onSettled 不能把同 space
  // 其它仍在 pending 的切换乐观态抹掉。修复后仅回滚本条目，且 refetch 推迟到该 space
  // 所有在途切换都 settle 之后。
  function deferred<T = unknown>() {
    let resolveFn!: (value: T) => void
    let rejectFn!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolveFn = res
      rejectFn = rej
    })
    return { promise, resolve: resolveFn, reject: rejectFn }
  }

  it('does not clobber a still-pending second toggle when the first fails', async () => {
    const aDisable = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
    const bDisable = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
    electronFetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/skills/user%3Aa/disable')) return aDisable.promise
      if (url.endsWith('/skills/user%3Ab/disable')) return bDisable.promise
      // 收尾时 B settle 触发的 list/configs refetch 走默认成功，避免测试报错。
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { skills: [] } }) })
    })

    const queryClient = makeQueryClient()
    const { skillKeys, useDisableSkillMutation } = await import('./skills')
    const configKey = skillKeys.configs('wt-1')
    const listKey = skillKeys.list('wt-1')
    queryClient.setQueryData(configKey, {
      'user:a': { enabled: true },
      'user:b': { enabled: true },
    })
    queryClient.setQueryData(listKey, [
      { skill_id: 'a', skill_key: 'user:a', name: 'A', source: 'user', enabled: true },
      { skill_id: 'b', skill_key: 'user:b', name: 'B', source: 'user', enabled: true },
    ])

    const aHook = renderHook(() => useDisableSkillMutation(), { wrapper: makeWrapper(queryClient) })
    const bHook = renderHook(() => useDisableSkillMutation(), { wrapper: makeWrapper(queryClient) })

    // 先发 A、后发 B，两者都进入乐观态（都 disabled）。
    let aPromise: Promise<unknown>
    let bPromise: Promise<unknown>
    act(() => {
      aPromise = aHook.result.current
        .mutateAsync({ canonicalKey: 'user:a', spaceId: 'space-1' })
        .catch(() => undefined)
      bPromise = bHook.result.current.mutateAsync({ canonicalKey: 'user:b', spaceId: 'space-1' })
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as
        | Record<string, { enabled: boolean }>
        | undefined
      expect(cfg?.['user:a']?.enabled).toBe(false)
      expect(cfg?.['user:b']?.enabled).toBe(false)
    })

    // 先发 A 失败：仅回滚 A 本条目，B 的乐观态必须保留。
    act(() => {
      aDisable.reject(new Error('first toggle failed'))
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as
        | Record<string, { enabled: boolean }>
        | undefined
      expect(cfg?.['user:a']?.enabled).toBe(true) // A 已回滚
      expect(cfg?.['user:b']?.enabled).toBe(false) // B 未被覆盖
      const list = queryClient.getQueryData(listKey) as
        | Array<{ skill_key: string; enabled: boolean }>
        | undefined
      expect(list?.find((s) => s.skill_key === 'user:a')?.enabled).toBe(true)
      expect(list?.find((s) => s.skill_key === 'user:b')?.enabled).toBe(false)
    })

    // 收尾：让 B 成功 settle。B 的 onSettled 会触发 endSpaceToggle('space-1')，
    // 计数归零并 invalidate。注意：本测试只 setQueryData 注入了 list/configs，没有组件
    // 订阅这两个 query，所以 invalidate 不会触发真实 refetch（react-query 只为有观察者的
    // query 重新拉取）——这里只需确认 B settle 后协调计数归零（无泄漏）即可。
    act(() => {
      bDisable.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ data: { skill_canonical_key: 'user:b', enabled: false, found: true } }),
      })
    })
    await act(async () => {
      await bPromise
    })
    // B 已成功 settle：configs 中 B 仍为 disabled（乐观态 + 服务端确认），A 仍为 enabled。
    const finalCfg = queryClient.getQueryData(configKey) as
      | Record<string, { enabled: boolean }>
      | undefined
    expect(finalCfg?.['user:a']?.enabled).toBe(true)
    expect(finalCfg?.['user:b']?.enabled).toBe(false)
  })

  // 同 key 相反操作乱序落库的 race（ 第二轮 review）。下面四个用例覆盖：
  //  - 先 enable 后 disable，串行保证 disable 不会在 enable 落库前发出，最终态 = 用户最后操作；
  //  - 两者都失败时不把中间态（enable 的乐观 enabled:true）写回；
  //  - enable 成功、disable 失败 → 保留 enable 的成功态；
  //  - enable 失败、disable 成功 → 最终 disabled。
  function sameKeyMocks() {
    const enableReq = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
    const disableReq = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
    electronFetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/skills/user%3Ax/enable')) return enableReq.promise
      if (url.endsWith('/skills/user%3Ax/disable')) return disableReq.promise
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { skills: [] } }) })
    })
    return { enableReq, disableReq }
  }

  function seedSameKey(
    queryClient: ReturnType<typeof makeQueryClient>,
    configKey: readonly unknown[],
    listKey: readonly unknown[],
  ) {
    queryClient.setQueryData(configKey, { 'user:x': { enabled: false } })
    queryClient.setQueryData(listKey, [
      { skill_id: 'x', skill_key: 'user:x', name: 'X', source: 'user', enabled: false },
    ])
  }

  it('serializes opposite toggles on the same key so the last action wins', async () => {
    const { enableReq, disableReq } = sameKeyMocks()
    const queryClient = makeQueryClient()
    const { skillKeys, useEnableSkillMutation, useDisableSkillMutation } = await import('./skills')
    const configKey = skillKeys.configs('wt-1')
    const listKey = skillKeys.list('wt-1')
    seedSameKey(queryClient, configKey, listKey)

    const enableHook = renderHook(() => useEnableSkillMutation(), { wrapper: makeWrapper(queryClient) })
    const disableHook = renderHook(() => useDisableSkillMutation(), { wrapper: makeWrapper(queryClient) })

    // 先 enable 后 disable（同 key）。enable 立即乐观翻 enabled；disable 被串行排队。
    act(() => {
      void enableHook.result.current.mutateAsync({ canonicalKey: 'user:x', spaceId: 'space-1' }).catch(() => undefined)
      void disableHook.result.current.mutateAsync({ canonicalKey: 'user:x', spaceId: 'space-1' }).catch(() => undefined)
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as Record<string, { enabled: boolean }> | undefined
      expect(cfg?.['user:x']?.enabled).toBe(true)
    })
    // disable 的请求在 enable 落库前不应发出（串行保证，杜绝乱序落库）。
    expect(electronFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/skills/user%3Ax/enable'),
      expect.anything(),
    )
    expect(electronFetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/skills/user%3Ax/disable'),
      expect.anything(),
    )

    // enable 落库成功 → disable 才被放行（乐观翻回 disabled，请求发出）。
    act(() => {
      enableReq.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { skill_canonical_key: 'user:x', enabled: true, found: true } }),
      })
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as Record<string, { enabled: boolean }> | undefined
      expect(cfg?.['user:x']?.enabled).toBe(false)
      expect(electronFetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/skills/user%3Ax/disable'),
        expect.anything(),
      )
    })

    // disable 落库成功 → 最终态 disabled，即用户最后一次操作（而非被 enable 的乱序写覆盖）。
    act(() => {
      disableReq.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { skill_canonical_key: 'user:x', enabled: false, found: true } }),
      })
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as Record<string, { enabled: boolean }> | undefined
      expect(cfg?.['user:x']?.enabled).toBe(false)
    })
  })

  it('does not restore a stale intermediate snapshot when same-key toggles both fail', async () => {
    const { enableReq, disableReq } = sameKeyMocks()
    const queryClient = makeQueryClient()
    const { skillKeys, useEnableSkillMutation, useDisableSkillMutation } = await import('./skills')
    const configKey = skillKeys.configs('wt-1')
    const listKey = skillKeys.list('wt-1')
    seedSameKey(queryClient, configKey, listKey)

    const enableHook = renderHook(() => useEnableSkillMutation(), { wrapper: makeWrapper(queryClient) })
    const disableHook = renderHook(() => useDisableSkillMutation(), { wrapper: makeWrapper(queryClient) })

    act(() => {
      void enableHook.result.current.mutateAsync({ canonicalKey: 'user:x', spaceId: 'space-1' }).catch(() => undefined)
      void disableHook.result.current.mutateAsync({ canonicalKey: 'user:x', spaceId: 'space-1' }).catch(() => undefined)
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as Record<string, { enabled: boolean }> | undefined
      expect(cfg?.['user:x']?.enabled).toBe(true)
    })

    // enable 失败 → 回滚到初始 disabled；disable 随后被放行。
    act(() => {
      enableReq.reject(new Error('enable failed'))
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as Record<string, { enabled: boolean }> | undefined
      expect(cfg?.['user:x']?.enabled).toBe(false)
    })
    await waitFor(() => {
      expect(electronFetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/skills/user%3Ax/disable'),
        expect.anything(),
      )
    })

    // disable 进入在途（乐观 disabled）后也失败 → 应回到初始 disabled，而非 enable 留下的
    // 中间态 enabled:true。
    act(() => {
      disableReq.reject(new Error('disable failed'))
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as Record<string, { enabled: boolean }> | undefined
      expect(cfg?.['user:x']?.enabled).toBe(false)
    })
  })

  it('keeps the prior successful toggle when the last opposite toggle fails', async () => {
    const { enableReq, disableReq } = sameKeyMocks()
    const queryClient = makeQueryClient()
    const { skillKeys, useEnableSkillMutation, useDisableSkillMutation } = await import('./skills')
    const configKey = skillKeys.configs('wt-1')
    const listKey = skillKeys.list('wt-1')
    seedSameKey(queryClient, configKey, listKey)

    const enableHook = renderHook(() => useEnableSkillMutation(), { wrapper: makeWrapper(queryClient) })
    const disableHook = renderHook(() => useDisableSkillMutation(), { wrapper: makeWrapper(queryClient) })

    act(() => {
      void enableHook.result.current.mutateAsync({ canonicalKey: 'user:x', spaceId: 'space-1' }).catch(() => undefined)
      void disableHook.result.current.mutateAsync({ canonicalKey: 'user:x', spaceId: 'space-1' }).catch(() => undefined)
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as Record<string, { enabled: boolean }> | undefined
      expect(cfg?.['user:x']?.enabled).toBe(true)
    })

    // enable 成功 → 乐观态确认 enabled。
    act(() => {
      enableReq.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { skill_canonical_key: 'user:x', enabled: true, found: true } }),
      })
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as Record<string, { enabled: boolean }> | undefined
      expect(cfg?.['user:x']?.enabled).toBe(false) // disable 已乐观翻 disabled
    })

    // disable 失败 → 回滚到 enable 成功后的 enabled，而非初始 disabled。
    act(() => {
      disableReq.reject(new Error('disable failed'))
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as Record<string, { enabled: boolean }> | undefined
      expect(cfg?.['user:x']?.enabled).toBe(true)
    })
  })

  it('ends disabled when the first toggle fails and the second succeeds', async () => {
    const { enableReq, disableReq } = sameKeyMocks()
    const queryClient = makeQueryClient()
    const { skillKeys, useEnableSkillMutation, useDisableSkillMutation } = await import('./skills')
    const configKey = skillKeys.configs('wt-1')
    const listKey = skillKeys.list('wt-1')
    seedSameKey(queryClient, configKey, listKey)

    const enableHook = renderHook(() => useEnableSkillMutation(), { wrapper: makeWrapper(queryClient) })
    const disableHook = renderHook(() => useDisableSkillMutation(), { wrapper: makeWrapper(queryClient) })

    act(() => {
      void enableHook.result.current.mutateAsync({ canonicalKey: 'user:x', spaceId: 'space-1' }).catch(() => undefined)
      void disableHook.result.current.mutateAsync({ canonicalKey: 'user:x', spaceId: 'space-1' }).catch(() => undefined)
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as Record<string, { enabled: boolean }> | undefined
      expect(cfg?.['user:x']?.enabled).toBe(true)
    })

    act(() => {
      enableReq.reject(new Error('enable failed'))
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as Record<string, { enabled: boolean }> | undefined
      expect(cfg?.['user:x']?.enabled).toBe(false)
    })
    await waitFor(() => {
      expect(electronFetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/skills/user%3Ax/disable'),
        expect.anything(),
      )
    })

    // disable 成功 → 最终 disabled（用户最后操作 disable，且 enable 失败不影响最终态）。
    act(() => {
      disableReq.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { skill_canonical_key: 'user:x', enabled: false, found: true } }),
      })
    })
    await waitFor(() => {
      const cfg = queryClient.getQueryData(configKey) as Record<string, { enabled: boolean }> | undefined
      expect(cfg?.['user:x']?.enabled).toBe(false)
    })
  })
})

describe('ensureSkillMaterializedLocally ', () => {
  beforeEach(() => {
    electronFetchMock.mockReset()
    mockSpaceStoreState.spaces = [{ id: 'space-1', organization_id: 'wt-1' }]
    mockSpaceStoreState.selectedAgent = { id: 'agent-1', is_default: true }
    mockSpaceStoreState.agentCache = {}
    ;(window as unknown as { tabtin?: unknown }).tabtin = undefined
  })

  it('returns exists when local SKILL.md is already present', async () => {
    const readContent = vi.fn().mockResolvedValue({
      content: `---
name: probe
description: "probe"
---

# probe
`,
    })
    const install = vi.fn()
    const writeContent = vi.fn()
    ;(window as unknown as {
      tabtin?: { skill?: Record<string, unknown> }
    }).tabtin = {
      skill: { readContent, install, writeContent },
    }

    const { ensureSkillMaterializedLocally } = await import('./skills')
    const outcome = await ensureSkillMaterializedLocally({
      spaceId: 'space-1',
      skill: {
        skill_id: 'probe',
        skill_key: 'user:probe',
        name: 'probe',
        source: 'user',
        package_id: 'pkg-1',
        latest_version_seq: 1,
      },
    })

    expect(outcome).toBe('exists')
    expect(install).not.toHaveBeenCalled()
    expect(writeContent).not.toHaveBeenCalled()
  })

  it('installs package skills from registry when local file is missing', async () => {
    const readContent = vi.fn().mockResolvedValue({ content: '' })
    const install = vi.fn().mockResolvedValue({ filesWritten: 1 })
    ;(window as unknown as {
      tabtin?: { skill?: Record<string, unknown> }
    }).tabtin = {
      skill: { readContent, install },
    }
    electronFetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/services/package-registry/packages/pkg-1/versions/2/files')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              version_seq: 2,
              version_label: '0.0.2',
              bundle_sha256: 'bundle-hash',
              files: [{
                path: 'SKILL.md',
                sha256: 'a'.repeat(64),
                size: 12,
                download_url: 'https://example.test/s',
                content_type: 'text/markdown',
              }],
            },
          }),
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const { ensureSkillMaterializedLocally } = await import('./skills')
    const outcome = await ensureSkillMaterializedLocally({
      spaceId: 'space-1',
      skill: {
        skill_id: 'probe',
        skill_key: 'user:probe',
        name: 'probe',
        source: 'user',
        package_id: 'pkg-1',
        latest_version_seq: 2,
      },
    })

    expect(outcome).toBe('installed')
    expect(install).toHaveBeenCalled()
  })

  it('writes a skeleton for user skills without package when local file is missing', async () => {
    const readContent = vi.fn().mockResolvedValue({ content: '' })
    const writeContent = vi.fn().mockResolvedValue({
      mdPath: '/tmp/SKILL.md',
      skillDir: '/tmp/probe',
    })
    ;(window as unknown as {
      tabtin?: { skill?: Record<string, unknown> }
    }).tabtin = {
      skill: { readContent, writeContent },
    }

    const { ensureSkillMaterializedLocally } = await import('./skills')
    const outcome = await ensureSkillMaterializedLocally({
      spaceId: 'space-1',
      skill: {
        skill_id: 'probe',
        skill_key: 'user:probe',
        name: 'Probe Skill',
        description: 'for slash invoke',
        source: 'user',
      },
    })

    expect(outcome).toBe('skeleton')
    expect(writeContent).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: 'space-1',
      organizationId: 'wt-1',
      skillKey: 'user:probe',
      content: expect.stringContaining('name: probe'),
    }))
  })

  it('accepts explicit organizationId when space→org mapping is unavailable', async () => {
    mockSpaceStoreState.spaces = []
    const readContent = vi.fn().mockResolvedValue({ content: '' })
    const writeContent = vi.fn().mockResolvedValue({
      mdPath: '/tmp/SKILL.md',
      skillDir: '/tmp/probe',
    })
    ;(window as unknown as {
      tabtin?: { skill?: Record<string, unknown> }
    }).tabtin = {
      skill: { readContent, writeContent },
    }

    const { ensureSkillMaterializedLocally } = await import('./skills')
    const outcome = await ensureSkillMaterializedLocally({
      spaceId: 'space-orphan',
      organizationId: 'wt-direct',
      skill: {
        skill_id: 'probe',
        skill_key: 'user:probe',
        name: 'Probe',
        source: 'user',
      },
    })

    expect(outcome).toBe('skeleton')
    expect(writeContent).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'wt-direct',
      spaceId: 'space-orphan',
    }))
  })
})

describe('useSkillContentQuery organization snapshot', () => {
  beforeEach(() => {
    electronFetchMock.mockReset()
  })

  it('reads the published package detail before the local registry for organization shelf items', async () => {
    const readContent = vi.fn().mockResolvedValue({ content: '# Local draft' })
    ;(window as unknown as {
      tabtin?: { skill?: { readContent?: ReturnType<typeof vi.fn> } }
    }).tabtin = { skill: { readContent } }
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { doc_content: '# Published snapshot' },
      }),
    })

    const { useSkillContentQuery } = await import('./skills')
    const { result } = renderHook(() => useSkillContentQuery('user:snapshot-skill', {
      spaceId: 'space-1',
      organizationId: 'wt-1',
      publishedSnapshotSkillId: 'skill-1',
    }), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.data).toBe('# Published snapshot'))
    expect(readContent).not.toHaveBeenCalled()
    expect(electronFetchMock).toHaveBeenCalledWith(
      'http://localhost:6060/skills/user%3Asnapshot-skill/package?organization_id=wt-1&skill_id=skill-1',
      expect.anything(),
    )
  })
})

describe('restorePublishedSkillForShare', () => {
  beforeEach(() => {
    electronFetchMock.mockReset()
    mockSpaceStoreState.spaces = []
    ;(window as unknown as { tabtin?: unknown }).tabtin = undefined
  })

  it('按显式组织下载并强制恢复发布版本，不生成骨架', async () => {
    const install = vi.fn().mockResolvedValue({ filesWritten: 1 })
    const readContent = vi.fn()
    const writeContent = vi.fn()
    ;(window as unknown as {
      tabtin?: { skill?: Record<string, unknown> }
    }).tabtin = {
      skill: { install, readContent, writeContent },
    }
    electronFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          version_seq: 3,
          version_label: '0.0.3',
          bundle_sha256: 'bundle-hash',
          files: [{
            path: 'SKILL.md',
            sha256: 'a'.repeat(64),
            size: 12,
            download_url: 'https://example.test/skill.md',
            content_type: 'text/markdown',
          }],
        },
      }),
    })

    const { restorePublishedSkillForShare } = await import('./skills')
    await restorePublishedSkillForShare({
      spaceId: 'space-without-store-entry',
      organizationId: 'target-org',
      versionSeq: 3,
      skill: {
        skill_id: 'probe',
        skill_key: 'user:probe',
        name: 'probe',
        source: 'user',
        package_id: 'pkg-1',
        latest_version_seq: 3,
      },
    })

    expect(readContent).not.toHaveBeenCalled()
    expect(writeContent).not.toHaveBeenCalled()
    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      skillKey: 'probe',
      organizationId: 'target-org',
      spaceId: 'space-without-store-entry',
    }))
  })
})
