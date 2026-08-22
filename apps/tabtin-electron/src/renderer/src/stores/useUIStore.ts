/** @store-category prefs */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'
import type { ThemeMode, LayoutState } from '@tabtin/app-shell'
import {
  DEFAULT_COLOR_SCHEME,
  type ColorSchemeId,
  getColorSchemeById,
} from '@/constants/color-schemes'
import { LayoutConstraints } from '@/constants/layout'
import { dispatchCrawlViewLayoutChange, getRendererZoomFactor } from '@/utils/crawl-view-bounds'
import {
  SIDEBAR_LAYOUT_DEFAULT_V8,
  SIDEBAR_LAYOUT_DEFAULT_V10,
  SIDEBAR_LAYOUT_DEFAULT_V11,
  SIDEBAR_LAYOUT_DEFAULT_WIDTH,
  SIDEBAR_LAYOUT_HISTORICAL_DEFAULTS,
  clampSidebarLayoutWidth,
} from './sidebarLayoutConstants'
import { markLocalChange, reconcileNamespace, scheduleNamespaceSave } from './uiSettingsSync'
import { registerResetAction } from './sessionResetRegistry'
import type { UISettingsMap } from '@/types/uiSettings'
import { GLOBAL_SEARCH_UI_ENABLED } from '@/utils/featureFlags'
import { createLogger } from '@/utils/logger'

const themeLog = createLogger('Theme')

type AppearanceIpcResult = {
  success?: boolean
  shouldUseDarkColors?: boolean
  shouldUseDarkColorsForSystemIntegratedUI?: boolean | null
  themeSource?: 'system' | 'light' | 'dark'
  error?: string
}

// TabData 表格字体外观（风格/字重/字号）已迁移到 per-table 的
// useTableAppearanceStore。此处仅 type-only 重导出，保持既有
// `@stores/useUIStore` 的类型引用方（GridToolbarMainBar / ViewFilterGroupBar 等）不破坏。
export type {
  TableFontStyle,
  TableFontWeight,
  TableFontSize,
} from './useTableAppearanceStore'

type ResolvedTheme = 'light' | 'dark'

/**
 * Shell 最外层 sidebar（SpaceSidebarGlobal）宽度约束。
 *
 * 历史背景：早期 `setSidebarWidth` 错用 `LayoutConstraints.sidebar.{min,max,default}Width`
 * 做 clamp——但那三个值都是 64，实际是 nav bar 的固定宽度，不是可拖 sidebar 的合理范围。
 * 结果用户每次拖动 sidebar，最终都被压回 64px——`useUIStore.sidebarWidth` 也因此变成事
 * 实上的"死字段"（AppLayout 都不读它）。
 *
 * 本次（v7）把这条线接对：
 * - clamp / 默认值见 `sidebarLayoutConstants.ts`（与 Space 工作台分栏数值对齐）
 */
const clampShellSidebarWidth = clampSidebarLayoutWidth

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'

let _persistTimer: ReturnType<typeof setTimeout> | null = null
const debouncedStorage = {
  getItem: (name: string) => localStorage.getItem(name),
  setItem: (name: string, value: string) => {
    if (_persistTimer) clearTimeout(_persistTimer)
    _persistTimer = setTimeout(() => localStorage.setItem(name, value), 200)
  },
  removeItem: (name: string) => localStorage.removeItem(name),
}

const getSystemTheme = (): ResolvedTheme => {
  if (!isBrowser || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const applyThemeToDom = (resolvedTheme: ResolvedTheme) => {
  if (!isBrowser) return
  const root = document.documentElement
  root.classList.toggle('dark', resolvedTheme === 'dark')
}

const resolveThemeFromAppearanceResult = (
  theme: ThemeMode,
  result: AppearanceIpcResult | null | undefined,
  fallback: ResolvedTheme,
): ResolvedTheme => {
  if (theme !== 'system') return theme
  if (typeof result?.shouldUseDarkColors === 'boolean') {
    return result.shouldUseDarkColors ? 'dark' : 'light'
  }
  return fallback
}

const syncAppearanceToMain = (
  theme: ThemeMode,
  applyResolved: (resolved: ResolvedTheme, result: AppearanceIpcResult | null) => void,
) => {
  if (typeof window === 'undefined' || !window.tabtin?.setAppearance) return
  const matchMediaDark = isBrowser && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : null

  void window.tabtin.setAppearance(theme).then((result: AppearanceIpcResult) => {
    const fallback = theme === 'system' ? getSystemTheme() : theme
    const resolved = resolveThemeFromAppearanceResult(theme, result, fallback)
    themeLog.info('appearance synced', {
      theme,
      resolved,
      shouldUseDarkColors: result?.shouldUseDarkColors ?? null,
      systemUiDark: result?.shouldUseDarkColorsForSystemIntegratedUI ?? null,
      themeSource: result?.themeSource ?? null,
      matchMediaDark,
    })
    applyResolved(resolved, result ?? null)
  }).catch((error: unknown) => {
    themeLog.warn('Failed to sync appearance', error)
  })
}

const applyColorSchemeToDom = (scheme: ColorSchemeId) => {
  if (!isBrowser) return
  const root = document.documentElement
  root.dataset.colorScheme = scheme
}

export type UIFontSize = 'small' | 'default' | 'large'
const UI_ZOOM_MAP: Record<UIFontSize, number> = { small: 0.8, default: 0.9, large: 1.0 }

export interface AgentChatCapsulePlacement {
  side: 'left' | 'right'
  yRatio: number
}

export const DEFAULT_AGENT_CHAT_CAPSULE_PLACEMENT: AgentChatCapsulePlacement = {
  side: 'right',
  yRatio: 1,
}

const normalizeAgentChatCapsulePlacement = (
  value: unknown,
): AgentChatCapsulePlacement => {
  const placement =
    value && typeof value === 'object'
      ? value as Partial<AgentChatCapsulePlacement>
      : {}
  const side = placement.side === 'left' || placement.side === 'right'
    ? placement.side
    : DEFAULT_AGENT_CHAT_CAPSULE_PLACEMENT.side
  const yRatio = typeof placement.yRatio === 'number' && Number.isFinite(placement.yRatio)
    ? Math.max(0, Math.min(1, placement.yRatio))
    : DEFAULT_AGENT_CHAT_CAPSULE_PLACEMENT.yRatio

  return { side, yRatio }
}

const normalizeUIFontSize = (value: unknown): UIFontSize => {
  if (value === 'small' || value === 'default' || value === 'large') return value
  return value === 'xlarge' ? 'large' : 'default'
}

const applyRendererZoom = (size: UIFontSize) => {
  if (typeof window === 'undefined' || !window.tabtin?.zoom) return

  const nextZoom = UI_ZOOM_MAP[size]
  const currentZoom = getRendererZoomFactor()
  if (Math.abs(currentZoom - nextZoom) > 0.0001) {
    window.tabtin.zoom.setZoomFactor(nextZoom)
  }

  // UI 缩放不会稳定触发 resize，主动通知嵌入式原生视图重算 bounds。
  dispatchCrawlViewLayoutChange('ui-font-size')
}

interface UIState extends LayoutState {
  // 主题相关
  theme: ThemeMode
  resolvedTheme: ResolvedTheme
  accentColor: string
  colorScheme: ColorSchemeId
  uiFontSize: UIFontSize

  // 布局状态
  sidebarWidth: number
  sidebarCollapsed: boolean
  contextCollapsed: boolean
  mainContentCollapsed: boolean
  pinnedWidth: number

  // 右侧 Agent 面板状态
  chatSidePanelWidth: number
  /** 对话模式下右侧画布辅助位宽度（与 chatSidePanelWidth 独立，切换模式时不互换） */
  canvasSidePanelWidth: number
  chatSidePanelCollapsed: boolean
  chatSessionListWidth: number
  /** 无三态布局的桌面场景临时铺满当前文档/表格；任务 / IM 应统一使用 taskViewMode。 */
  focusedCanvas: { scopeKey: string; tabKey: string } | null
  /** app-focus 右下角 Agent 对话悬浮面板展开态（临时 UI 态，按 scopeKey 隔离，不持久化） */
  appFocusChatOverlayOpenByScopeKey: Record<string, boolean>
  /** Agent 对话胶囊的全局停靠偏好；纵向位置以可用区间内的 0…1 表示。 */
  agentChatCapsulePlacement: AgentChatCapsulePlacement

  // 加载状态
  isLoading: boolean
  loadingMessage: string

  // 错误状态
  error: string | null

  // 全局遮罩层计数（用于控制 WebContentsView 显示层级）
  overlayCount: number

  // 全局搜索
  globalSearchOpen: boolean

  // 资源监控
  showResourceMonitor: boolean

  // 操作方法
  setTheme: (theme: ThemeMode) => void
  setAccentColor: (color: string) => void
  setColorScheme: (scheme: ColorSchemeId) => void
  setUIFontSize: (size: UIFontSize) => void
  setSidebarWidth: (width: number) => void
  setPinnedWidth: (width: number) => void
  setChatSidePanelWidth: (width: number) => void
  setCanvasSidePanelWidth: (width: number) => void
  toggleSidebar: () => void
  toggleContext: () => void
  toggleMainContent: () => void
  toggleChatSidePanel: () => void
  setChatSessionListWidth: (width: number) => void
  setChatSidePanelCollapsed: (collapsed: boolean) => void
  setFocusedCanvas: (focusedCanvas: { scopeKey: string; tabKey: string } | null) => void
  setAppFocusChatOverlayOpen: (scopeKey: string, open: boolean) => void
  setAgentChatCapsulePlacement: (placement: AgentChatCapsulePlacement) => void
  setContextCollapsed: (collapsed: boolean) => void
  setLoading: (loading: boolean, message?: string) => void
  setError: (error: string | null) => void
  clearError: () => void
  setOverlayCount: (count: number) => void
  setGlobalSearchOpen: (open: boolean) => void
  toggleGlobalSearch: () => void
  /**
   * Memo 旧入口兼容符号。
   * 记忆入口已收口到云端应用；open/toggle 仍会回到任务域桌面，
   * closeMemo 是 no-op（不可再强切 mainNav——会把消息域踢回任务，）。
   */
  openMemo: () => void
  closeMemo: () => void
  toggleMemo: () => void
  setShowResourceMonitor: (show: boolean) => void

  // IA Phase 2 个人偏好同步（theme / fontSize / colorScheme 三个 namespace）。
  // saveToServer：标记本地改动 + 防抖写穿后端（authed 才发、失败静默重试）。
  // syncFromServer：按 namespace updatedAt 合并服务器值（本地较新则不被覆盖）。
  saveToServer: (namespace: 'theme' | 'fontSize' | 'colorScheme') => void
  syncFromServer: (remote: UISettingsMap) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      // 初始状态
      theme: 'system',
      resolvedTheme: getSystemTheme(),
      accentColor: '215 65% 52%',
      colorScheme: DEFAULT_COLOR_SCHEME,
      uiFontSize: 'default' as UIFontSize,
      sidebarWidth: SIDEBAR_LAYOUT_DEFAULT_WIDTH,
      sidebarCollapsed: false,
      contextCollapsed: false,
      listWidth: 320, // 列表面板宽度
      pinnedWidth: LayoutConstraints.pinned.defaultWidth,
      mainContentCollapsed: false,
      chatSidePanelWidth: LayoutConstraints.chatSidePanel.defaultWidth,
      canvasSidePanelWidth: LayoutConstraints.chatSidePanel.defaultWidth,
      chatSidePanelCollapsed: false,
      chatSessionListWidth: LayoutConstraints.chatSessionList.defaultWidth,
      focusedCanvas: null,
      appFocusChatOverlayOpenByScopeKey: {},
      agentChatCapsulePlacement: DEFAULT_AGENT_CHAT_CAPSULE_PLACEMENT,
      isLoading: false,
      loadingMessage: '',
      error: null,
      overlayCount: 0,
      globalSearchOpen: false,
      showResourceMonitor: true,

      // 主题操作
      setTheme: (theme) => {
        const changed = get().theme !== theme
        // 先用 matchMedia 乐观上色；IPC 回包后以主进程 shouldUseDarkColors 校正
        const resolvedTheme = theme === 'system' ? getSystemTheme() : theme
        set({ theme, resolvedTheme })
        applyThemeToDom(resolvedTheme)

        syncAppearanceToMain(theme, (resolved) => {
          if (get().theme !== theme) return
          if (get().resolvedTheme === resolved) return
          set({ resolvedTheme: resolved })
          applyThemeToDom(resolved)
        })

        // 只在真正改动时写穿后端——避免启动 initializeTheme(同值) / 系统主题
        // 变化(走 setState 不走本函数) 触发无谓 PUT。
        if (changed) get().saveToServer('theme')
      },

      setAccentColor: (color) => {
        set({ accentColor: color })

        // 更新 CSS 变量
        const root = document.documentElement
        root.style.setProperty('--accent', color)
        root.style.setProperty('--ring', color)
      },

      setColorScheme: (scheme) => {
        const resolvedScheme = getColorSchemeById(scheme).id
        const changed = get().colorScheme !== resolvedScheme
        set({ colorScheme: resolvedScheme })
        if (typeof document !== 'undefined') {
          const root = document.documentElement
          root.style.removeProperty('--accent')
          root.style.removeProperty('--ring')
        }
        applyColorSchemeToDom(resolvedScheme)
        if (changed) get().saveToServer('colorScheme')
      },

      setUIFontSize: (size) => {
        const changed = get().uiFontSize !== size
        set({ uiFontSize: size })
        applyRendererZoom(size)
        if (changed) get().saveToServer('fontSize')
      },

      // shell 最外层 sidebar 宽度——全局偏好（不绑 Space），所有 main nav tab 共享。
      // clamp 走 sidebarLayoutConstants，不再误用 LayoutConstraints.sidebar.{min,max}（那是 nav bar 的 64px）。
      setSidebarWidth: (width) => {
        set({ sidebarWidth: clampShellSidebarWidth(width) })
      },

      setPinnedWidth: (width) => {
        set({
          pinnedWidth: Math.max(
            LayoutConstraints.pinned.minWidth,
            Math.min(LayoutConstraints.pinned.maxWidth, width)
          )
        })
      },

      setChatSidePanelWidth: (width) => {
        set({
          chatSidePanelWidth: Math.max(
            LayoutConstraints.chatSidePanel.minWidth,
            Math.min(LayoutConstraints.chatSidePanel.maxWidth, width),
          ),
        })
      },

      setCanvasSidePanelWidth: (width) => {
        set({
          canvasSidePanelWidth: Math.max(
            LayoutConstraints.canvasSidePanel.minWidth,
            Math.round(width),
          ),
        })
      },

      toggleSidebar: () => {
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
      },

      toggleChatSidePanel: () => {
        set((state) => ({
          chatSidePanelCollapsed: !state.chatSidePanelCollapsed,
        }))
      },

      setChatSessionListWidth: (width: number) => {
        set({
          chatSessionListWidth: Math.max(
            LayoutConstraints.chatSessionList.minWidth,
            Math.min(LayoutConstraints.chatSessionList.maxWidth, width),
          ),
        })
      },

      setChatSidePanelCollapsed: (collapsed: boolean) => {
        set({ chatSidePanelCollapsed: collapsed })
      },

      setFocusedCanvas: (focusedCanvas) => {
        set({ focusedCanvas })
      },

      setAppFocusChatOverlayOpen: (scopeKey, open) => {
        set(state => {
          if (!!state.appFocusChatOverlayOpenByScopeKey[scopeKey] === open) return state
          return {
            appFocusChatOverlayOpenByScopeKey: {
              ...state.appFocusChatOverlayOpenByScopeKey,
              [scopeKey]: open,
            },
          }
        })
      },

      setAgentChatCapsulePlacement: (placement) => {
        set({ agentChatCapsulePlacement: normalizeAgentChatCapsulePlacement(placement) })
      },

      toggleContext: () => {
        set(state => ({ contextCollapsed: !state.contextCollapsed }))
      },

      toggleMainContent: () => {
        set(state => {
          const nextCollapsed = !state.mainContentCollapsed
          // 🛡️ 防呆逻辑：如果要折叠主内容区域，检查是否会导致所有区域都被隐藏
          if (nextCollapsed) {
            // 检查是否有钉住区域（这个需要从外部传入，我们暂时假设如果折叠主内容，至少要有钉住区域）
            // 由于这里无法访问 pinnedItems，我们在组件层面做检查
            console.warn('[useUIStore] Attempting to collapse main content area')
          }
          return { mainContentCollapsed: nextCollapsed }
        })
      },

      setContextCollapsed: (collapsed: boolean) => {
        set({ contextCollapsed: collapsed })
      },

      // 状态操作
      setLoading: (loading, message = '') => {
        set({ isLoading: loading, loadingMessage: message })
      },

      setError: (error) => {
        set({ error })
      },

      clearError: () => {
        set({ error: null })
      },

      setOverlayCount: (count: number) => {
        set(state => {
          const next = Math.max(0, count)
          if (state.overlayCount === next) return state
          return { overlayCount: next }
        })
      },

      setGlobalSearchOpen: (open) => {
        if (!GLOBAL_SEARCH_UI_ENABLED && open) return
        set({ globalSearchOpen: open })
      },
      toggleGlobalSearch: () => {
        if (!GLOBAL_SEARCH_UI_ENABLED) return
        set(state => ({ globalSearchOpen: !state.globalSearchOpen }))
      },

      // 兼容旧调用点；Memo 产品入口已移除，不再改变导航状态。
      openMemo: () => {},
      closeMemo: () => {},
      toggleMemo: () => {},

      setShowResourceMonitor: (show: boolean) => {
        set({ showResourceMonitor: show })
      },

      // ── IA Phase 2 个人偏好同步 ──────────────────────────────
      saveToServer: (namespace) => {
        markLocalChange(namespace)
        scheduleNamespaceSave(namespace, () => {
          const state = get()
          if (namespace === 'theme') return state.theme
          if (namespace === 'fontSize') return state.uiFontSize
          return state.colorScheme
        })
      },

      syncFromServer: (remote) => {
        // theme：以 ui_settings.theme 为 SSoT，值域 system/light/dark。
        reconcileNamespace<ThemeMode>({
          namespace: 'theme',
          remote: remote.theme,
          getLocalValue: () => get().theme,
          applyRemoteValue: (value) => {
            if (value !== 'system' && value !== 'light' && value !== 'dark') return
            const resolved = value === 'system' ? getSystemTheme() : value
            set({ theme: value, resolvedTheme: resolved })
            applyThemeToDom(resolved)
            syncAppearanceToMain(value, (nextResolved) => {
              if (get().theme !== value) return
              if (get().resolvedTheme === nextResolved) return
              set({ resolvedTheme: nextResolved })
              applyThemeToDom(nextResolved)
            })
          },
          buildSaveValue: () => get().theme,
        })

        reconcileNamespace<UIFontSize>({
          namespace: 'fontSize',
          remote: remote.fontSize,
          getLocalValue: () => get().uiFontSize,
          applyRemoteValue: (value) => {
            const normalizedValue = normalizeUIFontSize(value)
            set({ uiFontSize: normalizedValue })
            applyRendererZoom(normalizedValue)
          },
          buildSaveValue: () => get().uiFontSize,
        })

        reconcileNamespace<ColorSchemeId>({
          namespace: 'colorScheme',
          remote: remote.colorScheme,
          getLocalValue: () => get().colorScheme,
          applyRemoteValue: (value) => {
            const resolved = getColorSchemeById(value).id
            set({ colorScheme: resolved })
            if (typeof document !== 'undefined') {
              const root = document.documentElement
              root.style.removeProperty('--accent')
              root.style.removeProperty('--ring')
            }
            applyColorSchemeToDom(resolved)
          },
          buildSaveValue: () => get().colorScheme,
        })
      },
    }),
    withPersistSafety({
      name: PERSIST_KEYS.ui,
      storage: isBrowser ? createJSONStorage(() => createMigratingStorage(debouncedStorage, ['tabtin-ui-store'])) : undefined,
      version: 14,
      migrate: (persistedState: any, version: number) => {
        if (version < 1) {
          return {
            ...persistedState,
            chatSidePanelWidth: LayoutConstraints.chatSidePanel.defaultWidth,
            chatSidePanelCollapsed: false,
          }
        }
        if (version < 2) {
          return {
            ...persistedState,
            showResourceMonitor: false,
          }
        }
        // v3 added chatSessionSidebarVisible / chatSessionTabsVisible — now removed in v4
        if (version < 4) {
          const { chatSessionSidebarVisible: _, chatSessionSidebarWidth: _2, chatSessionTabsVisible: _3, ...rest } = persistedState
          return rest
        }
        // v5：资源监控独立成「性能」面板并默认开启；清除旧的 showResourceMonitor 持久值，
        // 让 store 默认值（true）接管。用户首次看到新位置后仍可在新面板里关闭。
        if (version < 5) {
          const { showResourceMonitor: _resourceMonitorLegacy, ...rest } = persistedState
          return rest
        }
        // v6：Memo 从 UI 独立面板升级为主导航 tab；v7 后记忆入口收口到云盘，
        // 旧 isMemoOpen 持久值只清理，不再回写 mainNav。
        if (version < 6) {
          const { isMemoOpen: _legacyMemoOpen, ...rest } = persistedState
          return rest
        }
        if (version < 7) {
          // v7：修复 sidebarWidth 历史 bug——之前 setSidebarWidth 错用了
          // LayoutConstraints.sidebar.{min,max,default}Width（都是 64，实为 nav bar 宽度）
          // 做 clamp，导致用户拖动 sidebar 时，宽度每次都被压回 64px。
          // 这次把不在合理范围 [160, 320] 内的 sidebarWidth 一律 clamp 回去（默认 192）。
          // merge 函数里还有一层兜底 clamp，确保 hydration 落地一定是合法值。
          //
          // 同时这一步语义升级：sidebarWidth 从"事实上死字段"正式变成"shell 最外层
          // sidebar 宽度的全局偏好"——所有 main nav tab（agent/im/me）共享，
          // AppLayout 改成读写它（替代之前误用的 useSpaceViewPrefsStore.sidebarTabsWidth）。
          return {
            ...persistedState,
            sidebarWidth: clampShellSidebarWidth(persistedState?.sidebarWidth),
          }
        }
        if (version < 8) {
          // v8：字体外观（tableFontStyle/Weight/Size）迁移到 per-table 的
          // useTableAppearanceStore。这里把旧的全局字段从 ui 持久态里剥掉；旧值已由
          // useTableAppearanceStore 在模块初始化时读出来作为 defaultAppearance 种子，
          // 升级用户不丢风格。
          const {
            tableFontStyle: _legacyFontStyle,
            tableFontWeight: _legacyFontWeight,
            tableFontSize: _legacyFontSize,
            ...rest
          } = persistedState ?? {}
          return rest
        }
        if (version < 9) {
          // v9：对话模式画布辅助位宽度独立持久化，不再复用 chatSidePanelWidth。
          return {
            ...persistedState,
            canvasSidePanelWidth: LayoutConstraints.chatSidePanel.defaultWidth,
          }
        }
        if (version < 10) {
          // v10：侧栏默认宽度 192 → 224；仅迁移仍停留在旧默认值的偏好，保留用户手动拖过的宽度。
          const sidebarWidth =
            persistedState?.sidebarWidth === SIDEBAR_LAYOUT_DEFAULT_V8
              ? SIDEBAR_LAYOUT_DEFAULT_V10
              : clampShellSidebarWidth(persistedState?.sidebarWidth)
          return { ...persistedState, sidebarWidth }
        }
        if (version < 11) {
          // v11：侧栏默认宽度 224 → 256；192/224 均视为历史默认值。
          const width = persistedState?.sidebarWidth
          const isHistoricalDefault =
            width === SIDEBAR_LAYOUT_DEFAULT_V8
            || width === SIDEBAR_LAYOUT_DEFAULT_V10
          const sidebarWidth = isHistoricalDefault
            ? SIDEBAR_LAYOUT_DEFAULT_V11
            : clampShellSidebarWidth(width)
          return { ...persistedState, sidebarWidth }
        }
        if (version < 12) {
          // v12：侧栏默认宽度 256 → 288；历史默认值一律升到当前默认，手动拖过的宽度保留。
          const width = persistedState?.sidebarWidth
          const sidebarWidth = SIDEBAR_LAYOUT_HISTORICAL_DEFAULTS.has(width)
            ? SIDEBAR_LAYOUT_DEFAULT_WIDTH
            : clampShellSidebarWidth(width)
          return { ...persistedState, sidebarWidth }
        }
        if (version < 13) {
          return {
            ...persistedState,
            uiFontSize: normalizeUIFontSize(persistedState?.uiFontSize),
          }
        }
        if (version < 14) {
          return {
            ...persistedState,
            agentChatCapsulePlacement: normalizeAgentChatCapsulePlacement(
              persistedState?.agentChatCapsulePlacement,
            ),
          }
        }
        return persistedState
      },
      partialize: (state) => ({
        theme: state.theme,
        accentColor: state.accentColor,
        colorScheme: state.colorScheme,
        uiFontSize: state.uiFontSize,
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        contextCollapsed: state.contextCollapsed,
        mainContentCollapsed: state.mainContentCollapsed,
        listWidth: state.listWidth,
        pinnedWidth: state.pinnedWidth,
        chatSidePanelWidth: state.chatSidePanelWidth,
        canvasSidePanelWidth: state.canvasSidePanelWidth,
        chatSidePanelCollapsed: state.chatSidePanelCollapsed,
        chatSessionListWidth: state.chatSessionListWidth,
        agentChatCapsulePlacement: state.agentChatCapsulePlacement,
        showResourceMonitor: state.showResourceMonitor,
      }),
      merge: (persistedState, currentState) => {
        const {
          chatMaximized: _legacyChatMaximized,
          chatSessionSidebarVisible: _legacySidebarVisible,
          chatSessionSidebarWidth: _legacySidebarWidth,
          chatSessionTabsVisible: _legacyTabsVisible,
          // v6 已经移除 isMemoOpen——双保险：即使跨多版本跳跃没走到 v6 分支，
          // 这里 strip 一下确保不会污染当前 state
          isMemoOpen: _legacyIsMemoOpen,
          ...typedPersisted
        } = (persistedState ?? {}) as Partial<UIState> & {
          chatMaximized?: boolean
          chatSessionSidebarVisible?: boolean
          chatSessionSidebarWidth?: number
          chatSessionTabsVisible?: boolean
          isMemoOpen?: boolean
        }

        return {
          ...currentState,
          ...typedPersisted,
          uiFontSize: normalizeUIFontSize(
            typedPersisted.uiFontSize ?? currentState.uiFontSize,
          ),
          // sidebarWidth 兜底 clamp——v7 migration 会处理一次，但如果用户跨大版本升级
          // 命中早期 if-return 分支（pre-existing migration 模式问题），可能没经过 v7。
          // 这层保证最终落地 state 一定在合法范围 [160, 320]。
          sidebarWidth: clampShellSidebarWidth(
            typedPersisted.sidebarWidth ?? currentState.sidebarWidth,
          ),
          chatSidePanelWidth: Math.max(
            LayoutConstraints.chatSidePanel.minWidth,
            Math.min(
              LayoutConstraints.chatSidePanel.maxWidth,
              typedPersisted.chatSidePanelWidth ?? currentState.chatSidePanelWidth,
            ),
          ),
          canvasSidePanelWidth: Math.max(
            LayoutConstraints.canvasSidePanel.minWidth,
            Math.round(
              typedPersisted.canvasSidePanelWidth ?? currentState.canvasSidePanelWidth,
            ),
          ),
          chatSidePanelCollapsed: typedPersisted.chatSidePanelCollapsed ?? currentState.chatSidePanelCollapsed,
          chatSessionListWidth: Math.max(
            LayoutConstraints.chatSessionList.minWidth,
            Math.min(
              LayoutConstraints.chatSessionList.maxWidth,
              typedPersisted.chatSessionListWidth ?? currentState.chatSessionListWidth,
            ),
          ),
          agentChatCapsulePlacement: normalizeAgentChatCapsulePlacement(
            typedPersisted.agentChatCapsulePlacement
              ?? currentState.agentChatCapsulePlacement,
          ),
        }
      },
    })
  )
)

// 初始化主题
const initializeTheme = () => {
  const { theme, setTheme } = useUIStore.getState()
  setTheme(theme)

  const applySystemResolved = (resolvedTheme: ResolvedTheme, source: string) => {
    const { theme: current } = useUIStore.getState()
    if (current !== 'system') return
    useUIStore.setState({ resolvedTheme })
    applyThemeToDom(resolvedTheme)
    themeLog.info('system theme resolved', { resolvedTheme, source })
  }

  // matchMedia 作兜底（部分环境仍可靠）；主进程 nativeTheme 为 Windows 真源
  let removeMediaListener: (() => void) | undefined
  if (isBrowser && window.matchMedia) {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => {
      applySystemResolved(mediaQuery.matches ? 'dark' : 'light', 'matchMedia')
    }
    mediaQuery.addEventListener('change', handleChange)
    removeMediaListener = () => mediaQuery.removeEventListener('change', handleChange)
  }

  let removeNativeListener: (() => void) | undefined
  if (typeof window !== 'undefined' && window.tabtin?.onNativeThemeUpdated) {
    removeNativeListener = window.tabtin.onNativeThemeUpdated((payload) => {
      applySystemResolved(
        payload.shouldUseDarkColors ? 'dark' : 'light',
        'nativeTheme',
      )
      themeLog.info('nativeTheme push', {
        shouldUseDarkColors: payload.shouldUseDarkColors,
        systemUiDark: payload.shouldUseDarkColorsForSystemIntegratedUI,
        themeSource: payload.themeSource,
      })
    })
  }

  return () => {
    removeMediaListener?.()
    removeNativeListener?.()
  }
}

// 在应用启动时初始化主题
if (typeof window !== 'undefined') {
  initializeTheme()
  applyColorSchemeToDom(useUIStore.getState().colorScheme)
  const uiFontSize = useUIStore.getState().uiFontSize || 'default'
  applyRendererZoom(uiFontSize)
}

// ── IA Phase 2：登出/换账号时把"已接后端同步的偏好"内存重置为默认 ────────────
// 只清 localStorage 不够——同进程换人登录时内存里仍是上一个人的 theme/字号/配色，
// reconcile 的"远端缺失→推本地"会把上个人的值写进新账号云端（串账号）。这里把
// 三个同步 namespace（theme/fontSize/colorScheme）内存态拉回默认并落地 DOM，与
// sessionReset 清 localStorage 对齐。注意不走 setTheme/setUIFontSize 等 setter
// （那会触发 saveToServer），登出态本就不该再写后端。
registerResetAction('ui-prefs-sync', 'reset', () => {
  const resolvedSystemTheme = getSystemTheme()
  useUIStore.setState({
    theme: 'system',
    resolvedTheme: resolvedSystemTheme,
    colorScheme: DEFAULT_COLOR_SCHEME,
    uiFontSize: 'default',
    focusedCanvas: null,
    // 登出/换账号时清掉 app-focus 悬浮面板展开态，避免串到下一账号
    appFocusChatOverlayOpenByScopeKey: {},
  })
  applyThemeToDom(resolvedSystemTheme)
  applyColorSchemeToDom(DEFAULT_COLOR_SCHEME)
  applyRendererZoom('default')
})
