/**
 * LinkedRecordCreateHost — 跨表新建关联记录宿主
 *
 * 按 foreignTableId 拉取目标表字段，复用 RecordFormDialog 创建模式，
 * 不切换全局 selectedTable。供关联选择器「+ 添加记录」打开完整记录表单。
 */

import React from 'react'
import {
  RecordFormDialog,
  useToast,
  type RecordFormData,
  type FieldDefinition,
} from '@tabtin/smartsheet-ui'
import { toFieldDefinitions, toOrganizationMembers } from '@tabtin/table-ui'
import { FieldApiService, RecordApiService, TableApiService } from '@tabtin/table-core'
import type { Field } from '@tabtin/table-core'
import { useTranslation } from 'react-i18next'
import {
  announceTableDrawerOpen,
  useCloseOnOtherTableDrawerOpen,
} from '@/components/table/utils/tableDrawerCoordinator'
import { useTableStore } from '@/stores/useTableStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('LinkedRecordCreateHost')

export interface LinkedRecordCreateHostProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  foreignTableId: string
  /** 创建成功后回传新记录，供关联选择器勾选并落库 */
  onCreated: (record: { id: string; title?: string }) => void
  /**
   * 为 false 时不参与表抽屉互斥（从关联选择器内再开新建表单时使用，
   * 避免关掉父级编辑侧栏或干扰选择器）。
   */
  coordinateDrawers?: boolean
}

export const LinkedRecordCreateHost: React.FC<LinkedRecordCreateHostProps> = ({
  open,
  onOpenChange,
  foreignTableId,
  onCreated,
  coordinateDrawers = false,
}) => {
  const { t } = useTranslation('record')
  const drawerId = React.useId()
  const { toast } = useToast()
  const storeTables = useTableStore((s) => s.tables)
  const currentUserId = useAuthStore((state) => state.user?.id != null ? String(state.user.id) : undefined)
  const organizationMembers = useOrganizationStore((state) => state.members)
  const userOptions = React.useMemo(
    () => toOrganizationMembers(organizationMembers),
    [organizationMembers],
  )

  const [loading, setLoading] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [fields, setFields] = React.useState<Field[]>([])
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [tableName, setTableName] = React.useState('')

  const closeHost = React.useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  React.useEffect(() => {
    if (open && coordinateDrawers) {
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
    if (!open || !foreignTableId) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)

    void (async () => {
      try {
        const fieldsResp = await FieldApiService.getFields(foreignTableId)
        if (cancelled) return
        setFields(fieldsResp.fields ?? [])
      } catch (err) {
        if (cancelled) return
        log.error('Failed to load foreign fields for create:', err)
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
  }, [open, foreignTableId, t])

  React.useEffect(() => {
    if (!open || !foreignTableId) {
      setTableName('')
      return
    }
    const fromStore = storeTables.find((tb) => tb.id === foreignTableId)
    if (fromStore?.name) {
      setTableName(fromStore.name)
      return
    }
    setTableName('')
    let cancelled = false
    void TableApiService.getTable(foreignTableId)
      .then((tb: { name?: string } | null) => {
        if (!cancelled && tb?.name) setTableName(tb.name)
      })
      .catch((err) => {
        log.warn('Failed to resolve foreign table name:', err)
      })
    return () => {
      cancelled = true
    }
  }, [open, foreignTableId, storeTables])

  React.useEffect(() => {
    if (!open) {
      setFields([])
      setLoadError(null)
      setTableName('')
    }
  }, [open])

  const fieldDefinitions = React.useMemo(
    () => toFieldDefinitions(fields) as FieldDefinition[],
    [fields],
  )

  const resolveTitle = React.useCallback(
    (data: RecordFormData, created: { id: string; data?: Record<string, unknown> }) => {
      const primaryField = fields.find((f) => f.is_primary)
      if (primaryField) {
        const fromForm = data[primaryField.name]
        if (fromForm != null && fromForm !== '') return String(fromForm)
        const fromRecord = created.data?.[primaryField.name]
        if (fromRecord != null && fromRecord !== '') return String(fromRecord)
      }
      const firstValue = Object.values(data).find((v) => v != null && v !== '')
      return firstValue != null ? String(firstValue) : undefined
    },
    [fields],
  )

  const handleSubmit = React.useCallback(
    async (data: RecordFormData) => {
      setIsSubmitting(true)
      try {
        const created = await RecordApiService.createRecord({
          table_id: foreignTableId,
          data,
        })
        const title = resolveTitle(data, created)
        log.info('Created linked record', {
          foreignTableId,
          recordId: created.id,
        })
        // 关闭由 RecordFormDialog 在 onSubmit 成功后统一 handleClose
        onCreated({ id: created.id, title })
      } catch (err) {
        log.error('Create linked record failed:', err)
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
    [foreignTableId, resolveTitle, onCreated, toast, t],
  )

  if (!open) return null

  const showError = Boolean(loadError) && !loading

  return (
    <RecordFormDialog
      open={open}
      onOpenChange={onOpenChange}
      fields={showError || loading ? [] : fieldDefinitions}
      initialData={{}}
      mode="create"
      currentUserId={currentUserId}
      organizationMembers={userOptions}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      isReadonly={loading || showError}
      isLoading={loading}
      title={
        tableName
          ? t('dialog.createTitle', { name: tableName })
          : t('dialog.createTitleFallback', { defaultValue: '新建记录' })
      }
      description={
        showError
          ? (loadError ?? t('errors.loadRecordFailed', '加载记录失败'))
          : t('dialog.createDescription')
      }
      tableId={foreignTableId}
    />
  )
}
