/**
 * ElectronCrawlToolRunner
 *
 * 在 Electron 主进程中实现 CrawlToolRunner 接口，
 * 利用已有的 View 生命周期 API 和 HTML 清洗能力完成网页内容抓取。
 *
 * 流程：创建 background view -> 加载 URL -> 提取 HTML -> 清洗 -> 销毁 view
 *
 * 安全措施：
 * - 任务级总体超时（默认 60s），防止页面 JS 死循环导致无限 hang
 * - 超时后主动销毁 View 并返回明确的超时错误
 */

import type { CrawlToolRunner, CrawlCleanHtmlInput, CrawlCleanHtmlOutput } from '@tabtin/action-tools/types'
import { cleanHtml, generateSkeletonHtml } from '@tabtin/action-tools/impl'
import { buildDeepOuterHTMLExpression } from '@tabtin/browser-core'
import { getViewFactory } from '../view-factory'
import { loadUrl } from '../embedded-crawl-view'
import { createLogger } from '../logger'

const log = createLogger('ElectronCrawlRunner')

const DEFAULT_TASK_TIMEOUT_MS = 60_000

export class ElectronCrawlToolRunner implements CrawlToolRunner {
  async crawlCleanHtml(input: CrawlCleanHtmlInput): Promise<CrawlCleanHtmlOutput> {
    const { url, waitForDynamic = true, timeout = 30000 } = input as any
    if (!url) {
      return {
        success: false,
        clean_html: '',
        title: '',
        url: url || '',
        content_length: 0,
        error: { message: 'url is required', code: 'INVALID_PARAMETER', retriable: false, fatal: true } as any,
      }
    }

    const taskTimeout = Math.max(
      (input as any).totalTimeout || DEFAULT_TASK_TIMEOUT_MS,
      timeout + 10000,
    )

    log.info('crawlCleanHtml:', { url, waitForDynamic, timeout, taskTimeout })

    const viewFactory = getViewFactory()
    const viewId = `crawl-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    let cleanupTimer: ReturnType<typeof setTimeout> | undefined

    const forceDestroyView = () => {
      viewFactory.destroyView(viewId, { force: true }).catch((e: any) => {
        log.warn('force destroy view failed:', e)
      })
    }

    const coreTask = async (): Promise<CrawlCleanHtmlOutput> => {
      let handle: any = null
      try {
        handle = await viewFactory.createView({
          id: viewId,
          url: 'about:blank',
          displayMode: 'hidden',
          profile: 'background-task',
          autoClose: true,
        })

        const view = handle?.view
        if (!view?.webContents || view.webContents.isDestroyed()) {
          throw new Error('Failed to create background view')
        }

        // 与 browser open 对齐（tabs.ts 默认走 loadUrl 的 'settled'）：
        // waitForDynamic 时用 'settled'——基础导航后观察 DOM 稳定作为「内容就绪」信号，
        // 覆盖 load 后才 fetch 渲染的 SPA；且 settle 超时只标 readiness 不判失败，
        // 不会像 'networkidle' 那样超时抛错让整个 extract 失败。
        const loadResult = await loadUrl(viewId, url, {
          waitUntil: waitForDynamic ? 'settled' : 'load',
          timeout,
          // Agent crawl 需要真加载页面（含偶发文件 URL）；用户 tabweb 不走此路径。
          forceBrowser: true,
        })

        if (!loadResult.success) {
          throw new Error(loadResult.error || `Failed to load ${url}`)
        }

        const wc = view.webContents
        if (wc.isDestroyed()) {
          throw new Error('WebContents destroyed before HTML extraction')
        }

        const rawHtml: string = await wc.executeJavaScript(
          buildDeepOuterHTMLExpression()
        )
        const title: string = await wc.executeJavaScript('document.title')
        const finalUrl: string = wc.getURL()

        const cleaned = cleanHtml(rawHtml)
        const skeleton = generateSkeletonHtml(cleaned)

        log.info('crawlCleanHtml OK:', {
          url: finalUrl,
          title,
          cleanLen: cleaned.length,
          skeletonLen: skeleton.length,
        })

        return {
          success: true,
          clean_html: cleaned,
          skeleton_html: skeleton,
          title,
          url: finalUrl,
          content_length: cleaned.length,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('crawlCleanHtml failed:', message)
        return {
          success: false,
          clean_html: '',
          title: '',
          url,
          content_length: 0,
          error: { message, code: 'CRAWL_FAILED' } as any,
        }
      } finally {
        if (handle) {
          try {
            await viewFactory.destroyView(viewId, { force: true })
          } catch (e) {
            log.warn('cleanup view failed:', e)
          }
        }
      }
    }

    const timeoutGuard = new Promise<CrawlCleanHtmlOutput>((resolve) => {
      cleanupTimer = setTimeout(() => {
        log.error(`crawlCleanHtml total timeout (${taskTimeout}ms), force destroying view ${viewId}`)
        forceDestroyView()
        resolve({
          success: false,
          clean_html: '',
          title: '',
          url,
          content_length: 0,
          error: {
            message: `Crawl task timed out after ${taskTimeout}ms — the page may have a blocking script or unresponsive navigation`,
            code: 'TIMEOUT',
            retriable: true,
            fatal: false,
          } as any,
        })
      }, taskTimeout)
    })

    try {
      return await Promise.race([coreTask(), timeoutGuard])
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer)
    }
  }

  async cleanup(): Promise<void> {
    log.info('cleanup called')
  }
}
