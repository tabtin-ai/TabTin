import React from 'react'
import { TablePanePortalHost } from '@components/table/portal/TablePanePortalHost'
import {
  createTabDataRuntimeMonitorInstanceId,
  registerTabDataRuntimeHost,
  unregisterTabDataRuntimeHost,
  updateTabDataRuntimeHost,
} from '@components/table/table-runtime-monitor'

interface TablePaneRendererProps {
  tableId: string
  title?: string
  spaceId?: string | null
  organizationId?: string | null
  isPaneActive?: boolean
  isVisible?: boolean
  onPaneInteraction?: () => void
}

export const TablePaneRenderer: React.FC<TablePaneRendererProps> = ({
  tableId,
  title,
  spaceId,
  organizationId,
  isPaneActive = false,
  isVisible = true,
  onPaneInteraction,
}) => {
  const runtimeMonitorInstanceIdRef = React.useRef(createTabDataRuntimeMonitorInstanceId())

  React.useEffect(() => {
    const instanceId = runtimeMonitorInstanceIdRef.current
    registerTabDataRuntimeHost(instanceId, {
      tableId,
      title: title ?? null,
      spaceId: spaceId ?? null,
      organizationId: organizationId ?? null,
      tabKey: tableId ? `tabdata:${tableId}` : null,
      isPaneActive,
      isVisible,
      isLoading: false,
      hasError: false,
    })
    return () => {
      unregisterTabDataRuntimeHost(instanceId)
    }
  }, [])

  React.useEffect(() => {
    updateTabDataRuntimeHost(runtimeMonitorInstanceIdRef.current, {
      tableId,
      title: title ?? null,
      spaceId: spaceId ?? null,
      organizationId: organizationId ?? null,
      tabKey: tableId ? `tabdata:${tableId}` : null,
      isPaneActive,
      isVisible,
      isLoading: false,
      hasError: false,
    })
  }, [tableId, title, spaceId, organizationId, isPaneActive, isVisible])

  return (
    <div
      className="h-full w-full"
      onPointerDownCapture={() => onPaneInteraction?.()}
      onFocusCapture={() => onPaneInteraction?.()}
      onKeyDownCapture={() => onPaneInteraction?.()}
    >
      <TablePanePortalHost
        tableId={tableId}
        className="h-full w-full"
        data-canvas-table-id={tableId}
      />
    </div>
  )
}
