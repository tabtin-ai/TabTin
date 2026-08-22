import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import type { CrawlspaceHost, OrphanReconcileResult } from '@tabtin/crawlspace-core'
import { requestCloseWorkspace } from '@tabtin/crawlspace-core'
import { crawlViewClient } from '../electron/crawl-view-client'
import { taskApiClient } from '../electron/task-api-client'
import { runSessionClient } from '../electron/run-session-client'
import { agentClient } from '../electron/agent-client'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'

const log = createLogger('CrawlspaceHost')

/**
 * 校验 window.tabtin 下各 API 命名空间是否正确注入。
 * 在宿主初始化时调用，缺失的 API 会被记录到 console.warn。
 * 返回缺失 API 列表，空数组表示全部就绪。
 */
export function validateHostApis(): string[] {
  const missing: string[] = []
  if (typeof window === 'undefined') {
    missing.push('window')
    return missing
  }
  const tabtin = window.tabtin
  if (!tabtin) {
    missing.push('window.tabtin')
    return missing
  }

  const requiredNamespaces = ['crawlView', 'taskAPI', 'runSession', 'agent'] as const
  for (const ns of requiredNamespaces) {
    if (!tabtin[ns]) {
      missing.push(`window.tabtin.${ns}`)
    }
  }

  const electron = window.electron
  if (!electron?.ipcRenderer) {
    missing.push('window.electron.ipcRenderer')
  }

  if (missing.length > 0) {
    log.warn('API 完整性校验失败，缺失:', { missing })
  }
  return missing
}

type CrawlViewOptions =
  | {
      profile: string
      kind: 'workspace-view'
      crawlspaceId: string
      partition: string
      isPreview?: boolean
      allowMultiple?: boolean
    }
  | {
      profile: string
      kind: 'normal-view'
      crawlspaceId?: never
      partition?: string
      isPreview?: boolean
      allowMultiple?: boolean
    }

type ScreenshotCaptureOptions = {
  format?: 'png' | 'jpeg'
  quality?: number
  rect?: { x: number; y: number; width: number; height: number }
}

type ViewScriptOptions = {
  profile?: string
  partition?: string
  crawlspaceId?: string
  kind?: string
  isPreview?: boolean
}

const normalizeViewScriptOptions = (options?: ViewScriptOptions): CrawlViewOptions | undefined => {
  if (!options) {
    return undefined
  }

  const profile = options.profile ?? 'user-tab'
  if (
    options.kind === 'workspace-view' &&
    options.crawlspaceId &&
    options.partition
  ) {
    return {
      profile,
      kind: 'workspace-view',
      crawlspaceId: options.crawlspaceId,
      partition: options.partition,
      isPreview: options.isPreview
    }
  }

  return {
    profile,
    kind: 'normal-view',
    partition: options.partition,
    isPreview: options.isPreview
  }
}

const executeFrontendAgentAction = async (params: { task_id: string; action: any; params: Record<string, any> }) => {
  try {
    return await agentClient.executeAction(params)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// 延迟校验 API 完整性，确保 preload 脚本注入完成后再检查
if (typeof window !== 'undefined') {
  const runCheck = () => validateHostApis()
  if (document.readyState === 'complete') {
    // 已加载完毕，下一个微任务执行
    Promise.resolve().then(runCheck)
  } else {
    window.addEventListener('load', runCheck, { once: true })
  }
}

/**
 * ElectronCrawlspaceHost
 *
 * 说明：
 * - 这里是”宿主能力”的唯一实现入口（renderer 侧）。
 * - 具体的 view/run 清理仍由主进程/核心逻辑执行；这里主要负责 UI 关闭与兜底对齐触发。
 */
export const electronCrawlspaceHost: CrawlspaceHost = {
  view: {
    show: async (viewId, url, bounds, runId, options) => {
      if (!viewId) {
        return { success: false, error: i18n.t('crawl:host.errors.viewIdMissingShow') }
      }
      return crawlViewClient.show(viewId, url, bounds, runId, options)
    },
    hide: async (viewId?: string) => {
      return crawlViewClient.hide(viewId)
    },
    setViewBounds: async (viewId, bounds) => {
      if (!viewId) {
        return { success: false, error: i18n.t('crawl:host.errors.viewIdMissingBounds') }
      }
      return crawlViewClient.setViewBounds(viewId, bounds)
    },
    destroy: async (viewId) => {
      if (!viewId) {
        return { success: false, error: i18n.t('crawl:host.errors.viewIdMissingDestroy') }
      }
      return crawlViewClient.destroyTabView(viewId)
    },
    onEvent: (callback: (event: any) => void) => {
      return crawlViewClient.onEvent(callback)
    },
    hasView: async (viewId: string) => {
      if (!viewId) {
        return { success: false, error: i18n.t('crawl:host.errors.viewIdMissingCheck') }
      }
      return crawlViewClient.hasView(viewId)
    },
    touch: async (viewId: string, reason?: string) => {
      if (!viewId) {
        return { success: false, error: i18n.t('crawl:host.errors.viewIdMissingTouch') }
      }
      return crawlViewClient.touch(viewId, reason)
    },
    getNavigationState: async (viewId?: string) => {
      return crawlViewClient.getNavigationState(viewId)
    },
    goBack: async (viewId?: string) => {
      if (!viewId) {
        return { success: false, error: i18n.t('crawl:host.errors.viewIdMissingGoBack') }
      }
      return crawlViewClient.goBack(viewId)
    },
    goForward: async (viewId?: string) => {
      if (!viewId) {
        return { success: false, error: i18n.t('crawl:host.errors.viewIdMissingGoForward') }
      }
      return crawlViewClient.goForward(viewId)
    },
    reload: async (viewId?: string, ignoreCache = false) => {
      if (!viewId) {
        return { success: false, error: i18n.t('crawl:host.errors.viewIdMissingReload') }
      }
      return crawlViewClient.reload(Boolean(ignoreCache), viewId)
    },
    stop: async (viewId?: string) => {
      if (!viewId) {
        return { success: false, error: i18n.t('crawl:host.errors.viewIdMissingStop') }
      }
      return crawlViewClient.stop(viewId)
    },
    executeScript: async (code, viewId, url, options) => {
      return crawlViewClient.executeScript(code, viewId, url, options)
    },
    getProcessedContent: async (viewId, url, runId, options) => {
      return crawlViewClient.getProcessedContent(viewId, url, runId, options)
    },
    getHTML: async (viewId, url, runId, options) => {
      return crawlViewClient.getHTML(viewId, url, runId, options)
    },
    getPageInfo: async (viewId, url, runId, options) => {
      return crawlViewClient.getPageInfo(viewId, url, runId, options)
    },
    screenshot: async (captureOptions: ScreenshotCaptureOptions | undefined, viewId, url, runId, options) => {
      return crawlViewClient.screenshot(captureOptions, viewId, url, runId, options)
    }
  },
  analytics: {
    onPaginationEvent: (callback: (payload: any) => void) => {
      const ipcRenderer = window.electron?.ipcRenderer
      if (!ipcRenderer) {
        log.warn(i18n.t('crawl:host.logs.ipcRendererUnavailable'))
        return () => {}
      }

      const listener = (_event: any, payload: any) => {
        callback(payload)
      }
      const unsub = ipcRenderer.on('analytics:pagination:event', listener)
      return () => {
        unsub?.()
      }
    }
  },

  taskApi: {
    create: async (config: any) => {
      try {
        return (await taskApiClient.create(config)) as {
          success: boolean
          task?: unknown
          error?: string
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    enqueue: async (taskId: string) => {
      try {
        return (await taskApiClient.enqueue(taskId)) as {
          success: boolean
          task?: unknown
          error?: string
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    get: async (taskId: string) => {
      try {
        return (await taskApiClient.get(taskId)) as {
          success: boolean
          task?: unknown
          error?: string
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    cancel: async (taskId: string) => {
      try {
        return (await taskApiClient.cancel(taskId)) as {
          success: boolean
          task?: unknown
          error?: string
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    resume: async (taskId: string) => {
      try {
        return (await taskApiClient.resume(taskId)) as {
          success: boolean
          task?: unknown
          error?: string
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    resumeWithPagination: async (params: any) => {
      try {
        return (await taskApiClient.resumeWithPagination(params)) as {
          success: boolean
          task?: Record<string, unknown>
          error?: string
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    selectRecommendation: async (params: any) => {
      try {
        return (await taskApiClient.selectRecommendation(params)) as {
          success: boolean
          task?: Record<string, unknown>
          error?: string
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    onStateChange: (callback: (payload: any) => void) => {
      return taskApiClient.onStateChange(callback)
    },
  },

  runSession: {
    create: async (runId: string, sessionId?: string) => {
      try {
        const result = (await runSessionClient.create(runId, sessionId)) as {
          success?: boolean
          error?: string
        }
        return { success: Boolean(result?.success), error: result?.error }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    endRun: async (runId: string, options?: { reason?: string }) => {
      try {
        const result = (await runSessionClient.endRun(runId, options)) as { success?: boolean; error?: string }
        return { success: Boolean(result?.success), error: result?.error }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  },
  navigation: {
    goBack: async (viewId: string) => {
      return (
        electronCrawlspaceHost.view?.goBack?.(viewId) ?? {
          success: false,
          error: i18n.t('crawl:clients.apiUnavailable', { api: 'view.goBack' })
        }
      )
    },
    goForward: async (viewId: string) => {
      return (
        electronCrawlspaceHost.view?.goForward?.(viewId) ?? {
          success: false,
          error: i18n.t('crawl:clients.apiUnavailable', { api: 'view.goForward' })
        }
      )
    },
    reload: async (viewId: string, ignoreCache = false) => {
      return (
        electronCrawlspaceHost.view?.reload?.(viewId, Boolean(ignoreCache)) ?? {
          success: false,
          error: i18n.t('crawl:clients.apiUnavailable', { api: 'view.reload' })
        }
      )
    },
    stop: async (viewId: string) => {
      return (
        electronCrawlspaceHost.view?.stop?.(viewId) ?? {
          success: false,
          error: i18n.t('crawl:clients.apiUnavailable', { api: 'view.stop' })
        }
      )
    }
  },
  viewScript: {
    executeScript: async (
      code: string,
      viewId: string,
      url?: string,
      options?: ViewScriptOptions
    ) => {
      if (!electronCrawlspaceHost.view?.executeScript) {
        return null
      }
      return electronCrawlspaceHost.view.executeScript(
        code,
        viewId,
        url,
        normalizeViewScriptOptions(options)
      )
    },
    getProcessedContent: async (
      viewId: string,
      url?: string,
      runId?: string,
      options?: ViewScriptOptions
    ) => {
      if (!electronCrawlspaceHost.view?.getProcessedContent) {
        return null
      }
      return electronCrawlspaceHost.view.getProcessedContent(
        viewId,
        url,
        runId,
        normalizeViewScriptOptions(options)
      )
    }
  },
  agent: {
    executeAction: executeFrontendAgentAction
  },
  closeWorkspaceUI: async ({ crawlspaceId, reason }) => {
    const store = useCrawlTabStore.getState()
    const handled = requestCloseWorkspace({
      crawlspaceId,
      reason: reason || 'host.closeWorkspaceUI'
    })
    if (handled) {
      return
    }
    await store.closeCrawlspace(crawlspaceId, reason || 'host.closeWorkspaceUI', {
      reason: 'closeWorkspaceUI'
    })
  },
  reconcileOrphans: async ({ knownTabIds, knownViewIds, knownWorkspaceIds, reason }): Promise<OrphanReconcileResult> => {
    const api = window.tabtin?.crawlView
    if (!api || typeof api.reconcileOrphans !== 'function') {
      return { success: false, error: i18n.t('crawl:clients.apiUnavailable', { api: 'crawlView.reconcileOrphans' }) }
    }

    const result = await api.reconcileOrphans({ knownTabIds, knownViewIds, knownWorkspaceIds, reason })
    return result as OrphanReconcileResult
  }
}
