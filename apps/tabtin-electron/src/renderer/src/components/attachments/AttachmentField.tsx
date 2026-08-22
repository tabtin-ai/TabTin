import React from 'react'
import { StatusNotice, toast } from '@tabtin/smartsheet-ui'
import type { FieldDefinition } from '@tabtin/smartsheet-ui'
import { GridAttachmentInlineEditor } from '@tabtin/table-engine-canvas'
import type {
  TableGridAttachmentDownloadItem,
  TableGridAttachmentUploadHandler,
  TableGridAttachmentUploadProgressItem,
  TableGridRow,
} from '@tabtin/table-engine'
import {
  buildAttachmentKeyCounts,
  consumeAttachmentKeyCount,
  enrichAttachmentReferences,
  filterCurrentFieldAttachments,
  findUniqueAttachmentNameMatch,
  normalizeAttachmentReferences,
} from '@tabtin/table-ui'
import { AttachmentApiService, type AttachmentReference } from '@tabtin/table-core'
import { useTranslation } from 'react-i18next'
import {
  useAttachmentStore,
  buildAttachmentUploadKey,
} from '@/stores/useAttachmentStore'
import { validateUploadFile } from '@/constants/upload'
import { createAttachmentFileRefHandler } from './attachmentFileRef'
import {
  downloadTabDataAttachment,
  downloadTabDataAttachmentsBatch,
} from './downloadTabDataAttachments'
import { loadElectronAttachmentPreviewUi } from './electronAttachmentPreviewUi'

interface AttachmentFieldProps {
  field: FieldDefinition
  tableId: string
  recordId?: string
  value: AttachmentReference[]
  onChange: (value: AttachmentReference[]) => void
  disabled?: boolean
  busy?: boolean
}

export const AttachmentField: React.FC<AttachmentFieldProps> = ({
  field,
  tableId,
  recordId,
  value,
  onChange,
  disabled = false,
  busy = false,
}) => {
  const { t } = useTranslation('attachments')
  const { t: tChat } = useTranslation('chat')
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const [isFetching, setIsFetching] = React.useState(false)
  const [isRemoving, setIsRemoving] = React.useState(false)
  const hasFetchedRef = React.useRef(false)
  const fieldValue = React.useMemo(
    () => filterCurrentFieldAttachments(value ?? [], field.id),
    [field.id, value],
  )

  // 创建抽屉无落库 recordId：REST 省略 record_id；本地进度 key 用稳定草稿身份。
  const taskRecordId = recordId ?? '__draft_record__'
  const uploadKey = React.useMemo(
    () => buildAttachmentUploadKey(tableId, field.id, taskRecordId),
    [tableId, field.id, taskRecordId]
  )

  const startUpload = useAttachmentStore(state => state.startUpload)
  const removeTask = useAttachmentStore(state => state.removeTask)
  const resolveRemovalReferenceIds = React.useCallback(
    async (removed: AttachmentReference[]): Promise<string[]> => {
      // 草稿上传得到的 orphan reference：直接用本地 reference_id 删除，无需查记录附件列表。
      if (!recordId) {
        return removed.flatMap((attachment) => {
          const referenceId = attachment.reference_id
          return referenceId ? [referenceId] : []
        })
      }

      let authoritativeFieldAttachments: AttachmentReference[]
      try {
        const attachments = await AttachmentApiService.getRecordAttachments(recordId)
        authoritativeFieldAttachments = attachments.filter(attachment => attachment.field_id === field.id)
      } catch (error) {
        console.warn('获取附件列表以解析删除引用失败:', error)
        throw error
      }

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

        if (!matched) {
          return []
        }
        usedReferenceIds.add(matched.reference_id)
        return [matched.reference_id]
      })
    },
    [field.id, recordId],
  )

  React.useEffect(() => {
    if (!recordId || hasFetchedRef.current) {
      return
    }
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
        console.error('获取附件列表失败:', error)
        setErrorMessage(error instanceof Error ? error.message : t('errors.fetchFailed'))
      })
      .finally(() => setIsFetching(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId]) // 只依赖 recordId，避免 value/onChange 导致无限循环

  const validateFiles = React.useCallback((files: File[]) => {
    const validFiles: File[] = []
    const rejected: Array<{ name: string; reason: string }> = []

    for (const file of files) {
      const result = validateUploadFile(file, 'ATTACHMENT')
      if (!result.valid) {
        const reason = result.reason?.startsWith('fileTooLarge:')
          ? t('errors.fileTooLarge', { limit: result.reason.split(':')[1], defaultValue: '超过 {{limit}}MB 大小限制' })
          : t('errors.fileTypeNotAllowed', { defaultValue: '不支持的文件类型' })
        rejected.push({ name: file.name, reason })
      } else {
        validFiles.push(file)
      }
    }

    if (rejected.length > 0) {
      const summary = rejected.length === 1
        ? t('errors.fileRejectedSingle', {
            name: rejected[0].name,
            reason: rejected[0].reason,
            defaultValue: '文件 {{name}} 被跳过：{{reason}}',
          })
        : t('errors.fileRejectedMultiple', {
            count: rejected.length,
            defaultValue: '{{count}} 个文件被跳过',
          })
      const description = rejected.length > 1
        ? rejected.map(r => `${r.name}：${r.reason}`).join('\n')
        : undefined
      toast.warning(summary, description ? { description } : undefined)
    }

    return validFiles
  }, [t])

  const mapUploadItems = React.useCallback(
    (items: Array<{
      uploadItemId: string
      file: File
      status: TableGridAttachmentUploadProgressItem['status']
      progress: number
      error?: string
    }>): TableGridAttachmentUploadProgressItem[] =>
      items.map((item) => ({
        uploadItemId: item.uploadItemId,
        file: item.file,
        fileName: item.file.name,
        status: item.status,
        progress:
          Number.isFinite(item.progress) && item.progress >= 0
            ? Math.min(1, item.progress)
            : 0,
        error: item.error,
      })),
    [],
  )

  const handleAttachmentUpload = React.useCallback<TableGridAttachmentUploadHandler<TableGridRow>>(
    async ({ files, onProgress }) => {
      const validFiles = validateFiles(files ?? [])
      if (validFiles.length === 0) {
        return []
      }

      setErrorMessage(null)
      const unsubscribe =
        typeof onProgress === 'function'
          ? useAttachmentStore.subscribe((state) => {
              const taskItems = state.tasks[uploadKey]?.items ?? []
              onProgress(mapUploadItems(taskItems))
            })
          : null

      try {
        // 无落库 recordId 时省略 REST record_id（后端允许 orphan）；task key 用草稿身份。
        const references = await startUpload({
          tableId,
          fieldId: field.id,
          recordId: recordId || undefined,
          taskRecordId,
          files: validFiles,
          onRetrySuccess: (retryReferences) => {
            onChange([...fieldValue, ...retryReferences])
          },
        })

        const latestUploads = useAttachmentStore.getState().tasks[uploadKey]?.items ?? []
        if (typeof onProgress === 'function') {
          onProgress(mapUploadItems(latestUploads))
        }
        return references
      } catch (error) {
        console.error('附件上传失败:', error)
        setErrorMessage(error instanceof Error ? error.message : t('errors.uploadFailed'))
        removeTask(uploadKey)
        throw error
      } finally {
        unsubscribe?.()
      }
    },
    [field.id, fieldValue, mapUploadItems, onChange, recordId, removeTask, startUpload, t, tableId, taskRecordId, uploadKey, validateFiles],
  )

  const handleAttachmentFileRef = React.useMemo(
    () =>
      createAttachmentFileRefHandler({
        tableId,
        resolveFieldId: () => field.id,
        resolveRecordId: () => recordId,
        missingTableMessage: t('errors.uploadFailed'),
        missingFieldMessage: t('errors.uploadFailed'),
        missingRecordMessage: t('tips.saveBeforeUpload'),
        fileTypeNotAllowedMessage: t('errors.fileTypeNotAllowed', {
          defaultValue: '不支持的文件类型',
        }),
      }),
    [field.id, recordId, t, tableId],
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
        resolveRemovalReferenceIds(removed).then((referenceIds) =>
          Promise.all(referenceIds.map((referenceId) => AttachmentApiService.removeReference(referenceId))),
        ).catch((error) => {
          console.error('删除附件失败:', error)
          setErrorMessage(error instanceof Error ? error.message : t('errors.removeFailed'))
          onChange(previous)
        }).finally(() => {
          setIsRemoving(false)
        })
        return
      }

      onChange(next)
    },
    [fieldValue, onChange, resolveRemovalReferenceIds, t],
  )

  const editorDisabled = disabled || busy || isRemoving
  const canUpload = !editorDisabled
  const handleDownloadAttachment = React.useCallback(
    (item: TableGridAttachmentDownloadItem) => downloadTabDataAttachment(item, tChat, {
      tableId,
      fieldId: field.id,
      recordId,
    }),
    [field.id, recordId, tChat, tableId],
  )
  const handleDownloadAllAttachments = React.useCallback(
    (items: TableGridAttachmentDownloadItem[]) =>
      downloadTabDataAttachmentsBatch(items, tChat, {
        tableId,
        fieldId: field.id,
        recordId,
      }),
    [field.id, recordId, tChat, tableId],
  )
  const loadAttachmentPreviewUi = React.useCallback(
    () => loadElectronAttachmentPreviewUi({
      tableId,
      fieldId: field.id,
      recordId,
    }),
    [field.id, recordId, tableId],
  )

  return (
    <div className="space-y-3">
      {isFetching ? (
        <p className="text-body text-muted-foreground">{t('tips.syncing')}</p>
      ) : null}

      <GridAttachmentInlineEditor
        rowData={{ id: taskRecordId, row_id: taskRecordId }}
        field={field.name}
        fieldId={field.id}
        rawValue={fieldValue}
        onChange={handleValueChange}
        onAttachmentUpload={canUpload ? handleAttachmentUpload : undefined}
        // file-ref / reuse 仍要求已落库 record（API 不对称）；无 recordId 时不挂 handler。
        onAttachmentFileRef={canUpload && recordId ? handleAttachmentFileRef : undefined}
        onDownloadAttachment={handleDownloadAttachment}
        onDownloadAllAttachments={handleDownloadAllAttachments}
        loadPreviewUi={loadAttachmentPreviewUi}
        disabled={editorDisabled}
        fileTypeErrorMessage={t('errors.fileTypeNotAllowed', { defaultValue: '不支持的文件类型' })}
        disableRemove={disabled || isRemoving}
        labels={{
          attachmentUpload: t('actions.upload'),
          attachmentUploading: t('actions.uploading'),
          attachmentUploadHint: t('tips.uploadDropHint', { defaultValue: '点击、粘贴或拖拽文件到这里' }),
          attachmentEmpty: t('labels.empty', { defaultValue: '暂无附件' }),
          attachmentDownloadAll: t('actions.downloadAll', { defaultValue: '全部下载' }),
          attachmentRemove: t('actions.remove'),
          attachmentFileTypeNotAllowed: t('errors.fileTypeNotAllowed', { defaultValue: '不支持的文件类型' }),
        }}
        className="min-h-[260px]"
      />

      {errorMessage ? <StatusNotice tone="danger" size="sm" description={errorMessage} /> : null}
    </div>
  )
}
