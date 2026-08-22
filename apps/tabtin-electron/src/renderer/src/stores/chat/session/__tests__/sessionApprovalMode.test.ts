import { beforeEach, describe, expect, it, vi } from 'vitest'

const notifyApprovalModeChanged = vi.fn().mockResolvedValue({ success: true, applied: true })
vi.mock('@/services/approvalModeSyncApi', () => ({
  notifyApprovalModeChanged: (...args: unknown[]) => notifyApprovalModeChanged(...args),
}))

const chatState = {
  approvalModeBySessionId: {} as Record<string, string>,
}
const runtimeState = {
  approvalModeBySessionId: {} as Record<string, string>,
  groupRuntimeBySessionId: {} as Record<string, unknown>,
}
const spaceState = {
  selectedSpace: {
    id: 'space-1',
    type: 'workspace',
    approval_grant: 'auto' as string | null,
  } as {
    id: string
    type: string
    approval_grant?: string | null
    project_id?: string | null
    is_archived?: boolean
  } | null,
  spaces: [] as Array<{
    id: string
    type: string
    approval_grant?: string | null
    project_id?: string | null
    is_archived?: boolean
  }>,
  selectedAgent: {
    agent_config: { security: { allow_yolo_mode: true } },
  },
}
const organizationState = {
  selectedOrganization: {
    settings: { allow_member_yolo: true },
  },
}

vi.mock('../../useChatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: typeof chatState) => unknown) => selector(chatState),
    {
      getState: () => chatState,
      setState: (partial: Partial<typeof chatState> | ((s: typeof chatState) => Partial<typeof chatState>)) => {
        const next = typeof partial === 'function' ? partial(chatState) : partial
        Object.assign(chatState, next)
      },
    },
  ),
}))

vi.mock('../../../useChatRuntimeStore', () => ({
  useChatRuntimeStore: Object.assign(
    (selector: (state: typeof runtimeState) => unknown) => selector(runtimeState),
    {
      getState: () => runtimeState,
      setState: (partial: Partial<typeof runtimeState> | ((s: typeof runtimeState) => Partial<typeof runtimeState>)) => {
        const next = typeof partial === 'function' ? partial(runtimeState) : partial
        Object.assign(runtimeState, next)
      },
    },
  ),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (state: typeof spaceState) => unknown) => selector(spaceState),
    { getState: () => spaceState },
  ),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: Object.assign(
    (selector: (state: typeof organizationState) => unknown) => selector(organizationState),
    { getState: () => organizationState },
  ),
}))

describe('sessionApprovalMode', () => {
  beforeEach(() => {
    chatState.approvalModeBySessionId = {}
    runtimeState.approvalModeBySessionId = {}
    runtimeState.groupRuntimeBySessionId = {}
    spaceState.selectedSpace = {
      id: 'space-1',
      type: 'workspace',
      approval_grant: 'auto',
    }
    spaceState.spaces = [spaceState.selectedSpace!]
    spaceState.selectedAgent = {
      agent_config: { security: { allow_yolo_mode: true } },
    }
    notifyApprovalModeChanged.mockClear()
  })

  it('setSessionApprovalMode 不再写入会话权限数据源', async () => {
    const { setSessionApprovalMode } = await import('../sessionApprovalMode')
    setSessionApprovalMode('session-1', 'auto')
    expect(chatState.approvalModeBySessionId['session-1']).toBeUndefined()
    expect(runtimeState.approvalModeBySessionId['session-1']).toBeUndefined()
  })

  it('resolveEffectiveSessionApprovalMode 受 Workspace grant 上限约束', async () => {
    const { setSessionApprovalMode, resolveEffectiveSessionApprovalMode } = await import('../sessionApprovalMode')
    setSessionApprovalMode('session-1', 'full_access')
    expect(resolveEffectiveSessionApprovalMode('session-1')).toBe('auto')
  })

  it('#6021 Workspace full_access 时会话可选中全部允许（不被 Agent legacy 夹回 auto）', async () => {
    spaceState.selectedSpace = {
      id: 'space-1',
      type: 'workspace',
      approval_grant: 'full_access',
    }
    spaceState.spaces = [spaceState.selectedSpace]
    // Agent 仍只有 legacy allow_yolo_mode——旧路径会卡在 auto
    spaceState.selectedAgent = {
      agent_config: { security: { allow_yolo_mode: true } },
    }

    const { setSessionApprovalMode, resolveEffectiveSessionApprovalMode } = await import('../sessionApprovalMode')
    setSessionApprovalMode('session-1', 'full_access')
    expect(resolveEffectiveSessionApprovalMode('session-1')).toBe('full_access')
  })

  it('#9313 忽略旧会话 always_ask，唯一读取 Workspace full_access', async () => {
    spaceState.selectedSpace = {
      id: 'space-1',
      type: 'workspace',
      approval_grant: 'full_access',
    }
    spaceState.spaces = [spaceState.selectedSpace]
    chatState.approvalModeBySessionId['session-1'] = 'always_ask'
    runtimeState.approvalModeBySessionId['session-1'] = 'always_ask'

    const { resolveEffectiveSessionApprovalMode } = await import('../sessionApprovalMode')
    expect(resolveEffectiveSessionApprovalMode('session-1')).toBe('full_access')
  })

  it('#5520 setSessionApprovalMode live 通知主进程更新运行中 session 请求档', async () => {
    const { setSessionApprovalMode } = await import('../sessionApprovalMode')
    setSessionApprovalMode('session-1', 'auto')
    // 动态 import 在 microtask 触发 IPC，await 一次让其落地。
    await vi.waitFor(() => expect(notifyApprovalModeChanged).toHaveBeenCalledTimes(1))
    expect(notifyApprovalModeChanged).toHaveBeenCalledWith({
      sessionId: 'session-1',
      approvalMode: 'auto',
    })
  })
})
