import { resolveRecordId } from '@tabtin/table-engine'
import { buildAttachmentUploadKey, type AttachmentTaskState } from '@/stores/useAttachmentStore'
import type { GridDisplayRow, GridDisplayRows } from './gridDisplayUtils'

const ATTACHMENT_FIELD_TYPES = new Set(['attachment'])
const ACTIVE_UPLOAD_STATUSES = new Set(['pending', 'uploading'])

export interface AttachmentLikeField {
  id: string
  name: string
  field_type?: string | null
}

export interface BuildUploadingAttachmentRowsParams {
  rows: GridDisplayRows
  selectedTableId: string | null
  fields: AttachmentLikeField[]
  tasks: Record<string, Pick<AttachmentTaskState, 'items'>>
  previewUrls: Record<string, string>
  draftRowId?: string
}

export interface BuildUploadingAttachmentRowsResult {
  rows: GridDisplayRows
  resolvedTaskKeys: string[]
}

const toAttachmentArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value
  }
  if (value == null) {
    return []
  }
  return [value]
}

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const pickString = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value !== 'string') {
      continue
    }
    const trimmed = value.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return undefined
}

const resolveAttachmentIdentity = (value: unknown, fallback?: string): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : fallback ?? null
  }

  if (!isRecordValue(value)) {
    return fallback ?? null
  }

  return (
    pickString(value, [
      'reference_id',
      'referenceId',
      'file_id',
      'fileId',
      'upload_item_id',
      'uploadItemId',
      'url',
      'download_url',
      'downloadUrl',
      'access_url',
      'accessUrl',
      'name',
      'file_name',
      'filename',
    ]) ?? fallback ?? null
  )
}

const buildExistingIdentitySet = (items: unknown[]): Set<string> => {
  const identities = new Set<string>()
  items.forEach((item, index) => {
    const identity = resolveAttachmentIdentity(item, `item-${index}`)
    if (identity) {
      identities.add(identity)
    }
  })
  return identities
}

const resolveRowRecordId = (
  row: GridDisplayRow,
  draftRowId?: string
): string | undefined => {
  const resolved = resolveRecordId(row) ?? undefined
  if (!resolved) {
    return undefined
  }

  if (draftRowId && resolved === draftRowId) {
    return undefined
  }

  return resolved
}

const buildPendingUploadValue = (
  taskItem: AttachmentTaskState['items'][number],
  previewUrl?: string
) => ({
  __uploading: true,
  upload_item_id: taskItem.uploadItemId,
  name: taskItem.file.name,
  file_name: taskItem.file.name,
  mime_type: taskItem.file.type || 'application/octet-stream',
  url: previewUrl ?? '',
  preview_url: previewUrl ?? '',
  upload_status: taskItem.status,
  upload_progress:
    Number.isFinite(taskItem.progress) && taskItem.progress >= 0
      ? Math.min(1, taskItem.progress)
      : 0,
})

export const buildUploadingAttachmentRows = ({
  rows,
  selectedTableId,
  fields,
  tasks,
  previewUrls,
  draftRowId,
}: BuildUploadingAttachmentRowsParams): BuildUploadingAttachmentRowsResult => {
  if (!selectedTableId || rows.length === 0 || fields.length === 0) {
    return { rows, resolvedTaskKeys: [] }
  }

  const attachmentFields = fields.filter((field) =>
    ATTACHMENT_FIELD_TYPES.has(String(field.field_type ?? '').toLowerCase())
  )
  if (attachmentFields.length === 0 || Object.keys(tasks).length === 0) {
    return { rows, resolvedTaskKeys: [] }
  }

  const resolvedTaskKeys = new Set<string>()

  const nextRows = rows.map((row) => {
    const recordId = resolveRowRecordId(row, draftRowId)
    const sourceRow = row as Record<string, unknown>
    let nextRow: Record<string, unknown> | null = null

    attachmentFields.forEach((field) => {
      const taskKey = buildAttachmentUploadKey(selectedTableId, field.id, recordId)
      const task = tasks[taskKey]
      if (!task || task.items.length === 0) {
        return
      }

      const currentItems = toAttachmentArray((nextRow ?? sourceRow)[field.name])
      const existingIdentities = buildExistingIdentitySet(currentItems)
      const overlayItems: unknown[] = []

      let canResolveTask = true

      task.items.forEach((item) => {
        if (ACTIVE_UPLOAD_STATUSES.has(item.status)) {
          overlayItems.push(
            buildPendingUploadValue(item, previewUrls[item.uploadItemId])
          )
          canResolveTask = false
          return
        }

        if (item.status === 'completed' && item.reference) {
          const identity = resolveAttachmentIdentity(item.reference, item.uploadItemId)
          if (!identity || !existingIdentities.has(identity)) {
            // 上传任务会先于 GridAttachmentEditor.emitChange 暴露 completed reference。
            // 标记这段仅用于展示的本地回流，避免编辑器把它误认成远端协作者更新；
            // 真实记录值同步后不会携带该标记，并会按下方 identity 逻辑清理任务。
            overlayItems.push({
              ...item.reference,
              __local_upload_overlay: true,
            })
            canResolveTask = false
            return
          }
          return
        }

        if (item.status !== 'error' && item.status !== 'cancelled') {
          canResolveTask = false
        }
      })

      if (overlayItems.length > 0) {
        if (!nextRow) {
          nextRow = { ...sourceRow }
        }
        nextRow[field.name] = [...currentItems, ...overlayItems]
      }

      if (canResolveTask) {
        resolvedTaskKeys.add(taskKey)
      }
    })

    return nextRow ?? row
  })

  return {
    rows: nextRows,
    resolvedTaskKeys: Array.from(resolvedTaskKeys),
  }
}
