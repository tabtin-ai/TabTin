import {
  type RecordFormMode,
  buildRecordPayload,
  createDraftFromRecord,
  createEmptyDraft,
} from '@/table-host/record-draft-utils'
import { toErrorMessage } from '@/table-host/value-utils'
import { RecordApiService } from '@tabtin/table-core'
import type { TableField, TableRecord } from '@tabtin/table-ui'
import { useCallback, useEffect, useMemo, useState } from 'react'

interface UseTableHostRecordActionsInput {
  hasAccessToken: boolean
  selectedTableId: string
  selectedViewId: string | null
  records: TableRecord[]
  orderedFields: TableField[]
  editableFields: TableField[]
  onRefresh: () => void
}

export const useTableHostRecordActions = ({
  hasAccessToken,
  selectedTableId,
  selectedViewId,
  records,
  orderedFields,
  editableFields,
  onRefresh,
}: UseTableHostRecordActionsInput) => {
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const [formMode, setFormMode] = useState<RecordFormMode>('create')
  const [recordDraft, setRecordDraft] = useState<Record<string, string>>({})
  const [actionLoading, setActionLoading] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  const selectedRecord = useMemo(
    () => records.find((record) => record.id === selectedRecordId) ?? null,
    [records, selectedRecordId]
  )

  const clearActionFeedback = useCallback(() => {
    setActionError(null)
    setActionMessage(null)
  }, [])

  const resetRecordContext = useCallback(() => {
    setSelectedRecordId(null)
    setFormMode('create')
    clearActionFeedback()
  }, [clearActionFeedback])

  useEffect(() => {
    if (selectedRecordId && !records.some((record) => record.id === selectedRecordId)) {
      setSelectedRecordId(null)
    }
  }, [records, selectedRecordId])

  useEffect(() => {
    if (formMode === 'edit') {
      if (selectedRecord) {
        setRecordDraft(createDraftFromRecord(orderedFields, selectedRecord))
      } else {
        setRecordDraft(createEmptyDraft(orderedFields))
      }
      return
    }

    setRecordDraft(createEmptyDraft(orderedFields))
  }, [formMode, orderedFields, selectedRecord])

  useEffect(() => {
    void selectedTableId
    void selectedViewId
    resetRecordContext()
  }, [selectedTableId, selectedViewId, resetRecordContext])

  const handleSelectRecord = useCallback(
    (recordId: string) => {
      setSelectedRecordId(recordId)
      clearActionFeedback()

      if (formMode !== 'edit') {
        return
      }

      const nextRecord = records.find((record) => record.id === recordId)
      if (!nextRecord) {
        return
      }

      setRecordDraft(createDraftFromRecord(orderedFields, nextRecord))
    },
    [clearActionFeedback, formMode, orderedFields, records]
  )

  const handleDraftChange = useCallback((fieldName: string, value: string) => {
    setRecordDraft((prev) => ({
      ...prev,
      [fieldName]: value,
    }))
  }, [])

  const handleResetDraft = useCallback(() => {
    if (formMode === 'edit' && selectedRecord) {
      setRecordDraft(createDraftFromRecord(orderedFields, selectedRecord))
      return
    }

    setRecordDraft(createEmptyDraft(orderedFields))
  }, [formMode, orderedFields, selectedRecord])

  const handleCreateRecord = useCallback(async () => {
    if (!hasAccessToken) {
      setActionError('未检测到 access_token，请先登录')
      return
    }

    if (!selectedTableId) {
      setActionError('请先选择表格')
      return
    }

    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)

    try {
      const payload = buildRecordPayload('create', orderedFields, recordDraft)
      if (Object.keys(payload).length === 0) {
        throw new Error('请至少填写一个字段再创建记录')
      }

      const createdRecord = await RecordApiService.createRecord({
        table_id: selectedTableId,
        data: payload,
      })

      setActionMessage(`记录创建成功：${createdRecord.id}`)
      setSelectedRecordId(createdRecord.id)
      setFormMode('edit')
      onRefresh()
    } catch (actionErrorObj) {
      setActionError(`创建失败：${toErrorMessage(actionErrorObj)}`)
    } finally {
      setActionLoading(false)
    }
  }, [hasAccessToken, onRefresh, orderedFields, recordDraft, selectedTableId])

  const handleUpdateRecord = useCallback(async () => {
    if (!hasAccessToken) {
      setActionError('未检测到 access_token，请先登录')
      return
    }

    if (!selectedRecordId) {
      setActionError('请选择要编辑的记录')
      return
    }

    setActionLoading(true)
    setActionError(null)
    setActionMessage(null)

    try {
      const payload = buildRecordPayload('edit', editableFields, recordDraft)
      if (Object.keys(payload).length === 0) {
        throw new Error('当前没有可提交的字段')
      }

      await RecordApiService.updateRecord(selectedRecordId, { data: payload })
      setActionMessage(`记录已更新：${selectedRecordId}`)
      onRefresh()
    } catch (actionErrorObj) {
      setActionError(`更新失败：${toErrorMessage(actionErrorObj)}`)
    } finally {
      setActionLoading(false)
    }
  }, [editableFields, hasAccessToken, onRefresh, recordDraft, selectedRecordId])

  const handleDeleteRecord = useCallback(async () => {
    if (!hasAccessToken) {
      setActionError('未检测到 access_token，请先登录')
      return
    }

    if (!selectedRecordId) {
      setActionError('请选择要删除的记录')
      return
    }

    const confirmed = window.confirm(`确认删除记录 ${selectedRecordId} 吗？`)
    if (!confirmed) {
      return
    }

    setDeleteLoading(true)
    setActionError(null)
    setActionMessage(null)

    try {
      await RecordApiService.deleteRecord(selectedRecordId)
      setActionMessage(`记录已删除：${selectedRecordId}`)
      setSelectedRecordId(null)
      setFormMode('create')
      onRefresh()
    } catch (actionErrorObj) {
      setActionError(`删除失败：${toErrorMessage(actionErrorObj)}`)
    } finally {
      setDeleteLoading(false)
    }
  }, [hasAccessToken, onRefresh, selectedRecordId])

  return {
    selectedRecordId,
    selectedRecord,
    formMode,
    setFormMode,
    recordDraft,
    actionLoading,
    deleteLoading,
    actionError,
    actionMessage,
    clearActionFeedback,
    resetRecordContext,
    handleSelectRecord,
    handleDraftChange,
    handleResetDraft,
    handleCreateRecord,
    handleUpdateRecord,
    handleDeleteRecord,
  }
}
