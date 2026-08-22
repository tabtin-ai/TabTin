/**
 * LinkedRecordFormHost — 跨表关联记录详情宿主
 *
 * 按 foreignTableId + recordId 拉取目标表字段与记录，复用 RecordFormDialog
 * 侧栏展示，不切换全局 selectedTable。
 * 产品口径：从关联 chip /「打开完整详情」进入时默认只读查看，
 * 不在此宿主内跨表保存编辑。递归打开限制为单层：本宿主内不再打开另一层跨表详情。
 */

import React from 'react'
import {
  RecordFormDialog,
  useToast,
  type RecordFormData,
  type FieldDefinition,
} from '@tabtin/smartsheet-ui'
import { toFieldDefinitions } from '@tabtin/table-ui'
import {
  FieldApiService,
  RecordApiService,
  TableApiService,
  computeChangedRecordData,
} from '@tabtin/table-core'
import type { Field, TableRecord } from '@tabtin/table-core'
import { LinkCellEditor } from '@/components/field/LinkCellEditor'
import { useTranslation } from 'react-i18next'
import {
  announceTableDrawerOpen,
  useCloseOnOtherTableDrawerOpen,
} from '@/components/table/utils/tableDrawerCoordinator'
import {
  useOptionalSpaceContextActions,
  useOptionalSpaceContextState,
} from '@/components/context-space/SpaceContextAreaContext'
import { resolveForegroundTabScopeKey } from '@/components/chat/subagent/openSubagentTab'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useTableStore } from '@/stores/useTableStore'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('LinkedRecordFormHost')

export interface LinkedRecordFormHostProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  foreignTableId: string
  recordId: string
  titleHint?: string
  /**
   * 关联入口默认只读。仅在明确需要跨表编辑时才传 false
   * （当前产品不开放该路径，见 ）。
   */
  isReadonly?: boolean
  onSaved?: () => void
  /**
   * 为 false 时不参与表抽屉互斥（从记录表单内再开关联详情时使用，
   * 避免关掉父级「编辑记录」侧栏）。
   */
  coordinateDrawers?: boolean
}

interface LinkEditorModalState {
  fieldId: string
  fieldName: string
  fieldConfig: {
    foreignTableId: string
    relationship: string
    lookupFieldId?: string
    isOneWay?: boolean
    visibleFieldIds?: string[]
    filterByViewId?: string
  }
  currentValue: Array<{ id: string; title?: string }>
}

export const LinkedRecordFormHost: React.FC<LinkedRecordFormHostProps> = ({
  open,
  onOpenChange,
  foreignTableId,
  recordId,
  titleHint,
  isReadonly = true,
  onSaved,
  coordinateDrawers = true,
}) => {
  const { t } = useTranslation('record')
  const drawerId = React.useId()
  const { toast } = useToast()
  const spaceId = useSpaceStore((s) => s.selectedSpace?.id)
  const storeTables = useTableStore((s) => s.tables)
  const openTableTab = useSpaceContextTabsStore((s) => s.openTableTab)
  const spaceContext = useOptionalSpaceContextState()
  const spaceActions = useOptionalSpaceContextActions()

  const [loading, setLoading] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [fields, setFields] = React.useState<Field[]>([])
  const [record, setRecord] = React.useState<TableRecord | null>(null)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [linkEditorState, setLinkEditorState] = React.useState<LinkEditorModalState | null>(null)
  const [linkFieldOverrides, setLinkFieldOverrides] = React.useState<Record<string, unknown>>({})
  const [sourceTableName, setSourceTableName] = React.useState('')

  const closeHost = React.useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  React.useEffect(() => {
    if (open && coordinateDrawers) {
      // 与主字段展开共用 record-form 抽屉协调，互斥关闭
      announceTableDrawerOpen('record-form', drawerId)
    }
  }, [drawerId, open, coordinateDrawers])

  useCloseOnOtherTableDrawerOpen(
    'record-form',
    drawerId,
    open && coordinateDrawers,
    closeHost,
  )

  React.useEffect(() => {
    if (!open || !foreignTableId || !recordId) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setLinkEditorState(null)
    setLinkFieldOverrides({})

    void (async () => {
      try {
        const [fieldsResp, recordResp] = await Promise.all([
          FieldApiService.getFields(foreignTableId),
          RecordApiService.getRecord(recordId, { fieldKeyType: 'name' }),
        ])
        if (cancelled) return
        setFields(fieldsResp.fields ?? [])
        setRecord(recordResp)
      } catch (err) {
        if (cancelled) return
        log.error('Failed to load linked record:', err)
        setLoadError(
          err instanceof Error
            ? err.message
            : t('errors.loadRecordFailed', '加载记录失败'),
        )
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, foreignTableId, recordId, t])

  // 解析「记录来自」表名：优先本地 tables 缓存，否则拉一次表元数据
  React.useEffect(() => {
    if (!open || !foreignTableId) {
      setSourceTableName('')
      return
    }
    const fromStore = storeTables.find((tb) => tb.id === foreignTableId)
    if (fromStore?.name) {
      setSourceTableName(fromStore.name)
      return
    }
    // 走 API 前先清空，避免 foreignTableId 切换时短暂显示旧表名
    setSourceTableName('')
    let cancelled = false
    void TableApiService.getTable(foreignTableId)
      .then((tb: { name?: string } | null) => {
        if (!cancelled && tb?.name) setSourceTableName(tb.name)
      })
      .catch((err) => {
        log.warn('Failed to resolve source table name:', err)
      })
    return () => {
      cancelled = true
    }
  }, [open, foreignTableId, storeTables])

  React.useEffect(() => {
    if (!open) {
      setFields([])
      setRecord(null)
      setLoadError(null)
      setLinkEditorState(null)
      setLinkFieldOverrides({})
      setSourceTableName('')
    }
  }, [open])

  const handleGoToSourceTable = React.useCallback(() => {
    if (!foreignTableId) return
    // 优先走工作台同款 onTableClick（内含正确 tabScopeKey），与侧栏点表一致
    const table = storeTables.find((tb) => tb.id === foreignTableId)
    if (spaceActions && table) {
      log.info('goToSourceTable via onTableClick', { foreignTableId, name: table.name })
      spaceActions.onTableClick(table)
      onOpenChange(false)
      return
    }
    if (!spaceId) {
      log.warn('goToSourceTable aborted: missing spaceId', { foreignTableId })
      return
    }
    // 回退：用前台 scope 桶，禁止写裸 spaceId
    const tabScopeKey =
      spaceContext?.tabScopeKey ||
      resolveForegroundTabScopeKey(spaceId) ||
      spaceId
    log.info('goToSourceTable via openTableTab', { foreignTableId, tabScopeKey })
    openTableTab(tabScopeKey, foreignTableId)
    onOpenChange(false)
  }, [
    foreignTableId,
    storeTables,
    spaceActions,
    spaceId,
    spaceContext?.tabScopeKey,
    openTableTab,
    onOpenChange,
  ])

  const fieldDefinitions = React.useMemo(
    () => toFieldDefinitions(fields) as FieldDefinition[],
    [fields],
  )

  const baselineData: RecordFormData = React.useMemo(() => {
    if (!record) return {}
    return (record.data ?? {}) as RecordFormData
  }, [record])

  const initialData: RecordFormData = React.useMemo(() => {
    if (Object.keys(linkFieldOverrides).length === 0) return baselineData
    return { ...baselineData, ...linkFieldOverrides }
  }, [baselineData, linkFieldOverrides])

  const handleLinkFieldEdit = React.useCallback(
    (fieldId: string, fieldName: string, currentValue: unknown) => {
      if (isReadonly) return
      const field = fields.find((f) => f.id === fieldId)
      if (!field || field.field_type !== 'link') return
      const options = (field.options ?? {}) as Record<string, unknown>
      const targetTableId = String(options.foreignTableId ?? '')
      if (!targetTableId) return

      let items: Array<{ id: string; title?: string }> = []
      if (Array.isArray(currentValue)) {
        items = currentValue
          .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object')
          .map((v) => ({
            id: String(v.id ?? ''),
            title: v.title ? String(v.title) : undefined,
          }))
      } else if (
        currentValue &&
        typeof currentValue === 'object' &&
        'id' in (currentValue as object)
      ) {
        const v = currentValue as Record<string, unknown>
        items = [{ id: String(v.id ?? ''), title: v.title ? String(v.title) : undefined }]
      }

      setLinkEditorState({
        fieldId,
        fieldName,
        fieldConfig: {
          foreignTableId: targetTableId,
          relationship: String(options.relationship ?? 'ManyMany'),
          lookupFieldId: options.lookupFieldId ? String(options.lookupFieldId) : undefined,
          isOneWay: Boolean(options.isOneWay),
          visibleFieldIds: Array.isArray(options.visibleFieldIds)
            ? (options.visibleFieldIds as unknown[]).map(String)
            : undefined,
          filterByViewId: options.filterByViewId
            ? String(options.filterByViewId)
            : undefined,
        },
        currentValue: items,
      })
    },
    [isReadonly, fields],
  )

  const handleLinkEditorSave = React.useCallback(
    async (newValue: Array<{ id: string; title?: string }>) => {
      if (!linkEditorState || !record) return
      const field = fields.find((f) => f.id === linkEditorState.fieldId)
      if (!field) return
      const isSingle =
        linkEditorState.fieldConfig.relationship === 'OneOne' ||
        linkEditorState.fieldConfig.relationship === 'ManyOne'
      const cellValue = isSingle
        ? newValue.length > 0
          ? newValue[0]
          : null
        : newValue

      await RecordApiService.updateRecord(record.id, {
        fields: { [field.id]: cellValue },
        fieldKeyType: 'id',
      })

      setLinkFieldOverrides((prev) => ({
        ...prev,
        [field.name]: cellValue,
      }))
      setRecord((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          data: { ...(prev.data ?? {}), [field.name]: cellValue },
        }
      })
    },
    [linkEditorState, record, fields],
  )

  const handleSubmit = React.useCallback(
    async (data: RecordFormData) => {
      if (!record || isReadonly) return
      setIsSubmitting(true)
      try {
        const changed = computeChangedRecordData(data, baselineData)
        if (Object.keys(changed).length === 0) {
          onOpenChange(false)
          return
        }
        await RecordApiService.updateRecord(record.id, {
          data: changed,
          fieldKeyType: 'name',
        })
        onSaved?.()
        onOpenChange(false)
        toast({ title: t('toast.updateSuccess', '记录已更新') })
      } catch (err) {
        log.error('Submit linked record failed:', err)
        toast({
          variant: 'destructive',
          title: t('errors.submitFailed', '提交失败'),
          description: err instanceof Error ? err.message : String(err),
        })
        throw err
      } finally {
        setIsSubmitting(false)
      }
    },
    [record, isReadonly, baselineData, onOpenChange, onSaved, toast, t],
  )

  if (!open) return null

  // 始终挂同一套 RecordFormDialog Sheet，加载态只换正文，避免「空 drawer → 闪一下 → 有内容」
  const showError = Boolean(loadError) && !loading && !record

  return (
    <>
      <RecordFormDialog
        open={open}
        onOpenChange={onOpenChange}
        fields={showError || loading ? [] : fieldDefinitions}
        initialData={loading || !record ? {} : initialData}
        mode="edit"
        onSubmit={handleSubmit}
        isSubmitting={isSubmitting}
        isReadonly={isReadonly || loading || showError}
        isLoading={loading}
        // 从画布打开：勿与 Grid 抢焦点，避免 FocusOutside 误关
        preventOpenAutoFocus
        title={
          titleHint ||
          (isReadonly
            ? t('dialog.viewTitle', '查看记录')
            : t('dialog.editTitle', '编辑记录'))
        }
        description={
          showError
            ? (loadError ?? t('errors.loadRecordFailed', '加载记录失败'))
            : undefined
        }
        tableId={foreignTableId}
        recordId={recordId}
        onLinkFieldEdit={
          isReadonly || loading || !record ? undefined : handleLinkFieldEdit
        }
        onOpenLinkedRecord={undefined}
        sourceTableName={sourceTableName || undefined}
        onGoToSourceTable={
          spaceId && foreignTableId && sourceTableName
            ? handleGoToSourceTable
            : undefined
        }
      />
      {linkEditorState && record && (
        <LinkCellEditor
          open
          onClose={() => setLinkEditorState(null)}
          tableId={foreignTableId}
          recordId={record.id}
          fieldId={linkEditorState.fieldId}
          fieldConfig={linkEditorState.fieldConfig}
          currentValue={linkEditorState.currentValue}
          onSave={handleLinkEditorSave}
        />
      )}
    </>
  )
}
