/** @store-category prefs */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'

/**
 * 桌面端侧栏底部一级导航 tab。
 *
 * 与 iOS 端「私信 / Agent / 我的」IA 对齐——桌面端把主要工作入口
 * 收口到侧栏顶部模块标签。每个 tab 切换时**侧栏中间内容**变化；**主画布
 * （ContentArea）的行为取决于 tab**：
 *   - 'agent' → 主画布保持当前 Space / 欢迎页
 *   - 'project' → 内部状态：从「对话 > Project」进入详情页，不作为可见一级 Tab
 *   - 'im' → 侧栏渲染会话列表；未选会话主画布渲染私信欢迎页，选了会话走现有
 *            isIMActive 状态机（chat panel 接管 ChatView）
 *   - 'me' → 主画布渲染 SettingsSpace（按 activeRoute 切 panel）
 * 详见 useShellLayoutState 的 workbenchMode 分支。
 *
 * Phase 0.7 完成的关系：
 *   - 旧的 Settings 全屏机制（useSettingsSpaceStore.isOpen + AppLayout 切
 *     SettingsSidebar）已退役，被「我的」tab 自然覆盖
 *   - openSettings(...) 调用全保留——内部重定向到 setCurrentTab('me') +
 *     setRoute(route)，调用方代码无需修改
 *
 * 旧 Memo 导航符号仅在 useUIStore 保留为空操作，等待调用方完成迁移后删除。
 *
 * Phase 状态：
 *   - 默认 'agent'——内容是现有侧栏完整结构（Desktop/对话切换 + portal + Agent 列表）
 *   - 'im' 侧栏渲染 SidebarIMPanel（ConversationList），主画布有专属欢迎页
 *   - 'project' 是「对话」里的Project 详情壳层状态；仅切 ContentArea，不写 selectedSpace
 *   - 'me' 已联通 SettingsSpace 全套面板（个人资料 / 通知 / 团队管理 等）
 *
 * 历史：
 *   - v1: 'recent' 占位 tab，从未真做内容；v2 起被 'im' 接替（私信入口），
 *     旧持久化值 'recent' 迁移为 'agent'（最安全的 fallback，让用户进默认视图）
 */

export type MainNavTab =
  | 'im'
  | 'agent'
  | 'cloud-docs'
  | 'automation'
  | 'agents'
  | 'skills'
  | 'collaboration'
  | 'project'
  | 'me'

const LEGACY_HUB_MAIN_NAV_TABS = new Set<MainNavTab>([
  'automation',
  'skills',
  'collaboration',
  'project',
])
const MAIN_NAV_TABS: readonly MainNavTab[] = [
  'im',
  'agent',
  'cloud-docs',
  'automation',
  'agents',
  'skills',
  'collaboration',
  'project',
  'me',
]
// 仅用于本地 IM 联调：每次 Electron 重启后回到「消息」，免去重复点击侧栏。
// 必须同时是 Vite dev，避免任何打包环境误设 VITE_* 时改变真实用户的现场。
const DEV_INITIAL_TAB: MainNavTab =
  import.meta.env.DEV && import.meta.env.VITE_DEV_INITIAL_MODULE === 'im' ? 'im' : 'agent'

interface MainNavState {
  currentTab: MainNavTab
  setCurrentTab: (tab: MainNavTab) => void
}

interface MainNavPersistedState {
  currentTab?: string
}

function normalizeMainNavTab(tab: string | undefined): MainNavTab | undefined {
  if (!tab) return undefined
  if (!MAIN_NAV_TABS.includes(tab as MainNavTab)) return 'agent'
  if (LEGACY_HUB_MAIN_NAV_TABS.has(tab as MainNavTab)) return 'agent'
  return tab as MainNavTab
}

export const useMainNavStore = create<MainNavState>()(
  persist(
    (set) => ({
      currentTab: DEV_INITIAL_TAB,
      setCurrentTab: (tab) => {
        if (!MAIN_NAV_TABS.includes(tab)) return
        set({ currentTab: tab })
      },
    }),
    withPersistSafety<MainNavState, MainNavPersistedState>({
      name: PERSIST_KEYS.mainNav,
      version: 8,
      // 无 legacy 旧 key——空数组让 createMigratingStorage 直接 fall through 到 localStorage
      storage: createJSONStorage(() => createMigratingStorage(localStorage, [])),
      // v1 → v2：'recent' tab 退役；v3：memo 入口从底部导航迁到顶部模块标签；
      // v4：memo 顶部入口退役；v5：hub 一级模块改走 app-page；
      // v6：'project' mainNavTab 退役，Project 详情统一走 app-page store；
      // v8：'agents' 恢复为独立一级域（AI 分身提级到窄栏 + 侧栏列表）。
      migrate: (persisted) => {
        const state = (persisted ?? {}) as MainNavPersistedState
        const tab = normalizeMainNavTab(state.currentTab)
        return tab ? { ...state, currentTab: tab } : state
      },
      // 保险：merge 时再校一遍——防御 version 字段缺失或外部直接改 localStorage 的情况。
      merge: (persisted, currentState) => {
        const state = (persisted ?? {}) as MainNavPersistedState
        const safeTab = normalizeMainNavTab(state.currentTab) ?? currentState.currentTab
        return {
          ...currentState,
          ...state,
          // persist hydration 会覆盖初始化值；IM 联调模式需要在这一步坚定地回到消息模块。
          currentTab: DEV_INITIAL_TAB === 'im' ? 'im' : safeTab,
        }
      },
    }),
  ),
)
