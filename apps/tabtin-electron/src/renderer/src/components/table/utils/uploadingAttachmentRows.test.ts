import { describe, expect, it } from 'vitest'
import { buildAttachmentUploadKey } from '@/stores/useAttachmentStore'
import { buildUploadingAttachmentRows } from './uploadingAttachmentRows'

describe('buildUploadingAttachmentRows', () => {
  it('应将上传中的附件任务合并到当前展示行，供粘贴后立即显示 loading', () => {
    const taskKey = buildAttachmentUploadKey('table-1', 'field-attachment', 'record-1')
    const file = new File(['attachment'], 'pasted.png', { type: 'image/png' })

    const result = buildUploadingAttachmentRows({
      rows: [
        {
          id: 'record-1',
          row_id: 'record-1',
          Attachment: [],
        },
      ],
      selectedTableId: 'table-1',
      fields: [
        { id: 'field-attachment', name: 'Attachment', field_type: 'attachment' },
      ],
      tasks: {
        [taskKey]: {
          items: [
            {
              uploadItemId: 'upload-1',
              file,
              status: 'uploading',
              progress: 0.4,
              uploadedSize: 4,
              totalSize: 10,
              chunkSize: 10,
              completedParts: 0,
              totalParts: 1,
            },
          ],
        },
      },
      previewUrls: {
        'upload-1': 'blob://upload-1',
      },
    })

    expect(result.resolvedTaskKeys).toEqual([])
    expect(result.rows).toHaveLength(1)
    expect((result.rows[0] as Record<string, unknown>).Attachment).toEqual([
      {
        __uploading: true,
        upload_item_id: 'upload-1',
        name: 'pasted.png',
        file_name: 'pasted.png',
        mime_type: 'image/png',
        url: 'blob://upload-1',
        preview_url: 'blob://upload-1',
        upload_status: 'uploading',
        upload_progress: 0.4,
      },
    ])
  })

  it('应在真实附件已同步回记录后标记任务可清理，避免 completed 任务长期滞留', () => {
    const taskKey = buildAttachmentUploadKey('table-1', 'field-attachment', 'record-1')
    const reference = {
      reference_id: 'ref-1',
      file_id: 'file-1',
      name: 'image.png',
      url: 'https://cdn.example.com/image.png',
      mime_type: 'image/png',
    }

    const beforeSync = buildUploadingAttachmentRows({
      rows: [
        {
          id: 'record-1',
          row_id: 'record-1',
          Attachment: [],
        },
      ],
      selectedTableId: 'table-1',
      fields: [
        { id: 'field-attachment', name: 'Attachment', field_type: 'attachment' },
      ],
      tasks: {
        [taskKey]: {
          items: [
            {
              uploadItemId: 'upload-1',
              file: new File(['image'], 'image.png', { type: 'image/png' }),
              status: 'completed',
              progress: 1,
              uploadedSize: 10,
              totalSize: 10,
              chunkSize: 10,
              completedParts: 1,
              totalParts: 1,
              reference,
            },
          ],
        },
      },
      previewUrls: {},
    })

    expect((beforeSync.rows[0] as Record<string, unknown>).Attachment).toEqual([
      {
        ...reference,
        __local_upload_overlay: true,
      },
    ])
    expect(beforeSync.resolvedTaskKeys).toEqual([])

    const afterSync = buildUploadingAttachmentRows({
      rows: [
        {
          id: 'record-1',
          row_id: 'record-1',
          Attachment: [reference],
        },
      ],
      selectedTableId: 'table-1',
      fields: [
        { id: 'field-attachment', name: 'Attachment', field_type: 'attachment' },
      ],
      tasks: {
        [taskKey]: {
          items: [
            {
              uploadItemId: 'upload-1',
              file: new File(['image'], 'image.png', { type: 'image/png' }),
              status: 'completed',
              progress: 1,
              uploadedSize: 10,
              totalSize: 10,
              chunkSize: 10,
              completedParts: 1,
              totalParts: 1,
              reference,
            },
          ],
        },
      },
      previewUrls: {},
    })

    expect((afterSync.rows[0] as Record<string, unknown>).Attachment).toEqual([reference])
    expect(afterSync.resolvedTaskKeys).toEqual([taskKey])
  })
})
