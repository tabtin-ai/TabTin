import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockState = {
  organization: {
    organizations: [] as Array<{ id: string; name: string; type?: string; is_default?: boolean; owner_id?: string }>,
    selectedOrganization: null as { id: string; name: string } | null,
    loadOrganizations: vi.fn().mockResolvedValue(undefined),
    selectOrganization: vi.fn().mockResolvedValue(undefined),
  },
  auth: {
    user: null as { id: string } | null,
  },
  chat: {
    sessionsBySpaceId: {} as Record<string, Array<{ id: string; organization_id: string }>>,
    purgeOrganizationSpaces: vi.fn(),
  },
  space: {
    spaces: [] as Array<{ id: string; organization_id: string; agent_id?: string }>,
    selectedSpace: null as { id: string; organization_id: string } | null,
    selectedAgent: null as { id: string } | null,
    agentCache: {} as Record<string, unknown>,
    setState: vi.fn(),
  },
  im: {
    conversations: [] as Array<{ id: string; organization_id: string }>,
    setState: vi.fn(),
  },
  background: {
    clearOrganization: vi.fn(),
  },
}

const mockToast = vi.fn()
const mockNotifyLogout = vi.fn()
const mockOnSpaceDeleted = vi.fn()
const mockShowOrganizationMembershipNotice = vi.fn()
const mockSetOrganizationAccessRecoveryInFlight = vi.fn()
const mockSetOrganizationAccessBlocked = vi.fn()
const mockClearOrganizationAccessState = vi.fn()
const mockGatewayClose = vi.fn()
const mockGatewayConnect = vi.fn().mockResolvedValue(true)
const mockGatewayForceReconnect = vi.fn().mockResolvedValue(true)
const mockInvalidateLocalWorkspaceBootstrap = vi.fn()

vi.mock('@tabtin/app-shell', () => ({
  registerResetAction: vi.fn(),
  useOrganizationStore: Object.assign(
    () => mockState.organization,
    { getState: () => mockState.organization, setState: vi.fn(), subscribe: vi.fn(() => () => {}) },
  ),
  useSpaceStore: Object.assign(
    () => mockState.space,
    { getState: () => mockState.space, setState: (updater: any) => mockState.space.setState(updater) },
  ),
  getRuntime: () => ({
    bridge: {
      onSpaceDeleted: mockOnSpaceDeleted,
    },
  }),
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    () => mockState.chat,
    { getState: () => mockState.chat },
  ),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: Object.assign(
    () => mockState.im,
    { getState: () => mockState.im, setState: (updater: any) => mockState.im.setState(updater) },
  ),
}))

vi.mock('@stores/useBackgroundEventStore', () => ({
  useBackgroundEventStore: { getState: () => mockState.background },
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: Object.assign(
    () => mockState.auth,
    { getState: () => mockState.auth, setState: vi.fn(), subscribe: vi.fn(() => () => {}) },
  ),
}))

vi.mock('@/utils/authPersistence', () => ({
  notifyLogoutRequired: mockNotifyLogout,
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: mockToast,
}))

vi.mock('@/stores/useOrganizationMembershipNoticeStore', () => ({
  useOrganizationMembershipNoticeStore: {
    getState: () => ({
      showNotice: mockShowOrganizationMembershipNotice,
    }),
  },
}))

vi.mock('@/stores/useWsConnectionStore', () => ({
  useWsConnectionStore: {
    getState: () => ({
      setOrganizationAccessRecoveryInFlight: mockSetOrganizationAccessRecoveryInFlight,
      setOrganizationAccessBlocked: mockSetOrganizationAccessBlocked,
      clearOrganizationAccessState: mockClearOrganizationAccessState,
    }),
  },
}))

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: () => ({
      close: mockGatewayClose,
      connect: mockGatewayConnect,
      forceReconnect: mockGatewayForceReconnect,
    }),
  }),
}))

vi.mock('@components/sidebar/ensureLocalWorkspace', () => ({
  invalidateLocalWorkspaceBootstrapForOrganization: mockInvalidateLocalWorkspaceBootstrap,
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => {
      const def =
        typeof options?.defaultValue === 'string' ? options.defaultValue : key
      return def.replace('{{name}}', String(options?.name ?? ''))
    },
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

let handleMembershipChangedEnvelope: typeof import('../membershipEventHandler').handleMembershipChangedEnvelope
let recoverFromInvalidOrganizationAccess: typeof import('../membershipEventHandler').recoverFromInvalidOrganizationAccess

beforeEach(async () => {
  vi.resetModules()
  mockState.organization.organizations = []
  mockState.organization.selectedOrganization = null
  mockState.organization.loadOrganizations.mockClear().mockResolvedValue(undefined)
  mockState.organization.selectOrganization.mockClear().mockResolvedValue(undefined)
  mockState.chat.sessionsBySpaceId = {}
  mockState.chat.purgeOrganizationSpaces.mockClear()
  mockState.space.spaces = []
  mockState.space.selectedSpace = null
  mockState.space.selectedAgent = null
  mockState.space.agentCache = {}
  mockState.space.setState.mockClear()
  mockState.space.setState.mockImplementation((_updater: any) => undefined)
  mockState.im.conversations = []
  mockState.im.setState.mockClear()
  mockState.background.clearOrganization.mockClear()
  mockState.auth.user = null
  mockToast.mockClear()
  mockNotifyLogout.mockClear()
  mockOnSpaceDeleted.mockClear()
  mockShowOrganizationMembershipNotice.mockClear()
  mockSetOrganizationAccessRecoveryInFlight.mockClear()
  mockSetOrganizationAccessBlocked.mockClear()
  mockClearOrganizationAccessState.mockClear()
  mockGatewayClose.mockClear()
  mockGatewayConnect.mockClear().mockResolvedValue(true)
  mockGatewayForceReconnect.mockClear().mockResolvedValue(true)
  mockInvalidateLocalWorkspaceBootstrap.mockClear()

  const mod = await import('../membershipEventHandler')
  handleMembershipChangedEnvelope = mod.handleMembershipChangedEnvelope
  recoverFromInvalidOrganizationAccess = mod.recoverFromInvalidOrganizationAccess
})

describe('handleMembershipChangedEnvelope', () => {
  it('removed_from_all_organizations 触发登出（toast 先显示，logout 延迟 4s，给用户读提示的时间）', async () => {
    vi.useFakeTimers()
    try {
      handleMembershipChangedEnvelope({
        added: [],
        removed: ['ws-A'],
        all_ids: [],
        primary_id: null,
        reason: 'removed_from_all_organizations',
      })

      // toast 立即出现
      expect(mockToast).toHaveBeenCalled()
      expect(mockShowOrganizationMembershipNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'membership-removed-all',
          kind: 'removed_all',
          title: '你已被移出所有组织',
        }),
      )
      // logout 被延迟触发
      expect(mockNotifyLogout).not.toHaveBeenCalled()

      // 推进 4s 后才触发登出
      vi.advanceTimersByTime(4000)
      expect(mockNotifyLogout).toHaveBeenCalledWith('organization_removed_from_all')
    } finally {
      vi.useRealTimers()
    }
  })

  it('当前前台被移出时自动切到 primary', async () => {
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A' },
      { id: 'ws-B', name: 'B' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-A', name: 'A' }

    handleMembershipChangedEnvelope({
      added: [],
      removed: ['ws-A'],
      all_ids: ['ws-B'],
      primary_id: 'ws-B',
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(mockState.chat.purgeOrganizationSpaces).toHaveBeenCalledWith('ws-A', [])
    expect(mockInvalidateLocalWorkspaceBootstrap).toHaveBeenCalledWith('ws-A')
    expect(mockState.background.clearOrganization).toHaveBeenCalledWith('ws-A')
    expect(mockToast).toHaveBeenCalled()
    expect(mockShowOrganizationMembershipNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'membership-removed-ws-A',
        kind: 'removed',
        title: '已被移出「A」',
      }),
    )
    expect(mockState.organization.selectOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ws-B' }),
    )
    expect(mockNotifyLogout).not.toHaveBeenCalled()
  })

  it('无 fallback organization 时恢复失败并进入组织访问受阻状态，不误判为已恢复', async () => {
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-A', name: 'A' }

    const recovered = await recoverFromInvalidOrganizationAccess('ws-A')

    expect(recovered).toBe(false)
    expect(mockSetOrganizationAccessBlocked).toHaveBeenCalledWith('ws-A', 'A')
    expect(mockClearOrganizationAccessState).not.toHaveBeenCalled()
    expect(mockGatewayConnect).not.toHaveBeenCalled()
    expect(mockShowOrganizationMembershipNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'membership-access_denied-blocked-ws-A',
        kind: 'access_denied',
        title: '无法访问「A」',
      }),
    )
  })

  it('恢复到 fallback organization 后强制刷新主进程 gateway membership', async () => {
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A' },
      { id: 'ws-B', name: 'B' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-A', name: 'A' }
    mockState.organization.selectOrganization.mockImplementationOnce(async (organization) => {
      mockState.organization.selectedOrganization = organization
    })

    const recovered = await recoverFromInvalidOrganizationAccess('ws-A')

    expect(recovered).toBe(true)
    expect(mockClearOrganizationAccessState).toHaveBeenCalled()
    expect(mockGatewayForceReconnect).toHaveBeenCalledTimes(1)
    expect(mockGatewayClose).not.toHaveBeenCalled()
    expect(mockGatewayConnect).not.toHaveBeenCalled()
  })

  it('membership push 移出当前组织但无 fallback 时，也进入组织访问受阻状态', async () => {
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-A', name: 'A' }

    handleMembershipChangedEnvelope({
      added: [],
      removed: ['ws-A'],
      all_ids: ['ws-B'],
      primary_id: 'ws-B',
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(mockSetOrganizationAccessBlocked).toHaveBeenCalledWith('ws-A', 'A')
    expect(mockShowOrganizationMembershipNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'membership-removed-blocked-ws-A',
        kind: 'removed',
        title: '已被移出「A」',
      }),
    )
  })

  it('批量移出多个 organization 时 fallback 跳过所有 removed，不会误选到同样被移的团队', async () => {
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A' },
      { id: 'ws-B', name: 'B' },
      { id: 'ws-C', name: 'C' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-A', name: 'A' }

    handleMembershipChangedEnvelope({
      added: [],
      removed: ['ws-A', 'ws-B'],
      all_ids: ['ws-C'],
      primary_id: 'ws-C',
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(mockState.chat.purgeOrganizationSpaces).toHaveBeenCalledWith('ws-A', [])
    expect(mockState.chat.purgeOrganizationSpaces).toHaveBeenCalledWith('ws-B', [])
    expect(mockState.organization.selectOrganization).toHaveBeenCalledTimes(1)
    expect(mockState.organization.selectOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ws-C' }),
    )
  })

  it('仅新增 organization 时刷新列表 + 给"已被邀请加入"toast（Y-14）', async () => {
    // 当前用户是 user-self；ws-B 的 owner 是别人 user-other，所以是"被邀请"
    mockState.auth.user = { id: 'user-self' }
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A', owner_id: 'user-self' },
      { id: 'ws-B', name: 'B', owner_id: 'user-other' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-A', name: 'A' }

    handleMembershipChangedEnvelope({
      added: ['ws-B'],
      removed: [],
      all_ids: ['ws-A', 'ws-B'],
      primary_id: 'ws-A',
    })

    expect(mockState.organization.loadOrganizations).toHaveBeenCalled()
    expect(mockState.organization.selectOrganization).not.toHaveBeenCalled()
    // 弹 toast 告知用户被加入
    await vi.waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'membership-added-ws-B' }),
      )
    })
    expect(mockNotifyLogout).not.toHaveBeenCalled()
  })

  it('#1604：自己创建的团队被周期同步捞到 added 时不弹"被邀请"toast', async () => {
    // 复现：用户刚创建团队 ws-new，服务端 60s 周期同步把它当 added 推过来。
    // ws-new 的 owner 就是当前用户 → 不应弹"你被邀请加入了新团队"。
    mockState.auth.user = { id: 'user-self' }
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A', owner_id: 'user-self' },
      { id: 'ws-new', name: '我的新团队', owner_id: 'user-self' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-A', name: 'A' }

    handleMembershipChangedEnvelope({
      added: ['ws-new'],
      removed: [],
      all_ids: ['ws-A', 'ws-new'],
      primary_id: 'ws-A',
    })

    expect(mockState.organization.loadOrganizations).toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 不弹"被邀请"toast（自建团队已有创建流程的本地反馈覆盖）
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'membership-added-ws-new' }),
    )
    expect(mockNotifyLogout).not.toHaveBeenCalled()
  })

  it('#1604：added 里同时含自建团队和别人邀请的团队，只对后者弹 toast', async () => {
    mockState.auth.user = { id: 'user-self' }
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A', owner_id: 'user-self' },
      { id: 'ws-self-new', name: '自建', owner_id: 'user-self' },
      { id: 'ws-invited', name: '被邀请', owner_id: 'user-other' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-A', name: 'A' }

    handleMembershipChangedEnvelope({
      added: ['ws-self-new', 'ws-invited'],
      removed: [],
      all_ids: ['ws-A', 'ws-self-new', 'ws-invited'],
      primary_id: 'ws-A',
    })

    await vi.waitFor(() => {
      // 被邀请的仍弹
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'membership-added-ws-invited' }),
      )
    })
    // 自建的不弹
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'membership-added-ws-self-new' }),
    )
  })

  it('#1604：成员变更事件先到、organization 列表后刷新时，自建组织不弹“被邀请”toast', async () => {
    // 复现真实竞态：事件到达时列表还没有 ws-new，刷新完才能拿到 owner_id。
    // 刷新前不能把“资料未知”当成“被别人邀请”。
    mockState.auth.user = { id: 'user-self' }
    mockState.organization.organizations = [{ id: 'ws-A', name: 'A', owner_id: 'user-self' }]
    mockState.organization.selectedOrganization = { id: 'ws-A', name: 'A' }

    let finishRefresh!: () => void
    mockState.organization.loadOrganizations.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = () => {
            mockState.organization.organizations = [
              { id: 'ws-A', name: 'A', owner_id: 'user-self' },
              { id: 'ws-new', name: '我的新组织', owner_id: 'user-self' },
            ]
            resolve()
          }
        }),
    )

    handleMembershipChangedEnvelope({
      added: ['ws-new'],
      removed: [],
      all_ids: ['ws-A', 'ws-new'],
      primary_id: 'ws-A',
    })

    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'membership-added-ws-new' }),
    )

    finishRefresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'membership-added-ws-new' }),
    )
  })

  it('被移出非前台 organization 仅清缓存，不切换', async () => {
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A' },
      { id: 'ws-B', name: 'B' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-A', name: 'A' }

    handleMembershipChangedEnvelope({
      added: [],
      removed: ['ws-B'],
      all_ids: ['ws-A'],
      primary_id: 'ws-A',
    })

    expect(mockState.chat.purgeOrganizationSpaces).toHaveBeenCalledWith('ws-B', [])
    expect(mockState.background.clearOrganization).toHaveBeenCalledWith('ws-B')
    expect(mockState.organization.selectOrganization).not.toHaveBeenCalled()
  })

  it('purgeRemovedOrganizationCaches 中某个 store 抛错，不中断后续清理', async () => {
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A' },
      { id: 'ws-B', name: 'B' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-B', name: 'B' }
    mockState.space.setState.mockImplementation(() => {
      throw new Error('space store boom')
    })

    expect(() =>
      handleMembershipChangedEnvelope({
        added: [],
        removed: ['ws-A'],
        all_ids: ['ws-B'],
        primary_id: 'ws-B',
      }),
    ).not.toThrow()

    // 后续 store 仍应被调用
    expect(mockState.chat.purgeOrganizationSpaces).toHaveBeenCalledWith('ws-A', [])
    expect(mockState.background.clearOrganization).toHaveBeenCalledWith('ws-A')
  })

  it('payload 非法时不 crash', () => {
    expect(() => handleMembershipChangedEnvelope(null)).not.toThrow()
    expect(() => handleMembershipChangedEnvelope('string')).not.toThrow()
    expect(() => handleMembershipChangedEnvelope(undefined)).not.toThrow()
  })

  it('Wave 3.2 复核加固：被移出 organization 时同步走 onSpaceDeleted（避免 hot 集合 stale 导致 Run 泄漏）', async () => {
    // 漏洞链回放：之前 purgeRemovedOrganizationCaches 直接 setState 删 spaces 列表，
    // 绕过 bridge.onSpaceDeleted —— 用户被移出团队后：
    //   1. spaces 列表立即剔除被移 organization 下的所有 Space
    //   2. SpaceWorkbenchHost 不再渲染该 Space 子树
    //   3. CrawlspaceWorkspace unmount → useRunManager cleanup → 调 workspaceRunGuard
    //   4. 此时 hot 仍含 sceneId（从未剔除）+ crawlspace config 仍在（purge 没跑）
    //   5. 双条件 → 错误保活 → "幽灵 Run" 永久泄漏（用户没有 UI 入口可见）
    //
    // 修复后：先逐个调 bridge.onSpaceDeleted（同步 removeFromHot + 触发 dirty save +
    // tab clean + crawlspace purge），再 setState 删 spaces。
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A' },
      { id: 'ws-B', name: 'B' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-B', name: 'B' }
    mockState.space.spaces = [
      { id: 'space-A1', organization_id: 'ws-A' },
      { id: 'space-A2', organization_id: 'ws-A' },
      { id: 'space-B1', organization_id: 'ws-B' },
    ]

    handleMembershipChangedEnvelope({
      added: [],
      removed: ['ws-A'],
      all_ids: ['ws-B'],
      primary_id: 'ws-B',
    })

    // 关键断言：被移 organization 下的每个 spaceId 都走了 onSpaceDeleted
    expect(mockOnSpaceDeleted).toHaveBeenCalledTimes(2)
    expect(mockOnSpaceDeleted).toHaveBeenCalledWith('space-A1')
    expect(mockOnSpaceDeleted).toHaveBeenCalledWith('space-A2')
    // ws-B 下的 space 不应被波及
    expect(mockOnSpaceDeleted).not.toHaveBeenCalledWith('space-B1')

    expect(mockState.chat.purgeOrganizationSpaces).toHaveBeenCalledWith(
      'ws-A',
      ['space-A1', 'space-A2'],
    )

    // setState 仍然要跑（删 spaces 列表自身）
    expect(mockState.space.setState).toHaveBeenCalled()
  })

  it('Wave 3.2 复核加固：onSpaceDeleted 抛错时仍继续清剩余 space + setState（不卡死）', async () => {
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A' },
      { id: 'ws-B', name: 'B' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-B', name: 'B' }
    mockState.space.spaces = [
      { id: 'space-A1', organization_id: 'ws-A' },
      { id: 'space-A2', organization_id: 'ws-A' },
    ]
    mockOnSpaceDeleted.mockImplementationOnce(() => {
      throw new Error('first space hook boom')
    })

    expect(() =>
      handleMembershipChangedEnvelope({
        added: [],
        removed: ['ws-A'],
        all_ids: ['ws-B'],
        primary_id: 'ws-B',
      }),
    ).not.toThrow()

    // 第二个 spaceId 仍被尝试
    expect(mockOnSpaceDeleted).toHaveBeenCalledWith('space-A1')
    expect(mockOnSpaceDeleted).toHaveBeenCalledWith('space-A2')
    // setState 仍要跑（不被前面的抛错阻断）
    expect(mockState.space.setState).toHaveBeenCalled()
  })

  it('Wave 3.2 复核加固：被移 organization 下没有 space 时 onSpaceDeleted 不调（早退）', async () => {
    mockState.organization.organizations = [
      { id: 'ws-A', name: 'A' },
      { id: 'ws-B', name: 'B' },
    ]
    mockState.organization.selectedOrganization = { id: 'ws-B', name: 'B' }
    mockState.space.spaces = [
      { id: 'space-B1', organization_id: 'ws-B' },
    ]

    handleMembershipChangedEnvelope({
      added: [],
      removed: ['ws-A'],
      all_ids: ['ws-B'],
      primary_id: 'ws-B',
    })

    expect(mockOnSpaceDeleted).not.toHaveBeenCalled()
    // setState 也跳过（早退）
    expect(mockState.space.setState).not.toHaveBeenCalled()
  })
})
