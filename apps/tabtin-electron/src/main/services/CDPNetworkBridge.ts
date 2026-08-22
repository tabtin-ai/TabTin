/**
 * CDPNetworkBridge — Electron 端浏览器 tab 的 CDP 桥接。
 *
 * 两个职责：
 *  1. **network/console 历史捕获**（BR-8 P3b）：构造 `ElectronBrowserContext`，调
 *     browser-core 的**双端共享** `attachRuntimeLogCapture` → 经 `onCDPEvent` 把
 *     Network/Runtime/Log 事件喂进共享 `NetworkLog` / `ConsoleLog`。Electron 与
 *     Daemon 自此走同一份 buffer 实现（写入 + 读取），不再有 Electron 私有并行缓冲。
 *  2. **请求拦截**（route/unroute 规则）：webContents.debugger 的 `Fetch.enable` +
 *     `Fetch.requestPaused` → fulfill/continue（这部分属 route 层，P3b 不动）。
 *
 * Debugger 生命周期委托给 CDPConnectionManager（strategy: 'persistent'）；该 manager
 * 与 ElectronBrowserContext 共用同一全局单例，attach 幂等、不会重复 attach。
 */

import { getRouteRules } from '@tabtin/action-tools/tools'
import { getCDPConnectionManager } from '@tabtin/action-tools/cdp'
import type { RouteRule } from '@tabtin/action-tools/types'
import { attachRuntimeLogCapture, getSharedNetworkLog, getSharedConsoleLog } from '@tabtin/browser-core'
import { ElectronBrowserContext } from '../context/ElectronBrowserContext'
import { createLogger } from '../logger'

const log = createLogger('CDPNetworkBridge')

type WebContents = Electron.WebContents

interface TabSession {
  tabId: string
  webContents: WebContents
  fetchEnabled: boolean
  /** 仅处理 Fetch.requestPaused 的原始 debugger 监听（network/console 走 ctx）。 */
  fetchHandler?: (event: Electron.Event, method: string, params: any) => void
  /** 共享 network/console 捕获的取消订阅函数（attachRuntimeLogCapture 返回）。 */
  disposeLogCapture?: () => void
}

const activeSessions = new Map<string, TabSession>()

export async function enableForTab(webContents: WebContents, tabId: string): Promise<void> {
  if (activeSessions.has(tabId)) {
    return
  }

  if (webContents.isDestroyed()) {
    log.warn('webContents already destroyed for tab', tabId)
    return
  }

  const manager = getCDPConnectionManager()
  try {
    await manager.getOrAttach(webContents, { strategy: 'persistent' })
  } catch (err: any) {
    log.error('CDPConnectionManager attach failed for tab', tabId, err?.message)
    return
  }

  const session: TabSession = {
    tabId,
    webContents,
    fetchEnabled: false,
  }
  activeSessions.set(tabId, session)

  const dbg = webContents.debugger

  // 仅消费 Fetch.requestPaused（拦截规则）；network/console 由 ctx.onCDPEvent 接管。
  const fetchHandler = (_event: any, method: string, params: any) => {
    if (method === 'Fetch.requestPaused') {
      void handleRequestPaused(tabId, params)
    }
  }
  session.fetchHandler = fetchHandler
  dbg.on('message', fetchHandler)

  dbg.on('detach', () => {
    log.info('Debugger detached for tab', tabId)
    const s = activeSessions.get(tabId)
    s?.disposeLogCapture?.()
    activeSessions.delete(tabId)
    getSharedNetworkLog().clear(tabId)
    getSharedConsoleLog().clear(tabId)
  })

  // ── network/console 历史捕获：browser-core 双端共享实现 ──
  try {
    const ctx = new ElectronBrowserContext(webContents)
    session.disposeLogCapture = await attachRuntimeLogCapture(ctx, tabId, {
      networkLog: getSharedNetworkLog(),
      consoleLog: getSharedConsoleLog(),
      // Electron 保留响应体抓取（旧 CDPNetworkBridge 行为）；daemon 默认关。
      captureBodies: true,
    })
  } catch (err: any) {
    log.warn('attachRuntimeLogCapture failed for tab', tabId, err?.message)
  }

  await refreshFetchInterception(tabId)

  log.info(`Enabled for tab ${tabId} — logCapture:${!!session.disposeLogCapture} fetch:${session.fetchEnabled}`)
}

export async function disableForTab(tabId: string): Promise<void> {
  const session = activeSessions.get(tabId)
  if (!session) return

  const { webContents } = session
  activeSessions.delete(tabId)

  session.disposeLogCapture?.()
  getSharedNetworkLog().clear(tabId)
  getSharedConsoleLog().clear(tabId)

  if (!webContents.isDestroyed() && session.fetchHandler) {
    try {
      webContents.debugger.removeListener('message', session.fetchHandler)
    } catch {
      // best effort
    }
  }

  if (webContents.isDestroyed()) return

  try {
    const dbg = webContents.debugger
    // 只关 Fetch（CDPNetworkBridge 自己开的）；Network/Runtime/Log 可能被其它 CDP
    // 消费方共用，不在此处统一 disable，避免误伤。
    if (dbg.isAttached() && session.fetchEnabled) {
      await dbg.sendCommand('Fetch.disable').catch(() => {})
    }
  } catch {
    // best effort cleanup
  }

  log.info(`Disabled for tab ${tabId}`)
}

/**
 * Refresh Fetch.enable with current route rule URL patterns.
 * Called when route rules change for a given tab.
 */
export async function refreshFetchInterception(tabId: string): Promise<void> {
  const session = activeSessions.get(tabId)
  if (!session || session.webContents.isDestroyed()) return

  const rules = getRouteRules(tabId)
  const dbg = session.webContents.debugger

  if (!dbg.isAttached()) return

  if (rules.length === 0) {
    if (session.fetchEnabled) {
      try {
        await dbg.sendCommand('Fetch.disable')
        session.fetchEnabled = false
      } catch { /* ignore */ }
    }
    return
  }

  const patterns = rules.map((r: RouteRule) => ({
    urlPattern: r.urlPattern,
    requestStage: 'Response' as const,
  }))

  try {
    if (session.fetchEnabled) {
      await dbg.sendCommand('Fetch.disable')
    }
    await dbg.sendCommand('Fetch.enable', { patterns })
    session.fetchEnabled = true
  } catch (err: any) {
    log.warn('Fetch.enable failed for tab', tabId, err?.message)
  }
}

async function handleRequestPaused(tabId: string, params: any): Promise<void> {
  const session = activeSessions.get(tabId)
  if (!session || session.webContents.isDestroyed()) return

  const { requestId, request } = params
  const dbg = session.webContents.debugger

  if (!dbg.isAttached()) return

  const rules = getRouteRules(tabId)
  const matchedRule = rules.find((r: RouteRule) => {
    try {
      return new RegExp(r.urlPattern).test(request.url)
    } catch {
      return request.url.includes(r.urlPattern)
    }
  })

  try {
    if (matchedRule) {
      const responseBody = matchedRule.body || ''
      const encodedBody = Buffer.from(responseBody).toString('base64')

      const responseHeaders: Array<{ name: string; value: string }> = []
      if (matchedRule.headers) {
        for (const [name, value] of Object.entries(matchedRule.headers)) {
          responseHeaders.push({ name, value: String(value) })
        }
      }
      if (!matchedRule.headers?.['content-type'] && !matchedRule.headers?.['Content-Type']) {
        responseHeaders.push({ name: 'Content-Type', value: 'text/plain' })
      }

      await dbg.sendCommand('Fetch.fulfillRequest', {
        requestId,
        responseCode: matchedRule.status ?? 200,
        responseHeaders,
        body: encodedBody,
      })
    } else {
      await dbg.sendCommand('Fetch.continueRequest', { requestId })
    }
  } catch (err: any) {
    try {
      await dbg.sendCommand('Fetch.continueRequest', { requestId })
    } catch { /* request may have been cancelled */ }
  }
}

export function getActiveTabIds(): string[] {
  return Array.from(activeSessions.keys())
}

export function isEnabledForTab(tabId: string): boolean {
  return activeSessions.has(tabId)
}
