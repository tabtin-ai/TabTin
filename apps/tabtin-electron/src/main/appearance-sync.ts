import { nativeTheme, type BrowserWindow, type WebContents } from 'electron'

import { getDeferredViewFactory } from './deferred-services'
import type { MainWindowAppearance } from './types/runtime'

type ViewFactoryLike = {
  getAllViewIds: () => string[]
  getWebContents: (id: string) => WebContents | null | undefined
}

const BG_COLOR_LIGHT = '#F5F3F0'
const BG_COLOR_DARK = '#111319'

export interface AppearanceSyncController {
  getCurrentAppearance: () => MainWindowAppearance
  setCurrentAppearance: (appearance: MainWindowAppearance) => void
  getBackgroundColor: () => string
  applyAppearanceToWebContents: (
    webContents: WebContents,
    appearance: MainWindowAppearance,
  ) => void
  ensureWebContentsThemeSync: (webContents: WebContents) => void
  cleanupWebContentsThemeSync: (webContents: WebContents) => void
  applyAppearanceToAllCrawlViews: (appearance: MainWindowAppearance) => void
  applyBackgroundForAppearance: (
    mainWindow: BrowserWindow,
    appearance: MainWindowAppearance,
  ) => void
}

export interface AppearanceSyncControllerOptions {
  /** 可注入自定义 ViewFactory，用于单元测试 mock；不传则使用全局 getDeferredViewFactory() */
  getViewFactory?: () => ViewFactoryLike | null
}

export function createAppearanceSyncController(options?: AppearanceSyncControllerOptions): AppearanceSyncController {
  let currentAppearance: MainWindowAppearance = 'system'
  const themedWebContents = new WeakSet<WebContents>()
  const themedWebContentsHandlers = new WeakMap<WebContents, () => void>()

  const resolveAppearance = (appearance: MainWindowAppearance): 'light' | 'dark' => {
    if (appearance === 'system') {
      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    }
    return appearance
  }

  const getBackgroundColor = () => {
    return resolveAppearance(currentAppearance) === 'dark' ? BG_COLOR_DARK : BG_COLOR_LIGHT
  }

  const buildWebContentsThemeScript = (resolvedAppearance: 'light' | 'dark') => `
(() => {
  try {
    const theme = ${JSON.stringify(resolvedAppearance)};
    const root = document.documentElement;
    if (root) {
      root.setAttribute('data-tabtin-color-scheme', theme);
    }
  } catch (error) {
    // 静默失败，避免影响页面逻辑
  }
})();`

  const applyAppearanceToWebContents = (
    webContents: WebContents,
    appearance: MainWindowAppearance,
  ) => {
    if (!webContents || webContents.isDestroyed()) {
      return
    }
    const resolvedAppearance = resolveAppearance(appearance)
    const script = buildWebContentsThemeScript(resolvedAppearance)
    webContents.executeJavaScript(script, true).catch(() => {
      // 忽略执行失败，避免影响页面加载
    })
  }

  const ensureWebContentsThemeSync = (webContents: WebContents) => {
    if (!webContents || webContents.isDestroyed()) {
      return
    }
    if (themedWebContents.has(webContents)) {
      return
    }
    themedWebContents.add(webContents)
    const handler = () => {
      applyAppearanceToWebContents(webContents, currentAppearance)
    }
    themedWebContentsHandlers.set(webContents, handler)
    webContents.on('dom-ready', handler)
  }

  const cleanupWebContentsThemeSync = (webContents: WebContents) => {
    if (!webContents) {
      return
    }
    const handler = themedWebContentsHandlers.get(webContents)
    if (handler && !webContents.isDestroyed()) {
      webContents.removeListener('dom-ready', handler)
    }
    themedWebContentsHandlers.delete(webContents)
    themedWebContents.delete(webContents)
  }

  const applyAppearanceToAllCrawlViews = (appearance: MainWindowAppearance) => {
    const viewFactory = options?.getViewFactory ? options.getViewFactory() : getDeferredViewFactory()
    if (!viewFactory) {
      return
    }
    for (const viewId of viewFactory.getAllViewIds()) {
      const webContents = viewFactory.getWebContents(viewId)
      if (webContents && !webContents.isDestroyed()) {
        ensureWebContentsThemeSync(webContents)
        applyAppearanceToWebContents(webContents, appearance)
      }
    }
  }

  const applyBackgroundForAppearance = (
    mainWindow: BrowserWindow,
    appearance: MainWindowAppearance,
  ) => {
    const isDark = appearance === 'dark' || (
      appearance === 'system' && nativeTheme.shouldUseDarkColors
    )
    mainWindow.setBackgroundColor(isDark ? BG_COLOR_DARK : BG_COLOR_LIGHT)
  }

  return {
    getCurrentAppearance: () => currentAppearance,
    setCurrentAppearance: (appearance) => {
      currentAppearance = appearance
    },
    getBackgroundColor,
    applyAppearanceToWebContents,
    ensureWebContentsThemeSync,
    cleanupWebContentsThemeSync,
    applyAppearanceToAllCrawlViews,
    applyBackgroundForAppearance,
  }
}
