/**
 * Tins ↔ CrawlView 集成层
 *
 * 职责：
 * 1. 订阅 CrawlViewEventManager 的外部监听器，驱动 TinManager 的激活评估
 * 2. 提供页面内容提取能力给 TinBridge
 * 3. 管理 content script 注入
 */

import { ipcMain, dialog, BrowserWindow, type WebContents, type WebContentsView } from 'electron'
import { logger } from '../utils/logger'
import { guardedHandle } from '../utils/guarded-handle'
import { getTinManager } from './tin-manager'
import { disposeTinBridge } from './tin-bridge'
import { UUID_RE, TinPermission } from './types'
import type { PageContext } from './activation-matcher'
import type { CrawlViewEventData } from '../crawl-view-events'

const TAG = 'TinsCrawlView'

/**
 * 模块级集成状态。集中管理以便清晰追踪生命周期，
 * 避免多个散落 let 变量在热重载/多窗口场景下造成的状态错乱。
 */
const state = {
  activeWebContents: null as WebContents | null,
  unsubscribeEventManager: null as (() => void) | null,
  viewGetter: null as ((tabId: string) => WebContentsView | undefined) | null,
}

/**
 * SD-052: 会话级已授权注入的 Tin 集合 — 按 tinId + URL origin 粒度授权。
 * 一次批准仅对该 Tin 在该 origin 下有效，换站需重新确认。
 */
const approvedTinOrigins = new Map<string, Set<string>>()

function safeGetOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function isApprovedForOrigin(tinId: string, origin: string): boolean {
  if (!origin) return false
  return approvedTinOrigins.get(tinId)?.has(origin) ?? false
}

function approveForOrigin(tinId: string, origin: string): void {
  if (!origin) return
  let origins = approvedTinOrigins.get(tinId)
  if (!origins) {
    origins = new Set()
    approvedTinOrigins.set(tinId, origins)
  }
  origins.add(origin)
}

export interface CrawlViewIntegrationOptions {
  /** 通过 tabId 获取对应 WebContentsView（来自 embedded-crawl-view） */
  getView: (tabId: string) => WebContentsView | undefined
}

/**
 * 初始化 CrawlView 集成。
 *
 * 通过 CrawlViewEventManager.addExternalListener 在主进程内直接订阅事件，
 * 不再依赖渲染进程转发。
 */
export function initCrawlViewIntegration(options: CrawlViewIntegrationOptions): void {
  state.viewGetter = options.getView

  guardedHandle('tins:inject-content-script', async (_event, instanceId: string) => {
    if (!UUID_RE.test(instanceId)) {
      logger.warn(TAG, 'Rejected inject-content-script: invalid instanceId format')
      return false
    }
    const manager = getTinManager()
    const instance = manager.findInstance(instanceId)
    if (!instance) {
      logger.warn(TAG, `Rejected inject-content-script: instance not found (${instanceId})`)
      return false
    }
    if (!instance.tin.permissions?.includes(TinPermission.PAGE_INJECT)) {
      logger.warn(TAG, `Rejected inject-content-script: missing ${TinPermission.PAGE_INJECT} permission (${instance.tin.name})`)
      return false
    }
    return injectContentScript(instanceId)
  })

  logger.info(TAG, 'CrawlView integration initialized')
}

/**
 * 连接到 CrawlViewEventManager，开始接收事件。
 * 需要在 CrawlViewEventManager 初始化之后调用。
 */
export function connectCrawlViewEvents(
  addExternalListener: (listener: (event: CrawlViewEventData) => void) => () => void
): void {
  if (state.unsubscribeEventManager) {
    state.unsubscribeEventManager()
  }
  state.unsubscribeEventManager = addExternalListener((event: CrawlViewEventData) => {
    onCrawlViewEvent(event)
  })
  logger.info(TAG, 'Connected to CrawlViewEventManager')
}

export function disposeCrawlViewIntegration(): void {
  if (state.unsubscribeEventManager) {
    state.unsubscribeEventManager()
    state.unsubscribeEventManager = null
  }
  try { ipcMain.removeHandler('tins:inject-content-script') } catch { /* already removed */ }
  disposeTinBridge()
  state.activeWebContents = null
  state.viewGetter = null
  approvedTinOrigins.clear()
  logger.info(TAG, 'CrawlView integration disposed')
}

/**
 * CrawlViewEventManager 事件回调：
 * 自动更新 activeWebContents 并驱动 TinManager。
 */
function onCrawlViewEvent(event: CrawlViewEventData): void {
  const viewId = event.data?.viewId as string | undefined

  if (viewId && state.viewGetter) {
    const view = state.viewGetter(viewId)
    if (view?.webContents && !view.webContents.isDestroyed()) {
      state.activeWebContents = view.webContents
    }
  }

  handleCrawlEvent({ type: event.type, data: event.data })
}

/**
 * 设置当前活跃的 WebContents（用于页面内容提取）。
 */
export function setActiveWebContents(webContents: WebContents | null): void {
  state.activeWebContents = webContents
}

/**
 * 处理 CrawlView 事件。
 */
function handleCrawlEvent(eventData: { type: string; data: any }): void {
  const manager = getTinManager()

  switch (eventData.type) {
    case 'navigation:started':
    case 'url:changed': {
      const url = eventData.data?.url || ''
      const title = eventData.data?.title || ''
      const context: PageContext = { url, title }
      manager.onPageNavigate(context)
      manager.broadcastToActiveTinWebviews('tin-event:page-navigate', url)
      break
    }

    case 'title:changed': {
      const title = eventData.data?.title || ''
      manager.onPageTitleUpdate(title)
      break
    }

    case 'page:loaded': {
      detectPageLanguage()
      injectContentScriptsForActive()
      manager.broadcastToActiveTinWebviews('tin-event:page-content-change')
      break
    }
  }
}

/**
 * 检测当前页面语言，通知 TinManager。
 */
async function detectPageLanguage(): Promise<void> {
  if (!state.activeWebContents || state.activeWebContents.isDestroyed()) return

  try {
    const lang = await state.activeWebContents.executeJavaScript(
      `document.documentElement.lang || document.querySelector('meta[http-equiv="content-language"]')?.content || ''`
    )
    if (lang) {
      getTinManager().onPageLanguageDetected(lang)
    }
  } catch (e) {
    logger.debug(TAG, 'Failed to detect page language:', e)
  }
}

/**
 * 获取页面内容（供 TinBridge 使用）。
 */
export async function getPageContent(
  format: 'text' | 'html' | 'markdown' = 'text'
): Promise<string> {
  if (!state.activeWebContents || state.activeWebContents.isDestroyed()) {
    return ''
  }

  try {
    switch (format) {
      case 'html':
        return await state.activeWebContents.executeJavaScript(
          `document.documentElement.outerHTML`
        )
      case 'text':
        return await state.activeWebContents.executeJavaScript(
          `document.body.innerText || document.body.textContent || ''`
        )
      case 'markdown':
        return await state.activeWebContents.executeJavaScript(
          `document.body.innerText || document.body.textContent || ''`
        )
      default:
        return ''
    }
  } catch (e) {
    logger.warn(TAG, 'Failed to get page content:', e)
    return ''
  }
}

/**
 * 获取页面选区文本。
 */
export async function getPageSelection(): Promise<string> {
  if (!state.activeWebContents || state.activeWebContents.isDestroyed()) {
    return ''
  }

  try {
    return await state.activeWebContents.executeJavaScript(
      `window.getSelection()?.toString() || ''`
    )
  } catch (e) {
    logger.debug(TAG, 'Failed to get page selection:', e)
    return ''
  }
}

/**
 * SD-011 + SD-052: 请求用户授权 Tin 注入 content script。
 * 按 tinId + URL origin 粒度授权（SD-052），换站点需重新确认。
 * Dialog 明确告知 content script 的完整能力范围（SD-011）。
 */
async function requestInjectionApproval(tinName: string, tinId: string, pageUrl: string): Promise<boolean> {
  const origin = safeGetOrigin(pageUrl)
  if (isApprovedForOrigin(tinId, origin)) return true

  const displayOrigin = origin || pageUrl || '未知页面'

  const focusedWindow = BrowserWindow.getFocusedWindow()
  const options = {
    type: 'warning' as const,
    title: 'Tin 内容脚本注入确认',
    message: `Tin「${tinName}」请求向当前页面注入内容脚本`,
    detail:
      `目标站点: ${displayOrigin}\n\n` +
      `该脚本将获得以下能力:\n` +
      `• 读取和修改页面 DOM 内容\n` +
      `• 访问页面 Cookie 和 localStorage\n` +
      `• 拦截和读取表单输入\n` +
      `• 向外部服务器发送网络请求\n\n` +
      `仅在您完全信任此 Tin 时才允许。\n` +
      `授权仅对该站点 (${displayOrigin}) 生效，访问其他站点时将再次询问。`,
    buttons: ['允许', '拒绝'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }

  const result = focusedWindow
    ? await dialog.showMessageBox(focusedWindow, options)
    : await dialog.showMessageBox(options)

  if (result.response === 0) {
    approveForOrigin(tinId, origin)
    logger.info(TAG, `User approved content script injection for Tin: ${tinName} (${tinId}) on ${displayOrigin}`)
    return true
  }

  logger.info(TAG, `User denied content script injection for Tin: ${tinName} (${tinId}) on ${displayOrigin}`)
  return false
}

/**
 * 为当前激活的 Tins 注入 content script。
 */
async function injectContentScriptsForActive(): Promise<void> {
  if (!state.activeWebContents || state.activeWebContents.isDestroyed()) return

  const manager = getTinManager()
  const activeInstances = manager.getActiveInstances()

  for (const instance of activeInstances) {
    const script = instance.tin.content_script
    if (!script) continue

    if (!instance.tin.permissions?.includes(TinPermission.PAGE_INJECT)) {
      logger.debug(TAG, `Tin ${instance.tin.name} missing ${TinPermission.PAGE_INJECT} permission, skipping content script`)
      continue
    }

    const pageUrl = state.activeWebContents?.isDestroyed() === false
      ? state.activeWebContents.getURL()
      : ''
    const approved = await requestInjectionApproval(instance.tin.name, instance.tin.id, pageUrl)
    if (!approved) continue

    try {
      await state.activeWebContents.executeJavaScript(wrapContentScript(instance.id, script))
      logger.debug(TAG, `Content script injected for Tin: ${instance.tin.name}`)
    } catch (e) {
      logger.warn(TAG, `Failed to inject content script for Tin ${instance.tin.name}:`, e)
    }
  }
}

/**
 * 为指定 Tin 实例注入 content script。
 */
async function injectContentScript(instanceId: string): Promise<boolean> {
  if (!state.activeWebContents || state.activeWebContents.isDestroyed()) return false

  const manager = getTinManager()
  const instance = manager.findInstance(instanceId)
  if (!instance?.tin.content_script) return false

  const pageUrl = state.activeWebContents?.isDestroyed() === false
    ? state.activeWebContents.getURL()
    : ''
  const approved = await requestInjectionApproval(instance.tin.name, instance.tin.id, pageUrl)
  if (!approved) return false

  try {
    await state.activeWebContents.executeJavaScript(
      wrapContentScript(instanceId, instance.tin.content_script)
    )
    return true
  } catch (e) {
    logger.warn(TAG, `Failed to inject content script for ${instanceId}:`, e)
    return false
  }
}

/**
 * 用 IIFE 包装 content script，防止全局污染，并注入 tinId。
 */
function wrapContentScript(instanceId: string, script: string): string {
  if (!UUID_RE.test(instanceId)) {
    throw new Error(`Invalid instanceId for content script: ${instanceId}`)
  }
  const safeId = JSON.stringify(instanceId)
  const guardKey = `__TIN_INJECTED_${instanceId.replace(/-/g, '_')}__`
  return `
    (function() {
      if (window[${JSON.stringify(guardKey)}]) return;
      window[${JSON.stringify(guardKey)}] = true;
      const __TIN_INSTANCE_ID__ = ${safeId};
      try {
        ${script}
      } catch(e) {
        console.error('[Tin ContentScript]', ${safeId}, e);
      }
    })();
  `
}
