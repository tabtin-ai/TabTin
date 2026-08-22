/** @store-category session */

/**
 * useDownloadStore - 下载管理状态
 *
 * 管理浏览器下载的全局状态：
 * - 监听主进程下载事件（started / progress / completed）
 * - 监听 HLS 流下载事件（stream progress / completed / failed）
 * - 提供下载操作方法（暂停/恢复/取消/打开/删除），含错误反馈
 * - 跟踪活跃下载数量（用于工具栏 badge）
 * - 提供 dispose 方法清理 IPC 监听器
 */

import { create } from 'zustand'
import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import { createIPCErrorHandler } from '@components/crawl/utils/ipc-error-handler'
import { withToast } from '@/utils/with-toast-on-error'
import {
  shouldSilenceDownloadCompletionToast,
  shouldSilenceDownloadStartToast,
} from '@/utils/download-toast-silence'

const handleError = createIPCErrorHandler('DownloadStore')
import type {
  DownloadItemData,
  DownloadItem,
  StreamDownloadItemData,
  StreamDownloadPhase,
  StreamProgressEvent,
  StreamCompletedEvent,
  StreamFailedEvent,
  DownloadIPCResult,
} from '@shared/types/download'

export type { DownloadItem, StreamDownloadPhase }
export type StreamDownloadItem = StreamDownloadItemData

// ==================== Downloads API 类型 ====================

interface DownloadsAPI {
  getAll: () => Promise<DownloadIPCResult>
  pause: (id: string) => Promise<DownloadIPCResult>
  resume: (id: string) => Promise<DownloadIPCResult>
  cancel: (id: string) => Promise<DownloadIPCResult>
  open: (id: string) => Promise<DownloadIPCResult>
  showInFolder: (id: string) => Promise<DownloadIPCResult>
  removeItem: (id: string) => Promise<DownloadIPCResult>
  clearCompleted: () => Promise<DownloadIPCResult>
  retry: (id: string) => Promise<DownloadIPCResult>
  deleteFile: (id: string) => Promise<DownloadIPCResult>
  getActiveCount: () => Promise<DownloadIPCResult>
  onStarted: (cb: (info: DownloadItem) => void) => () => void
  onProgress: (cb: (info: DownloadItem) => void) => () => void
  onCompleted: (cb: (info: DownloadItem) => void) => () => void
  cancelStream?: (id: string) => Promise<DownloadIPCResult>
  onStreamProgress?: (cb: (progress: StreamProgressEvent) => void) => () => void
  onStreamCompleted?: (cb: (data: StreamCompletedEvent) => void) => () => void
  onStreamFailed?: (cb: (data: StreamFailedEvent) => void) => () => void
}

function extractDownloads(result: DownloadIPCResult): DownloadItemData[] | null {
  return 'downloads' in result && Array.isArray(result.downloads)
    ? result.downloads
    : null
}

// ==================== Store 接口 ====================

interface DownloadStore {
  items: DownloadItem[]
  streamItems: StreamDownloadItem[]
  initialized: boolean
  activeCount: number

  initialize: () => void
  dispose: () => void
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  open: (id: string) => Promise<void>
  showInFolder: (id: string) => Promise<void>
  removeItem: (id: string) => Promise<void>
  clearCompleted: () => Promise<void>
  retry: (id: string) => Promise<void>
  deleteFile: (id: string) => Promise<void>
  refresh: () => Promise<void>
  cancelStream: (id: string) => Promise<void>
  removeStreamItem: (id: string) => void
}

// ==================== 工具方法 ====================

const getDownloadsApi = (): DownloadsAPI | undefined =>
  (window as { tabtin?: { downloads?: DownloadsAPI } }).tabtin?.downloads

function showGlobalDownloadToast(info: DownloadItem, phase: 'started' | 'completed'): void {
  // 外部登记的下载（资源中心 / Agent 工具经 ResourceDownloadService 完成后补账，
  // ）由发起方自行提示；这里静音，避免一次下载弹多个 toast，
  // 也避免 Agent 批量下载时 toast 刷屏。
  if (info.origin === 'external') return
  if (phase === 'started') {
    if (shouldSilenceDownloadStartToast(info)) return
    toast({ title: i18n.t('crawl:downloads.started', { name: info.name }) })
    return
  }
  if (shouldSilenceDownloadCompletionToast(info)) return
  if (info.status === 'completed') {
    toast.success(i18n.t('crawl:downloads.downloadCompleted', { name: info.name }))
  } else if (info.status === 'interrupted') {
    toast.error(i18n.t('crawl:downloads.downloadFailed', { name: info.name }))
  }
}

const computeActiveCount = (items: DownloadItem[], streamItems: StreamDownloadItem[]): number => {
  const regularActive = items.filter(i => i.status === 'progressing' || i.status === 'paused').length
  const streamActive = streamItems.filter(i =>
    i.status === 'resolving' || i.status === 'downloading' || i.status === 'merging'
  ).length
  return regularActive + streamActive
}

/**
 * 创建简单的 IPC action（getApi → call → toast error），消除重复代码。
 * 适用于不需要更新本地 state 的操作。
 *
 * contract W2-β：旧 envelope `{success, error}` 改为 invokeIpc 自动 throw —— catch 块
 * 统一通过 handleError toast。原"业务级 fail 但不 throw"路径已经收口到 invokeIpc 的
 * `ok:false → throw PlatformIpcError` 契约。
 */
function createSimpleAction(method: keyof DownloadsAPI, titleKey?: string) {
  return async (id: string) => {
    const api = getDownloadsApi()
    if (!api) return
    try {
      const fn = api[method] as (id: string) => Promise<unknown>
      await fn(id)
    } catch (err) {
      handleError(method as string, 'toast', titleKey)(err)
    }
  }
}

/**
 * 创建"调用 IPC + 成功后从 items 中移除"的 action，消除 removeItem/retry/deleteFile 的重复。
 *
 * contract W2-β：成功路径 = 没 throw —— 直接 setState 移除；失败统一走 catch toast。
 */
function createRemoveAction(method: keyof DownloadsAPI, titleKey?: string) {
  return async (id: string) => {
    const api = getDownloadsApi()
    if (!api) return
    try {
      const fn = api[method] as (id: string) => Promise<unknown>
      await fn(id)
      useDownloadStore.setState(state => {
        const newItems = state.items.filter(i => i.id !== id)
        return { items: newItems, activeCount: computeActiveCount(newItems, state.streamItems) }
      })
    } catch (err) {
      handleError(method as string, 'toast', titleKey)(err)
    }
  }
}

export const STREAM_CANCEL_SENTINEL = '__STREAM_CANCELLED__'

// ==================== Store ====================

export const useDownloadStore = create<DownloadStore>((set, get) => {
  let subs: (() => void)[] = []

  return {
    items: [],
    streamItems: [],
    initialized: false,
    activeCount: 0,

    initialize: () => {
      if (get().initialized) return

      const api = getDownloadsApi()
      if (!api) {
        handleError('initialize', 'toast')(new Error('downloads API 不可用'))
        return
      }

      const unsubStarted = api.onStarted((info: DownloadItem) => {
        set(state => {
          const newItems = [info, ...state.items]
          return { items: newItems, activeCount: computeActiveCount(newItems, state.streamItems) }
        })
        showGlobalDownloadToast(info, 'started')
      })

      const unsubProgress = api.onProgress((info: DownloadItem) => {
        set(state => {
          const newItems = state.items.map(item =>
            item.id === info.id ? { ...item, ...info } : item
          )
          return { items: newItems, activeCount: computeActiveCount(newItems, state.streamItems) }
        })
      })

      const unsubCompleted = api.onCompleted((info: DownloadItem) => {
        set(state => {
          const newItems = state.items.map(item =>
            item.id === info.id ? { ...item, ...info } : item
          )
          return { items: newItems, activeCount: computeActiveCount(newItems, state.streamItems) }
        })

        // 完成/失败提醒由主进程按「OS Desktop 成功，否则 Toast」终局裁决。
      })

      const newSubs: (() => void)[] = [unsubStarted, unsubProgress, unsubCompleted]

      if (api.onStreamProgress) {
        const unsubStreamProgress = api.onStreamProgress((progress: StreamProgressEvent) => {
          set(state => {
            const { downloadId, phase, downloadedSegments, totalSegments, downloadedBytes, speed, percent, duration, outputPath, totalSize } = progress
            const existing = state.streamItems.find(i => i.id === downloadId)

            if (existing) {
              const newStreamItems = state.streamItems.map(item =>
                item.id === downloadId
                  ? {
                      ...item,
                      url: progress.url || item.url,
                      resourceId: progress.resourceId || item.resourceId,
                      status: phase,
                      size: { received: downloadedBytes, total: totalSize ?? item.size.total },
                      segments: { done: downloadedSegments, total: totalSegments },
                      speed,
                      percent,
                      duration,
                      ...(outputPath ? { savePath: outputPath } : {}),
                    }
                  : item
              )
              return { streamItems: newStreamItems, activeCount: computeActiveCount(state.items, newStreamItems) }
            }

            const newItem: StreamDownloadItem = {
              id: downloadId,
              name: i18n.t('crawl:downloads.streamDefaultName'),
              url: progress.url || '',
              resourceId: progress.resourceId,
              savePath: outputPath || '',
              status: phase,
              size: { received: downloadedBytes, total: totalSize ?? 0 },
              segments: { done: downloadedSegments, total: totalSegments },
              speed,
              percent,
              duration,
              startTime: Date.now(),
            }
            const newStreamItems = [newItem, ...state.streamItems]
            return { streamItems: newStreamItems, activeCount: computeActiveCount(state.items, newStreamItems) }
          })
        })
        newSubs.push(unsubStreamProgress)
      }

      if (api.onStreamCompleted) {
        const unsubStreamCompleted = api.onStreamCompleted((data: StreamCompletedEvent) => {
          const existing = get().streamItems.find(i => i.id === data.downloadId)
          if (existing?.status === 'failed' && existing.error === STREAM_CANCEL_SENTINEL) return

          set(state => {
            const prev = state.streamItems.find(item => item.id === data.downloadId)
            const completedItem: StreamDownloadItem = {
              id: data.downloadId,
              name: data.name || prev?.name || i18n.t('crawl:downloads.streamDefaultName'),
              url: data.url || prev?.url || '',
              resourceId: data.resourceId || prev?.resourceId,
              savePath: data.filePath || prev?.savePath || '',
              status: 'completed' as StreamDownloadPhase,
              size: {
                received: data.size || prev?.size.received || 0,
                total: data.size || prev?.size.total || 0,
              },
              segments: prev?.segments || { done: data.segmentCount || 0, total: data.segmentCount || 0 },
              speed: 0,
              percent: 100,
              duration: data.duration ?? prev?.duration,
              startTime: prev?.startTime || Date.now(),
              endTime: Date.now(),
            }

            const newStreamItems = prev
              ? state.streamItems.map(item => (item.id === data.downloadId ? completedItem : item))
              : [completedItem, ...state.streamItems]
            return { streamItems: newStreamItems, activeCount: computeActiveCount(state.items, newStreamItems) }
          })

          toast.success(i18n.t('crawl:downloads.streamCompleted', { name: data.name || i18n.t('crawl:downloads.streamDefaultName') }))
        })
        newSubs.push(unsubStreamCompleted)
      }

      if (api.onStreamFailed) {
        const unsubStreamFailed = api.onStreamFailed((data: StreamFailedEvent) => {
          const existing = get().streamItems.find(i => i.id === data.downloadId)
          if (existing?.status === 'failed' && existing.error === STREAM_CANCEL_SENTINEL) return

          set(state => {
            const prev = state.streamItems.find(item => item.id === data.downloadId)
            const failedItem: StreamDownloadItem = {
              id: data.downloadId,
              name: prev?.name || i18n.t('crawl:downloads.streamDefaultName'),
              url: data.url || prev?.url || '',
              resourceId: data.resourceId || prev?.resourceId,
              savePath: prev?.savePath || '',
              status: 'failed' as StreamDownloadPhase,
              size: prev?.size || { received: 0, total: 0 },
              segments: prev?.segments || { done: 0, total: 0 },
              speed: 0,
              percent: prev?.percent || 0,
              duration: prev?.duration,
              startTime: prev?.startTime || Date.now(),
              endTime: Date.now(),
              error: data.error,
            }

            const newStreamItems = prev
              ? state.streamItems.map(item => (item.id === data.downloadId ? failedItem : item))
              : [failedItem, ...state.streamItems]
            return { streamItems: newStreamItems, activeCount: computeActiveCount(state.items, newStreamItems) }
          })

          const errorMsg = data.errorCode
            ? i18n.t(`crawl:downloads.streamErrors.${data.errorCode}`, { defaultValue: data.error })
            : data.error || i18n.t('crawl:downloads.streamErrors.UNKNOWN')
          toast({ title: i18n.t('crawl:downloads.streamFailed', { error: errorMsg }), variant: 'destructive' })
        })
        newSubs.push(unsubStreamFailed)
      }

      subs = newSubs

      // contract W2-β：旧 envelope `{success, downloads}` 改为 invokeIpc 直接返
      // `{ downloads }` 或 throw。失败 swallow（initialize 路径）让 UI 保留空列表，
      // 用户后续手动 refresh 会再次尝试 + 错误 toast。
      api.getAll().then((result) => {
        const downloads = extractDownloads(result)
        if (downloads) {
          set(state => ({
            items: downloads,
            activeCount: computeActiveCount(downloads, state.streamItems),
          }))
        }
      }).catch(handleError('getAll'))

      set({ initialized: true })
    },

    dispose: () => {
      for (const unsub of subs) {
        try { unsub() } catch { /* ignore */ }
      }
      subs = []
      set({ initialized: false, items: [], streamItems: [], activeCount: 0 })
    },

    pause: createSimpleAction('pause'),
    resume: createSimpleAction('resume'),
    cancel: createSimpleAction('cancel'),
    open: createSimpleAction('open', 'crawl:downloads.openFileFailed'),
    showInFolder: createSimpleAction('showInFolder', 'crawl:downloads.showInFolderFailed'),

    removeItem: createRemoveAction('removeItem'),

    // W2-γ：withToast 接入样板。原 try/catch + handleError 模板被 HOC 接管：
    // 失败时弹 destructive toast（PlatformIpcError 自动含 trace 末 6 位），dev
    // 模式 console.error 完整诊断；rethrow:false 与原"catch 后不再 throw"语
    // 义一致（fire-and-forget — caller 不接异常）。
    clearCompleted: withToast(
      async () => {
        const api = getDownloadsApi()
        if (!api) return
        // contract W2-β：clearCompleted 失败由 withToast HOC 弹 destructive toast；
        // 此处直接 await——成功路径继续 setState 清表，失败由外层 HOC 处理。
        await api.clearCompleted()
        set(state => {
          const newItems = state.items.filter(i => i.status === 'progressing' || i.status === 'paused')
          const newStreamItems = state.streamItems.filter(i => i.status !== 'completed' && i.status !== 'failed')
          return {
            items: newItems,
            streamItems: newStreamItems,
            activeCount: computeActiveCount(newItems, newStreamItems),
          }
        })
      },
      { titleKey: 'errors.downloadClearFailed', rethrow: false },
    ),

    retry: createRemoveAction('retry'),
    deleteFile: createRemoveAction('deleteFile', 'crawl:downloads.deleteFileFailed'),

    refresh: async () => {
      const api = getDownloadsApi()
      if (!api) return
      try {
        const result = await api.getAll()
        const downloads = extractDownloads(result)
        if (downloads) {
          set(state => ({
            items: downloads,
            activeCount: computeActiveCount(downloads, state.streamItems),
          }))
        }
      } catch (err: unknown) {
        handleError('refresh')(err)
      }
    },

    cancelStream: async (id) => {
      const api = getDownloadsApi()
      if (!api?.cancelStream) {
        toast({ title: i18n.t('crawl:downloads.streamErrors.UNKNOWN'), variant: 'destructive' })
        return
      }

      let shouldApplyCancelledState = false
      try {
        // contract W2-β：旧 envelope `{success, aborted, error}` 改为 invokeIpc 直接返
        // `{ aborted? }` 或 throw —— catch 块统一处理失败 toast。`aborted: false` 是
        // "成功调用但请求未真正中止"的业务状态（譬如下载已完成在此调用之前），需特别 toast。
        const result = await api.cancelStream(id)
        const aborted = result && 'aborted' in result ? Boolean(result.aborted) : true
        if (!aborted) {
          toast({ title: i18n.t('crawl:downloads.streamErrors.DOWNLOAD_ABORTED'), variant: 'destructive' })
          return
        }
        shouldApplyCancelledState = true
      } catch (err) {
        handleError('cancelStream', 'toast')(err)
        return
      }

      if (!shouldApplyCancelledState) return
      set(state => {
        const newStreamItems = state.streamItems.map(i =>
          i.id === id ? { ...i, status: 'failed' as StreamDownloadPhase, error: STREAM_CANCEL_SENTINEL, speed: 0, endTime: Date.now() } : i
        )
        return { streamItems: newStreamItems, activeCount: computeActiveCount(state.items, newStreamItems) }
      })
    },

    removeStreamItem: (id) => {
      set(state => {
        const newStreamItems = state.streamItems.filter(i => i.id !== id)
        return { streamItems: newStreamItems, activeCount: computeActiveCount(state.items, newStreamItems) }
      })
    },
  }
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useDownloadStore.getState().dispose()
  })
}
