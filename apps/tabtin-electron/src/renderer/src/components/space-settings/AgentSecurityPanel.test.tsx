import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const {
  agentState,
  spaceState,
  chatState,
  runtimeState,
  organizationState,
  toastMock,
  invalidateMock,
  getWorkspaceSnapshotMock,
} = vi.hoisted(() => ({
  agentState: {
    agent: {
      id: 'agent-1',
      agent_config: { security: {} },
    } as {
      id: string
      agent_config?: { security?: { approval_grant?: string; allow_yolo_mode?: boolean } }
    } | null,
  },
  spaceState: {
    selectedSpace: {
      id: 'space-1',
      type: 'workspace',
      approval_grant: 'always_ask' as string | null,
    } as {
      id: string
      type: string
      approval_grant?: string | null
    } | null,
    spaces: [{
      id: 'space-1',
      type: 'workspace',
      approval_grant: 'always_ask' as string | null,
    }],
    updateWorkspaceApprovalGrant: vi.fn().mockResolvedValue(true),
    loadAgent: vi.fn().mockResolvedValue(null),
    revokeApprovalMemoEntry: vi.fn(),
    revokeAllApprovalMemos: vi.fn(),
    isLoading: false,
  },
  chatState: {
    currentSessionId: 'session-1' as string | null,
    currentSessionIdBySpaceId: { 'space-1': 'session-1' } as Record<string, string | null>,
    approvalModeBySessionId: {} as Record<string, string>,
  },
  runtimeState: {
    approvalModeBySessionId: {} as Record<string, string>,
    groupRuntimeBySessionId: {} as Record<string, unknown>,
  },
  organizationState: {
    selectedOrganization: {
      id: 'org-1',
      settings: { allow_member_yolo: true },
    } as { id: string; settings?: { allow_member_yolo?: boolean } } | null,
  },
  toastMock: vi.fn(),
  invalidateMock: vi.fn().mockResolvedValue(undefined),
  getWorkspaceSnapshotMock: vi.fn().mockResolvedValue({ sources: {} }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opt?: { defaultValue?: string }) => {
      const dict: Record<string, string> = {
        'security.approvalGrantLabel': '审批权限授权',
        'security.approvalGrant.always_ask.name': '请求权限',
        'security.approvalGrant.always_ask.description': '操作前先请求授权',
        'security.approvalGrant.auto.name': '自动通过',
        'security.approvalGrant.auto.description': '常规操作自动批准，高风险仍会询问',
        'security.approvalGrant.full_access.name': '全部允许',
        'security.approvalGrant.full_access.description': '无需授权直接执行',
        'security.approvalGrantConfirmTitle': `授权「${String(opt?.tier ?? '')}」？`,
        'security.approvalGrantOrgBadge': '组织未开放',
        'security.approvalGrantManageBadge': '需管理员授权',
      }
      return opt?.defaultValue ?? dict[key] ?? key
    },
  }),
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  ConfirmDialog: ({
    open,
    title,
    onConfirm,
  }: {
    open: boolean
    title: string
    onConfirm: () => void
  }) => open ? (
    <div role="dialog">
      <p>{title}</p>
      <button type="button" onClick={onConfirm}>确认</button>
    </div>
  ) : null,
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  toast: (...args: unknown[]) => toastMock(...args),
}))

vi.mock('@utils/cn', () => ({
  cn: (...xs: unknown[]) => xs.filter(Boolean).join(' '),
}))

vi.mock('@stores/useSpaceStore', () => {
  const useSpaceStore = vi.fn((selector: (state: typeof spaceState) => unknown) => selector(spaceState))
  useSpaceStore.getState = () => spaceState
  return { useSpaceStore }
})

vi.mock('@stores/chat/useChatStore', () => {
  const useChatStore = vi.fn((selector: (state: typeof chatState) => unknown) => selector(chatState))
  useChatStore.getState = () => chatState
  useChatStore.setState = (partial: Partial<typeof chatState> | ((state: typeof chatState) => Partial<typeof chatState>)) => {
    const next = typeof partial === 'function' ? partial(chatState) : partial
    Object.assign(chatState, next)
  }
  return { useChatStore }
})

vi.mock('@stores/useChatRuntimeStore', () => {
  const useChatRuntimeStore = Object.assign(
    vi.fn((selector: (state: typeof runtimeState) => unknown) => selector(runtimeState)),
    {
      getState: () => runtimeState,
      setState: (partial: Partial<typeof runtimeState> | ((state: typeof runtimeState) => Partial<typeof runtimeState>)) => {
        const next = typeof partial === 'function' ? partial(runtimeState) : partial
        Object.assign(runtimeState, next)
      },
    },
  )
  return { useChatRuntimeStore }
})

vi.mock('@stores/useOrganizationStore', () => {
  const useOrganizationStore = vi.fn((selector: (state: typeof organizationState) => unknown) => selector(organizationState))
  useOrganizationStore.getState = () => organizationState
  return { useOrganizationStore }
})

vi.mock('./hooks/useSpaceExecutionAgent', () => ({
  useSpaceExecutionAgent: () => ({
    space: spaceState.spaces[0] ?? null,
    agent: agentState.agent,
    agentId: agentState.agent?.id ?? null,
    ensureAgent: vi.fn().mockResolvedValue(agentState.agent),
    isLoading: false,
  }),
}))

vi.mock('@components/workspace/notifyWorkspacePaths', () => ({
  notifyWorkspacePathsForSpace: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/services/agentConfigCacheApi', () => ({
  invalidateAgentConfigCache: (...args: unknown[]) => invalidateMock(...args),
}))

vi.mock('@components/space-settings/SpaceSettingsSectionHeader', () => ({
  SpaceSettingsSectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}))

import { AgentSecurityPanel } from './AgentSecurityPanel'

function autoButton(): HTMLButtonElement {
  return screen.getByRole('radio', { name: /自动通过/ }) as HTMLButtonElement
}

function setWorkspaceGrant(grant: string): void {
  const workspace = { id: 'space-1', type: 'workspace', approval_grant: grant }
  spaceState.selectedSpace = workspace
  spaceState.spaces = [workspace]
}

beforeEach(() => {
  vi.clearAllMocks()
  agentState.agent = {
    id: 'agent-1',
    agent_config: { security: {} },
  }
  setWorkspaceGrant('always_ask')
  spaceState.updateWorkspaceApprovalGrant.mockResolvedValue(true)
  chatState.currentSessionId = 'session-1'
  chatState.currentSessionIdBySpaceId = { 'space-1': 'session-1' }
  chatState.approvalModeBySessionId = {}
  runtimeState.approvalModeBySessionId = {}
  runtimeState.groupRuntimeBySessionId = {}
  organizationState.selectedOrganization = {
    id: 'org-1',
    settings: { allow_member_yolo: true },
  }
  getWorkspaceSnapshotMock.mockResolvedValue({ sources: {} })
  ;(window as unknown as {
    tabtin?: { agentSecurity?: { getWorkspaceSnapshot?: () => Promise<unknown> } }
  }).tabtin = {
    agentSecurity: {
      getWorkspaceSnapshot: getWorkspaceSnapshotMock,
    },
  }
})

async function renderPanel(canManage = true, sessionId: string | null = null): Promise<void> {
  render(<AgentSecurityPanel spaceId="space-1" canManage={canManage} sessionId={sessionId} />)
  await waitFor(() => {
    expect(getWorkspaceSnapshotMock).toHaveBeenCalledWith('space-1')
  })
}

describe('AgentSecurityPanel approval selection', () => {
  it('已授权档位内选择只写当前会话，不更新工作空间 grant', async () => {
    setWorkspaceGrant('auto')
    // 会话曾下调到 always_ask；点回 auto 时 grant 已到位，只同步会话
    chatState.approvalModeBySessionId = { 'session-1': 'always_ask' }

    await renderPanel(false)
    fireEvent.click(autoButton())

    expect(chatState.approvalModeBySessionId['session-1']).toBe('auto')
    expect(runtimeState.approvalModeBySessionId['session-1']).toBe('auto')
    expect(spaceState.updateWorkspaceApprovalGrant).not.toHaveBeenCalled()
  })

  it('显式 sessionId 优先于全局 currentSessionId，避免跨 Space 写错会话', async () => {
    setWorkspaceGrant('auto')
    chatState.currentSessionId = 'session-b'
    chatState.currentSessionIdBySpaceId = { 'space-1': 'session-a' }
    chatState.approvalModeBySessionId = { 'session-a': 'always_ask' }

    await renderPanel(true, 'session-a')
    fireEvent.click(autoButton())

    expect(chatState.approvalModeBySessionId['session-a']).toBe('auto')
    expect(runtimeState.approvalModeBySessionId['session-a']).toBe('auto')
    expect(chatState.approvalModeBySessionId['session-b']).toBeUndefined()
    expect(runtimeState.approvalModeBySessionId['session-b']).toBeUndefined()
  })

  it('超过授权上限时确认更新工作空间 grant，成功后写当前会话', async () => {
    await renderPanel()
    fireEvent.click(autoButton())
    fireEvent.click(screen.getByText('确认'))

    await waitFor(() => {
      expect(spaceState.updateWorkspaceApprovalGrant).toHaveBeenCalledWith('space-1', 'auto')
      expect(runtimeState.approvalModeBySessionId['session-1']).toBe('auto')
    })
  })

  it('新任务草稿（无 session）仍可升档更新工作空间 grant，选项不因缺 session 禁用', async () => {
    chatState.currentSessionId = null
    chatState.currentSessionIdBySpaceId = { 'space-1': null }
    chatState.approvalModeBySessionId = {}

    await renderPanel(true, null)
    const trigger = autoButton()
    expect(trigger.disabled).toBe(false)

    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('确认'))

    await waitFor(() => {
      expect(spaceState.updateWorkspaceApprovalGrant).toHaveBeenCalledWith('space-1', 'auto')
    })
    // 草稿尚无会话：只抬 grant，不写 per-session 审批档
    expect(Object.keys(runtimeState.approvalModeBySessionId)).toHaveLength(0)
    expect(Object.keys(chatState.approvalModeBySessionId)).toHaveLength(0)
  })

  it('授权更新失败时不写当前会话', async () => {
    spaceState.updateWorkspaceApprovalGrant.mockResolvedValue(false)

    await renderPanel()
    fireEvent.click(autoButton())
    fireEvent.click(screen.getByText('确认'))

    await waitFor(() => {
      expect(spaceState.updateWorkspaceApprovalGrant).toHaveBeenCalled()
      expect(runtimeState.approvalModeBySessionId['session-1']).toBeUndefined()
    })
  })

  it('group 会话固定请求批准，不写当前会话也不更新 grant', async () => {
    setWorkspaceGrant('full_access')
    runtimeState.groupRuntimeBySessionId = { 'session-1': { is_active: true } }

    await renderPanel()
    fireEvent.click(autoButton())

    expect(runtimeState.approvalModeBySessionId['session-1']).toBeUndefined()
    expect(spaceState.updateWorkspaceApprovalGrant).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalled()
  })

  it('组织未开放时宽松审批选项禁用并显示 badge', async () => {
    setWorkspaceGrant('full_access')
    organizationState.selectedOrganization = {
      id: 'org-1',
      settings: { allow_member_yolo: false },
    }

    await renderPanel(false)
    const trigger = autoButton()

    expect(trigger.disabled).toBe(true)
    expect(screen.getAllByText('组织未开放').length).toBeGreaterThan(0)
    fireEvent.click(trigger)
    expect(runtimeState.approvalModeBySessionId['session-1']).toBeUndefined()
    expect(spaceState.updateWorkspaceApprovalGrant).not.toHaveBeenCalled()
  })

  it('非管理者可使用已授权档位，但不能抬高 Workspace grant', async () => {
    setWorkspaceGrant('auto')
    chatState.approvalModeBySessionId = { 'session-1': 'always_ask' }

    await renderPanel(false)
    fireEvent.click(autoButton())

    expect(runtimeState.approvalModeBySessionId['session-1']).toBe('auto')
    expect(spaceState.updateWorkspaceApprovalGrant).not.toHaveBeenCalled()

    const fullAccessButton = screen.getByRole('radio', { name: /全部允许/ }) as HTMLButtonElement
    expect(fullAccessButton.disabled).toBe(true)
    expect(screen.getByText('需管理员授权')).not.toBeNull()
  })
})
