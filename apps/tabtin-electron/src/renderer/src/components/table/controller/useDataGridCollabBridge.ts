/**
 * useDataGridCollabBridge — Electron 薄封装层
 *
 * 核心逻辑已迁移到 @tabtin/table-engine/collab。
 * 本文件注入 Electron 特有的运行时依赖并保持与现有调用方的接口兼容。
 */

import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { getAuthToken } from '@/adapters/api-adapter-instance'
import { useAuthStore } from '@/stores/useAuthStore'
import { getUserColor } from '@tabtin/collab-core'
import { COLLAB_WS_URLS } from '@/config/api'
import { toast } from '@tabtin/smartsheet-ui'
import type { Field, CreateRecordRequest, UpdateRecordRequest, TableRecord } from '@tabtin/table-core'
import {
  useDataGridCollabBridge as useDataGridCollabBridgeCore,
  type UseDataGridCollabBridgeResult,
  type DiscardedRecordUpdateNotice,
} from '@tabtin/table-engine/collab'
import { preflightTableCollabAccess } from './preflightTableCollabAccess'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TABLE_COLLAB_DISABLED = (import.meta as any).env?.VITE_TABLE_COLLAB_DISABLED === 'true'

export interface UseDataGridCollabBridgeInput {
  selectedTableId: string | null
  parentDocumentId?: string | null
  fields: Field[]
  updateRecord: (recordId: string, data: UpdateRecordRequest) => Promise<TableRecord | null>
  createRecord: (data: CreateRecordRequest, options?: { skipLocalInsert?: boolean }) => Promise<TableRecord | null>
  mergeIncrementalRecords: (records: TableRecord[], newVersion: number) => void
  mergeIncrementalViewRecords?: (records: TableRecord[], newVersion: number) => void
  removeRecordsByIds: (recordIds: string[], newVersion?: number) => void
  onFieldChange?: (info: { action: string; field_ids?: string[] }) => void
  onViewChange?: () => void
}

export function useDataGridCollabBridge(
  input: UseDataGridCollabBridgeInput
): UseDataGridCollabBridgeResult {
  const currentUser = useAuthStore(state => state.user)
  const { t } = useTranslation('table')
  const fieldsRef = useRef(input.fields)
  fieldsRef.current = input.fields

  const handleConflictDiscarded = useCallback((discardedCount: number, replayedCount: number) => {
    const replayedSuffix = replayedCount > 0
      ? t('collab.conflictReplayedSuffix', { count: replayedCount, defaultValue: `, ${replayedCount} edits synced successfully` })
      : ''
    toast.warning(
      t('collab.conflictDiscarded', { count: discardedCount, defaultValue: `After reconnect, ${discardedCount} edits conflicted with others and were discarded` }) + replayedSuffix,
      { duration: 6000 },
    )
  }, [t])

  const handleStaleFieldEdit = useCallback((staleFieldIds: string[]) => {
    const currentFields = fieldsRef.current
    const matched = currentFields.filter(f => staleFieldIds.includes(f.id))
    const count = staleFieldIds.length

    let message: string
    if (matched.length > 0 && count <= 3) {
      const fieldNames = matched.map(f => `「${f.name}」`).join('')
      message = t('collab.staleFieldEditNamed', {
        fieldNames,
        defaultValue: `Field(s) ${fieldNames} deleted by another user, related edits skipped`,
      })
    } else if (matched.length > 0) {
      const firstName = `「${matched[0].name}」`
      message = t('collab.staleFieldEditTruncated', {
        firstName,
        count,
        defaultValue: `${firstName} and ${count - 1} other field(s) deleted by another user, related edits skipped`,
      })
    } else {
      message = t('collab.staleFieldEdit', {
        count,
        defaultValue: `${count} field(s) deleted by another user, related edits skipped`,
      })
    }

    toast.warning(message, { duration: 6000 })
  }, [t])

  const handleDiscardedRecordUpdate = useCallback((notice: DiscardedRecordUpdateNotice) => {
    const deletedBy = notice.deleted_by_name || t('collab.otherCollaborator', {
      defaultValue: '其他协作者',
    })
    toast.warning(
      t('collab.recordDeletedEditDiscarded', {
        deletedBy,
        defaultValue: `该记录已被${deletedBy}删除，您刚才的修改未保存`,
      }),
      { duration: 6000 },
    )
  }, [t])

  return useDataGridCollabBridgeCore({
    ...input,
    onConflictDiscarded: handleConflictDiscarded,
    onStaleFieldEdit: handleStaleFieldEdit,
    collabInput: {
      getAuthToken,
      preflightCollabAccess: preflightTableCollabAccess,
      parentDocumentId: input.parentDocumentId,
      serverUrl: COLLAB_WS_URLS.table,
      user: {
        id: currentUser?.id || 'anonymous',
        name: currentUser?.nickname || currentUser?.username || currentUser?.email || t('collab.anonymousUser', { defaultValue: 'User' }),
        color: getUserColor(currentUser?.id || ''),
        type: 'user',
      },
      collabDisabled: TABLE_COLLAB_DISABLED,
      onDiscardedRecordUpdate: handleDiscardedRecordUpdate,
    },
  })
}

export type { UseDataGridCollabBridgeResult }
