// Version guard MUST be the first import — it clears stale localStorage
// before any zustand store is created and hydrated.
import './stores/store-version-guard'

import '@styles/globals.css'

import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { PERSIST_KEYS } from './stores/persist-key-registry'
import { installConsoleCapture } from '@/services/logCollector'
import { syncDeviceFingerprint } from '@/utils/deviceId'

// 尽早安装 console 环形缓冲收集器，让「客户端诊断日志导出」能拿到界面层运行日志
// （含启动期）。ES import 会 hoist，此调用实际在所有静态 import 求值后立即执行，
// 早于 bootstrap()；幂等、无副作用依赖。
installConsoleCapture()

type RootBoundaryProps = {
  children: React.ReactNode
  enabled?: boolean
  fallback?: React.ReactNode
}

type InitialThemeMode = 'system' | 'light' | 'dark'

const LEGACY_UI_PERSIST_KEY = 'tabtin-ui-store'
const UI_PERSIST_KEYS_FOR_BOOT = [PERSIST_KEYS.ui, LEGACY_UI_PERSIST_KEY] as const

const PassthroughBoundary: React.FC<RootBoundaryProps> = ({ children }) => <>{children}</>

function resolveSystemTheme(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readStoredTheme(): InitialThemeMode | null {
  for (const key of UI_PERSIST_KEYS_FOR_BOOT) {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw) as { state?: { theme?: unknown }; theme?: unknown }
      const value = parsed.state?.theme ?? parsed.theme
      if (value === 'system' || value === 'light' || value === 'dark') return value
    } catch {
      // Invalid persisted state should not block the boot screen.
    }
  }
  return null
}

function applyInitialThemeBeforeBootScreen(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const theme = readStoredTheme() ?? 'system'
  const resolvedTheme = theme === 'system' ? resolveSystemTheme() : theme
  document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
}

function clearPrebootColorOverrides(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.removeProperty('--primary')
  root.style.removeProperty('--accent')
  root.style.removeProperty('--ring')
}

/** 首屏占位：React 启动期间接管 index.html 的静态加载反馈。 */
function BootScreen() {
  return (
    <div className="boot-screen">
      <div className="loading-spinner boot-spinner" />
      <div className="boot-title">正在启动 TabTin...</div>
    </div>
  )
}

const installLogFilter = () => {
  if (typeof window === 'undefined') return
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    debug: console.debug?.bind(console) ?? console.log.bind(console),
  }

  const getTokens = (): string[] | null => {
    try {
      const globalFilter = globalThis.__TABTIN_LOG_FILTER__
      const localFilter = localStorage.getItem('__tabtin_log_filter')
      const raw = typeof globalFilter === 'string' && globalFilter.trim()
        ? globalFilter
        : (localFilter || '')
      const tokens = raw.split('|').map(item => item.trim()).filter(Boolean)
      return tokens.length > 0 ? tokens : null
    } catch {
      return null
    }
  }

  const matchTokens = (args: unknown[], tokens: string[]): boolean => {
    return args.some(arg => {
      let text = ''
      if (typeof arg === 'string') {
        text = arg
      } else {
        try {
          text = JSON.stringify(arg)
        } catch {
          text = String(arg)
        }
      }
      return tokens.some(token => text.includes(token))
    })
  }

  const wrap = (method: 'log' | 'info' | 'debug') => {
    return (...args: unknown[]) => {
      const tokens = getTokens()
      if (!tokens || matchTokens(args, tokens)) {
        original[method](...args)
      }
    }
  }

  console.log = wrap('log')
  console.info = wrap('info')
  console.debug = wrap('debug')
}

installLogFilter()

const safeInit = (fn: () => void, name: string): void => {
  try {
    fn()
  } catch (e) {
    console.error(`[Init] ${name} failed:`, e)
  }
}

function getOrCreateRoot(container: HTMLElement) {
  if (!globalThis.__TABTIN_REACT_ROOT__) {
    console.debug('[Main] 创建 React 根节点')
    globalThis.__TABTIN_REACT_ROOT__ = createRoot(container)
  }
  return globalThis.__TABTIN_REACT_ROOT__
}

const bootContainer = document.getElementById('root')
if (!bootContainer) {
  throw new Error('Root element not found')
}
const rootContainer: HTMLElement = bootContainer
applyInitialThemeBeforeBootScreen()
getOrCreateRoot(rootContainer).render(<BootScreen />)

// 设备身份必须先于 App 内的设备注册副作用完成，但不必等首屏依赖加载完才开始。
// 与动态模块并行可消除启动关键路径上最多 2 秒的串行等待。
const deviceIdentityPromise = Promise.race([
  syncDeviceFingerprint(),
  new Promise<void>((resolve) => setTimeout(resolve, 2000)),
]).catch(() => undefined)

async function timedImport<T>(label: string, loader: () => Promise<T>): Promise<T> {
  const startedAt = performance.now()
  try {
    const module = await loader()
    console.debug(`[Bootstrap] ${label} loaded in ${Math.round(performance.now() - startedAt)}ms`)
    return module
  } catch (error) {
    console.error(`[Bootstrap] ${label} failed:`, error)
    throw error
  }
}

async function initializeRuntimeModules(): Promise<void> {
  console.debug('[Main] 开始后台加载运行时模块')

  const [
    ,
    terminalPaneStatus,
    snapshotManager,
    marketplaceDiscovery,
    collabNetworkRecovery,
  ] = await Promise.all([
    timedImport('draftsAggregatedExport', () => import('./stores/draftsAggregatedExport')),
    timedImport('terminalPaneStatusStore', () => import('@/stores/useTerminalPaneStatusStore')),
    timedImport('snapshotManager', () => import('@/components/terminal/snapshotManager')),
    timedImport('marketplaceDiscoveryClient', () => import('@/services/marketplaceDiscoveryClient')),
    timedImport('collabNetworkRecovery', () => import('@/services/collabNetworkRecovery')),
  ])

  safeInit(terminalPaneStatus.initPaneStatusListener, 'PaneStatusListener')
  safeInit(snapshotManager.initSnapshotManager, 'SnapshotManager')
  safeInit(collabNetworkRecovery.initCollabNetworkRecovery, 'CollabNetworkRecovery')

  marketplaceDiscovery.bootstrapMarketplaceDiscoveryPatterns().catch((e) => {
    console.error('[Init] MarketplaceDiscoveryPatterns failed:', e)
  })

}

async function bootstrap(): Promise<void> {
  console.debug('[Main] 开始加载首屏模块')

  const [
    i18nModule,
    uiStoreModule,
    colorSchemesModule,
    queryClientModule,
    notifyModule,
    errorReporter,
    apiAdapter,
    appShell,
    appModule,
    RootBoundary,
  ] = await Promise.all([
    timedImport('i18n', () => import('@/i18n')),
    timedImport('useUIStore', () => import('@/stores/useUIStore')),
    timedImport('color-schemes', () => import('@/constants/color-schemes')),
    timedImport('query-client', () => import('@/lib/query-client')),
    timedImport('notify', () => import('@/utils/notify')),
    timedImport('errorReporter', () => import('@/services/errorReporter')),
    timedImport('api-adapter-instance', () => import('@/adapters/api-adapter-instance')),
    timedImport('app-shell-init', () => import('@/adapters/app-shell-init')),
    timedImport('App', () => import('./App').then(module => ({
      default: module.default,
      preloadAppLayout: module.preloadAppLayout,
    }))),
    import.meta.env.DEV
      ? timedImport('DebugErrorBoundary', () => import('@components/debug').then(module => module.DebugErrorBoundary))
      : Promise.resolve(PassthroughBoundary),
  ])

  const App = appModule.default
  const i18n = i18nModule.default
  if (typeof window !== 'undefined') {
    if (i18n && typeof i18n.t === 'function') {
      window.i18n = i18n as unknown as Window['i18n']
    } else {
      console.error('[Main] ⚠️ i18n 实例异常，跳过 window 注入:', typeof i18n, i18n)
    }
    window.__useUIStore = uiStoreModule.useUIStore
    window.__tabtinNotify = notifyModule.notify
    window.__COLOR_SCHEMES = colorSchemesModule.COLOR_SCHEMES as unknown as Record<string, unknown>
  }
  clearPrebootColorOverrides()

  // 首屏 preload 第 1 层：AppLayout 就绪后再一次性进入应用。
  // App 目前尚无可独立交互的轻量外壳；提前挂载只会把 BootScreen 换成另一个
  // 全屏 Spinner，造成没有实际收益的二段式加载体验。
  try {
    await timedImport('AppLayout', appModule.preloadAppLayout)
  } catch (error) {
    console.error('[Bootstrap] AppLayout preload failed; rendering App fallback path:', error)
  }

  // 首屏 preload 第 2 层：AppLayout 完成后再预热后续 chunk，避免冷启动时
  // 与首屏依赖抢占 Vite 编译和磁盘吞吐。
  //   - 聊天栏 chunk（SpaceChatRailHost → ChatPanel）：几乎必现，优先 kick off
  //   - 已持久化活动 Tab 的 renderPane chunk：按持久化状态精准预热
  void import('@/components/context-space/registry/prefetchPersistedTabPanes')
    .then((m) => {
      m.prefetchChatRail()
      m.prefetchPersistedTabPanes()
    })
    .catch((error) => console.debug('[Bootstrap] 首屏第 2 层预热失败:', error))

  errorReporter.initErrorReporter()

  // Sentry 渲染进程接入：VITE_SENTRY_DSN 未配置时 no-op；
  // 动态加载不拖慢首屏，失败不影响启动。
  void import('@/services/sentry')
    .then((m) => m.initSentryRenderer())
    .catch((e) => console.warn('[Bootstrap] Sentry 初始化失败:', e))

  // 注册「帮助 → 导出诊断日志」菜单触发：主进程菜单 click 会向本窗口发
  // diagnostics:trigger-export，这里动态加载导出编排执行（不拖慢首屏）。
  try {
    window.tabtin?.diagnostics?.onTriggerExport?.(() => {
      void import('@/services/diagnostics/exportDiagnostics').then((m) =>
        m.exportDiagnostics({ reason: 'menu' }),
      )
    })
    window.tabtin?.diagnostics?.onTriggerCopy?.(() => {
      void import('@/services/diagnostics/exportDiagnostics').then((m) =>
        m.copyDiagnosticsToClipboard({ reason: 'menu' }),
      )
    })
  } catch {
    // 诊断触发注册失败不影响启动
  }

  safeInit(apiAdapter.initializeElectronApiAdapter, 'ElectronApiAdapter')
  safeInit(appShell.initAppShellForElectron, 'AppShellForElectron')

  await deviceIdentityPromise

  if (!import.meta.env.DEV) {
    try {
      await initializeRuntimeModules()
    } catch (error) {
      console.error('[Bootstrap] Runtime module init failed:', error)
    }
  }

  const root = getOrCreateRoot(rootContainer)
  console.debug('[Main] 开始渲染应用')
  try {
    root.render(
      <React.StrictMode>
        <QueryClientProvider client={queryClientModule.queryClient}>
          <RootBoundary enabled={import.meta.env.DEV}>
            <App />
          </RootBoundary>
        </QueryClientProvider>
      </React.StrictMode>,
    )
    console.debug('[Main] React 应用已挂载')
  } catch (error) {
    console.error('[Main] ❌ React 应用渲染失败:', error)
    throw error
  }

  if (import.meta.env.DEV) {
    void initializeRuntimeModules().catch((error) => {
      console.error('[Bootstrap] Runtime module init failed:', error)
    })
  }
}

bootstrap().catch((e) => console.error('[Bootstrap] Fatal:', e))
