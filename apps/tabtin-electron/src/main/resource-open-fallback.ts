/**
 * Main → renderer bridge for window.open / crawlspace popup URLs.
 *
 * Renderer `onOpenFallback` runs `tryOpenPreviewableDirectUrl` first, then
 * ResourceRouter. Previewable xlsx/pdf/image URLs therefore never create tabweb.
 */

import type { BrowserWindow } from 'electron'
import { createLogger } from './logger'

const log = createLogger('ResourceOpenFallback')

export const RESOURCE_OPEN_FALLBACK_CHANNEL = 'main:resource-router:open-fallback'

export interface ResourceOpenFallbackPayload {
  url: string
  source: string
  viewId?: string
  disposition?: string
  filename?: string
  mimeType?: string
  assetId?: string
}

export function sendResourceOpenFallback(
  mainWindow: BrowserWindow | null | undefined,
  payload: ResourceOpenFallbackPayload,
): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log.warn('sendResourceOpenFallback skipped: main window unavailable', {
      source: payload.source,
    })
    return false
  }
  mainWindow.webContents.send(RESOURCE_OPEN_FALLBACK_CHANNEL, payload)
  return true
}
