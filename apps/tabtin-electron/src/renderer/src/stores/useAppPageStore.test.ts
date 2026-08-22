import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  setCurrentTab: vi.fn(),
  closeSettings: vi.fn(),
  isSettingsOpen: false,
}))

vi.mock('./useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({ setCurrentTab: mocks.setCurrentTab }),
  },
}))

vi.mock('./useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: {
    getState: () => ({
      isOpen: mocks.isSettingsOpen,
      closeSettings: mocks.closeSettings,
    }),
  },
}))

import { useAppPageStore } from './useAppPageStore'

describe('useAppPageStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isSettingsOpen = false
    useAppPageStore.setState({ activePage: null, activeProjectId: null })
  })

  it('openProjectPage：切回 agent 工作台 + 记录 project 页', () => {
    useAppPageStore.getState().openProjectPage('team-space-1')

    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(useAppPageStore.getState().activePage).toBe('project')
    expect(useAppPageStore.getState().activeProjectId).toBe('team-space-1')
  })

  it('openAppPage 与 openProjectPage 互清 activeProjectId', () => {
    useAppPageStore.getState().openProjectPage('team-space-1')
    useAppPageStore.getState().openAppPage('skill')

    expect(useAppPageStore.getState().activePage).toBe('skill')
    expect(useAppPageStore.getState().activeProjectId).toBe(null)
  })

  it('openAppPage(collaboration) 清空 selectedProjectId', () => {
    useAppPageStore.getState().openProjectPage('team-space-1')
    useAppPageStore.getState().openAppPage('collaboration')

    expect(useAppPageStore.getState().activePage).toBe('collaboration')
    expect(useAppPageStore.getState().activeProjectId).toBe(null)
  })

  it('openAppPage(automation) 记录 automation 页', () => {
    useAppPageStore.getState().openAppPage('automation')

    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(useAppPageStore.getState().activePage).toBe('automation')
  })

  it('openAppPage(notification) 在主工作台打开通知中心', () => {
    useAppPageStore.getState().openAppPage('notification')

    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(useAppPageStore.getState().activePage).toBe('notification')
    expect(useAppPageStore.getState().activeProjectId).toBe(null)
  })

  it('新建组织后仍在设置页时，首次打开通知中心应先退出设置态', () => {
    mocks.isSettingsOpen = true

    useAppPageStore.getState().openAppPage('notification')

    expect(mocks.closeSettings).toHaveBeenCalledOnce()
    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(mocks.closeSettings.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.setCurrentTab.mock.invocationCallOrder[0])
    expect(useAppPageStore.getState().activePage).toBe('notification')
  })

  it('closeAppPage：同时清 activePage 与 activeProjectId', () => {
    useAppPageStore.getState().openProjectPage('team-space-1')
    useAppPageStore.getState().closeAppPage()

    expect(useAppPageStore.getState().activePage).toBe(null)
    expect(useAppPageStore.getState().activeProjectId).toBe(null)
  })
})
