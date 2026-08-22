/**
 * useWebCollabBridge — Web 端协作桥接薄封装
 *
 * 核心逻辑在 @tabtin/table-engine/collab，此文件仅注入 Web 特有的运行时依赖：
 *   - getAuthToken（localStorage）
 *   - COLLAB_WS_URLS.table
 *   - 当前用户信息
 */

import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { getUserColor } from '@tabtin/collab-core'
import { useAuthStore } from '@/stores/auth-store'
import { COLLAB_WS_URLS, TABLE_COLLAB_DISABLED } from '@/config/api'
import { STORAGE_KEYS } from '@/platform/web-auth-adapter'
import type { Field, CreateRecordRequest, UpdateRecordRequest, TableRecord } from '@tabtin/table-core'
import {
  useDataGridCollabBridge as useDataGridCollabBridgeCore,
  type UseDataGridCollabBridgeResult,
} from '@tabtin/table-engine/collab'

async function getAuthToken(): Promise<string> {
  const token = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)
  if (!token) throw new Error('No access token available')
  return token
}

export interface UseWebCollabBridgeInput {
  selectedTableId: string | null
  fields: Field[]
  updateRecord: (recordId: string, data: UpdateRecordRequest) => Promise<TableRecord | null>
  createRecord: (data: CreateRecordRequest, options?: { skipLocalInsert?: boolean }) => Promise<TableRecord | null>
  mergeIncrementalRecords: (records: TableRecord[], newVersion: number) => void
  mergeIncrementalViewRecords?: (records: TableRecord[], newVersion: number) => void
  removeRecordsByIds: (recordIds: string[], newVersion?: number) => void
  onFieldChange?: (info: { action: string; field_ids?: string[] }) => void
  onViewChange?: () => void
}

export function useWebCollabBridge(
  input: UseWebCollabBridgeInput,
): UseDataGridCollabBridgeResult {
  const currentUser = useAuthStore(state => state.user)
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

  return useDataGridCollabBridgeCore({
    ...input,
    onConflictDiscarded: handleConflictDiscarded,
    onStaleFieldEdit: handleStaleFieldEdit,
    collabInput: {
      getAuthToken,
      serverUrl: COLLAB_WS_URLS.table,
      user: {
        id: currentUser?.id || 'anonymous',
        name: currentUser?.nickname || currentUser?.username || currentUser?.email || t('collab.anonymousUser', { defaultValue: 'User' }),
        color: getUserColor(currentUser?.id || ''),
        type: 'human',
      },
      collabDisabled: TABLE_COLLAB_DISABLED,
    },
  })
}

export type { UseDataGridCollabBridgeResult }
