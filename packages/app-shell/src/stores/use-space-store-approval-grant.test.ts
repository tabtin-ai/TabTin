/** ：updateWorkspaceApprovalGrant 失败路径必须打 log.error（不改 toast）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tabtin/shared', () => ({
  withPersistSafety: (options: unknown) => options,
}))

vi.mock('@tabtin/config', () => ({
  API_ENDPOINTS: {},
  joinApiPath: (...parts: string[]) => parts.filter(Boolean).join('/'),
}))

const mockUpdateApprovalGrant = vi.fn()

vi.mock('../services/space-api.js', () => ({
  SpaceApiService: {},
  ProjectApiService: { list: vi.fn() },
  WorkspaceApiService: {
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    updateApprovalGrant: (...args: unknown[]) => mockUpdateApprovalGrant(...args),
  },
  AgentApiService: { getAgent: vi.fn(), listAgents: vi.fn() },
  ApprovalMemoApiService: {},
}))

vi.mock('../runtime.js', () => ({
  getRuntime: () => ({
    bridge: {
      onSpaceDeleted: vi.fn(),
      resolveCrawlspaceId: vi.fn(() => null),
      setActiveSpace: vi.fn(),
      getCurrentDeviceId: () => null,
    },
  }),
}))

vi.mock('./view-navigation.js', () => ({
  onNavigate: vi.fn(),
  emitNavigate: vi.fn(),
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

vi.mock('./use-agent-store.js', () => ({
  useAgentStore: {
    getState: () => ({ selectAgent: vi.fn() }),
  },
}))

const { useSpaceStore } = await import('./use-space-store.js')
const { resetFrontendContextReady } = await import('./frontend-context-ready.js')

beforeEach(() => {
  vi.clearAllMocks()
  resetFrontendContextReady()
  useSpaceStore.setState({
    spaces: [{ id: 'ws-12345678-abcd', approval_grant: 'always_ask' } as never],
    selectedSpace: null,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('#6532 updateWorkspaceApprovalGrant 失败路径可诊断', () => {
  it('PATCH 失败 → log.error 携带截断 workspaceId + message', async () => {
    mockUpdateApprovalGrant.mockRejectedValue(new Error('workspace not found'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ok = await useSpaceStore.getState().updateWorkspaceApprovalGrant(
      'ws-12345678-abcd',
      'full_access',
    )

    expect(ok).toBe(false)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const [, , payload] = errorSpy.mock.calls[0] as [string, string, { workspaceId: string; error: string }]
    expect(payload.workspaceId).toBe('ws-12345…')
    expect(payload.error).toBe('workspace not found')
  })

  it('PATCH 成功 → 不打 error 日志', async () => {
    mockUpdateApprovalGrant.mockResolvedValue({
      approval_grant: 'full_access',
      approval_memo_generation: 1,
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    useSpaceStore.setState({
      selectedSpace: { id: 'ws-12345678-abcd', approval_grant: 'always_ask' } as never,
    })

    const ok = await useSpaceStore.getState().updateWorkspaceApprovalGrant(
      'ws-12345678-abcd',
      'full_access',
    )

    expect(ok).toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
    const { getFrontendContextReady } = await import('./frontend-context-ready.js')
    expect(getFrontendContextReady()).toMatchObject({
      workspaceId: 'ws-12345678-abcd',
      approvalGrantKnown: true,
    })
  })
})

describe('Workspace frontend context ready 接线', () => {
  it('删除当前 Workspace 后清空其上下文就绪状态', async () => {
    const {
      getFrontendContextReady,
      notifyWorkspaceContextChanged,
    } = await import('./frontend-context-ready.js')
    const workspace = {
      id: 'ws-12345678-abcd',
      approval_grant: 'always_ask',
    } as never
    useSpaceStore.setState({
      spaces: [workspace],
      selectedSpace: workspace,
    })
    notifyWorkspaceContextChanged(workspace)

    await useSpaceStore.getState().deleteSpace('ws-12345678-abcd')

    expect(getFrontendContextReady()).toMatchObject({
      workspaceId: null,
      approvalGrantKnown: false,
    })
  })

  it('收到当前 Workspace 被删除的推送后清空其上下文就绪状态', async () => {
    const {
      getFrontendContextReady,
      notifyWorkspaceContextChanged,
    } = await import('./frontend-context-ready.js')
    const workspace = {
      id: 'ws-12345678-abcd',
      approval_grant: 'always_ask',
    } as never
    const listeners: Array<(envelope: unknown) => void> = []
    const gateway = {
      addListener: (listener: (envelope: unknown) => void) => listeners.push(listener),
      onReconnectedEvent: vi.fn(),
    }
    useSpaceStore.setState({
      spaces: [workspace],
      selectedSpace: workspace,
    })
    notifyWorkspaceContextChanged(workspace)
    useSpaceStore.getState().initSpaceWsListener(gateway as never)

    listeners[0]?.({
      type: 'space_list_changed',
      action: 'deleted',
      space_id: 'ws-12345678-abcd',
    })

    expect(getFrontendContextReady()).toMatchObject({
      workspaceId: null,
      approvalGrantKnown: false,
    })
  })
})
