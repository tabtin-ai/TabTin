import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/logger', () => {
  const stub = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  return {
    createLogger: () => stub,
    logger: stub,
  }
})

import { useAppPageStore } from '@stores/useAppPageStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useUIStore } from '@stores/useUIStore'
import { useTrackerAutomationNavStore } from '@components/tabtracker/trackerDetailNavigation'
import {
  __resetHubNavigationGenerationForTests,
  invalidatePendingHubNavigation,
  openAutomationHub,
  openSkillLibrary,
} from '../agentMemoryNavigation'

beforeEach(() => {
  __resetHubNavigationGenerationForTests()
  useOrganizationStore.setState({
    selectedOrganization: { id: 'org-1' },
  } as never)
  useAuthStore.setState({
    user: { id: 'user-1' },
  } as never)
  useSettingsSpaceStore.setState({
    closeSettings: vi.fn(),
  } as never)
  useIMStore.setState({
    closeIM: vi.fn(),
    setCurrentConversation: vi.fn(),
  } as never)
  useSpaceViewPrefsStore.setState({
    sidebarModeByOrganizationUser: {},
  } as never)
  useUIStore.setState({
    sidebarCollapsed: false,
    toggleSidebar: vi.fn(),
  } as never)
  useAppPageStore.setState({ activePage: null, activeProjectId: null })
  useTrackerAutomationNavStore.setState({ seq: 0, detail: null })
})

describe('openSkillLibrary / invalidatePendingHubNavigation', () => {
  it('点新任务作废进行中的打开后，晚到的 then 不再盖回技能库', async () => {
    openSkillLibrary()
    invalidatePendingHubNavigation()
    useAppPageStore.getState().closeAppPage()

    await vi.waitFor(() => {
      expect(useSettingsSpaceStore.getState().closeSettings).toHaveBeenCalled()
    })
    // 给 microtask / dynamic import 收尾时间
    await Promise.resolve()
    await Promise.resolve()

    expect(useAppPageStore.getState().activePage).toBeNull()
  })

  it('正常打开技能库会落 activePage=skill', async () => {
    openSkillLibrary()
    await vi.waitFor(() => {
      expect(useAppPageStore.getState().activePage).toBe('skill')
    })
  })

  it('点击自动化一级入口会清空上次详情并回到列表', async () => {
    useTrackerAutomationNavStore.getState().openDetail({
      taskId: 'task-old',
      spaceId: 'space-1',
      title: '旧详情',
    })

    openAutomationHub()

    await vi.waitFor(() => {
      expect(useAppPageStore.getState().activePage).toBe('automation')
    })
    expect(useTrackerAutomationNavStore.getState()).toMatchObject({
      seq: 2,
      detail: null,
    })
  })
})
