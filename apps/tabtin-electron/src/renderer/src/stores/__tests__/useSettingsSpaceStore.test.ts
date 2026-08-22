import { beforeEach, describe, expect, it, vi } from 'vitest'

type MainNavTab = 'im' | 'agent' | 'project' | 'me'
type NavigationTarget = 'settings' | 'space' | 'im'

let currentTab: MainNavTab = 'agent'
const setCurrentTabMock = vi.fn((tab: MainNavTab) => {
  const prev = { currentTab }
  currentTab = tab
  for (const listener of mainNavListeners) {
    listener({ currentTab }, prev)
  }
})
const mainNavListeners = new Set<(state: { currentTab: MainNavTab }, prev: { currentTab: MainNavTab }) => void>()
const navigationListeners = new Set<(target: NavigationTarget) => void>()
const organizationListeners = new Set<(state: OrganizationMockState, prev: OrganizationMockState) => void>()
const closeAuxiliaryPanelsMock = vi.fn()

type OrganizationMock = { id: string; type: 'team' | 'personal' }
type OrganizationMockState = {
  selectedOrganization: OrganizationMock | null
  organizations: OrganizationMock[]
}

const organizationOne: OrganizationMock = { id: 'wt-1', type: 'team' }
const organizationTwo: OrganizationMock = { id: 'wt-2', type: 'team' }
let organizationState: OrganizationMockState = {
  selectedOrganization: organizationOne,
  organizations: [organizationOne, organizationTwo],
}

function setSelectedOrganizationForTest(next: OrganizationMock | null): void {
  const prev = organizationState
  organizationState = { ...organizationState, selectedOrganization: next }
  for (const listener of organizationListeners) {
    listener(organizationState, prev)
  }
}

vi.mock('../useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({ currentTab, setCurrentTab: setCurrentTabMock }),
    subscribe: (listener: (state: { currentTab: MainNavTab }, prev: { currentTab: MainNavTab }) => void) => {
      mainNavListeners.add(listener)
      return () => mainNavListeners.delete(listener)
    },
  },
}))

vi.mock('../useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => organizationState,
    subscribe: (listener: (state: OrganizationMockState, prev: OrganizationMockState) => void) => {
      organizationListeners.add(listener)
      return () => organizationListeners.delete(listener)
    },
  },
}))

vi.mock('../viewNavigation', () => ({
  emitNavigate: (target: NavigationTarget) => {
    for (const listener of navigationListeners) listener(target)
  },
  onNavigate: (listener: (target: NavigationTarget) => void) => {
    navigationListeners.add(listener)
    return () => navigationListeners.delete(listener)
  },
}))

vi.mock('@tabtin/app-shell', () => ({
  getRuntime: () => ({
    bridge: {
      closeAuxiliaryPanels: closeAuxiliaryPanelsMock,
    },
  }),
}))

describe('useSettingsSpaceStore ', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
    vi.clearAllMocks()
    currentTab = 'agent'
    mainNavListeners.clear()
    navigationListeners.clear()
    organizationListeners.clear()
    organizationState = {
      selectedOrganization: organizationOne,
      organizations: [organizationOne, organizationTwo],
    }
  })

  it('显式关闭设置时退出 me tab，但不清空当前设置路由', async () => {
    const { useSettingsSpaceStore } = await import('../useSettingsSpaceStore')

    useSettingsSpaceStore.getState().openSettings({
      category: 'organization',
      section: 'usageBilling',
      organizationId: 'wt-1',
    })

    expect(currentTab).toBe('me')

    useSettingsSpaceStore.getState().closeSettings()

    expect(useSettingsSpaceStore.getState().isOpen).toBe(false)
    expect(currentTab).toBe('agent')
    expect(useSettingsSpaceStore.getState().activeRoute).toEqual({
      category: 'organization',
      section: 'usageBilling',
      organizationId: 'wt-1',
    })
  })

  it('设置页可见时，后台 space 导航事件不应把用户打回首页', async () => {
    const { useSettingsSpaceStore } = await import('../useSettingsSpaceStore')

    useSettingsSpaceStore.getState().openSettings({ category: 'profile', section: 'preferences' })
    navigationListeners.forEach(listener => listener('space'))

    expect(currentTab).toBe('me')
    expect(useSettingsSpaceStore.getState().isOpen).toBe(true)
    expect(useSettingsSpaceStore.getState().activeRoute).toEqual({
      category: 'profile',
      section: 'preferences',
    })
  })

  it('模块重新加载后恢复上次停留的设置路由', async () => {
    const firstModule = await import('../useSettingsSpaceStore')
    firstModule.useSettingsSpaceStore.getState().openSettings({ category: 'device', section: 'advancedConnections' })

    vi.resetModules()
    currentTab = 'agent'
    mainNavListeners.clear()
    navigationListeners.clear()

    const secondModule = await import('../useSettingsSpaceStore')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(currentTab).toBe('me')
    expect(secondModule.useSettingsSpaceStore.getState().isOpen).toBe(true)
    expect(secondModule.useSettingsSpaceStore.getState().activeRoute).toEqual({
      category: 'device',
      section: 'advancedConnections',
    })
  })

  it('恢复打开中的设置页时抵抗启动期 mainNav 回退到 agent', async () => {
    const firstModule = await import('../useSettingsSpaceStore')
    firstModule.useSettingsSpaceStore.getState().openSettings({ category: 'profile', section: 'preferences' })

    vi.resetModules()
    currentTab = 'agent'
    mainNavListeners.clear()
    navigationListeners.clear()

    const secondModule = await import('../useSettingsSpaceStore')
    await new Promise(resolve => setTimeout(resolve, 0))

    setCurrentTabMock('agent')
    await new Promise(resolve => queueMicrotask(resolve))

    expect(currentTab).toBe('me')
    expect(secondModule.useSettingsSpaceStore.getState().isOpen).toBe(true)
    expect(secondModule.useSettingsSpaceStore.getState().activeRoute).toEqual({
      category: 'profile',
      section: 'preferences',
    })
  })

  it('恢复打开中的设置页时忽略启动期 space 导航事件', async () => {
    const firstModule = await import('../useSettingsSpaceStore')
    firstModule.useSettingsSpaceStore.getState().openSettings({ category: 'profile', section: 'preferences' })

    vi.resetModules()
    currentTab = 'agent'
    mainNavListeners.clear()
    navigationListeners.clear()

    const secondModule = await import('../useSettingsSpaceStore')
    navigationListeners.forEach(listener => listener('space'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(currentTab).toBe('me')
    expect(secondModule.useSettingsSpaceStore.getState().isOpen).toBe(true)
    expect(secondModule.useSettingsSpaceStore.getState().activeRoute).toEqual({
      category: 'profile',
      section: 'preferences',
    })
  })

  it('设置页打开中时，非显式 mainNav 回退会被拉回 me', async () => {
    const { useSettingsSpaceStore } = await import('../useSettingsSpaceStore')

    useSettingsSpaceStore.getState().openSettings({ category: 'profile', section: 'preferences' })

    setCurrentTabMock('agent')
    await new Promise(resolve => queueMicrotask(resolve))

    expect(currentTab).toBe('me')
    expect(useSettingsSpaceStore.getState().isOpen).toBe(true)
    expect(useSettingsSpaceStore.getState().activeRoute).toEqual({
      category: 'profile',
      section: 'preferences',
    })
  })

  it('全局切换团队时同步当前团队设置路由，避免设置页继续显示旧团队', async () => {
    const { useSettingsSpaceStore } = await import('../useSettingsSpaceStore')

    useSettingsSpaceStore.getState().openSettings({
      category: 'organization',
      section: 'teamMembers',
      organizationId: 'wt-1',
    })

    expect(useSettingsSpaceStore.getState().activeRoute).toEqual({
      category: 'organization',
      section: 'teamMembers',
      organizationId: 'wt-1',
    })

    setSelectedOrganizationForTest(organizationTwo)

    expect(useSettingsSpaceStore.getState().activeRoute).toEqual({
      category: 'organization',
      section: 'teamMembers',
      organizationId: 'wt-2',
    })
  })
})
