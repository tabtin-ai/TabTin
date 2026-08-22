import {
  AttachmentApiService,
  type AttachmentCompleteResponse,
  type AttachmentPartUploadResponse,
  type AttachmentReference,
  type AttachmentUploadTaskResponse,
} from '@tabtin/table-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api'
import { useAttachmentStore } from './useAttachmentStore'
import { useUploadQueueStore } from './useUploadQueueStore'

vi.mock('@/services/mainProcessOssUploader', () => ({
  putPresignedObjectViaMainProcess: vi.fn(),
}))

describe('useAttachmentStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useAttachmentStore.getState().clearAll()
    useUploadQueueStore.getState().clearAll()
  })

  it('retries upload-task creation only when the server marks write contention retryable', async () => {
    const file = new File(['content'], 'evidence.png', { type: 'image/png' })
    const reference: AttachmentReference = {
      reference_id: 'reference-1',
      file_id: 'file-1',
      name: file.name,
      size: file.size,
      mime_type: file.type,
      url: 'https://example.test/evidence.png',
      field_id: 'field-1',
      record_id: 'record-1',
    }
    const writeContention = new ApiError('save busy', 503, {
      success: false,
      code: 'SAVE_BUSY',
      message: 'save busy',
      data: { retryable: true, retry_after_ms: 0 },
    })

    vi.spyOn(AttachmentApiService, 'createUploadTask')
      .mockRejectedValueOnce(writeContention)
      .mockResolvedValueOnce({
        task_id: 'task-1',
        files: [{
          upload_item_id: 'item-1',
          file_name: file.name,
          file_size: file.size,
          chunk_size: file.size,
          total_parts: 1,
          object_key: 'tabdata/evidence.png',
        }],
        task_type: 'single',
      } satisfies AttachmentUploadTaskResponse)
    vi.spyOn(AttachmentApiService, 'uploadPart').mockResolvedValue({
      upload_item_id: 'item-1',
      part_number: 1,
      etag: 'etag-1',
      completed_parts: 1,
      total_parts: 1,
      uploaded_size: file.size,
    } satisfies AttachmentPartUploadResponse)
    vi.spyOn(AttachmentApiService, 'completeUpload').mockResolvedValue({
      upload_item_id: 'item-1',
      file_id: reference.file_id,
      reference,
      status: 'completed',
    } satisfies AttachmentCompleteResponse)

    await expect(useAttachmentStore.getState().startUpload({
      tableId: 'table-1',
      fieldId: 'field-1',
      recordId: 'record-1',
      files: [file],
    })).resolves.toEqual([reference])

    expect(AttachmentApiService.createUploadTask).toHaveBeenCalledTimes(2)
    expect(AttachmentApiService.uploadPart).toHaveBeenCalledTimes(1)
    expect(AttachmentApiService.completeUpload).toHaveBeenCalledTimes(1)
  })

  it('does not retry upload-task creation for non-retryable client errors', async () => {
    const file = new File(['content'], 'evidence.png', { type: 'image/png' })
    const validationError = new ApiError('invalid attachment field', 400, {
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'invalid attachment field',
      data: { retryable: false },
    })
    vi.spyOn(AttachmentApiService, 'createUploadTask').mockRejectedValue(validationError)

    await expect(useAttachmentStore.getState().startUpload({
      tableId: 'table-1',
      fieldId: 'field-1',
      files: [file],
    })).rejects.toThrow('invalid attachment field')

    expect(AttachmentApiService.createUploadTask).toHaveBeenCalledTimes(1)
  })

  it('does not retry an ordinary 503 without the SAVE_BUSY contract', async () => {
    const file = new File(['content'], 'evidence.png', { type: 'image/png' })
    const serverError = new ApiError('service unavailable', 503, {
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'service unavailable',
      data: { retryable: true, retry_after_ms: 0 },
    })
    vi.spyOn(AttachmentApiService, 'createUploadTask').mockRejectedValue(serverError)

    await expect(useAttachmentStore.getState().startUpload({
      tableId: 'table-1',
      fieldId: 'field-1',
      files: [file],
    })).rejects.toThrow('service unavailable')

    expect(AttachmentApiService.createUploadTask).toHaveBeenCalledTimes(1)
  })

  it('stops retrying upload-task creation after two bounded retries', async () => {
    const file = new File(['content'], 'evidence.png', { type: 'image/png' })
    const writeContention = new ApiError('save busy', 503, {
      success: false,
      code: 'SAVE_BUSY',
      message: 'save busy',
      data: { retryable: true, retry_after_ms: 0 },
    })
    vi.spyOn(AttachmentApiService, 'createUploadTask').mockRejectedValue(writeContention)

    await expect(useAttachmentStore.getState().startUpload({
      tableId: 'table-1',
      fieldId: 'field-1',
      files: [file],
    })).rejects.toThrow('save busy')

    expect(AttachmentApiService.createUploadTask).toHaveBeenCalledTimes(3)
  })

  it('retries a failed attachment by rebuilding the upload task and commits the new reference', async () => {
    const file = new File(['content'], 'evidence.png', { type: 'image/png' })
    const reference: AttachmentReference = {
      reference_id: 'reference-2',
      file_id: 'file-2',
      name: file.name,
      size: file.size,
      mime_type: file.type,
      url: 'https://example.test/evidence.png',
      field_id: 'field-1',
      record_id: 'record-1',
    }
    const onRetrySuccess = vi.fn()

    vi.spyOn(AttachmentApiService, 'createUploadTask')
      .mockResolvedValueOnce({
        task_id: 'task-1',
        files: [{
          upload_item_id: 'item-1',
          file_name: file.name,
          file_size: file.size,
          chunk_size: file.size,
          total_parts: 1,
          object_key: 'tabdata/evidence-1.png',
        }],
        task_type: 'single',
      } satisfies AttachmentUploadTaskResponse)
      .mockResolvedValueOnce({
        task_id: 'task-2',
        files: [{
          upload_item_id: 'item-2',
          file_name: file.name,
          file_size: file.size,
          chunk_size: file.size,
          total_parts: 1,
          object_key: 'tabdata/evidence-2.png',
        }],
        task_type: 'single',
      } satisfies AttachmentUploadTaskResponse)
    vi.spyOn(AttachmentApiService, 'uploadPart')
      .mockRejectedValueOnce(new Error('temporary storage failure'))
      .mockResolvedValueOnce({
        upload_item_id: 'item-2',
        part_number: 1,
        etag: 'etag-2',
        completed_parts: 1,
        total_parts: 1,
        uploaded_size: file.size,
      } satisfies AttachmentPartUploadResponse)
    vi.spyOn(AttachmentApiService, 'completeUpload')
      .mockResolvedValueOnce({
        upload_item_id: 'item-2',
        file_id: reference.file_id,
        reference,
        status: 'completed',
      } satisfies AttachmentCompleteResponse)

    await expect(useAttachmentStore.getState().startUpload({
      tableId: 'table-1',
      fieldId: 'field-1',
      recordId: 'record-1',
      files: [file],
      onRetrySuccess,
    })).rejects.toThrow('temporary storage failure')

    const queueTaskId = 'tabdata-task-1-item-1'
    expect(useUploadQueueStore.getState().canRetryTask(queueTaskId)).toBe(true)

    await useUploadQueueStore.getState().retryTask(queueTaskId)

    expect(AttachmentApiService.createUploadTask).toHaveBeenCalledTimes(2)
    expect(AttachmentApiService.uploadPart).toHaveBeenCalledTimes(2)
    expect(AttachmentApiService.completeUpload).toHaveBeenCalledTimes(1)
    expect(onRetrySuccess).toHaveBeenCalledWith([reference])
    expect(useUploadQueueStore.getState().tasks.find((task) => task.id === queueTaskId)?.status)
      .toBe('completed')
  })

  it('keeps the same failed queue item retryable when rebuilding the task also fails', async () => {
    const file = new File(['content'], 'evidence.png', { type: 'image/png' })

    vi.spyOn(AttachmentApiService, 'createUploadTask')
      .mockResolvedValueOnce({
        task_id: 'task-1',
        files: [{
          upload_item_id: 'item-1',
          file_name: file.name,
          file_size: file.size,
          chunk_size: file.size,
          total_parts: 1,
          object_key: 'tabdata/evidence-1.png',
        }],
        task_type: 'single',
      } satisfies AttachmentUploadTaskResponse)
      .mockRejectedValueOnce(new Error('create task still unavailable'))
    vi.spyOn(AttachmentApiService, 'uploadPart')
      .mockRejectedValueOnce(new Error('temporary storage failure'))

    await expect(useAttachmentStore.getState().startUpload({
      tableId: 'table-1',
      fieldId: 'field-1',
      recordId: 'record-1',
      files: [file],
    })).rejects.toThrow('temporary storage failure')

    const queueTaskId = 'tabdata-task-1-item-1'
    await useUploadQueueStore.getState().retryTask(queueTaskId)

    const queueState = useUploadQueueStore.getState()
    expect(queueState.tasks).toHaveLength(1)
    expect(queueState.tasks[0]).toMatchObject({
      id: queueTaskId,
      status: 'failed',
      error: 'create task still unavailable',
    })
    expect(queueState.canRetryTask(queueTaskId)).toBe(true)
  })

  it('retries a completion failure without creating a second queue item', async () => {
    const file = new File(['content'], 'evidence.png', { type: 'image/png' })
    const reference: AttachmentReference = {
      reference_id: 'reference-complete-2',
      file_id: 'file-complete-2',
      name: file.name,
      size: file.size,
      mime_type: file.type,
      url: 'https://example.test/evidence.png',
      field_id: 'field-1',
      record_id: 'record-1',
    }
    const onRetrySuccess = vi.fn()

    vi.spyOn(AttachmentApiService, 'createUploadTask')
      .mockResolvedValueOnce({
        task_id: 'task-complete-1',
        files: [{
          upload_item_id: 'item-complete-1',
          file_name: file.name,
          file_size: file.size,
          chunk_size: file.size,
          total_parts: 1,
          object_key: 'tabdata/complete-1.png',
        }],
        task_type: 'single',
      } satisfies AttachmentUploadTaskResponse)
      .mockResolvedValueOnce({
        task_id: 'task-complete-2',
        files: [{
          upload_item_id: 'item-complete-2',
          file_name: file.name,
          file_size: file.size,
          chunk_size: file.size,
          total_parts: 1,
          object_key: 'tabdata/complete-2.png',
        }],
        task_type: 'single',
      } satisfies AttachmentUploadTaskResponse)
    vi.spyOn(AttachmentApiService, 'uploadPart').mockResolvedValue({
      upload_item_id: 'item-complete',
      part_number: 1,
      etag: 'etag-complete',
      completed_parts: 1,
      total_parts: 1,
      uploaded_size: file.size,
    } satisfies AttachmentPartUploadResponse)
    vi.spyOn(AttachmentApiService, 'completeUpload')
      .mockRejectedValueOnce(new Error('organization lock timeout'))
      .mockResolvedValueOnce({
        upload_item_id: 'item-complete-2',
        file_id: reference.file_id,
        reference,
        status: 'completed',
      } satisfies AttachmentCompleteResponse)

    await expect(useAttachmentStore.getState().startUpload({
      tableId: 'table-1',
      fieldId: 'field-1',
      recordId: 'record-1',
      files: [file],
      onRetrySuccess,
    })).rejects.toThrow('organization lock timeout')

    const queueTaskId = 'tabdata-task-complete-1-item-complete-1'
    expect(useUploadQueueStore.getState().tasks).toHaveLength(1)
    expect(useUploadQueueStore.getState().canRetryTask(queueTaskId)).toBe(true)

    await useUploadQueueStore.getState().retryTask(queueTaskId)

    expect(AttachmentApiService.createUploadTask).toHaveBeenCalledTimes(2)
    expect(AttachmentApiService.uploadPart).toHaveBeenNthCalledWith(
      2,
      'task-complete-2',
      'item-complete-2',
      1,
      expect.any(Blob),
      expect.any(Object),
    )
    expect(AttachmentApiService.completeUpload).toHaveBeenCalledTimes(2)
    expect(AttachmentApiService.completeUpload).toHaveBeenNthCalledWith(
      1,
      'task-complete-1',
      'item-complete-1',
    )
    expect(AttachmentApiService.completeUpload).toHaveBeenNthCalledWith(
      2,
      'task-complete-2',
      'item-complete-2',
    )
    expect(useUploadQueueStore.getState().tasks).toHaveLength(1)
    expect(useUploadQueueStore.getState().tasks[0]).toMatchObject({
      id: queueTaskId,
      status: 'completed',
    })
    expect(onRetrySuccess).toHaveBeenCalledWith([reference])
    expect(onRetrySuccess).toHaveBeenCalledTimes(1)
  })

  it('retries transient gateway and server completion failures without rebuilding the upload task', async () => {
    const file = new File(['content'], 'evidence.png', { type: 'image/png' })
    const reference: AttachmentReference = {
      reference_id: 'reference-1',
      file_id: 'file-1',
      name: file.name,
      size: file.size,
      mime_type: file.type,
      url: 'https://example.test/evidence.png',
      field_id: 'field-1',
      record_id: 'record-1',
    }
    const gatewayError = Object.assign(new Error('gateway unavailable'), { status: 503 })
    const serverError = Object.assign(new Error('lock timeout'), { status: 500 })

    vi.spyOn(AttachmentApiService, 'createUploadTask').mockResolvedValue({
      task_id: 'task-1',
      files: [{
        upload_item_id: 'item-1',
        file_name: file.name,
        file_size: file.size,
        chunk_size: file.size,
        total_parts: 1,
        object_key: 'tabdata/evidence-1.png',
      }],
      task_type: 'single',
    } satisfies AttachmentUploadTaskResponse)
    vi.spyOn(AttachmentApiService, 'uploadPart').mockResolvedValue({
      upload_item_id: 'item-1',
      part_number: 1,
      etag: 'etag-1',
      completed_parts: 1,
      total_parts: 1,
      uploaded_size: file.size,
    } satisfies AttachmentPartUploadResponse)
    vi.spyOn(AttachmentApiService, 'completeUpload')
      .mockRejectedValueOnce(gatewayError)
      .mockRejectedValueOnce(serverError)
      .mockResolvedValueOnce({
        upload_item_id: 'item-1',
        file_id: reference.file_id,
        reference,
        status: 'completed',
      } satisfies AttachmentCompleteResponse)

    await expect(useAttachmentStore.getState().startUpload({
      tableId: 'table-1',
      fieldId: 'field-1',
      recordId: 'record-1',
      files: [file],
    })).resolves.toEqual([reference])

    expect(AttachmentApiService.createUploadTask).toHaveBeenCalledTimes(1)
    expect(AttachmentApiService.uploadPart).toHaveBeenCalledTimes(1)
    expect(AttachmentApiService.completeUpload).toHaveBeenCalledTimes(3)
    expect(useUploadQueueStore.getState().tasks[0]).toMatchObject({
      id: 'tabdata-task-1-item-1',
      status: 'completed',
    })
  })

  it('stops completion retries and preserves cancelled state when cancelled during backoff', async () => {
    const file = new File(['content'], 'evidence.png', { type: 'image/png' })
    const reference: AttachmentReference = {
      reference_id: 'reference-1',
      file_id: 'file-1',
      name: file.name,
      size: file.size,
      mime_type: file.type,
      url: 'https://example.test/evidence.png',
      field_id: 'field-1',
      record_id: 'record-1',
    }
    const transientError = Object.assign(new Error('lock timeout'), { status: 500 })

    vi.spyOn(AttachmentApiService, 'createUploadTask').mockResolvedValue({
      task_id: 'task-1',
      files: [{
        upload_item_id: 'item-1',
        file_name: file.name,
        file_size: file.size,
        chunk_size: file.size,
        total_parts: 1,
        object_key: 'tabdata/evidence-1.png',
      }],
      task_type: 'single',
    } satisfies AttachmentUploadTaskResponse)
    vi.spyOn(AttachmentApiService, 'uploadPart').mockResolvedValue({
      upload_item_id: 'item-1',
      part_number: 1,
      etag: 'etag-1',
      completed_parts: 1,
      total_parts: 1,
      uploaded_size: file.size,
    } satisfies AttachmentPartUploadResponse)
    const completeUpload = vi.spyOn(AttachmentApiService, 'completeUpload')
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({
        upload_item_id: 'item-1',
        file_id: reference.file_id,
        reference,
        status: 'completed',
      } satisfies AttachmentCompleteResponse)

    const upload = useAttachmentStore.getState().startUpload({
      tableId: 'table-1',
      fieldId: 'field-1',
      recordId: 'record-1',
      files: [file],
    })

    await vi.waitFor(() => expect(completeUpload).toHaveBeenCalledTimes(1))
    const queueTaskId = 'tabdata-task-1-item-1'
    useUploadQueueStore.getState().cancelTask(queueTaskId)

    await expect(upload).resolves.toEqual([])
    expect(completeUpload).toHaveBeenCalledTimes(1)
    expect(useUploadQueueStore.getState().tasks[0]).toMatchObject({
      id: queueTaskId,
      status: 'cancelled',
    })
    expect(useAttachmentStore.getState().tasks['table-1::field-1::record-1'].items[0])
      .toMatchObject({ status: 'cancelled' })
  })

  it('does not retry a non-transient completion failure', async () => {
    const file = new File(['content'], 'evidence.png', { type: 'image/png' })
    const validationError = Object.assign(new Error('invalid upload task'), { status: 400 })

    vi.spyOn(AttachmentApiService, 'createUploadTask').mockResolvedValue({
      task_id: 'task-1',
      files: [{
        upload_item_id: 'item-1',
        file_name: file.name,
        file_size: file.size,
        chunk_size: file.size,
        total_parts: 1,
        object_key: 'tabdata/evidence-1.png',
      }],
      task_type: 'single',
    } satisfies AttachmentUploadTaskResponse)
    vi.spyOn(AttachmentApiService, 'uploadPart').mockResolvedValue({
      upload_item_id: 'item-1',
      part_number: 1,
      etag: 'etag-1',
      completed_parts: 1,
      total_parts: 1,
      uploaded_size: file.size,
    } satisfies AttachmentPartUploadResponse)
    vi.spyOn(AttachmentApiService, 'completeUpload').mockRejectedValue(validationError)

    await expect(useAttachmentStore.getState().startUpload({
      tableId: 'table-1',
      fieldId: 'field-1',
      recordId: 'record-1',
      files: [file],
    })).rejects.toThrow('invalid upload task')

    expect(AttachmentApiService.completeUpload).toHaveBeenCalledTimes(1)
    expect(useUploadQueueStore.getState().tasks[0]).toMatchObject({
      id: 'tabdata-task-1-item-1',
      status: 'failed',
    })
  })
})
