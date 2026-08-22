/** @store-category session */

import { create } from 'zustand'
import {
  AttachmentApiService,
  type AttachmentDirectUploader,
  type AttachmentReference,
} from '@tabtin/table-core'
import { computeFileHash } from '@tabtin/oss-client'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'
import { registerResetAction } from './sessionResetRegistry'
import { useUploadQueueStore } from './useUploadQueueStore'
import { putPresignedObjectViaMainProcess } from '@/services/mainProcessOssUploader'

type UploadStatus = 'pending' | 'uploading' | 'completed' | 'error' | 'cancelled'

const log = createLogger('AttachmentStore')
const UPLOAD_CONCURRENCY = 3
// 创建任务是 POST，只对服务端明确确认已回滚的写争用做重放，避免网络歧义导致重复任务。
const CREATE_TASK_RETRY_DELAYS_MS = [500, 1500]
const COMPLETION_RETRY_DELAYS_MS = [500, 1500]
// completeUpload 是 POST，requestJsonApi 默认不会重试；所有可安全重放的
// 完成阶段瞬态失败在这里统一做有界重试，避免与通用层形成双层重试风暴。
const COMPLETION_RETRYABLE_STATUS_CODES = new Set([408, 425, 500, 502, 503, 504])

type AttachmentRequestError = {
  status?: unknown
  statusCode?: unknown
  code?: unknown
  data?: unknown
}

const asAttachmentErrorRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? value as Record<string, unknown> : undefined

const getAttachmentErrorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as AttachmentRequestError
  const status = candidate.status ?? candidate.statusCode
  return typeof status === 'number' ? status : undefined
}

const getAttachmentErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as AttachmentRequestError
  const code = candidate.code ?? asAttachmentErrorRecord(candidate.data)?.code
  return typeof code === 'string' ? code : undefined
}

const getAttachmentErrorData = (error: unknown): Record<string, unknown> | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const envelope = asAttachmentErrorRecord((error as AttachmentRequestError).data)
  return asAttachmentErrorRecord(envelope?.data) ?? envelope
}

const isRetryableCreateTaskError = (error: unknown): boolean => {
  const data = getAttachmentErrorData(error)
  return getAttachmentErrorStatus(error) === 503
    && getAttachmentErrorCode(error) === 'SAVE_BUSY'
    && data?.retryable === true
}

const getCreateTaskRetryDelay = (error: unknown, fallbackMs: number): number => {
  const retryAfterMs = getAttachmentErrorData(error)?.retry_after_ms
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs)) {
    return fallbackMs
  }
  return Math.min(Math.max(retryAfterMs, 0), 5000)
}

const waitForCreateTaskRetry = (delayMs: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, delayMs))

const createUploadTaskWithRetry = async (
  payload: Parameters<typeof AttachmentApiService.createUploadTask>[0],
): Promise<Awaited<ReturnType<typeof AttachmentApiService.createUploadTask>>> => {
  let lastError: unknown

  for (let attempt = 0; attempt <= CREATE_TASK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await AttachmentApiService.createUploadTask(payload)
    } catch (error) {
      lastError = error
      const fallbackDelayMs = CREATE_TASK_RETRY_DELAYS_MS[attempt]
      if (!isRetryableCreateTaskError(error) || fallbackDelayMs == null) {
        throw error
      }

      const delayMs = getCreateTaskRetryDelay(error, fallbackDelayMs)
      log.warn('createUploadTask write contention, retrying', {
        attempt: attempt + 1,
        delayMs,
        status: getAttachmentErrorStatus(error),
        code: getAttachmentErrorCode(error),
        error: error instanceof Error ? error.message : String(error),
      })
      await waitForCreateTaskRetry(delayMs)
    }
  }

  throw lastError
}

const isRetryableCompletionError = (error: unknown): boolean => {
  if (error instanceof TypeError) return true
  const status = getAttachmentErrorStatus(error)
  return status != null && COMPLETION_RETRYABLE_STATUS_CODES.has(status)
}

const createUploadCancelledError = (): Error => {
  const error = new Error('Upload cancelled')
  error.name = 'AbortError'
  return error
}

const throwIfUploadAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw createUploadCancelledError()
}

const waitForCompletionRetry = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createUploadCancelledError())
      return
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, delayMs)
    const handleAbort = () => {
      clearTimeout(timer)
      reject(createUploadCancelledError())
    }
    signal.addEventListener('abort', handleAbort, { once: true })
  })

const completeUploadWithRetry = async (
  taskId: string,
  uploadItemId: string,
  signal: AbortSignal,
) => {
  let lastError: unknown

  for (let attempt = 0; attempt <= COMPLETION_RETRY_DELAYS_MS.length; attempt++) {
    try {
      throwIfUploadAborted(signal)
      const response = await AttachmentApiService.completeUpload(taskId, uploadItemId)
      throwIfUploadAborted(signal)
      return response
    } catch (error) {
      throwIfUploadAborted(signal)
      lastError = error
      const delayMs = COMPLETION_RETRY_DELAYS_MS[attempt]
      if (!isRetryableCompletionError(error) || delayMs == null) {
        throw error
      }

      log.warn('completeUpload transient failure, retrying', {
        taskId,
        uploadItemId,
        attempt: attempt + 1,
        delayMs,
        status: getAttachmentErrorStatus(error),
        error: error instanceof Error ? error.message : String(error),
      })
      await waitForCompletionRetry(delayMs, signal)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(i18n.t('attachments:apiErrors.completeUploadFailed'))
}

export interface AttachmentUploadItemState {
  uploadItemId: string
  file: File
  status: UploadStatus
  progress: number
  uploadedSize: number
  totalSize: number
  chunkSize: number
  completedParts: number
  totalParts: number
  partPresignedUrls?: Record<string, string>
  directUpload?: boolean
  reference?: AttachmentReference
  error?: string
}

export interface AttachmentTaskState {
  key: string
  taskId: string
  tableId: string
  fieldId: string
  recordId?: string
  createdAt: number
  items: AttachmentUploadItemState[]
}

// 兼容旧调用方的类型名，避免局部重构时的导入断层。
export type AttachmentUploadTask = AttachmentTaskState

export interface StartAttachmentUploadArgs {
  tableId: string
  fieldId: string
  /** 传给 createUploadTask 的 record_id；协作 pending 行应省略 */
  recordId?: string
  /**
   * 本地 task 字典 key 使用的行身份。
   * 默认等于 recordId；pending 乐观行应传真实客户端 UUID，避免与草稿 `__new__` 撞 key。
   */
  taskRecordId?: string
  files: File[]
  chunkSize?: number
  /** 全局上传通知重试成功后，把新引用重新提交给原业务单元格。 */
  onRetrySuccess?: (references: AttachmentReference[]) => void | Promise<void>
  /** 仅供 store 内部重试复用原通知行，避免一次重试生成两条失败任务。 */
  retryQueueTaskId?: string
}

interface AttachmentStore {
  tasks: Record<string, AttachmentTaskState>
  startUpload: (args: StartAttachmentUploadArgs) => Promise<AttachmentReference[]>
  abortUpload: (key: string, uploadItemId: string) => Promise<void>
  removeTask: (key: string) => void
  removeUploadItem: (key: string, uploadItemId: string) => void
  rebindRecordId: (tableId: string, fieldId: string, fromRecordId: string | undefined, toRecordId: string) => void
  clearAll: () => void
}

const makeUploadKey = (tableId: string, fieldId: string, recordId?: string) =>
  `${tableId}::${fieldId}::${recordId ?? '__new__'}`

const _activeAbortControllers = new Map<string, AbortController>()

const uploadPartViaMainProcess: AttachmentDirectUploader = ({
  presignedUrl,
  chunk,
  contentType,
  signal,
}) => putPresignedObjectViaMainProcess({
  presignedUrl,
  body: chunk,
  contentType,
  signal,
})

const cloneTaskWithItems = (
  task: AttachmentTaskState,
  updater: (items: AttachmentUploadItemState[]) => AttachmentUploadItemState[]
): AttachmentTaskState => ({
  ...task,
  items: updater(task.items),
})

export const useAttachmentStore = create<AttachmentStore>((set, get) => ({
  tasks: {},

  startUpload: async ({
    tableId,
    fieldId,
    recordId,
    taskRecordId,
    files,
    chunkSize,
    onRetrySuccess,
    retryQueueTaskId,
  }: StartAttachmentUploadArgs) => {
    if (!files || files.length === 0) {
      return []
    }

    const key = makeUploadKey(tableId, fieldId, taskRecordId ?? recordId)

    // Deduplicate file names (clipboard paste may produce multiple "image.png")
    const seenNames = new Map<string, number>()
    const deduplicateName = (name: string): string => {
      const count = seenNames.get(name) ?? 0
      seenNames.set(name, count + 1)
      if (count === 0) return name
      const dotIndex = name.lastIndexOf('.')
      if (dotIndex > 0) {
        return `${name.slice(0, dotIndex)}_${count}${name.slice(dotIndex)}`
      }
      return `${name}_${count}`
    }

    const HASH_MIN_SIZE = 100 * 1024
    const uploadFiles = await Promise.all(files.map(async file => {
      let fileHash: string | undefined
      if (file.size >= HASH_MIN_SIZE) {
        try { fileHash = await computeFileHash(file) } catch { /* hash failure non-blocking */ }
      }
      return {
        file,
        metadata: {
          file_name: deduplicateName(file.name || `file_${Date.now()}`),
          file_size: file.size,
          mime_type: file.type || 'application/octet-stream',
          chunk_size: chunkSize ?? AttachmentApiService.resolveChunkSize(file.size),
          is_public: false,
          ...(fileHash ? { file_hash: fileHash } : {}),
        },
      }
    }))

    const requestPayload = {
      table_id: tableId,
      field_id: fieldId,
      record_id: recordId,
      files: uploadFiles.map(item => item.metadata),
    }

    let taskResponse: Awaited<ReturnType<typeof AttachmentApiService.createUploadTask>>
    try {
      taskResponse = await createUploadTaskWithRetry(requestPayload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 协作乐观行 / 幽灵 ID：服务端尚无该记录时返回「资源不存在」。
      // complete_upload 不再写记录，省略 record_id 后仍可由前端 updateRecord 挂载。
      // 本地 task key 仍用调用方传入的 recordId，避免进度订阅对不上。
      const canRetryWithoutRecord =
        Boolean(recordId) && /资源不存在|not[_ ]?found|does not exist/i.test(message)
      if (canRetryWithoutRecord) {
        log.warn('createUploadTask record missing, retry without record_id', {
          tableId,
          fieldId,
          fileCount: uploadFiles.length,
          error: message,
        })
        try {
          taskResponse = await createUploadTaskWithRetry({
            ...requestPayload,
            record_id: undefined,
          })
        } catch (retryError) {
          log.error('createUploadTask retry failed', {
            tableId,
            fieldId,
            fileCount: uploadFiles.length,
            error: retryError instanceof Error ? retryError.message : String(retryError),
          })
          throw retryError
        }
      } else {
        log.error('createUploadTask failed', {
          tableId,
          fieldId,
          hasRecordId: Boolean(recordId),
          fileCount: uploadFiles.length,
          error: message,
        })
        throw error
      }
    }

    if (!taskResponse.files || taskResponse.files.length === 0) {
      throw new Error(i18n.t('attachments:apiErrors.uploadTaskEmpty'))
    }

    const responseFilesMap = new Map<string, typeof taskResponse.files[number]>()
    taskResponse.files.forEach(file => {
      responseFilesMap.set(file.file_name, file)
    })

    const uploadItems: AttachmentUploadItemState[] = uploadFiles.map(upload => {
      const responseFile = responseFilesMap.get(upload.metadata.file_name)
      if (!responseFile) {
        throw new Error(
          i18n.t('attachments:apiErrors.uploadTaskMissingItem', {
            name: upload.metadata.file_name
          })
        )
      }

      return {
        uploadItemId: responseFile.upload_item_id,
        file: upload.file,
        status: 'pending',
        progress: 0,
        uploadedSize: 0,
        totalSize: upload.file.size,
        chunkSize: responseFile.chunk_size,
        completedParts: 0,
        totalParts: responseFile.total_parts,
        partPresignedUrls: (responseFile as any).part_presigned_urls || {},
        directUpload: !!(responseFile as any).direct_upload,
      }
    })

    set(state => ({
      tasks: {
        ...state.tasks,
        [key]: {
          key,
          taskId: taskResponse.task_id,
          tableId,
          fieldId,
          recordId: taskRecordId ?? recordId,
          createdAt: Date.now(),
          items: uploadItems,
        },
      },
    }))

    const queueTaskIdMap = new Map<string, string>()
    const queueLastReported = new Map<string, number>()
    for (let i = 0; i < uploadItems.length; i++) {
      const item = uploadItems[i]
      const queueTaskId = retryQueueTaskId && uploadItems.length === 1
        ? retryQueueTaskId
        : `tabdata-${taskResponse.task_id}-${item.uploadItemId}`
      queueTaskIdMap.set(item.uploadItemId, queueTaskId)
      queueLastReported.set(item.uploadItemId, 0)
      const queueStore = useUploadQueueStore.getState()
      const queueTask = {
        fileName: uploadFiles[i].metadata.file_name,
        fileSize: item.totalSize,
        mimeType: item.file.type || 'application/octet-stream',
        module: 'tabdata',
        folder: `tabdata/${tableId}/${fieldId}`,
      }
      if (retryQueueTaskId && uploadItems.length === 1) {
        queueStore.updateTask(queueTaskId, {
          ...queueTask,
          status: 'queued',
          progress: 0,
          error: undefined,
        })
      } else {
        queueStore.addTask({ id: queueTaskId, ...queueTask })
      }
      queueStore.registerRetryCallback(queueTaskId, async () => {
        const retryReferences = await get().startUpload({
          tableId,
          fieldId,
          recordId,
          taskRecordId,
          files: [item.file],
          chunkSize,
          onRetrySuccess,
          retryQueueTaskId: queueTaskId,
        })
        await onRetrySuccess?.(retryReferences)
      })
    }

    const references: AttachmentReference[] = []
    const errors: Array<{ uploadItemId: string; error: unknown }> = []

    async function uploadOneItem(item: (typeof uploadItems)[number]) {
      const chunks: Blob[] = []
      const totalParts = item.totalParts
      const chunkSizeBytes = item.chunkSize
      for (let partNumber = 0; partNumber < totalParts; partNumber++) {
        const start = partNumber * chunkSizeBytes
        const end = Math.min(item.totalSize, start + chunkSizeBytes)
        chunks.push(item.file.slice(start, end))
      }

      const ac = new AbortController()
      _activeAbortControllers.set(item.uploadItemId, ac)

      const queueTaskId = queueTaskIdMap.get(item.uploadItemId)
      if (queueTaskId) {
        useUploadQueueStore.getState().registerCancelCallback(queueTaskId, () => ac.abort())
        useUploadQueueStore.getState().updateTask(queueTaskId, { status: 'uploading' })
      }

      set(state => ({
        tasks: {
          ...state.tasks,
          [key]: cloneTaskWithItems(state.tasks[key], items =>
            items.map(uploadItem =>
              uploadItem.uploadItemId === item.uploadItemId
                ? { ...uploadItem, status: 'uploading', progress: 0, uploadedSize: 0, completedParts: 0 }
                : uploadItem
            )
          ),
        },
      }))

      try {
        let uploadedSize = 0
        let completedParts = 0

        for (let index = 0; index < chunks.length; index++) {
          if (ac.signal.aborted) throw new Error('Upload cancelled')

          const partNumber = index + 1
          const chunk = chunks[index]

          const presignedUrl = item.directUpload
            ? item.partPresignedUrls?.[String(partNumber)]
            : undefined

          await AttachmentApiService.uploadPart(
            taskResponse.task_id,
            item.uploadItemId,
            partNumber,
            chunk,
            presignedUrl
              ? { presignedUrl, signal: ac.signal, directUploader: uploadPartViaMainProcess }
              : { signal: ac.signal },
          )

          uploadedSize += chunk.size
          completedParts = partNumber
          const progress = Math.min(1, uploadedSize / item.totalSize)

          set(state => ({
            tasks: {
              ...state.tasks,
              [key]: cloneTaskWithItems(state.tasks[key], items =>
                items.map(uploadItem =>
                  uploadItem.uploadItemId === item.uploadItemId
                    ? {
                        ...uploadItem,
                        status: 'uploading',
                        uploadedSize,
                        completedParts,
                        progress,
                      }
                    : uploadItem
                )
              ),
            },
          }))

          if (queueTaskId) {
            const lastP = queueLastReported.get(item.uploadItemId) ?? 0
            if (progress - lastP >= 0.05 || progress >= 1) {
              queueLastReported.set(item.uploadItemId, progress)
              useUploadQueueStore.getState().updateTask(queueTaskId, { progress })
            }
          }
        }

        const completeResponse = await completeUploadWithRetry(
          taskResponse.task_id,
          item.uploadItemId,
          ac.signal,
        )

        references.push(completeResponse.reference)

        set(state => ({
          tasks: {
            ...state.tasks,
            [key]: cloneTaskWithItems(state.tasks[key], items =>
              items.map(uploadItem =>
                uploadItem.uploadItemId === item.uploadItemId
                  ? {
                      ...uploadItem,
                      status: 'completed',
                      progress: 1,
                      uploadedSize: uploadItem.totalSize,
                      completedParts: uploadItem.totalParts,
                      reference: completeResponse.reference,
                    }
                  : uploadItem
              )
            ),
          },
        }))

        if (queueTaskId) {
          useUploadQueueStore.getState().updateTask(queueTaskId, {
            status: 'completed',
            progress: 1,
            completedAt: Date.now(),
          })
        }
      } catch (error) {
        if (ac.signal.aborted) {
          set(state => ({
            tasks: {
              ...state.tasks,
              [key]: cloneTaskWithItems(state.tasks[key], items =>
                items.map(uploadItem =>
                  uploadItem.uploadItemId === item.uploadItemId
                    ? { ...uploadItem, status: 'cancelled', error: undefined }
                    : uploadItem
                )
              ),
            },
          }))
          if (queueTaskId) {
            useUploadQueueStore.getState().updateTask(queueTaskId, { status: 'cancelled' })
          }
          return
        }

        console.error('Attachment upload failed for item:', item.uploadItemId, error)
        errors.push({ uploadItemId: item.uploadItemId, error })
        set(state => ({
          tasks: {
            ...state.tasks,
            [key]: cloneTaskWithItems(state.tasks[key], items =>
              items.map(uploadItem =>
                uploadItem.uploadItemId === item.uploadItemId
                  ? {
                      ...uploadItem,
                      status: 'error',
                      error: error instanceof Error ? error.message : i18n.t('attachments:apiErrors.uploadFailed'),
                    }
                  : uploadItem
              )
            ),
          },
        }))

        if (queueTaskId) {
          useUploadQueueStore.getState().updateTask(queueTaskId, {
            status: 'failed',
            error: error instanceof Error ? error.message : i18n.t('attachments:apiErrors.uploadFailed'),
          })
        }
      } finally {
        _activeAbortControllers.delete(item.uploadItemId)
      }
    }

    let cursor = 0
    async function worker() {
      while (cursor < uploadItems.length) {
        const idx = cursor++
        await uploadOneItem(uploadItems[idx])
      }
    }
    const workerCount = Math.min(UPLOAD_CONCURRENCY, uploadItems.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    if (references.length === 0 && errors.length > 0) {
      const firstErr = errors[0].error
      throw firstErr instanceof Error ? firstErr : new Error(i18n.t('attachments:apiErrors.uploadFailed'))
    }

    return references
  },

  abortUpload: async (key: string, uploadItemId: string) => {
    const task = get().tasks[key]
    if (!task) {
      return
    }
    const uploadItem = task.items.find(item => item.uploadItemId === uploadItemId)
    if (!uploadItem || uploadItem.status === 'completed') {
      return
    }

    const ac = _activeAbortControllers.get(uploadItemId)
    if (ac) {
      ac.abort()
      _activeAbortControllers.delete(uploadItemId)
    }

    try {
      await AttachmentApiService.abortUpload(task.taskId, uploadItemId)
    } catch (err) {
      console.warn('Abort upload API failed, forcing local cancel:', err)
    }

    set(state => ({
      tasks: {
        ...state.tasks,
        [key]: cloneTaskWithItems(state.tasks[key], items =>
          items.map(itemState =>
            itemState.uploadItemId === uploadItemId
              ? { ...itemState, status: 'cancelled' }
              : itemState
          )
        ),
      },
    }))

    const queueTaskId = `tabdata-${task.taskId}-${uploadItemId}`
    useUploadQueueStore.getState().updateTask(queueTaskId, { status: 'cancelled' })
  },

  removeTask: (key: string) => {
    set(state => {
      const nextTasks = { ...state.tasks }
      delete nextTasks[key]
      return { tasks: nextTasks }
    })
  },

  removeUploadItem: (key: string, uploadItemId: string) => {
    set(state => {
      const task = state.tasks[key]
      if (!task) {
        return state
      }
      const items = task.items.filter(item => item.uploadItemId !== uploadItemId)
      const nextTasks = { ...state.tasks }
      if (items.length === 0) {
        delete nextTasks[key]
      } else {
        nextTasks[key] = { ...task, items }
      }
      return { tasks: nextTasks }
    })
  },

  rebindRecordId: (tableId: string, fieldId: string, fromRecordId: string | undefined, toRecordId: string) => {
    const fromKey = makeUploadKey(tableId, fieldId, fromRecordId)
    const toKey = makeUploadKey(tableId, fieldId, toRecordId)

    set(state => {
      const task = state.tasks[fromKey]
      if (!task) {
        return state
      }
      const nextTasks = { ...state.tasks }
      delete nextTasks[fromKey]
      nextTasks[toKey] = {
        ...task,
        key: toKey,
        recordId: toRecordId,
      }
      return { tasks: nextTasks }
    })
  },

  clearAll: () => {
    const allTasks = get().tasks
    for (const task of Object.values(allTasks)) {
      for (const item of task.items) {
        if (item.status === 'pending' || item.status === 'uploading') {
          AttachmentApiService.abortUpload(task.taskId, item.uploadItemId).catch(() => {})
        }
      }
    }
    set({ tasks: {} })
  },
}))

export const buildAttachmentUploadKey = makeUploadKey

registerResetAction('attachment', 'reset', () => useAttachmentStore.getState().clearAll())
