import React, { useEffect, useRef } from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SpaceSidebarGlobal } from './SpaceSidebarGlobal'

const mocks = vi.hoisted(() => ({
  effectiveMainNavTab: 'agent' as 'agent' | 'im',
  loadSessions: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@stores/useAuthStore', () => ({
  selectIsAuthenticated: () => true,
  useAuthStore: (selector: (state: { isAuthenticated: boolean }) => unknown) => (
    selector({ isAuthenticated: true })
  ),
}))

vi.mock('./primaryNavigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./primaryNavigation')>()
  return {
    ...actual,
    usePrimaryNavigation: () => ({
      effectiveMainNavTab: mocks.effectiveMainNavTab,
      activeAppPage: null,
      isProjectNavActive: false,
      personalConversationSpaceId: 'space-1',
      projectConversationSpaceId: null,
      selectedProjectSpace: null,
      handlePrimaryNavigation: vi.fn(),
      setSidebarMode: vi.fn(),
      handleExitProject: vi.fn(),
      activePrimaryNavId: null,
    }),
  }
})

vi.mock('@components/context-space/SidebarConversationList', () => ({
  SidebarConversationList: () => {
    const loadedRef = useRef(false)
    useEffect(() => {
      if (loadedRef.current) return
      loadedRef.current = true
      mocks.loadSessions()
    }, [])
    return <button type="button">持续显示的任务</button>
  },
}))

vi.mock('./SidebarTaskPrimaryNav', () => ({ SidebarTaskPrimaryNav: () => <div>任务导航</div> }))
vi.mock('./SidebarIMPanel', () => ({ SidebarIMPanel: () => <div>消息列表</div> }))
vi.mock('./SidebarMePanel', () => ({ SidebarMePanel: () => <div>我的</div> }))
vi.mock('./SidebarAgentsPanel', () => ({ SidebarAgentsPanel: () => <div>AI 分身</div> }))
vi.mock('./SidebarCloudDocsPanel', () => ({ SidebarCloudDocsPanel: () => <div>云文档</div> }))
vi.mock('./CurrentProjectHeader', () => ({ CurrentProjectHeader: () => <div>项目</div> }))
vi.mock('@components/sidebar/SpaceSwitcherPopover', () => ({
  SpaceSwitcherPopover: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('./SidebarMenuItem', () => ({ SidebarMenuItem: () => <button type="button">选择工作空间</button> }))

describe('SpaceSidebarGlobal 会话侧栏连续性', () => {
  beforeEach(() => {
    mocks.effectiveMainNavTab = 'agent'
    mocks.loadSessions.mockClear()
  })

  it('从消息域回到任务首页时复用原会话列表且不重复加载', () => {
    const props = {
      executionSpaceId: 'space-1',
      workspaceScopeKey: 'desktop:organization-1:user:user-1',
      sidebarContentPortalRef: { current: null },
    }
    const { rerender } = render(<SpaceSidebarGlobal {...props} />)
    const initialSessionRow = screen.getByRole('button', { name: '持续显示的任务' })
    expect(mocks.loadSessions).toHaveBeenCalledTimes(1)

    mocks.effectiveMainNavTab = 'im'
    rerender(<SpaceSidebarGlobal {...props} />)
    expect(screen.getByText('消息列表')).toBeTruthy()
    expect(mocks.loadSessions).toHaveBeenCalledTimes(1)

    mocks.effectiveMainNavTab = 'agent'
    rerender(<SpaceSidebarGlobal {...props} />)
    expect(screen.getByRole('button', { name: '持续显示的任务' })).toBe(initialSessionRow)
    expect(mocks.loadSessions).toHaveBeenCalledTimes(1)
  })
})
