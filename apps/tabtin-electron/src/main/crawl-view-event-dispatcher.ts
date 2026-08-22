import type { BrowserWindow } from 'electron'

import { getEventBridge } from './run-session/EventBridge'
import { getRunSessionManager } from './run-session/RunSessionManager'
import { createLogger } from './logger'

const log = createLogger('CrawlViewEvents')

export interface DispatchableCrawlViewEvent {
  type: string
  timestamp: number
  runId?: string
  data: any
}

export type CrawlViewEventListener = (event: DispatchableCrawlViewEvent) => void

export interface DispatchCrawlViewEventOptions {
  type: string
  data: any
  fallbackViewId?: string | null
  timestamp?: number
  mainWindow: Pick<BrowserWindow, 'isDestroyed' | 'webContents'> | null
  externalListeners: CrawlViewEventListener[]
}

export function dispatchCrawlViewEvent(
  options: DispatchCrawlViewEventOptions,
): void {
  if (!options.mainWindow || options.mainWindow.isDestroyed()) {
    return
  }

  const viewId = options.data?.viewId || options.fallbackViewId || undefined
  const runSessionManager = getRunSessionManager()
  const runId = viewId ? runSessionManager.getRunIdByView(viewId) : undefined
  const eventData: DispatchableCrawlViewEvent = {
    type: options.type,
    timestamp: options.timestamp ?? Date.now(),
    runId: runId ?? undefined,
    data: {
      ...options.data,
      viewId,
    },
  }

  if (viewId && runId) {
    runSessionManager.addObservation({
      viewId,
      type: eventData.type,
      timestamp: eventData.timestamp,
      data: eventData.data,
      context: {
        url: eventData.data?.url,
        title: eventData.data?.title,
        error: eventData.data?.errorDescription
          ? { message: eventData.data.errorDescription }
          : undefined,
      },
    })
  }

  try {
    getEventBridge().push(eventData)
  } catch (error) {
    log.warn(`⚠️ 推送 EventBridge 失败（忽略）type=${eventData.type} viewId=${viewId}:`, error)
  }

  options.mainWindow.webContents.send('crawl-view:event', eventData)

  for (const listener of options.externalListeners) {
    try {
      listener(eventData)
    } catch (error) {
      log.warn(`外部 listener 执行出错 type=${eventData.type}:`, error)
    }
  }
}
