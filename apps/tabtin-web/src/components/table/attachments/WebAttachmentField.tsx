import React from 'react'
import { useTranslation } from 'react-i18next'
import { StatusNotice, type FieldDefinition } from '@tabtin/smartsheet-ui'
import { GridAttachmentInlineEditor } from '@tabtin/table-engine-canvas'
import type {
  TableGridAttachmentUploadHandler,
  TableGridAttachmentUploadProgressItem,
  TableGridRow,
} from '@tabtin/table-engine'
import {
  AttachmentApiService,
  type AttachmentReference,
  type AttachmentUploadFileOut,
} from '@tabtin/table-core'
import {
  buildAttachmentKeyCounts,
  consumeAttachmentKeyCount,
  enrichAttachmentReferences,
  filterCurrentFieldAttachments,
  findUniqueAttachmentNameMatch,
  normalizeAttachmentReferences,
} from '@tabtin/table-ui'

interface WebAttachmentFieldProps {
  field: FieldDefinition
  tableId: string
  recordId?: string
  value: AttachmentReference[]
  onChange: (value: AttachmentReference[]) => void
  disabled?: boolean
  busy?: boolean
  onCommitted?: (value: AttachmentReference[]) => void
}

interface UploadProgressState {
  uploadItemId: string
  file: File
  fileName: string
  status: TableGridAttachmentUploadProgressItem['status']
  progress: number
  error?: string
}

export const WebAttachmentField: React.FC<WebAttachmentFieldProps> = ({
  field,
  tableId,
  recordId,
  value,
  onChange,
  disabled = false,
  busy = false,
  onCommitted,
}) => {
  const { t } = useTranslation('table')
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [isFetching, setIsFetching] = React.useState(false)
  const [isRemoving, setIsRemoving] = React.useState(false)
  const hasFetchedRef = React.useRef(false)
  const fieldValue = React.useMemo(
    () => filterCurrentFieldAttachments(value ?? [], field.id),
    [field.id, value],
  )

  const resolveRemovalReferenceIds = React.useCallback(
    async (removed: AttachmentReference[]): Promise<string[]> => {
      // 草稿 orphan：直接用本地 reference_id 删除。
      if (!recordId) {
        return removed.flatMap((attachment) => {
          const referenceId = attachment.reference_id
          return referenceId ? [referenceId] : []
        })
      }

      const attachments = await AttachmentApiService.getRecordAttachments(recordId)
      const authoritativeFieldAttachments = attachments.filter(attachment => attachment.field_id === field.id)
      const usedReferenceIds = new Set<string>()
      const activeByReferenceId = new Map(
        authoritativeFieldAttachments.map((attachment) => [attachment.reference_id, attachment]),
      )

      return removed.flatMap((attachment) => {
        const directReferenceId = attachment.reference_id
        if (directReferenceId && activeByReferenceId.has(directReferenceId)) {
          usedReferenceIds.add(directReferenceId)
          return [directReferenceId]
        }

        const candidates = authoritativeFieldAttachments.filter(
          (candidate) => !usedReferenceIds.has(candidate.reference_id),
        )
        const matched =
          (attachment.file_id
            ? candidates.find((candidate) => candidate.file_id === attachment.file_id)
            : undefined) ??
          (attachment.url
            ? candidates.find((candidate) => candidate.url === attachment.url)
            : undefined) ??
          findUniqueAttachmentNameMatch(candidates, attachment.name)

        if (!matched) return []
        usedReferenceIds.add(matched.reference_id)
        return [matched.reference_id]
      })
    },
    [field.id, recordId],
  )

  React.useEffect(() => {
    if (!recordId || hasFetchedRef.current) return
    hasFetchedRef.current = true
    setIsFetching(true)
    AttachmentApiService.getRecordAttachments(recordId)
      .then((attachments) => {
        const fieldAttachments = attachments.filter(attachment => attachment.field_id === field.id)
        const enriched = enrichAttachmentReferences(fieldValue, fieldAttachments)
        if (enriched.some((item, index) => item !== fieldValue[index])) {
          onChange(enriched)
        }
      })
      .catch(error => {
        console.error('[WebAttachmentField] fetch attachments failed:', error)
        setErrorMessage(error instanceof Error ? error.message : t('attachments.errors.fetchFailed', { defaultValue: '获取附件列表失败' }))
      })
      .finally(() => setIsFetching(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId])

  const mapProgressItems = React.useCallback(
    (items: UploadProgressState[]): TableGridAttachmentUploadProgressItem[] =>
      items.map((item) => ({
        uploadItemId: item.uploadItemId,
        file: item.file,
        fileName: item.fileName,
        status: item.status,
        progress: item.progress,
        error: item.error,
      })),
    [],
  )

  const handleAttachmentUpload = React.useCallback<TableGridAttachmentUploadHandler<TableGridRow>>(
    async ({ files, onProgress }) => {
      const validFiles = files ?? []
      if (validFiles.length === 0) return []

      setErrorMessage(null)
      const uploadFiles = prepareUploadFiles(validFiles)
      // 无落库 recordId 时省略 record_id，后端建 orphan，创建记录时 sync 认领。
      const taskResponse = await AttachmentApiService.createUploadTask({
        table_id: tableId,
        field_id: field.id,
        ...(recordId ? { record_id: recordId } : {}),
        files: uploadFiles.map(({ metadata }) => metadata),
      })

      const responseFilesMap = new Map<string, AttachmentUploadFileOut>()
      taskResponse.files.forEach(file => responseFilesMap.set(file.file_name, file))

      const progressItems: UploadProgressState[] = uploadFiles.map(({ file, metadata }) => {
        const responseFile = responseFilesMap.get(metadata.file_name)
        if (!responseFile) {
          throw new Error(t('attachments.apiErrors.uploadTaskMissingItem', {
            defaultValue: '上传任务缺少文件 {{name}}',
            name: metadata.file_name,
          }))
        }
        return {
          uploadItemId: responseFile.upload_item_id,
          file,
          fileName: metadata.file_name,
          status: 'pending',
          progress: 0,
        }
      })

      const emitProgress = () => onProgress?.(mapProgressItems(progressItems))
      emitProgress()

      const references: AttachmentReference[] = []
      try {
        for (let index = 0; index < uploadFiles.length; index += 1) {
          const upload = uploadFiles[index]
          const responseFile = responseFilesMap.get(upload.metadata.file_name)
          const progressItem = progressItems[index]
          if (!responseFile) continue

          progressItem.status = 'uploading'
          emitProgress()

          const totalParts = Math.max(1, responseFile.total_parts)
          const chunkSize = responseFile.chunk_size || upload.file.size
          for (let partIndex = 0; partIndex < totalParts; partIndex += 1) {
            const partNumber = partIndex + 1
            const start = partIndex * chunkSize
            const end = Math.min(upload.file.size, start + chunkSize)
            const chunk = upload.file.slice(start, end)
            const presignedUrl = getPartPresignedUrl(responseFile, partNumber)

            await AttachmentApiService.uploadPart(
              taskResponse.task_id,
              responseFile.upload_item_id,
              partNumber,
              chunk,
              {
                presignedUrl,
                contentType: upload.file.type || 'application/octet-stream',
              },
            )

            progressItem.progress = Math.min(1, partNumber / totalParts)
            emitProgress()
          }

          const completed = await AttachmentApiService.completeUpload(
            taskResponse.task_id,
            responseFile.upload_item_id,
          )
          progressItem.status = 'completed'
          progressItem.progress = 1
          emitProgress()
          references.push(completed.reference)
        }

        return references
      } catch (error) {
        progressItems.forEach(item => {
          if (item.status !== 'completed') {
            item.status = 'error'
            item.error = error instanceof Error ? error.message : String(error)
          }
        })
        emitProgress()
        console.error('[WebAttachmentField] upload failed:', error)
        setErrorMessage(error instanceof Error ? error.message : t('attachments.errors.uploadFailed', { defaultValue: '附件上传失败' }))
        throw error
      }
    },
    [field.id, mapProgressItems, recordId, t, tableId],
  )

  const handleValueChange = React.useCallback(
    (nextValue: unknown) => {
      const next = normalizeAttachmentReferences(nextValue)
      const nextKeyCounts = buildAttachmentKeyCounts(next)
      const removed = fieldValue.filter((item, index) => !consumeAttachmentKeyCount(nextKeyCounts, item, index))

      if (removed.length > 0) {
        const previous = [...fieldValue]
        onChange(next)
        setIsRemoving(true)
        resolveRemovalReferenceIds(removed)
          .then((referenceIds) =>
            Promise.all(referenceIds.map((referenceId) => AttachmentApiService.removeReference(referenceId))),
          )
          .then(() => onCommitted?.(next))
          .catch((error) => {
            console.error('[WebAttachmentField] remove attachment failed:', error)
            setErrorMessage(error instanceof Error ? error.message : t('attachments.errors.removeFailed', { defaultValue: '删除附件失败' }))
            onChange(previous)
          })
          .finally(() => setIsRemoving(false))
        return
      }

      onChange(next)
      onCommitted?.(next)
    },
    [fieldValue, onChange, onCommitted, resolveRemovalReferenceIds, t],
  )

  const editorDisabled = disabled || busy || isRemoving
  const canUpload = !editorDisabled
  const taskRecordId = recordId ?? '__draft_record__'

  return (
    <div className="space-y-3">
      {isFetching ? (
        <p className="text-body text-muted-foreground">
          {t('attachments.tips.syncing', { defaultValue: '正在同步附件...' })}
        </p>
      ) : null}

      <GridAttachmentInlineEditor
        rowData={{ id: taskRecordId, row_id: taskRecordId }}
        field={field.name}
        fieldId={field.id}
        rawValue={fieldValue}
        onChange={handleValueChange}
        onAttachmentUpload={canUpload ? handleAttachmentUpload : undefined}
        disabled={editorDisabled}
        fileTypeErrorMessage={t('attachments.errors.fileTypeNotAllowed', { defaultValue: '不支持的文件类型' })}
        disableRemove={disabled || isRemoving}
        labels={{
          attachmentUpload: t('attachments.actions.upload', { defaultValue: '上传附件' }),
          attachmentUploading: t('attachments.actions.uploading', { defaultValue: '上传中...' }),
          attachmentUploadHint: t('attachments.tips.uploadDropHint', { defaultValue: '点击、粘贴或拖拽文件到这里' }),
          attachmentEmpty: t('attachments.labels.empty', { defaultValue: '暂无附件' }),
          attachmentDownloadAll: t('attachments.actions.downloadAll', { defaultValue: '全部下载' }),
          attachmentRemove: t('attachments.actions.remove', { defaultValue: '删除' }),
          attachmentFileTypeNotAllowed: t('attachments.errors.fileTypeNotAllowed', { defaultValue: '不支持的文件类型' }),
        }}
        className="min-h-[260px]"
      />

      {errorMessage ? <StatusNotice tone="danger" size="sm" description={errorMessage} /> : null}
    </div>
  )
}

const prepareUploadFiles = (files: File[]) => {
  const seenNames = new Map<string, number>()
  const deduplicateName = (name: string): string => {
    const count = seenNames.get(name) ?? 0
    seenNames.set(name, count + 1)
    if (count === 0) return name
    const dotIndex = name.lastIndexOf('.')
    return dotIndex > 0
      ? `${name.slice(0, dotIndex)}_${count}${name.slice(dotIndex)}`
      : `${name}_${count}`
  }

  return files.map(file => ({
    file,
    metadata: {
      file_name: deduplicateName(file.name || `file_${Date.now()}`),
      file_size: file.size,
      mime_type: file.type || 'application/octet-stream',
      chunk_size: AttachmentApiService.resolveChunkSize(file.size),
      is_public: false,
    },
  }))
}

const getPartPresignedUrl = (file: AttachmentUploadFileOut, partNumber: number): string | undefined => {
  const record = file as AttachmentUploadFileOut & {
    part_presigned_urls?: Record<string, string>
    direct_upload?: boolean
  }
  if (!record.direct_upload) return undefined
  return record.part_presigned_urls?.[String(partNumber)]
}
