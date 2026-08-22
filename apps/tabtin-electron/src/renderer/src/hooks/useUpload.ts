/**
 * 统一文件上传 Hook
 *
 * 封装 oss-direct-uploader 的上传调用 + 文件校验 + 状态管理（进度、错误、取消、重试）。
 * 各模块通过此 Hook 上传文件，不再各自手写 directUpload 调用和状态管理。
 */

import { useCallback, useRef, useState } from 'react'
import {
  directUpload,
  directUploadBatch,
  UploadAbortedError,
  StorageQuotaExceededError,
  BillingBlockedError,
  type DirectUploadResult,
  type DirectBatchUploadResult,
} from '@/services/oss-direct-uploader'
import {
  validateUploadFile,
  type UploadPresetKey,
  type UploadPreset,
} from '@/constants/upload'
import { useUploadQueueStore } from '@/stores/useUploadQueueStore'
import { showBillingErrorToast } from '@/lib/billingErrorHandler'
import { createLogger } from '@/utils/logger'

const log = createLogger('useUpload')

export type UploadStatus = 'idle' | 'validating' | 'uploading' | 'success' | 'error'

export interface UseUploadOptions {
  module: string
  folder: string
  contextType?: string
  contextId?: string
  preset?: UploadPresetKey | UploadPreset
  maxRetries?: number
  /** 跳过前端文件校验（由调用方自行校验时使用） */
  skipValidation?: boolean
  /** 是否在全局上传队列中追踪（默认 true） */
  trackInQueue?: boolean
  /** 组织 ID，用于存储计量。不传时由 oss-direct-uploader 自动获取。 */
  organizationId?: string
  /** 是否作为长期公开资产上传。默认 false，内容附件不得隐式公开。 */
  isPublic?: boolean
}

export interface UseUploadReturn {
  /** 上传单个文件 */
  upload: (file: File | Blob, fileName?: string) => Promise<DirectUploadResult>
  /** 批量上传 */
  uploadBatch: (files: Array<{ file: File | Blob; fileName: string }>) => Promise<DirectBatchUploadResult>
  /** 当前上传进度 (0-1) */
  progress: number
  /** 当前状态 */
  status: UploadStatus
  /** 错误信息 */
  error: string | null
  /** 取消当前上传 */
  cancel: () => void
  /** 是否正在上传 */
  isUploading: boolean
  /** 重置状态 */
  reset: () => void
}

export function useUpload(options: UseUploadOptions): UseUploadReturn {
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState<UploadStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const reset = useCallback(() => {
    setProgress(0)
    setStatus('idle')
    setError(null)
    abortRef.current = null
  }, [])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStatus('idle')
    setProgress(0)
  }, [])

  const trackInQueue = options.trackInQueue !== false
  const queueStore = useUploadQueueStore

  const startTrackedUpload = useCallback(async (
    file: File | Blob,
    resolvedName: string,
    taskId: string,
    controller: AbortController,
  ): Promise<DirectUploadResult> => {
    setError(null)
    setProgress(0)
    setStatus('uploading')

    if (trackInQueue) {
      queueStore.getState().updateTask(taskId, {
        status: 'uploading',
        progress: 0,
        error: undefined,
      })
      queueStore.getState().registerCancelCallback(taskId, () => controller.abort())
    }

    try {
      const result = await directUpload(file, resolvedName, {
        folder: options.folder,
        module: options.module,
        contextType: options.contextType,
        contextId: options.contextId,
        maxRetries: options.maxRetries,
        organizationId: options.organizationId,
        isPublic: options.isPublic,
        onProgress: (p) => {
          setProgress(p)
          if (trackInQueue) {
            queueStore.getState().updateTask(taskId, { progress: p })
          }
        },
        signal: controller.signal,
      })

      setStatus('success')
      setProgress(1)

      if (trackInQueue) {
        queueStore.getState().updateTask(taskId, {
          status: 'completed',
          progress: 1,
          accessUrl: result.accessUrl,
          fileId: result.fileId,
          completedAt: Date.now(),
          instant: result.instant,
        })
      }

      return result
    } catch (err) {
      if (err instanceof UploadAbortedError) {
        setStatus('idle')
        setProgress(0)
        if (trackInQueue) {
          queueStore.getState().updateTask(taskId, { status: 'cancelled' })
        }
        throw err
      }
      if (err instanceof StorageQuotaExceededError) {
        showBillingErrorToast('STORAGE_QUOTA_EXCEEDED')
      }
      if (err instanceof BillingBlockedError) {
        showBillingErrorToast('BILLING_BLOCKED')
      }
      const msg = err instanceof Error ? err.message : 'Upload failed'
      setStatus('error')
      setError(msg)
      if (trackInQueue) {
        queueStore.getState().updateTask(taskId, { status: 'failed', error: msg })
      }
      throw err
    }
  }, [options.folder, options.module, options.contextType, options.contextId, options.maxRetries, options.organizationId, options.isPublic, trackInQueue])

  const upload = useCallback(async (
    file: File | Blob,
    fileName?: string,
  ): Promise<DirectUploadResult> => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const resolvedName = fileName ?? (file instanceof File ? file.name : 'file')
    const taskId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    setError(null)
    setProgress(0)

    if (!options.skipValidation && options.preset && file instanceof File) {
      setStatus('validating')
      const validation = validateUploadFile(file, options.preset)
      if (!validation.valid) {
        const msg = validation.reason ?? 'File validation failed'
        setStatus('error')
        setError(msg)
        throw new Error(msg)
      }
    }

    if (trackInQueue) {
      queueStore.getState().addTask({
        id: taskId,
        fileName: resolvedName,
        fileSize: file.size,
        mimeType: (file as File).type || 'application/octet-stream',
        module: options.module,
        folder: options.folder,
      })
      queueStore.getState().registerRetryCallback(taskId, () => {
        const retryController = new AbortController()
        abortRef.current = retryController
        return startTrackedUpload(file, resolvedName, taskId, retryController)
      })
    }

    return startTrackedUpload(file, resolvedName, taskId, controller)
  }, [options.folder, options.module, options.preset, options.skipValidation, trackInQueue, startTrackedUpload])

  const uploadBatchFn = useCallback(async (
    files: Array<{ file: File | Blob; fileName: string }>,
  ): Promise<DirectBatchUploadResult> => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setError(null)
    setProgress(0)

    if (!options.skipValidation && options.preset) {
      setStatus('validating')
      for (const item of files) {
        if (item.file instanceof File) {
          const validation = validateUploadFile(item.file, options.preset)
          if (!validation.valid) {
            const msg = validation.reason ?? 'File validation failed'
            setStatus('error')
            setError(`${item.fileName}: ${msg}`)
            throw new Error(`${item.fileName}: ${msg}`)
          }
        }
      }
    }

    setStatus('uploading')

    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const taskIds = files.map((_, i) => `${batchId}-${i}`)
    const lastReportedProgress: number[] = new Array(files.length).fill(0)

    if (trackInQueue) {
      for (let i = 0; i < files.length; i++) {
        const item = files[i]
        queueStore.getState().addTask({
          id: taskIds[i],
          fileName: item.fileName,
          fileSize: item.file.size,
          mimeType: (item.file as File).type || 'application/octet-stream',
          module: options.module,
          folder: options.folder,
        })
        queueStore.getState().updateTask(taskIds[i], { status: 'uploading' })
        queueStore.getState().registerCancelCallback(taskIds[i], () => controller.abort())
        queueStore.getState().registerRetryCallback(taskIds[i], () => {
          const retryController = new AbortController()
          abortRef.current = retryController
          return startTrackedUpload(item.file, item.fileName, taskIds[i], retryController)
        })
      }
    }

    try {
      const result = await directUploadBatch(files, {
        folder: options.folder,
        module: options.module,
        contextType: options.contextType,
        contextId: options.contextId,
        maxRetries: options.maxRetries,
        organizationId: options.organizationId,
        isPublic: options.isPublic,
        signal: controller.signal,
        onFileProgress: (index, p) => {
          setProgress(p)
          if (trackInQueue && taskIds[index]) {
            if (p - lastReportedProgress[index] >= 0.05 || p >= 1) {
              lastReportedProgress[index] = p
              queueStore.getState().updateTask(taskIds[index], { progress: p })
            }
          }
        },
        onFileComplete: (index, fileResult, err) => {
          const overallProgress = (index + 1) / files.length
          setProgress(overallProgress)
          if (trackInQueue && taskIds[index]) {
            if (err) {
              queueStore.getState().updateTask(taskIds[index], {
                status: 'failed',
                error: err,
              })
            } else if (fileResult) {
              queueStore.getState().updateTask(taskIds[index], {
                status: 'completed',
                progress: 1,
                accessUrl: fileResult.accessUrl,
                fileId: fileResult.fileId,
                completedAt: Date.now(),
                instant: fileResult.instant,
              })
            }
          }
          if (err) {
            log.warn(`file ${index} failed:`, err)
          }
        },
      })

      if (result.quotaExceeded) {
        showBillingErrorToast('STORAGE_QUOTA_EXCEEDED')
      }
      if (result.billingBlocked) {
        showBillingErrorToast('BILLING_BLOCKED')
      }
      if (result.failedCount > 0) {
        setStatus('error')
        setError(`${result.failedCount} / ${result.total} files failed`)
      } else {
        setStatus('success')
        setProgress(1)
      }

      return result
    } catch (err) {
      if (err instanceof UploadAbortedError) {
        setStatus('idle')
        setProgress(0)
        if (trackInQueue) {
          for (const id of taskIds) {
            const task = queueStore.getState().tasks.find(t => t.id === id)
            if (task && (task.status === 'queued' || task.status === 'uploading')) {
              queueStore.getState().updateTask(id, { status: 'cancelled' })
            }
          }
        }
        throw err
      }
      const msg = err instanceof Error ? err.message : 'Upload failed'
      setStatus('error')
      setError(msg)
      if (trackInQueue) {
        for (const id of taskIds) {
          const task = queueStore.getState().tasks.find(t => t.id === id)
          if (task && (task.status === 'queued' || task.status === 'uploading')) {
            queueStore.getState().updateTask(id, { status: 'failed', error: msg })
          }
        }
      }
      throw err
    }
  }, [options.folder, options.module, options.contextType, options.contextId, options.maxRetries, options.organizationId, options.isPublic, options.preset, options.skipValidation, trackInQueue, startTrackedUpload])

  return {
    upload,
    uploadBatch: uploadBatchFn,
    progress,
    status,
    error,
    cancel,
    isUploading: status === 'uploading' || status === 'validating',
    reset,
  }
}
