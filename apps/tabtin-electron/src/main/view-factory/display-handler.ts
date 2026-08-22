/**
 * 显示逻辑模块
 *
 * 职责：
 * - 根据 displayMode 处理 View 显示（hidden / embedded / new-window）
 * - 主窗口内显示/隐藏/移除
 * - 通知渲染进程创建/关闭标签
 */

import type { BrowserWindow } from 'electron'
import type { ViewEntry } from './types'
import type { ViewManager } from '@tabtin/browser-capabilities'
import { applyBrowserViewBorderRadius } from '../browser-view-radius'

export interface DisplayContext {
  mainWindow: BrowserWindow | null
  viewManager: ViewManager
  log: (...args: any[]) => void
  /** RF04: 更新 VSR 中的 lastAccessTime（ViewFactory 提供） */
  touchView: (id: string) => void
}

// ---------------------------------------------------------------------------
// 显示模式处理
// ---------------------------------------------------------------------------

export async function handleDisplay(state: ViewEntry, ctx: DisplayContext): Promise<void> {
  const { displayMode, bounds } = state.config

  ctx.log('[ViewFactory] 处理显示逻辑:', {
    id: state.id,
    displayMode,
    hasBounds: !!bounds
  })

  switch (displayMode) {
    case 'hidden':
      await hideToOffscreen(state, ctx)
      break
    case 'embedded':
      await showInMainWindow(state, ctx)
      break
    case 'new-window':
      throw new Error(
        `[ViewFactory] displayMode 'new-window' 暂未实现，无法显示 View ${state.id}。` +
        `请使用 'hidden' 或 'embedded'。`
      )
    default:
      throw new Error(`未知的 displayMode: ${displayMode}`)
  }
}

export async function hideToOffscreen(state: ViewEntry, ctx: DisplayContext): Promise<void> {
  ctx.log('[ViewFactory] 隐藏 View:', state.id)
  ctx.viewManager.hideView(state.id)
  state.attachedToMainWindow = false
}

export async function showInMainWindow(state: ViewEntry, ctx: DisplayContext): Promise<void> {
  if (!ctx.mainWindow) {
    throw new Error('主窗口未设置，无法显示嵌入式 View')
  }

  ctx.log('[ViewFactory] 显示在主窗口:', state.id)

  ctx.viewManager.showView(state.id)

  if (state.config.bounds) {
    ctx.viewManager.setBounds(state.id, state.config.bounds)
  }
  const view = ctx.viewManager.getView(state.id)
  if (view) {
    applyBrowserViewBorderRadius(view)
  }

  state.attachedToMainWindow = true
  ctx.touchView(state.id)
  ctx.log('[ViewFactory] ✅ View 已显示')
}

export async function removeFromMainWindow(
  id: string,
  views: Map<string, ViewEntry>,
  ctx: DisplayContext
): Promise<void> {
  const state = views.get(id)

  if (!state || !ctx.mainWindow) return

  ctx.log('[ViewFactory] 从主窗口移除:', id)

  ctx.viewManager.hideView(id)

  state.attachedToMainWindow = false

  ctx.log('[ViewFactory] ✅ View 已从主窗口移除')
}

// ---------------------------------------------------------------------------
// 渲染进程标签通知
// ---------------------------------------------------------------------------

export async function notifyRendererCreateTab(
  state: ViewEntry,
  ctx: DisplayContext
): Promise<void> {
  if (!ctx.mainWindow) return

  const allowTempTabUi = process.env.TABTIN_ALLOW_TEMP_TAB_UI === '1'
  if (!allowTempTabUi && !state.config.persistent) {
    ctx.log('[ViewFactory] ⏭️ 临时标签 UI 入口已禁用，跳过通知渲染进程:', {
      id: state.id,
      profile: state.config.profile
    })
    return
  }

  const skipAutoSelect = false

  ctx.log('[ViewFactory] 通知渲染进程创建标签:', {
    id: state.id,
    profile: state.config.profile,
    skipAutoSelect
  })

  ctx.mainWindow.webContents.send('crawl-view:temporary-tab-created', {
    id: state.id,
    url: state.config.url || '',
    name: state.config.tabName || '未命名标签',
    temporary: !state.config.persistent,
    skipAutoSelect,
    profile: state.config.profile,
    kind: state.config.metadata?.kind,
    crawlspaceId: state.config.metadata?.crawlspaceId,
    partition: state.config.partition,
    isPreview: state.config.metadata?.isPreview === true,
    metadata: state.config.metadata
  })

  state.tabNotified = true
}

export async function notifyRendererCloseTab(
  state: ViewEntry,
  ctx: DisplayContext
): Promise<void> {
  if (!ctx.mainWindow) return

  if (state.config.metadata?.kind === 'workspace-view' || state.config.metadata?.crawlspaceId) {
    return
  }

  const allowTempTabUi = process.env.TABTIN_ALLOW_TEMP_TAB_UI === '1'
  if (!allowTempTabUi && !state.config.persistent) {
    ctx.log('[ViewFactory] ⏭️ 临时标签 UI 入口已禁用，跳过关闭通知:', {
      id: state.id,
      profile: state.config.profile
    })
    return
  }

  ctx.log('[ViewFactory] 通知渲染进程关闭标签:', state.id)

  ctx.mainWindow.webContents.send('crawl-view:close-temporary-tab', {
    tabId: state.id,
    profile: state.config.profile,
    kind: state.config.metadata?.kind,
    crawlspaceId: state.config.metadata?.crawlspaceId,
    partition: state.config.partition,
    isPreview: state.config.metadata?.isPreview === true
  })
}
