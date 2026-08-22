/**
 * cdp-actions.ts — CDP 截图 / PDF / Markdown 转换
 *
 * 封装基于 Chrome DevTools Protocol 的页面截图、PDF 生成、
 * HTML→Markdown 转换等操作，供 FrontendActionBridge 注入到 action-tools API。
 */

import {
  setScreenshotAPI,
  setCDPScreenshotAPI,
  setPdfAPI,
  setPageToMarkdownAPI,
} from '@tabtin/action-tools/runtime'
import { createTurndownInstance } from '@tabtin/action-tools/headless'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import { getViewFactory } from '../view-factory'

function isWebContentsVisible(webContents: any): boolean {
  try {
    const factory = getViewFactory()
    if (!factory) return false
    const wcId = webContents.id
    for (const viewId of factory.getAllViewIds()) {
      const state = factory.getViewState(viewId)
      if (state && state.view?.webContents?.id === wcId) {
        return state.attachedToMainWindow
      }
    }
  } catch { /* ignore lookup failures */ }
  return false
}

export async function cdpCapture(webContents: any, cdpOpts?: {
  fullPage?: boolean
  width?: number
  format?: 'png' | 'jpeg'
  quality?: number
}): Promise<Buffer> {
  const { width = 1280, fullPage = false, format = 'png', quality } = cdpOpts || {}
  const debugger_ = webContents.debugger
  let wasAttached = false
  let needsRestore = false

  try {
    if (!debugger_.isAttached()) {
      debugger_.attach('1.3')
      wasAttached = true
    }

    const isVisible = isWebContentsVisible(webContents)

    if (!isVisible) {
      await debugger_.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
      })
      needsRestore = true
      await new Promise(r => setTimeout(r, 200))
    }

    const result = await debugger_.sendCommand('Page.captureScreenshot', {
      format: format === 'jpeg' ? 'jpeg' : 'png',
      ...(format === 'jpeg' && quality ? { quality } : {}),
      captureBeyondViewport: fullPage,
    })

    if (needsRestore) {
      await debugger_.sendCommand('Emulation.clearDeviceMetricsOverride')
    }

    return Buffer.from(result.data, 'base64')
  } finally {
    if (wasAttached) {
      try { debugger_.detach() } catch { /* already detached */ }
    }
  }
}

export function setupScreenshotAPI(): void {
  setScreenshotAPI({
    capture: async (options) => {
      if (options.fullPage && options.viewId) {
        const factory = getViewFactory()
        const webContents = factory.getWebContents(options.viewId)
        if (!webContents || webContents.isDestroyed()) {
          return { success: false, error: `View ${options.viewId} not found or destroyed` }
        }

        try {
          const fmt = options.format || 'png'
          const buffer = await cdpCapture(webContents, {
            fullPage: true,
            format: fmt,
            quality: options.quality,
          })

          const { nativeImage } = await import('electron')
          const img = nativeImage.createFromBuffer(buffer)
          const size = img.getSize()

          const { join } = await import('path')
          const { mkdirSync, writeFileSync } = await import('fs')
          const dir = options.savePath || getHomeTabtinPath('screenshots')
          mkdirSync(dir, { recursive: true })
          const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
          const filename = `view-fullpage-${ts}.${fmt}`
          const fullPath = join(dir, filename)
          writeFileSync(fullPath, buffer)

          const result: any = {
            success: true,
            path: fullPath,
            width: size.width,
            height: size.height,
            format: fmt,
            sizeBytes: buffer.length,
          }

          if (options.includeBase64) {
            result.base64 = buffer.toString('base64')
          }

          return result
        } catch (e: any) {
          return { success: false, error: e?.message || 'CDP full-page screenshot failed' }
        }
      }

      const { captureScreenshot } = await import('./ScreenshotService')
      return captureScreenshot(options)
    },
  })
}

export function setupPdfAPI(): void {
  setPdfAPI({
    generate: async (options) => {
      const factory = getViewFactory()
      if (!factory) return { success: false, error: 'ViewFactory not available' }
      const webContents = factory.getWebContents(options.viewId)
      if (!webContents || webContents.isDestroyed()) {
        return { success: false, error: `View ${options.viewId} not found or destroyed` }
      }
      try {
        const pdfOpts: Electron.PrintToPDFOptions = {
          landscape: options.landscape ?? false,
          printBackground: options.printBackground ?? true,
          pageSize: (options.pageSize as any) || 'A4',
        }
        if (options.margins) pdfOpts.margins = options.margins
        const buf = await webContents.printToPDF(pdfOpts)
        const { join } = await import('path')
        const { writeFile, mkdir } = await import('fs/promises')
        const dir = getHomeTabtinPath('exports')
        await mkdir(dir, { recursive: true })
        const savePath = options.savePath || join(dir, `pdf-${Date.now()}.pdf`)
        await writeFile(savePath, buf)
        return { success: true, path: savePath, sizeBytes: buf.length }
      } catch (e: any) {
        return { success: false, error: e?.message || 'PDF generation failed' }
      }
    },
  })
}

export function setupMarkdownAPI(): void {
  setPageToMarkdownAPI({
    convert: async (options) => {
      const factory = getViewFactory()
      if (!options.viewId && !options.url) {
        return { success: false, error: 'viewId or url is required' }
      }
      let html = ''
      let title = ''
      let url = ''

      if (options.viewId && factory) {
        const webContents = factory.getWebContents(options.viewId)
        if (!webContents || webContents.isDestroyed()) {
          return { success: false, error: `View ${options.viewId} not found or destroyed` }
        }
        html = await webContents.executeJavaScript('document.documentElement.outerHTML')
        title = await webContents.executeJavaScript('document.title')
        url = webContents.getURL()
      } else if (options.url) {
        const { net } = await import('electron')
        const resp = await net.fetch(options.url)
        html = await resp.text()
        url = options.url
        const m = html.match(/<title[^>]*>([^<]+)<\/title>/i)
        title = m?.[1] ?? ''
      }

      try {
        const td = await createTurndownInstance({
          removeImages: !options.includeImages,
          removeLinks: !options.includeLinks,
        })
        const markdown = td.turndown(html)
        return {
          success: true,
          markdown,
          title,
          url,
          wordCount: markdown.split(/\s+/).filter(Boolean).length,
        }
      } catch (e: any) {
        return { success: false, error: e?.message || 'Markdown conversion failed' }
      }
    },
  })
}

export function setupCDPScreenshotAPI(): void {
  setCDPScreenshotAPI({
    capture: cdpCapture,
  })
}

export function setupAllCDPActions(): void {
  setupScreenshotAPI()
  setupPdfAPI()
  setupMarkdownAPI()
  setupCDPScreenshotAPI()
}
