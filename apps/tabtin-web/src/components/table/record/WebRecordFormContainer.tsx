/**
 * WebRecordFormContainer — Web 端记录表单容器
 *
 * 对齐 Electron 的 RecordFormContainer，连接 RecordFormDialog（@tabtin/smartsheet-ui）
 * 与 Web 端 Store 层。附件字段通过 WebAttachmentField 复用单元格附件 editor。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  CommentsSection,
  RecordFormDialog,
  toast,
  type AttachmentFieldRenderProps,
  type RecordFormData,
} from '@tabtin/smartsheet-ui'
import { MessageSquare } from 'lucide-react'
import { toFieldDefinitions, toWorkspaceMembers } from '@tabtin/table-ui'
import { useOrganizationStore } from '@tabtin/app-shell'
import { useAuthStore } from '@/stores/auth-store'
import { computeChangedRecordData, isOutOfBandManagedField } from '@tabtin/table-core'
import type { AttachmentReference, Field, Table } from '@tabtin/table-core'
import {
  useRecordComments,
  type SharedRecordCommentsAccess,
} from './useSharedRecordComments'

const WebAttachmentField = React.lazy(() =>
  import('@/components/table/attachments/WebAttachmentField').then((module) => ({
    default: module.WebAttachmentField,
  })),
)

export interface WebRecordFormContainerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'create' | 'edit'
  table: Table | null
  fields: Field[]
  record?: { id: string; data: Record<string, unknown> } | null
  editingRecordId?: string | null
  initialValues?: RecordFormData
  canNavigatePrev?: boolean
  canNavigateNext?: boolean
  isReadonly?: boolean
  modal?: boolean
  touchOptimized?: boolean
  /** 分享只读详情已带授权后附件数据，设为 false 可避免请求普通表格附件 API。 */
  loadAttachmentsFromTableApi?: boolean
  /** undefined uses the authenticated API; an access object uses the public-share API; null disables comments. */
  sharedRecordComments?: SharedRecordCommentsAccess | null
  initialCommentsOpen?: boolean
  targetCommentId?: string | null
  subscribeCommentChanges?: (onChange: () => void) => () => void
  onNavigatePrev?: () => void
  onNavigateNext?: () => void
  onSaved?: () => void
  onAttachmentFieldCommitted?: (payload: {
    recordId: string
    fieldId: string
    fieldName: string
    value: AttachmentReference[]
  }) => void
  createRecord: (req: { table_id: string; data: RecordFormData }) => Promise<unknown>
  updateRecord: (id: string, req: { data: RecordFormData }) => Promise<unknown>
  fetchRecord?: (recordId: string) => Promise<{ id: string; data: Record<string, unknown> } | null>
}

export const WebRecordFormContainer: React.FC<WebRecordFormContainerProps> = ({
  open,
  onOpenChange,
  mode,
  table,
  fields,
  record,
  editingRecordId,
  initialValues,
  canNavigatePrev = false,
  canNavigateNext = false,
  isReadonly = false,
  modal = false,
  touchOptimized = false,
  loadAttachmentsFromTableApi = true,
  sharedRecordComments,
  initialCommentsOpen = false,
  targetCommentId,
  subscribeCommentChanges,
  onNavigatePrev,
  onNavigateNext,
  onSaved,
  onAttachmentFieldCommitted,
  createRecord,
  updateRecord,
  fetchRecord,
}) => {
  const { t, i18n } = useTranslation('table')
  const wsMembers = useOrganizationStore((state) => state.members)
  const currentUserId = useAuthStore((state) => state.user?.id)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [fetchedRecord, setFetchedRecord] = React.useState<{ id: string; data: Record<string, unknown> } | null>(null)
  const [isFetching, setIsFetching] = React.useState(false)
  const [commentsVisible, setCommentsVisible] = React.useState(false)
  const saveOnExit = mode === 'edit' && !isReadonly

  const isPendingNavigation = editingRecordId?.startsWith('__pending_') ?? false

  React.useEffect(() => {
    if (!open || mode !== 'edit' || !editingRecordId || !fetchRecord || isPendingNavigation) {
      if (!isPendingNavigation) setFetchedRecord(null)
      return
    }
    if (record) {
      setFetchedRecord(null)
      return
    }
    let cancelled = false
    setIsFetching(true)
    fetchRecord(editingRecordId).then(r => {
      if (!cancelled) {
        setFetchedRecord(r)
        setIsFetching(false)
        if (!r) {
          toast({
            variant: 'destructive',
            title: t('record.errors.recordNotFound', { defaultValue: 'Record does not exist or has been deleted' }),
          })
          onOpenChange(false)
        }
      }
    }).catch(() => {
      if (!cancelled) {
        setFetchedRecord(null)
        setIsFetching(false)
        toast({
          variant: 'destructive',
          title: t('record.errors.fetchFailed', { defaultValue: 'Failed to load record, please retry' }),
        })
        onOpenChange(false)
      }
    })
    return () => { cancelled = true }
  }, [open, mode, editingRecordId, record, fetchRecord, isPendingNavigation, onOpenChange, t])

  const resolvedRecord = record ?? fetchedRecord
  const commentsEnabled = Boolean(
    open && mode === 'edit' && resolvedRecord?.id && sharedRecordComments !== null,
  )
  const recordComments = useRecordComments({
    access: sharedRecordComments ?? undefined,
    recordId: resolvedRecord?.id,
    enabled: commentsEnabled,
    targetCommentId,
    subscribe: subscribeCommentChanges,
  })

  React.useEffect(() => {
    setCommentsVisible(commentsEnabled && initialCommentsOpen)
  }, [commentsEnabled, initialCommentsOpen, resolvedRecord?.id])

  const fieldDefinitions = React.useMemo(() => toFieldDefinitions(fields), [fields])

  const outOfBandFieldNames = React.useMemo(
    () => fields.filter((f) => isOutOfBandManagedField(f)).map((f) => f.name),
    [fields],
  )

  const workspaceMembers = React.useMemo(() => toWorkspaceMembers(wsMembers), [wsMembers])

  const handleRenderAttachmentField = React.useCallback(
    ({
      field,
      value,
      onChange,
      recordId,
      disabled,
    }: AttachmentFieldRenderProps) => {
      if (!table) return null
      const attachmentValue = normalizeAttachmentValue(value)

      const resolvedRecordId = recordId ?? resolvedRecord?.id

      const handleAttachmentChange = (next: AttachmentReference[]) => {
        const normalized = next.map((item) => ({
          reference_id: item.reference_id,
          file_id: item.file_id,
          table_id: item.table_id,
          field_id: item.field_id,
          record_id: item.record_id,
          name: item.name,
          url: item.url,
          size: item.size,
          mime_type: item.mime_type,
          thumbnail_url: item.thumbnail_url,
          smThumbnailUrl: item.smThumbnailUrl,
          lgThumbnailUrl: item.lgThumbnailUrl,
          preview_url: item.preview_url,
        }))

        onChange(normalized)
      }

      const handleAttachmentCommitted = (next: AttachmentReference[]) => {
        if (!resolvedRecordId) return
        onAttachmentFieldCommitted?.({
          recordId: resolvedRecordId,
          fieldId: field.id,
          fieldName: field.name,
          value: next,
        })
      }

      return (
        <React.Suspense
          fallback={
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-body text-muted-foreground">
              {t('record.loading', { defaultValue: 'Loading...' })}
            </div>
          }
        >
          <WebAttachmentField
            field={field}
            tableId={table.id}
            recordId={resolvedRecordId}
            value={attachmentValue}
            onChange={handleAttachmentChange}
            disabled={disabled}
            busy={isSubmitting}
            onCommitted={handleAttachmentCommitted}
          />
        </React.Suspense>
      )
    },
    [isSubmitting, onAttachmentFieldCommitted, resolvedRecord?.id, table, t],
  )

  const initialData: RecordFormData = React.useMemo(() => {
    if (mode === 'edit' && resolvedRecord) {
      return resolvedRecord.data
    }
    if (mode === 'create' && initialValues) {
      return initialValues
    }
    return {}
  }, [mode, resolvedRecord, initialValues])

  const handleSubmit = React.useCallback(
    async (data: RecordFormData) => {
      if (!table) return

      if (mode === 'edit' && !resolvedRecord) {
        toast({
          variant: 'destructive',
          title: t('record.errors.recordNotFound', { defaultValue: 'Record does not exist or has been deleted' }),
        })
        onOpenChange(false)
        return
      }

      setIsSubmitting(true)
      try {
        if (mode === 'create') {
          await createRecord({ table_id: table.id, data })
        } else if (mode === 'edit' && resolvedRecord) {
          // 仅提交用户实际改动的字段：formData 携带整条记录（含系统托管字段），
          // 整条回传会被后端 bulk_update 因系统字段而整条拒绝。带外管理字段（附件/
          // 多媒体）经各自 API 即时落库、懒加载回填，不参与 diff（详见 computeChangedRecordData）。
          const changed = computeChangedRecordData(data, initialData, {
            ignoreKeys: outOfBandFieldNames,
          })
          if (Object.keys(changed).length === 0) {
            if (!saveOnExit) {
              onOpenChange(false)
              onSaved?.()
            }
            return
          }
          await updateRecord(resolvedRecord.id, { data: changed })
        }
        if (!saveOnExit) {
          onOpenChange(false)
        }
        onSaved?.()
      } catch (error) {
        console.error('[WebRecordFormContainer] submit failed:', error)
        toast({
          variant: 'destructive',
          title: mode === 'create'
            ? t('record.errors.createFailed', { defaultValue: 'Failed to create record' })
            : t('record.errors.updateFailed', { defaultValue: 'Failed to update record' }),
          description: error instanceof Error ? error.message : undefined,
        })
      } finally {
        setIsSubmitting(false)
      }
    },
    [table, mode, resolvedRecord, initialData, outOfBandFieldNames, createRecord, updateRecord, onOpenChange, onSaved, saveOnExit, t],
  )

  React.useEffect(() => {
    if (open && mode === 'edit' && !resolvedRecord && !isFetching && !isPendingNavigation) {
      if (fetchRecord && editingRecordId) return
      onOpenChange(false)
    }
  }, [open, mode, resolvedRecord, isFetching, isPendingNavigation, fetchRecord, editingRecordId, onOpenChange])

  if (!table) return null
  if (mode === 'edit' && !resolvedRecord && !isFetching && !isPendingNavigation) return null

  return (
    <RecordFormDialog
      open={open}
      onOpenChange={onOpenChange}
      fields={fieldDefinitions}
      initialData={initialData}
      mode={mode}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      isReadonly={isReadonly}
      saveOnExit={saveOnExit}
      modal={modal}
      touchOptimized={touchOptimized}
      title={
        mode === 'create'
          ? t('record.dialog.createTitle', { defaultValue: 'New record' })
          : isReadonly
            ? t('record.dialog.viewTitle', { defaultValue: 'Record details' })
          : t('record.dialog.editTitle', { defaultValue: 'Edit record' })
      }
      description={
        mode === 'create'
          ? t('record.dialog.createDescription', { defaultValue: 'Fill in field information to create a new record' })
          : isReadonly
            ? t('record.dialog.viewDescription', { defaultValue: 'View record fields and comments' })
          : t('record.dialog.editDescription', { defaultValue: 'Edit field values and save' })
      }
      tableId={table.id}
      recordId={resolvedRecord?.id}
      renderAttachmentField={loadAttachmentsFromTableApi ? handleRenderAttachmentField : undefined}
      canNavigatePrev={canNavigatePrev}
      canNavigateNext={canNavigateNext}
      onNavigatePrev={onNavigatePrev}
      onNavigateNext={onNavigateNext}
      headerActions={
        commentsEnabled ? (
          <Button
            type="button"
            variant={commentsVisible ? 'secondary' : 'ghost'}
            size="sm"
            className="shrink-0 gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => setCommentsVisible((visible) => !visible)}
            aria-pressed={commentsVisible}
            aria-label={t('record.comments.toggle', { defaultValue: '打开评论' })}
          >
            <MessageSquare className="h-4 w-4" />
            <span className="hidden text-body sm:inline">
              {recordComments.total > 0
                ? t('record.comments.titleWithCount', {
                    defaultValue: '评论 ({{count}})',
                    count: recordComments.total,
                  })
                : t('record.comments.title', { defaultValue: '评论' })}
            </span>
          </Button>
        ) : null
      }
      secondaryPanelOpen={commentsVisible}
      secondaryPanel={
        commentsEnabled ? (
          <CommentsSection
            layout="side-panel"
            comments={recordComments.comments}
            total={recordComments.total}
            value={recordComments.draft}
            onValueChange={recordComments.setDraft}
            onSubmit={recordComments.submit}
            mentionCandidates={recordComments.mentionCandidates}
            onMentionSearch={recordComments.searchMentionCandidates}
            currentUserId={currentUserId}
            deletingCommentIds={recordComments.deletingCommentIds}
            onDeleteComment={recordComments.deleteComment}
            onRetry={recordComments.retry}
            isLoading={recordComments.loading}
            isSubmitting={recordComments.submitting}
            error={recordComments.error}
            hasMore={recordComments.hasMore}
            isLoadingMore={recordComments.loadingMore}
            onLoadMore={recordComments.loadMore}
            highlightedCommentId={targetCommentId}
            locale={i18n.language}
            labels={{
              title: t('record.comments.title', { defaultValue: '评论' }),
              placeholder: t('record.comments.placeholder', {
                defaultValue: '添加评论，输入 @ 提及成员',
              }),
              submit: t('record.comments.submit', { defaultValue: '发送评论' }),
              deleteComment: t('record.comments.delete', { defaultValue: '删除' }),
              deletingComment: t('record.comments.deleting', { defaultValue: '正在删除...' }),
              retry: t('record.comments.retry', { defaultValue: '重试' }),
              loading: t('record.comments.loading', { defaultValue: '正在加载评论...' }),
              noMentionResults: t('record.comments.noMentionResults', {
                defaultValue: '没有匹配的成员',
              }),
              loadMore: t('record.comments.loadMore', { defaultValue: '加载更多评论' }),
              loadingMore: t('record.comments.loadingMore', { defaultValue: '正在加载...' }),
            }}
          />
        ) : null
      }
      organizationMembers={workspaceMembers}
      currentUserId={currentUserId}
    />
  )
}

const normalizeAttachmentValue = (value: AttachmentFieldRenderProps['value']): AttachmentReference[] =>
  (value ?? []).flatMap((item) => {
    const referenceId = item.reference_id ?? item.file_id ?? item.url
    if (!referenceId) return []
    return [{
      reference_id: referenceId,
      file_id: item.file_id ?? referenceId,
      table_id: item.table_id,
      field_id: item.field_id,
      record_id: item.record_id,
      name: item.name ?? item.file_id ?? referenceId,
      url: item.url,
      size: item.size,
      mime_type: item.mime_type,
      thumbnail_url: item.thumbnail_url,
      smThumbnailUrl: item.smThumbnailUrl,
      lgThumbnailUrl: item.lgThumbnailUrl,
      preview_url: item.preview_url,
    }]
  })
