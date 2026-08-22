import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authStateRef, organizationStateRef, mockTriggerCreate } = vi.hoisted(() => ({
  authStateRef: {
    current: { authPhase: 'authenticated' as const, user: { id: 'user-1' } },
  },
  organizationStateRef: {
    current: {
      selectedOrganization: null as null | {
        id: string
        name: string
        type: 'personal' | 'team'
        owner_id: string
      },
      currentUserRole: null as null | 'owner' | 'admin' | 'editor' | 'viewer',
    },
  },
  mockTriggerCreate: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: string | { defaultValue?: string },
    ) => {
      const template = typeof options === 'string'
        ? options
        : typeof options?.defaultValue === 'string'
          ? options.defaultValue
          : key
      if (!options || typeof options === 'string') return template
      return Object.entries(options).reduce((text, [name, value]) => (
        text.replaceAll(`{{${name}}}`, String(value))
      ), template)
    },
  }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(authStateRef.current),
  selectIsAuthenticated: (state: { authPhase?: string }) => state.authPhase === 'authenticated',
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: typeof organizationStateRef.current) => unknown) =>
    selector(organizationStateRef.current),
}))

vi.mock('@components/auth', () => ({
  AuthDialog: () => null,
}))

vi.mock('@components/sidebar/NewSpaceButton', () => ({
  useCreateSpaceFlow: () => ({
    triggerCreate: mockTriggerCreate,
  }),
}))

vi.mock('@components/tabchat/CreateConversationDialog', () => ({
  CreateConversationDialog: () => null,
}))

describe('WelcomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authStateRef.current = { authPhase: 'authenticated' as const, user: { id: 'user-1' } }
    organizationStateRef.current = {
      selectedOrganization: null,
      currentUserRole: null,
    }
  })

  it('点击"创建第一个 Space"触发 triggerCreate（直接开 dialog，不弹 OS 选目录窗）', async () => {
    const { WelcomePage } = await import('./WelcomePage')

    render(React.createElement(WelcomePage))

    fireEvent.click(screen.getByRole('button', { name: '创建第一个 Space' }))

    expect(mockTriggerCreate).toHaveBeenCalledTimes(1)
  })

  it('被邀请加入的团队暂无 Space 时显示团队空态，而不是新用户 ready 文案', async () => {
    organizationStateRef.current = {
      selectedOrganization: {
        id: 'wt-team',
        name: '设计团队',
        type: 'team',
        owner_id: 'owner-1',
      },
      currentUserRole: 'editor',
    }
    const { WelcomePage } = await import('./WelcomePage')

    render(React.createElement(WelcomePage))

    expect(screen.queryByText('准备好了！')).toBeNull()
    expect(screen.getByText('已加入「设计团队」')).toBeTruthy()

    // 文案随 Workteam→Organization 改名收口为「在此组织创建 Space」
    fireEvent.click(screen.getByRole('button', { name: '在此组织创建 Space' }))

    expect(mockTriggerCreate).toHaveBeenCalledTimes(1)
  })

  it('团队 owner 暂无 Space 时仍显示创建第一个 Space 的新用户文案', async () => {
    organizationStateRef.current = {
      selectedOrganization: {
        id: 'wt-owned-team',
        name: 'Owner 团队',
        type: 'team',
        owner_id: 'user-1',
      },
      currentUserRole: 'owner',
    }
    const { WelcomePage } = await import('./WelcomePage')

    render(React.createElement(WelcomePage))

    expect(screen.getByText('准备好了！')).toBeTruthy()
    expect(screen.getByRole('button', { name: '创建第一个 Space' })).toBeTruthy()
  })

  it('个人 organization 暂无 Space 时仍显示创建第一个 Space 的新用户文案', async () => {
    organizationStateRef.current = {
      selectedOrganization: {
        id: 'wt-personal',
        name: '个人空间',
        type: 'personal',
        owner_id: 'user-1',
      },
      currentUserRole: 'owner',
    }
    const { WelcomePage } = await import('./WelcomePage')

    render(React.createElement(WelcomePage))

    expect(screen.getByText('准备好了！')).toBeTruthy()
    expect(screen.getByRole('button', { name: '创建第一个 Space' })).toBeTruthy()
  })

  it('角色尚未加载时用 owner_id 识别被邀请团队', async () => {
    organizationStateRef.current = {
      selectedOrganization: {
        id: 'wt-team-loading-role',
        name: '协作团队',
        type: 'team',
        owner_id: 'owner-1',
      },
      currentUserRole: null,
    }
    const { WelcomePage } = await import('./WelcomePage')

    render(React.createElement(WelcomePage))

    expect(screen.queryByText('准备好了！')).toBeNull()
    expect(screen.getByText('已加入「协作团队」')).toBeTruthy()
  })

  it('未登录时仍显示访客欢迎页', async () => {
    authStateRef.current = { authPhase: 'anonymous' as const, user: null }
    const { WelcomePage } = await import('./WelcomePage')

    render(React.createElement(WelcomePage))

    expect(screen.getByText('AI 不再只是')).toBeTruthy()
    expect(screen.queryByText('准备好了！')).toBeNull()
  })
})
