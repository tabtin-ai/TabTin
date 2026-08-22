/**
 * 对话 file-ref → 表格附件：优先 reuseAttachment，否则按 URL 下载再上传。
 */

import { AttachmentApiService } from '@tabtin/table-core'
import type {
  TableGridAttachmentFileRef,
  TableGridAttachmentFileRefHandler,
  TableGridRow,
} from '@tabtin/table-engine'
import { createLogger } from '@/utils/logger'
import { useAttachmentStore } from '@/stores/useAttachmentStore'

const log = createLogger('attachmentFileRef')

async function fileFromUrl(url: string, name: string, mimeType?: string): Promise<File> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`下载失败 (${response.status})`)
  }
  const blob = await response.blob()
  return new File([blob], name || 'file', {
    type: mimeType || blob.type || 'application/octet-stream',
  })
}

export type CreateAttachmentFileRefHandlerOptions = {
  tableId: string | undefined
  resolveFieldId: (field: string, fieldId?: string) => string | undefined
  resolveRecordId: (rowData: TableGridRow) => string | undefined
  missingTableMessage: string
  missingFieldMessage: string
  missingRecordMessage: string
  fileTypeNotAllowedMessage: string
}

export function createAttachmentFileRefHandler(
  options: CreateAttachmentFileRefHandlerOptions,
): TableGridAttachmentFileRefHandler<TableGridRow> {
  return async ({ rowData, field, fieldId, fileRefs }) => {
    const tableId = options.tableId
    if (!tableId) {
      throw new Error(options.missingTableMessage)
    }

    const normalizedFieldId = options.resolveFieldId(field, fieldId)
    if (!normalizedFieldId) {
      throw new Error(options.missingFieldMessage)
    }

    const recordId = options.resolveRecordId(rowData)
    if (!recordId) {
      throw new Error(options.missingRecordMessage)
    }

    if (fileRefs.length === 0) {
      throw new Error(options.fileTypeNotAllowedMessage)
    }

    const results: unknown[] = []
    const filesToUpload: File[] = []

    for (const ref of fileRefs) {
      if (ref.file_id) {
        try {
          const reused = await AttachmentApiService.reuseAttachment({
            file_id: ref.file_id,
            table_id: tableId,
            field_id: normalizedFieldId,
            record_id: recordId,
          })
          results.push(reused)
          continue
        } catch (error) {
          log.warn(
            `reuseAttachment failed file_id=${ref.file_id}, fallback upload: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }

      if (!ref.url) {
        throw new Error(options.fileTypeNotAllowedMessage)
      }
      filesToUpload.push(await fileFromUrl(ref.url, ref.name, ref.mime_type))
    }

    if (filesToUpload.length > 0) {
      const uploaded = await useAttachmentStore.getState().startUpload({
        tableId,
        fieldId: normalizedFieldId,
        recordId,
        files: filesToUpload,
      })
      results.push(...uploaded)
    }

    return results
  }
}
