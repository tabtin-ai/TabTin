import React, { Activity, useEffect, useMemo } from 'react'
import { cn } from '@utils/cn'
import { TablePanePortalHost } from '@components/table/portal/TablePanePortalHost'
import { useTablePanePortal } from '@components/table/portal/TablePanePortalContext'
import { useTableCanvasLRU, useStableUnloadedSet } from '@components/table/hooks/useTableCanvasLRU'

interface PersistentTableTabsProps {
  tableIds: string[]
  activeTableId: string | null
  /** ⭐ 已在分屏中渲染的表格 ID 集合，需要排除避免重复渲染 */
  excludeTableIds?: Set<string>
  className?: string
}

const UnloadedTablePlaceholder: React.FC<{ tableId: string }> = ({ tableId }) => (
  <div
    className="absolute inset-0 flex items-center justify-center bg-background"
    data-table-tab-id={tableId}
    data-table-unloaded="true"
    aria-hidden="true"
  >
    <div className="animate-spin h-5 w-5 rounded-full border-2 border-primary/30 border-t-primary" />
  </div>
)

export const PersistentTableTabs: React.FC<PersistentTableTabsProps> = ({
  tableIds,
  activeTableId,
  excludeTableIds,
  className,
}) => {
  const { setUnloadedTableIds } = useTablePanePortal()

  const filteredTableIds = useMemo(() => {
    if (!excludeTableIds || excludeTableIds.size === 0) {
      return tableIds
    }
    return tableIds.filter(id => !excludeTableIds.has(id))
  }, [tableIds, excludeTableIds])

  const rawUnloaded = useTableCanvasLRU(filteredTableIds, activeTableId)
  const unloadedTableIds = useStableUnloadedSet(rawUnloaded)

  useEffect(() => {
    setUnloadedTableIds(unloadedTableIds)
    return () => setUnloadedTableIds(Object.freeze(new Set<string>()))
  }, [unloadedTableIds, setUnloadedTableIds])

  if (filteredTableIds.length === 0) return null

  const hasActiveTable = Boolean(activeTableId && !excludeTableIds?.has(activeTableId))

  return (
    <div
      className={cn('absolute inset-0', className)}
      style={{ pointerEvents: hasActiveTable ? 'auto' : 'none' }}
    >
      {filteredTableIds.map(tableId => {
        const isActive = tableId === activeTableId

        if (unloadedTableIds.has(tableId)) {
          if (!isActive) return null
          return (
            <UnloadedTablePlaceholder key={tableId} tableId={tableId} />
          )
        }

        // 非 active table 用 `<Activity hidden>`：自动清理 ResizeObserver /
        // 虚拟列表 / 测量缓存等 effect，节省 CPU。React state 保留，切回来
        // 秒恢复。slot 注销由 effect cleanup 触发，portal layer 自然把
        // table view 移到 parking。
        return (
          <Activity key={tableId} mode={isActive ? 'visible' : 'hidden'}>
            <TablePanePortalHost
              tableId={tableId}
              className="absolute inset-0"
              aria-hidden={!isActive}
              data-table-tab-id={tableId}
            />
          </Activity>
        )
      })}
    </div>
  )
}

PersistentTableTabs.displayName = 'PersistentTableTabs'
