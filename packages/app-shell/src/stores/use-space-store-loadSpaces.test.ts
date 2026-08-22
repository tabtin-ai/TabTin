/**
 * Wave 3.2 复核加固第三轮：`loadSpaces` silent removal 漏洞回归测试。
 *
 * 漏洞链回放：
 *   1. 用户在 ws-1 持有 Space-A（hot 中、Run 跑着）
 *   2. WS 短断连期间另一端 archive/delete 了 Space-A
 *   3. reconnect → `gateway.onReconnectedEvent → loadSpaces(ws-1)`
 *   4. 修复前：response 不含 Space-A → set 直接拼接覆盖 → silent removal
 *   5. SpaceWorkbenchHost.spaces.find 找不到 → 不渲染 Space-A → cleanup 跑
 *   6. 此时 hot 仍含 sceneId（从未剔除）+ crawlspace config 仍在（从未 purge）
 *   7. 守卫双条件 true → 错误保活 → "幽灵 Run" 永久泄漏
 *
 * 修复后：set 之前先 diff 出"在 prev 但不在 response"的 spaceId 列表，逐个调
 * `bridge.onSpaceDeleted`（同步 removeFromHot + dirty 兜底 + tab clean + cs purge）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tabtin/shared', () => ({
  withPersistSafety: (options: unknown) => options,
}))

vi.mock('@tabtin/config', () => ({
  API_ENDPOINTS: {},
  joinApiPath: (...parts: string[]) => parts.filter(Boolean).join('/'),
}))

const mockListProjects = vi.fn()
const mockListWorkspaces = vi.fn()
const mockUpdateWorkspace = vi.fn()
const mockDeleteWorkspace = vi.fn()
const mockGetAgent = vi.fn()
const mockListAgents = vi.fn()
const mockOnSpaceDeleted = vi.fn()
const mockResolveCrawlspaceId = vi.fn(() => null)
const mockSetActiveSpace = vi.fn()
const mockOnNavigate = vi.fn()
const mockEmitNavigate = vi.fn()
let mockCurrentDeviceId: string | null = null

vi.mock('../services/space-api.js', () => ({
  SpaceApiService: {},
  ProjectApiService: {
    list: (...args: unknown[]) => mockListProjects(...args),
  },
  WorkspaceApiService: {
    list: (...args: unknown[]) => mockListWorkspaces(...args),
    update: (...args: unknown[]) => mockUpdateWorkspace(...args),
    delete: (...args: unknown[]) => mockDeleteWorkspace(...args),
  },
  AgentApiService: {
    getAgent: (...args: unknown[]) => mockGetAgent(...args),
    listAgents: (...args: unknown[]) => mockListAgents(...args),
  },
  ApprovalMemoApiService: {},
}))

vi.mock('../runtime.js', () => ({
  getRuntime: () => ({
    bridge: {
      onSpaceDeleted: mockOnSpaceDeleted,
      resolveCrawlspaceId: mockResolveCrawlspaceId,
      setActiveSpace: mockSetActiveSpace,
      getCurrentDeviceId: () => mockCurrentDeviceId,
    },
  }),
}))

vi.mock('./view-navigation.js', () => ({
  onNavigate: mockOnNavigate,
  emitNavigate: mockEmitNavigate,
}))

vi.mock('./session-reset-registry.js', () => ({
  registerResetAction: vi.fn(),
}))

vi.mock('./use-organization-store.js', () => ({
  useOrganizationStore: {
    getState: () => ({ selectedOrganization: null }),
    subscribe: vi.fn(() => () => {}),
  },
}))

let useSpaceStore: typeof import('./use-space-store.js').useSpaceStore
let useAgentStore: typeof import('./use-agent-store.js').useAgentStore

const makeSpace = (id: string, organizationId: string, type: 'workspace' | 'team_space' = 'workspace') => ({
  id,
  organization_id: organizationId,
  name: id,
  type,
  agent_id: null,
})

/**
 *  终态口径：个人域 `WorkspaceApiService.list`，团队域 `ProjectApiService.list`。
 */
const mockListSpacesForTypes = (workspaceSpaces: any[], teamSpaces: any[] = []) => {
  mockListWorkspaces.mockImplementation(() => Promise.resolve(
    workspaceSpaces.map((space) => ({
      id: space.id,
      organization_id: space.organization_id,
      project_id: space.project_id ?? null,
      provisioning_source: space.provisioning_source
        ?? (space.is_companion === true ? 'system_project' : 'user'),
      is_companion: space.is_companion === true
        || space.provisioning_source === 'system_project'
        || space.provisioning_source === 'system_task',
      name: space.name,
      working_dir: space.working_dir ?? '',
      working_dir_type: space.working_dir_type,
      device_id: space.device_id ?? null,
      device_online: space.device_online ?? false,
      is_home: space.is_home ?? false,
      trust_status: space.trust_status ?? 'trusted',
      approval_grant: space.approval_grant ?? 'always_ask',
      approval_memo_generation: space.approval_memo_generation ?? 0,
      agent_id: space.agent_id ?? null,
      execution_agent_id: space.execution_agent_id ?? space.agent_id ?? null,
    })),
  ))
  mockListProjects.mockImplementation(() => Promise.resolve({
    spaces: teamSpaces,
    total: teamSpaces.length,
  }))
}

beforeEach(async () => {
  vi.resetModules()
  mockListProjects.mockReset().mockResolvedValue({ spaces: [], total: 0 })
  mockListWorkspaces.mockReset().mockResolvedValue([])
  mockUpdateWorkspace.mockReset()
  mockDeleteWorkspace.mockReset()
  mockGetAgent.mockReset()
  mockListAgents.mockReset().mockResolvedValue([
    { id: 'agent-default', name: 'Default Agent' },
  ])
  mockOnSpaceDeleted.mockReset()
  mockResolveCrawlspaceId.mockReset().mockReturnValue(null)
  mockCurrentDeviceId = null
  window.localStorage.clear()

  const mod = await import('./use-space-store.js')
  useSpaceStore = mod.useSpaceStore
  const agentMod = await import('./use-agent-store.js')
  useAgentStore = agentMod.useAgentStore
  useSpaceStore.setState({
    spaces: [],
    selectedSpace: null,
    agentCache: {},
    selectedAgent: null,
    isLoading: false,
    isCreating: false,
    error: null,
    loadRetryCount: 0,
    lastLoadError: null,
  })
  useAgentStore.setState({
    selectedAgent: null,
    agentCache: {},
    isLoading: false,
    error: null,
  })
})

describe('useSpaceStore.selectSpace — Space 级 working_dir hydrate', () => {
  it('Space 暂无 agent_id 但有 working_dir 时，setActiveSpace 使用 Space 执行根', () => {
    const space = {
      ...makeSpace('space-A', 'ws-1'),
      working_dir: 'C:\\Users\\me\\Downloads\\VoiceSync-Windows-0.3.1',
      working_dir_type: 'mixed',
    }

    useSpaceStore.getState().selectSpace(space)

    expect(mockSetActiveSpace).toHaveBeenCalledWith(
      'space-A',
      null,
      'ws-1',
      'C:\\Users\\me\\Downloads\\VoiceSync-Windows-0.3.1',
    )
  })

  it('#6198：同组织切换 Space 只切现场，不改写 selectedAgent，也不按 agent_id 拉取', async () => {
    const space = {
      ...makeSpace('space-A', 'ws-1'),
      agent_id: 'agent-1',
      working_dir: 'C:\\Users\\me\\Downloads\\VoiceSync-Windows-0.3.1',
      working_dir_type: 'mixed',
    }
    useSpaceStore.setState({
      selectedAgent: {
        id: 'agent-old',
        name: 'agent-old',
        organization_id: 'ws-1',
      } as never,
    })

    useSpaceStore.getState().selectSpace(space)

    expect(useSpaceStore.getState().selectedAgent?.id).toBe('agent-old')
    expect(mockGetAgent).not.toHaveBeenCalled()
    expect(mockListAgents).not.toHaveBeenCalled()
    expect(mockSetActiveSpace).toHaveBeenCalledTimes(1)
    expect(mockSetActiveSpace).toHaveBeenCalledWith(
      'space-A',
      null,
      'ws-1',
      'C:\\Users\\me\\Downloads\\VoiceSync-Windows-0.3.1',
    )
  })

  it('#6198：同组织无 agent_id 的 Workspace 也不会清掉或改写当前身份', () => {
    useSpaceStore.setState({
      selectedAgent: {
        id: 'agent-old',
        name: 'agent-old',
        organization_id: 'ws-1',
      } as never,
    })

    useSpaceStore.getState().selectSpace(makeSpace('space-B', 'ws-1'))

    expect(useSpaceStore.getState().selectedAgent?.id).toBe('agent-old')
    expect(mockGetAgent).not.toHaveBeenCalled()
    expect(mockListAgents).not.toHaveBeenCalled()
  })

  it('#8617：切到其他组织的 Space 时清掉跨 org selectedAgent', () => {
    useSpaceStore.setState({
      selectedAgent: {
        id: 'agent-org-a',
        name: '小Tin',
        organization_id: 'org-a',
      } as never,
    })
    useAgentStore.setState({
      selectedAgent: {
        id: 'agent-org-a',
        name: '小Tin',
        organization_id: 'org-a',
      } as never,
    })

    useSpaceStore.getState().selectSpace(makeSpace('space-B', 'org-b'))

    expect(useSpaceStore.getState().selectedAgent).toBeNull()
    expect(useAgentStore.getState().selectedAgent).toBeNull()
    expect(mockSetActiveSpace).toHaveBeenCalledWith('space-B', null, 'org-b', null)
  })

  it('纯 Workspace 改名和删除走 Workspace API', async () => {
    const workspace = {
      ...makeSpace('workspace-only', 'ws-1'),
      workspace_record: true,
      working_dir: '/Users/me/project',
      icon: 'rocket',
      agent_id: 'agent-shell',
      execution_agent_id: 'agent-shell',
    }
    useSpaceStore.setState({ spaces: [workspace] })
    mockUpdateWorkspace.mockResolvedValue({
      id: 'workspace-only',
      organization_id: 'ws-1',
      name: 'Renamed',
      working_dir: '/Users/me/renamed-project',
      working_dir_type: 'doc',
      device_id: 'device-new',
      device_online: true,
      is_home: false,
      trust_status: 'trusted',
      approval_grant: 'auto',
      approval_memo_generation: 3,
    })
    mockDeleteWorkspace.mockResolvedValue(undefined)

    await expect(
      useSpaceStore.getState().updateSpace('workspace-only', { name: 'Renamed' }),
    ).resolves.toBe(true)
    expect(mockUpdateWorkspace).toHaveBeenCalledWith(
      'workspace-only',
      {
        name: 'Renamed',
        description: undefined,
        working_dir: undefined,
        working_dir_type: undefined,
        device_fingerprint: undefined,
        custom_rules: undefined,
        execution_limits: undefined,
      },
    )
    expect(useSpaceStore.getState().spaces[0].name).toBe('Renamed')
    expect(useSpaceStore.getState().spaces[0]).toMatchObject({
      icon: 'rocket',
      agent_id: null,
      execution_agent_id: null,
      workspace_record: true,
      working_dir: '/Users/me/renamed-project',
      working_dir_type: 'doc',
      owner_execution_device_id: 'device-new',
      approval_grant: 'auto',
      approval_memo_generation: 3,
    })

    await expect(
      useSpaceStore.getState().deleteSpace('workspace-only'),
    ).resolves.toBe(true)
    expect(mockDeleteWorkspace).toHaveBeenCalledWith('workspace-only', null)
    expect(useSpaceStore.getState().spaces).toEqual([])
  })

  it('#7248：现场规则/执行限额写入 Workspace API 并回读到本地状态', async () => {
    const workspace = {
      ...makeSpace('workspace-rules', 'ws-1'),
      workspace_record: true,
      working_dir: '/Users/me/project',
      custom_rules: '',
      execution_limits: {},
    }
    useSpaceStore.setState({ spaces: [workspace] })
    mockUpdateWorkspace.mockResolvedValue({
      id: 'workspace-rules',
      organization_id: 'ws-1',
      name: workspace.name,
      working_dir: '/Users/me/project',
      working_dir_type: 'code',
      device_id: null,
      device_online: false,
      is_home: false,
      trust_status: 'trusted',
      approval_grant: 'always_ask',
      approval_memo_generation: 0,
      custom_rules: '用早上好开头回复',
      execution_limits: { max_iterations_per_run: 40 },
    })

    await expect(
      useSpaceStore.getState().updateSpace('workspace-rules', {
        custom_rules: '用早上好开头回复',
        execution_limits: { max_iterations_per_run: 40 },
      }),
    ).resolves.toBe(true)

    expect(mockUpdateWorkspace).toHaveBeenCalledWith(
      'workspace-rules',
      expect.objectContaining({
        custom_rules: '用早上好开头回复',
        execution_limits: { max_iterations_per_run: 40 },
      }),
    )
    expect(useSpaceStore.getState().spaces[0]).toMatchObject({
      custom_rules: '用早上好开头回复',
      execution_limits: { max_iterations_per_run: 40 },
    })
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useSpaceStore.loadSpaces — silent removal 防御（Wave 3.2 复核加固第三轮）', () => {
  it('reconnect 后 response 不含已删的 spaceId → 同步调 bridge.onSpaceDeleted', async () => {
    // 模拟弱网恢复：本地 spaces 里有 space-A 和 space-B（都属 ws-1），但
    // response 只剩 space-B（A 已被另一端删除）
    useSpaceStore.setState({
      spaces: [makeSpace('space-A', 'ws-1'), makeSpace('space-B', 'ws-1')],
    })
    mockListSpacesForTypes([makeSpace('space-B', 'ws-1')])

    await useSpaceStore.getState().loadSpaces('ws-1')

    expect(mockOnSpaceDeleted).toHaveBeenCalledTimes(1)
    expect(mockOnSpaceDeleted).toHaveBeenCalledWith('space-A')
    expect(mockOnSpaceDeleted).not.toHaveBeenCalledWith('space-B')

    // setState 仍然完成 — spaces 列表只剩 B
    expect(useSpaceStore.getState().spaces.map(s => s.id)).toEqual(['space-B'])
  })

  it('首次 loadSpaces（prev 为空）→ 不误判为删除，不调 onSpaceDeleted', async () => {
    // 首次启动场景：prev.spaces 是空的，response 给出 5 个 Space。这种场景
    // 不应该让 loadSpaces 把"5 个 Space 都不在 prev 里"误判成"全删了"。
    expect(useSpaceStore.getState().spaces).toEqual([])
    mockListSpacesForTypes([makeSpace('space-A', 'ws-1'), makeSpace('space-B', 'ws-1')])

    await useSpaceStore.getState().loadSpaces('ws-1')

    expect(mockOnSpaceDeleted).not.toHaveBeenCalled()
    expect(useSpaceStore.getState().spaces.map(s => s.id)).toEqual(['space-A', 'space-B'])
  })

  it('加载远端 Agent Space 时个人域走 Workspace API、团队域走 Project API', async () => {
    mockListSpacesForTypes([makeSpace('space-workspace', 'ws-1')])

    await useSpaceStore.getState().loadSpaces('ws-1')

    expect(mockListWorkspaces).toHaveBeenCalledWith('ws-1')
    expect(mockListProjects).toHaveBeenCalledWith('ws-1')
    expect(useSpaceStore.getState().spaces.map(s => s.id)).toEqual(['space-workspace'])
  })

  it('多 organization 共存场景 → 只对当前 organizationId 范围 diff，不误删别的 organization', async () => {
    // batch load 模式或者跨 organization 切换：state.spaces 里既有 ws-1 也有 ws-2
    // 的项。loadSpaces('ws-1') 应该只对 ws-1 里消失的 spaceId 调 onSpaceDeleted，
    // ws-2 的项不受影响。
    useSpaceStore.setState({
      spaces: [
        makeSpace('space-A', 'ws-1'),
        makeSpace('space-B', 'ws-1'),
        makeSpace('space-X', 'ws-2'),
      ],
    })
    mockListSpacesForTypes([makeSpace('space-A', 'ws-1')])

    await useSpaceStore.getState().loadSpaces('ws-1')

    // 只有 space-B（ws-1 内消失的）被剔
    expect(mockOnSpaceDeleted).toHaveBeenCalledTimes(1)
    expect(mockOnSpaceDeleted).toHaveBeenCalledWith('space-B')

    // ws-2 的 Space 仍在
    const ids = useSpaceStore.getState().spaces.map(s => s.id).sort()
    expect(ids).toEqual(['space-A', 'space-X'])
  })

  it('response 跟 prev 完全一致 → 不调 onSpaceDeleted（无变化）', async () => {
    useSpaceStore.setState({
      spaces: [makeSpace('space-A', 'ws-1'), makeSpace('space-B', 'ws-1')],
    })
    mockListSpacesForTypes([makeSpace('space-A', 'ws-1'), makeSpace('space-B', 'ws-1')])

    await useSpaceStore.getState().loadSpaces('ws-1')

    expect(mockOnSpaceDeleted).not.toHaveBeenCalled()
  })

  it('导航列表不按当前设备过滤 → 遥控端也能看到可访问 Workspace', async () => {
    mockCurrentDeviceId = 'device-remote-viewer'
    mockListSpacesForTypes([makeSpace('space-A', 'ws-1'), makeSpace('space-B', 'ws-1')])

    await useSpaceStore.getState().loadSpaces('ws-1')

    //  终态：个人域走 Workspace API，不再按设备过滤
    expect(mockListWorkspaces).toHaveBeenCalledWith('ws-1')
    expect(useSpaceStore.getState().spaces.map(s => s.id)).toEqual(['space-A', 'space-B'])
  })

  it('loadSpaces 同时合并 Workspace（个人）与 Project（团队）列表', async () => {
    mockListSpacesForTypes(
      [makeSpace('space-A', 'ws-1')],
      [{ ...makeSpace('team-space-1', 'ws-1'), type: 'team_space', execution_space_id: 'space-A' }],
    )

    await useSpaceStore.getState().loadSpaces('ws-1')

    expect(mockListWorkspaces).toHaveBeenCalledWith('ws-1')
    expect(mockListProjects).toHaveBeenCalledWith('ws-1')
    expect(useSpaceStore.getState().spaces.map(s => s.id)).toEqual(['space-A', 'team-space-1'])
  })

  it('loadSpaces 保留 Project 关联 Workspace（个人 Workspace 与 Team Project 并存）', async () => {
    const projectWorkspace = {
      ...makeSpace('project-workspace-1', 'ws-1'),
      project_id: 'team-space-1',
      provisioning_source: 'system_project',
      is_companion: true,
    }
    mockListSpacesForTypes(
      [projectWorkspace],
      [{ ...makeSpace('team-space-1', 'ws-1'), type: 'team_space', execution_space_id: null }],
    )

    await useSpaceStore.getState().loadSpaces('ws-1')

    // 结果集合：个人 Workspace（shaped）+ 团队 Project（team_space）；
    // 具体形状交给 `workspaceToSpaceLike` 兜底，这里只断言 id 排布。
    expect(useSpaceStore.getState().spaces.map(s => s.id)).toEqual([
      'project-workspace-1',
      'team-space-1',
    ])
    //  / ：供给来源与伴生标记必须穿透 workspaceToSpaceLike
    const shaped = useSpaceStore.getState().spaces.find(s => s.id === 'project-workspace-1')
    expect(shaped?.project_id).toBe('team-space-1')
    expect(shaped?.provisioning_source).toBe('system_project')
    expect(shaped?.is_companion).toBe(true)
  })

  it('Team Space membership 被收回后，按后端列表结果移出本地列表', async () => {
    useSpaceStore.setState({
      spaces: [
        makeSpace('space-A', 'ws-1'),
        { ...makeSpace('team-space-1', 'ws-1'), type: 'team_space', execution_space_id: 'space-A' },
      ],
    })
    mockListSpacesForTypes([makeSpace('space-A', 'ws-1')], [])

    await useSpaceStore.getState().loadSpaces('ws-1')

    expect(mockOnSpaceDeleted).toHaveBeenCalledWith('team-space-1')
    expect(useSpaceStore.getState().spaces.map(s => s.id)).toEqual(['space-A'])
  })

  it('onSpaceDeleted 抛错 → 不阻断后续 spaceId 处理，setState 仍跑通', async () => {
    useSpaceStore.setState({
      spaces: [makeSpace('space-A', 'ws-1'), makeSpace('space-B', 'ws-1')],
    })
    mockListSpacesForTypes([])
    // 第一次 hook 调用抛错，第二次正常
    mockOnSpaceDeleted.mockImplementationOnce(() => {
      throw new Error('hook boom')
    })

    await useSpaceStore.getState().loadSpaces('ws-1')

    // 两个 spaceId 都被尝试调用
    expect(mockOnSpaceDeleted).toHaveBeenCalledTimes(2)
    expect(mockOnSpaceDeleted).toHaveBeenCalledWith('space-A')
    expect(mockOnSpaceDeleted).toHaveBeenCalledWith('space-B')

    // setState 仍跑通 — spaces 被清空
    expect(useSpaceStore.getState().spaces).toEqual([])
  })

  it('hook 调用顺序：先 onSpaceDeleted 再 setState（避免 SpaceWorkbenchHost 中间态错误保活）', async () => {
    // 验证顺序：onSpaceDeleted 必须在 spaces 列表 setState 之前调，否则
    // SpaceWorkbenchHost 看到 spaces 列表减少 → unmount → cleanup → 守卫读
    // hot 还含 sceneId → 错误保活。
    const callOrder: string[] = []
    useSpaceStore.setState({
      spaces: [makeSpace('space-A', 'ws-1')],
    })
    mockListSpacesForTypes([])
    mockOnSpaceDeleted.mockImplementation(() => {
      callOrder.push('onSpaceDeleted')
      // 调用时 spaces 列表必须还含 space-A（setState 还没跑）
      expect(useSpaceStore.getState().spaces.map(s => s.id)).toContain('space-A')
    })

    // 用 subscribe 捕获 setState 时机
    const unsub = useSpaceStore.subscribe((state, prev) => {
      if (state.spaces !== prev.spaces) callOrder.push('setState')
    })

    try {
      await useSpaceStore.getState().loadSpaces('ws-1')
    } finally {
      unsub()
    }

    // 顺序：先 onSpaceDeleted，再 setState
    expect(callOrder).toEqual(['onSpaceDeleted', 'setState'])
  })
})
