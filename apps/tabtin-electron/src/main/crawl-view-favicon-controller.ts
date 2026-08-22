import type { WebContents } from 'electron'

import { getFaviconResolver } from './webcontents/favicon-resolver'
import { createLogger } from './logger'

const log = createLogger('FaviconController')

export interface CrawlViewFaviconPayload {
  favicon: string
  url: string
  viewId?: string
}

export interface CrawlViewFaviconControllerOptions {
  emitFaviconChanged: (payload: CrawlViewFaviconPayload) => void
}

export interface CrawlViewFaviconController {
  attach: (webContents: WebContents, viewId: string | null) => void
  detach: () => void
  handleFaviconUpdated: (
    webContents: WebContents,
    viewId: string | null,
    favicons: string[],
  ) => void
}

let _faviconResolver: ReturnType<typeof getFaviconResolver> | null = null

function getResolver() {
  if (!_faviconResolver) {
    _faviconResolver = getFaviconResolver()
  }
  return _faviconResolver
}

export function createCrawlViewFaviconController(
  options: CrawlViewFaviconControllerOptions,
): CrawlViewFaviconController {
  let attachedTarget: { webContents: WebContents; viewId: string | null } | null = null

  const isCurrentAttachedView = (
    webContents: WebContents,
    viewId: string | null,
  ): boolean => {
    return attachedTarget?.webContents === webContents && attachedTarget.viewId === viewId
  }

  return {
    attach: (webContents, viewId) => {
      attachedTarget = { webContents, viewId }
    },
    detach: () => {
      attachedTarget = null
    },
    handleFaviconUpdated: (webContents, viewId, favicons) => {
      if (webContents.isDestroyed()) return
      if (!favicons || favicons.length === 0) return

      void getResolver()
        .resolve({
          webContents,
          pageUrl: webContents.getURL(),
          favicons,
          allowDom: false,
        })
        .then((dataUrl) => {
          if (webContents.isDestroyed()) return
          if (!isCurrentAttachedView(webContents, viewId)) return
          const fallback = favicons[0] || null
          const favicon = dataUrl || fallback
          if (!favicon) return
          options.emitFaviconChanged({
            favicon,
            url: webContents.getURL(),
            viewId: viewId ?? undefined,
          })
          // 只记录来源与体积，避免把整条 favicon data URL（可能是 MB 级 base64）打进日志，
          // 撑爆终端缓冲与内存（见 favicon 内存链排查）。
          log.debug('Favicon 变化:', {
            url: webContents.getURL(),
            isDataUrl: favicon.startsWith('data:'),
            length: favicon.length,
          })
        })
        .catch((err) => {
          log.warn('Favicon 解析失败:', err)
        })
    },
  }
}
