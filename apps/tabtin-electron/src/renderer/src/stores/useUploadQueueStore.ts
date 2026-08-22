/** @store-category session */

/**
 * useUploadQueueStore — 全局上传队列管理
 *
 * 统一管理所有模块的文件上传任务：
 *   - 任务状态追踪（排队 / 上传中 / 完成 / 失败 / 已取消）
 *   - 上传进度展示
 *   - 取消 / 重试操作
 *   - 并发控制
 *   - 完成通知
 */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'

// ==================== 类型 ====================

export type UploadTaskStatus =
  | 'queued'
  | 'uploading'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface UploadTask {
  id: string
  fileName: string
  fileSize: number
  mimeType: string
  module: string
  folder: string
  status: UploadTaskStatus
  progress: number
  /** 上传结果（完成后填充） */
  accessUrl?: string
  fileId?: string
  /** 错误信息 */
  error?: string
  /** 创建时间 */
  createdAt: number
  /** 完成时间 */
  completedAt?: number
  /** 是否是秒传 */
  instant?: boolean
}

/**
 * 上传任务运行时回调（cancel / retry）的签名。
 *
 * 返回值故意放宽到 `unknown` —— 实际消费方（`cancelTask` / `retryTask`）只
 * 关心副作用（中止 / 重新发起上传），不读返回值。原签名 `Promise<void>` 把
 * 调用方逼着包一层 `() => { void uploadFn() }` 才能编过；放宽后调用方可以直
 * 接传 `() => uploadFn()`，返回的 `Promise<UploadResult>` 自然被 `retryTask`
 * 内部 `await cb()` 等待但不消费。
 */
type UploadTaskRuntimeCallback = () => void | Promise<unknown>

interface UploadQueueState {
  tasks: UploadTask[]
  /** 通知面板是否展开 */
  isPanelOpen: boolean
  /** 取消回调（不序列化，仅运行时） */
  cancelCallbackByTaskId: Record<string, UploadTaskRuntimeCallback>
  /** 重试回调（不序列化，仅运行时） */
  retryCallbackByTaskId: Record<string, UploadTaskRuntimeCallback>

  // ── Actions ──
  addTask: (task: Omit<UploadTask, 'status' | 'progress' | 'createdAt'> & { id: string }) => void
  updateTask: (id: string, updates: Partial<UploadTask>) => void
  removeTask: (id: string) => void
  registerCancelCallback: (id: string, callback: UploadTaskRuntimeCallback) => void
  registerRetryCallback: (id: string, callback: UploadTaskRuntimeCallback) => void
  cancelTask: (id: string) => void
  retryTask: (id: string) => Promise<void>
  clearCompleted: () => void
  clearAll: () => void
  togglePanel: () => void
  setPanel: (open: boolean) => void

  // ── 派生状态 ──
  getActiveCount: () => number
  getFailedCount: () => number
  getOverallProgress: () => number
  hasActiveTasks: () => boolean
  canRetryTask: (id: string) => boolean
}

// ==================== Store ====================

export const useUploadQueueStore = create<UploadQueueState>((set, get) => ({
  tasks: [],
  isPanelOpen: false,
  cancelCallbackByTaskId: {},
  retryCallbackByTaskId: {},

  addTask: (task) => {
    set((s) => ({
      isPanelOpen: true,
      tasks: [
        {
          ...task,
          status: 'queued',
          progress: 0,
          createdAt: Date.now(),
        },
        ...s.tasks,
      ],
    }))
  },

  updateTask: (id, updates) => {
    set((s) => {
      const nextCancelCallbacks = { ...s.cancelCallbackByTaskId }
      const nextRetryCallbacks = { ...s.retryCallbackByTaskId }
      let nextPanelOpen = s.isPanelOpen

      if (updates.status === 'queued' || updates.status === 'uploading') {
        nextPanelOpen = true
      }

      if (updates.status === 'failed') {
        nextPanelOpen = true
        delete nextCancelCallbacks[id]
      }

      if (updates.status === 'completed' || updates.status === 'cancelled') {
        delete nextCancelCallbacks[id]
        delete nextRetryCallbacks[id]
      }

      return {
        isPanelOpen: nextPanelOpen,
        tasks: s.tasks.map((t) =>
          t.id === id ? { ...t, ...updates } : t,
        ),
        cancelCallbackByTaskId: nextCancelCallbacks,
        retryCallbackByTaskId: nextRetryCallbacks,
      }
    })
  },

  removeTask: (id) => {
    set((s) => {
      const nextCancelCallbacks = { ...s.cancelCallbackByTaskId }
      const nextRetryCallbacks = { ...s.retryCallbackByTaskId }
      delete nextCancelCallbacks[id]
      delete nextRetryCallbacks[id]
      return {
        tasks: s.tasks.filter((t) => t.id !== id),
        cancelCallbackByTaskId: nextCancelCallbacks,
        retryCallbackByTaskId: nextRetryCallbacks,
      }
    })
  },

  registerCancelCallback: (id, callback) => {
    set((s) => ({
      cancelCallbackByTaskId: { ...s.cancelCallbackByTaskId, [id]: callback },
    }))
  },

  registerRetryCallback: (id, callback) => {
    set((s) => ({
      retryCallbackByTaskId: { ...s.retryCallbackByTaskId, [id]: callback },
    }))
  },

  cancelTask: (id) => {
    const cb = get().cancelCallbackByTaskId[id]
    if (cb) cb()
    set((s) => {
      const nextCancelCallbacks = { ...s.cancelCallbackByTaskId }
      const nextRetryCallbacks = { ...s.retryCallbackByTaskId }
      delete nextCancelCallbacks[id]
      delete nextRetryCallbacks[id]
      return {
        tasks: s.tasks.map((t) =>
          t.id === id && (t.status === 'queued' || t.status === 'uploading')
            ? { ...t, status: 'cancelled' as const }
            : t,
        ),
        cancelCallbackByTaskId: nextCancelCallbacks,
        retryCallbackByTaskId: nextRetryCallbacks,
      }
    })
  },

  retryTask: async (id) => {
    const cb = get().retryCallbackByTaskId[id]
    if (!cb) return

    set((s) => ({
      isPanelOpen: true,
      tasks: s.tasks.map((t) =>
        t.id === id
          ? { ...t, status: 'queued' as const, progress: 0, error: undefined }
          : t,
      ),
    }))

    try {
      await cb()
    } catch (err) {
      const task = get().tasks.find((t) => t.id === id)
      if (task && task.status !== 'completed' && task.status !== 'cancelled') {
        get().updateTask(id, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Upload failed',
        })
      }
    }
  },

  clearCompleted: () => {
    set((s) => {
      const tasks = s.tasks.filter(
        (t) => t.status !== 'completed' && t.status !== 'cancelled',
      )
      const taskIds = new Set(tasks.map((t) => t.id))
      return {
        tasks,
        cancelCallbackByTaskId: Object.fromEntries(
          Object.entries(s.cancelCallbackByTaskId).filter(([id]) => taskIds.has(id)),
        ),
        retryCallbackByTaskId: Object.fromEntries(
          Object.entries(s.retryCallbackByTaskId).filter(([id]) => taskIds.has(id)),
        ),
      }
    })
  },

  clearAll: () => {
    set({
      tasks: [],
      cancelCallbackByTaskId: {},
      retryCallbackByTaskId: {},
    })
  },

  togglePanel: () => {
    set((s) => ({ isPanelOpen: !s.isPanelOpen }))
  },

  setPanel: (open) => {
    set({ isPanelOpen: open })
  },

  getActiveCount: () => {
    return get().tasks.filter(
      (t) => t.status === 'queued' || t.status === 'uploading',
    ).length
  },

  getFailedCount: () => {
    return get().tasks.filter((t) => t.status === 'failed').length
  },

  getOverallProgress: () => {
    const active = get().tasks.filter(
      (t) => t.status === 'queued' || t.status === 'uploading' || t.status === 'completed',
    )
    if (active.length === 0) return 0
    const totalProgress = active.reduce((sum, t) => sum + t.progress, 0)
    return totalProgress / active.length
  },

  hasActiveTasks: () => {
    return get().tasks.some(
      (t) => t.status === 'queued' || t.status === 'uploading',
    )
  },

  canRetryTask: (id) => {
    return typeof get().retryCallbackByTaskId[id] === 'function'
  },
}))

registerResetAction('upload-queue', 'reset', () => useUploadQueueStore.getState().clearAll())
