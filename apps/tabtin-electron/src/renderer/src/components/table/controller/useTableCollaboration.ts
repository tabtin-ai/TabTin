/**
 * useTableCollaboration — Electron 薄封装层
 *
 * 核心逻辑已迁移到 @tabtin/table-engine/collab。
 * 本文件注入 Electron 特有的运行时依赖（auth / ws url / env flag）。
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { getAuthToken } from '@/adapters/api-adapter-instance'
import { useAuthStore } from '@/stores/useAuthStore'
import { getUserColor } from '@tabtin/collab-core'
import { COLLAB_WS_URLS } from '@/config/api'
import {
  useTableCollaboration as useTableCollaborationCore,
  type UseTableCollaborationResult,
} from '@tabtin/table-engine/collab'
import { preflightTableCollabAccess } from './preflightTableCollabAccess'

export interface UseTableCollaborationInput {
  tableId: string | null
  enabled?: boolean
  parentDocumentId?: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TABLE_COLLAB_DISABLED = (import.meta as any).env?.VITE_TABLE_COLLAB_DISABLED === 'true'

export function useTableCollaboration(
  input: UseTableCollaborationInput
): UseTableCollaborationResult {
  const { t } = useTranslation('common')
  const currentUser = useAuthStore(state => state.user)

  const onStoreFailed = useCallback(
    (_message: string) => {
      toast({
        title: t('collab.storeFailed'),
        variant: 'destructive',
      })
    },
    [t]
  )

  return useTableCollaborationCore({
    tableId: input.tableId,
    enabled: input.enabled,
    parentDocumentId: input.parentDocumentId,
    getAuthToken,
    preflightCollabAccess: preflightTableCollabAccess,
    serverUrl: COLLAB_WS_URLS.table,
    user: {
      id: currentUser?.id || 'anonymous',
      name: currentUser?.nickname || currentUser?.username || currentUser?.email || '用户',
      color: getUserColor(currentUser?.id || ''),
      type: 'user',
    },
    collabDisabled: TABLE_COLLAB_DISABLED,
    onStoreFailed,
  })
}

export type { UseTableCollaborationResult }

export {
  replayPendingTableWrites,
  rowOrderHas,
  type CellChange,
  type PendingTableWrite,
} from '@tabtin/table-engine/collab'
