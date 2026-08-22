/**
 * TableReadonlyContext — 表级只读 SSOT（跨 grid / 非 grid 视图共享）
 *
 * 合成来源：
 * - GET /tabdata/tables/{id} → current_user_role
 * - Collab WS scope=readonly
 * - resource_shared permission_changed 实时降级
 */

import React, { createContext, useContext, useMemo } from 'react'
import {
  isPermissionInsufficientForEditing,
  selectResourceShareNotifications,
  useResourceShareDowngrade,
} from '@tabtin/smartsheet-ui'
import { useTableStore } from '@stores/useTableStore'
import { useNotificationStore } from '@stores/useNotificationStore'
import { useTableCollab } from './TableCollabContext'
import { isReadonlyTableRole } from './tablePermissions'

export interface TableReadonlyContextValue {
  isTableReadonly: boolean
}

const TableReadonlyContext = createContext<TableReadonlyContextValue>({
  isTableReadonly: false,
})

export const useTableReadonly = (): TableReadonlyContextValue =>
  useContext(TableReadonlyContext)

export const TableReadonlyProvider: React.FC<{
  tableId: string | null
  children: React.ReactNode
}> = ({ tableId, children }) => {
  const selectedTable = useTableStore(state => state.selectedTable)
  const { collabBridge } = useTableCollab()

  const allNotifications = useNotificationStore(state => state.notifications)
  const resourceNotifications = useMemo(
    () => selectResourceShareNotifications(allNotifications, 'table', tableId),
    [allNotifications, tableId],
  )
  const downgrade = useResourceShareDowngrade('table', tableId, resourceNotifications)
  const downgradeInsufficient = isPermissionInsufficientForEditing(downgrade.changedPermission)

  const isTableReadonly = useMemo(() => {
    const selectedTableMatchesPane = Boolean(
      tableId && selectedTable?.id && selectedTable.id === tableId,
    )
    const roleReadonly = tableId
      ? !selectedTableMatchesPane || isReadonlyTableRole(selectedTable?.current_user_role)
      : isReadonlyTableRole(selectedTable?.current_user_role)
    const collab = collabBridge.collab
    const collabReadonly = Boolean(
      collab.isOnline && !collab.isFallback && !collab.canEdit,
    )
    return Boolean(roleReadonly || collabReadonly || downgradeInsufficient)
  }, [
    tableId,
    selectedTable?.id,
    selectedTable?.current_user_role,
    collabBridge.collab.isOnline,
    collabBridge.collab.isFallback,
    collabBridge.collab.canEdit,
    downgradeInsufficient,
  ])

  const value = useMemo(
    () => ({ isTableReadonly }),
    [isTableReadonly],
  )

  return (
    <TableReadonlyContext.Provider value={value}>
      {children}
    </TableReadonlyContext.Provider>
  )
}
