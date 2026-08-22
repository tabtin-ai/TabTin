import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockMarkNavClicked, mockDetectionRef } = vi.hoisted(() => {
  const markNavClicked = vi.fn()
  return {
    mockMarkNavClicked: markNavClicked,
    mockDetectionRef: {
      current: {
        loading: false,
        shouldShow: false,
        claudeUrgent: false,
        markNavClicked,
      },
    },
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { authPhase: string }) => unknown) =>
    selector({ authPhase: 'authenticated' }),
  selectIsAuthenticated: (state: { authPhase: string }) => state.authPhase === 'authenticated',
}))

vi.mock('@components/onboarding/external-import/useExternalImportDetection', () => ({
  useExternalImportDetection: () => mockDetectionRef.current,
}))

import { SidebarTaskPrimaryNav } from './SidebarTaskPrimaryNav'

describe('SidebarTaskPrimaryNav', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDetectionRef.current = {
      loading: false,
      shouldShow: false,
      claudeUrgent: false,
      markNavClicked: mockMarkNavClicked,
    }
  })

  it('renders vertical primary-nav rows and dispatches navigation', () => {
    const onNavigate = vi.fn()
    render(
      <SidebarTaskPrimaryNav
        activePrimaryNavId="automation"
        onNavigate={onNavigate}
      />,
    )

    expect(screen.getByTestId('sidebar-new-task-button').className).toContain('px-1.5')
    expect(screen.getByTestId('sidebar-new-task-button').className).toContain('mx-1.5')
    expect(screen.getByTestId('sidebar-task-module-link-automation').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('sidebar-task-module-link-skills').getAttribute('aria-current')).toBeNull()

    fireEvent.click(screen.getByTestId('sidebar-task-module-link-skills'))
    expect(onNavigate).toHaveBeenCalledWith('skills')

    fireEvent.click(screen.getByTestId('sidebar-new-task-button'))
    expect(onNavigate).toHaveBeenCalledWith('new-task')
  })

  it('「导入数据」点击时标记 nav 已读并导航至导入页', () => {
    const onNavigate = vi.fn()
    render(
      <SidebarTaskPrimaryNav
        activePrimaryNavId="new-task"
        onNavigate={onNavigate}
      />,
    )

    fireEvent.click(screen.getByTestId('sidebar-import-data-button'))
    expect(mockMarkNavClicked).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith('import-data')
  })

  it('检测到可导入历史时显示指示灯', () => {
    mockDetectionRef.current = {
      loading: false,
      shouldShow: true,
      claudeUrgent: false,
      markNavClicked: mockMarkNavClicked,
    }

    render(
      <SidebarTaskPrimaryNav
        activePrimaryNavId="new-task"
        onNavigate={vi.fn()}
      />,
    )

    expect(screen.getByTestId('sidebar-import-data-indicator')).toBeTruthy()
  })

  it('导入页激活时侧栏高亮', () => {
    render(
      <SidebarTaskPrimaryNav
        activePrimaryNavId="import-data"
        onNavigate={vi.fn()}
      />,
    )

    expect(screen.getByTestId('sidebar-import-data-button').getAttribute('aria-current')).toBe('page')
  })

  it('顶栏不再常驻「外部历史」（档案挂在工作空间下）', () => {
    render(
      <SidebarTaskPrimaryNav
        activePrimaryNavId="new-task"
        onNavigate={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('sidebar-external-history-button')).toBeNull()
  })
})
