/**
 * Agent 记忆 / 分身配置 / 技能库 / 自动化 / 协作导航。
 *
 * AI 分身走独立一级域（mainNavTab=agents，侧栏列表 + 主画布详情）；
 * 技能库 / 自动化 / 协作仍走 app-page，由 AppFullPageHost 承载主画布。
 */
import { create } from 'zustand'
import { createLogger } from '@/utils/logger'
import type { AppPageId } from '@/stores/useAppPageStore'
import { useExternalArchiveFocusStore } from '@components/onboarding/external-import/useExternalArchiveFocusStore'
import { useTrackerAutomationNavStore } from '@components/tabtracker/trackerDetailNavigation'

const log = createLogger('AgentMemoryNavigation')

interface AgentMemoryFocusState {
  organizationId: string | null
  agentId: string | null
  memoryId: string | null
  nonce: number
  setFocus: (focus: {
    organizationId?: string | null
    agentId?: string | null
    memoryId?: string | null
  }) => void
  clear: () => void
}

export const useAgentMemoryFocusStore = create<AgentMemoryFocusState>((set) => ({
  organizationId: null,
  agentId: null,
  memoryId: null,
  nonce: 0,
  setFocus: (focus) =>
    set((s) => ({
      organizationId: focus.organizationId ?? null,
      agentId: focus.agentId ?? null,
      memoryId: focus.memoryId ?? null,
      nonce: s.nonce + 1,
    })),
  clear: () => set({ organizationId: null, agentId: null, memoryId: null }),
}))

type HubAppPageId = Exclude<AppPageId, 'project'>

/**
 * 异步 openAppPageNavigation / openAgentHub 的世代令牌。
 * 点「新任务」等离开路径必须 bump，否则晚到的 then() 会把全屏页盖回来。
 */
let hubNavigationGeneration = 0

/** 作废尚未完成的技能库 / 自动化 / 协作 / AI 分身异步打开。 */
export function invalidatePendingHubNavigation(): void {
  hubNavigationGeneration += 1
}

/** @internal 单测重置 */
export function __resetHubNavigationGenerationForTests(): void {
  hubNavigationGeneration = 0
}

function runNavigationCleanup(): Promise<[
  ReturnType<typeof import('@stores/useSettingsSpaceStore').useSettingsSpaceStore.getState>,
  ReturnType<typeof import('@stores/useIMStore').useIMStore.getState>,
  ReturnType<typeof import('@stores/useSpaceViewPrefsStore').useSpaceViewPrefsStore.getState>,
  ReturnType<typeof import('@stores/useOrganizationStore').useOrganizationStore.getState>,
  ReturnType<typeof import('@stores/useAuthStore').useAuthStore.getState>,
  ReturnType<typeof import('@stores/useAppPageStore').useAppPageStore.getState>,
  ReturnType<typeof import('@stores/useMainNavStore').useMainNavStore.getState>,
  ReturnType<typeof import('@stores/useUIStore').useUIStore.getState>,
]> {
  return Promise.all([
    import('@stores/useSettingsSpaceStore'),
    import('@stores/useIMStore'),
    import('@stores/useSpaceViewPrefsStore'),
    import('@stores/useOrganizationStore'),
    import('@stores/useAuthStore'),
    import('@stores/useAppPageStore'),
    import('@stores/useMainNavStore'),
    import('@stores/useUIStore'),
  ]).then(([
    settingsMod,
    imMod,
    prefsMod,
    orgMod,
    authMod,
    appPageMod,
    mainNavMod,
    uiMod,
  ]) => {
    settingsMod.useSettingsSpaceStore.getState().closeSettings()
    imMod.useIMStore.getState().closeIM()
    imMod.useIMStore.getState().setCurrentConversation(null)
    const organizationId = orgMod.useOrganizationStore.getState().selectedOrganization?.id
    const userId = authMod.useAuthStore.getState().user?.id
    if (organizationId && userId) {
      prefsMod.useSpaceViewPrefsStore
        .getState()
        .setSidebarModeForOrganizationUser(organizationId, userId, 'conversations')
    }
    appPageMod.useAppPageStore.getState().closeAppPage()
    const uiStore = uiMod.useUIStore.getState()
    if (uiStore.sidebarCollapsed) uiStore.toggleSidebar()
    return [
      settingsMod.useSettingsSpaceStore.getState(),
      imMod.useIMStore.getState(),
      prefsMod.useSpaceViewPrefsStore.getState(),
      orgMod.useOrganizationStore.getState(),
      authMod.useAuthStore.getState(),
      appPageMod.useAppPageStore.getState(),
      mainNavMod.useMainNavStore.getState(),
      uiMod.useUIStore.getState(),
    ]
  })
}

/** 打开侧栏一级全屏 App 页（技能库 / 自动化 / 协作）。 */
export function openAppPageNavigation(page: HubAppPageId): void {
  const generation = ++hubNavigationGeneration
  runNavigationCleanup()
    .then(([, , , , , appPageState]) => {
      if (generation !== hubNavigationGeneration) return
      appPageState.openAppPage(page)
    })
    .catch((err) => {
      log.warn('打开任务侧栏全屏 App 页失败', { page, err })
    })
}

export function openAgentHub(): void {
  const generation = ++hubNavigationGeneration
  runNavigationCleanup()
    .then(([, , , , , , mainNavState]) => {
      if (generation !== hubNavigationGeneration) return
      mainNavState.setCurrentTab('agents')
    })
    .catch((err) => {
      log.warn('打开 AI 分身域失败', { err })
    })
}

export function openSkillLibrary(): void {
  openAppPageNavigation('skill')
}

export function openAutomationHub(): void {
  // 一级入口代表进入模块首页；不能复用上次从任务树打开的详情状态。
  useTrackerAutomationNavStore.getState().openList()
  openAppPageNavigation('automation')
}

export function openImportHub(): void {
  openAppPageNavigation('import')
}

export function openExternalArchives(focus?: {
  source: string
  sourceSessionId: string
} | null): void {
  if (focus?.source && focus.sourceSessionId) {
    useExternalArchiveFocusStore.getState().setFocus({
      source: focus.source,
      sourceSessionId: focus.sourceSessionId,
    })
  }
  openAppPageNavigation('external-archives')
}

export function openCollaborationHub(): void {
  openAppPageNavigation('collaboration')
}

export function openAgentSettings(agentId: string, organizationId?: string | null): void {
  useAgentMemoryFocusStore.getState().setFocus({ agentId, organizationId })
  openAgentHub()
}

export function openAgentMemory(opts: {
  organizationId?: string | null
  agentId?: string | null
  memoryId?: string | null
} = {}): void {
  useAgentMemoryFocusStore.getState().setFocus(opts)
  openAgentHub()
}

/** @deprecated 使用 openAppPageNavigation */
export function openTaskHub(page: Extract<AppPageId, 'skill'>): void {
  openAppPageNavigation(page)
}
