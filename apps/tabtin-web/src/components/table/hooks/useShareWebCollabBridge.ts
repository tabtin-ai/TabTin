/**
 * useShareWebCollabBridge — 分享页表格协作桥接。
 *
 * 注入 share collab token 与访客身份，REST 仍走 configureWebTableRuntime 的分享头。
 */
import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import type { Field, CreateRecordRequest, UpdateRecordRequest, TableRecord } from '@tabtin/table-core'
import {
  useDataGridCollabBridge as useDataGridCollabBridgeCore,
  type UseDataGridCollabBridgeResult,
} from '@tabtin/table-engine/collab'
import { COLLAB_WS_URLS } from '@/config/api'
import { buildShareCollabUser } from '@/pages/hooks/useShareCollab'
import { useAuthStore } from '@/stores/auth-store'

export interface UseShareWebCollabBridgeInput {
  selectedTableId: string | null
  fields: Field[]
  updateRecord: (recordId: string, data: UpdateRecordRequest) => Promise<TableRecord | null>
  createRecord: (data: CreateRecordRequest, options?: { skipLocalInsert?: boolean }) => Promise<TableRecord | null>
  mergeIncrementalRecords: (records: TableRecord[], newVersion: number) => void
  mergeIncrementalViewRecords?: (records: TableRecord[], newVersion: number) => void
  removeRecordsByIds: (recordIds: string[], newVersion?: number) => void
  onFieldChange?: (info: { action: string; field_ids?: string[] }) => void
  onViewChange?: () => void
  shareId: string
  password?: string
  getAuthToken: () => Promise<string>
  refreshToken: () => Promise<string | null>
  collabDisabled?: boolean
}

export function useShareWebCollabBridge(
  input: UseShareWebCollabBridgeInput,
): UseDataGridCollabBridgeResult {
  const currentUser = useAuthStore((state) => state.user)
  const { t } = useTranslation('table')
  const fieldsRef = useRef(input.fields)
  fieldsRef.current = input.fields

  const handleConflictDiscarded = useCallback((discardedCount: number, replayedCount: number) => {
    const replayedSuffix = replayedCount > 0
      ? t('collab.conflictReplayedSuffix', { count: replayedCount, defaultValue: `, ${replayedCount} edits synced successfully` })
      : ''
    toast.info(
      t('collab.conflictDiscarded', { count: discardedCount, defaultValue: `After reconnect, ${discardedCount} edits conflicted with others and were discarded` }) + replayedSuffix,
      { duration: 6000 },
    )
  }, [t])

  const handleStaleFieldEdit = useCallback((staleFieldIds: string[]) => {
    const currentFields = fieldsRef.current
    const matched = currentFields.filter((f) => staleFieldIds.includes(f.id))
    const count = staleFieldIds.length

    let message: string
    if (matched.length > 0 && count <= 3) {
      const fieldNames = matched.map((f) => `「${f.name}」`).join('')
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

  const collabUser = buildShareCollabUser(input.shareId, currentUser)

  return useDataGridCollabBridgeCore({
    selectedTableId: input.selectedTableId,
    fields: input.fields,
    updateRecord: input.updateRecord,
    createRecord: input.createRecord,
    mergeIncrementalRecords: input.mergeIncrementalRecords,
    mergeIncrementalViewRecords: input.mergeIncrementalViewRecords,
    removeRecordsByIds: input.removeRecordsByIds,
    onFieldChange: input.onFieldChange,
    onViewChange: input.onViewChange,
    onConflictDiscarded: handleConflictDiscarded,
    onStaleFieldEdit: handleStaleFieldEdit,
    collabInput: {
      getAuthToken: input.getAuthToken,
      serverUrl: COLLAB_WS_URLS.table,
      user: collabUser,
      collabDisabled: input.collabDisabled ?? false,
      onTokenRefreshRequired: () => { void input.refreshToken() },
    },
  })
}

export type { UseDataGridCollabBridgeResult }
