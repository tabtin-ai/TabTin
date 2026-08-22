import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { useTablePanePortal } from './TablePanePortalContext'
import { TablePreviewSkeleton } from '@components/common/ListSkeletons'
import { useTablePaneRetention } from './useTablePaneRetention'

const TablePaneView = React.lazy(() =>
  import('@components/table/TablePaneView').then(m => ({ default: m.TablePaneView }))
)

interface TablePanePortalLayerProps {
  tableIds: string[]
  /** All still-open tables in the current tab scope. In cloud-docs mode this
   * is wider than tableIds, which intentionally contains only the active table. */
  retentionTableIds?: string[]
}

const buildUniqueTableIds = (tableIds: string[]) => {
  const seen = new Set<string>()
  const result: string[] = []
  tableIds.forEach(id => {
    if (!id || seen.has(id)) return
    seen.add(id)
    result.push(id)
  })
  return result
}

/**
 * TablePanePortalLayer - 表格 Portal 的渲染层
 *
 * ⚠️ 重要设计决策：
 * - 已存在的 root 回到 connected slot 时使用 useLayoutEffect，确保选中首帧可见
 * - parking / 清理仍使用 useEffect + requestAnimationFrame，避免同步卸载引发布局循环
 * - root div 一旦创建就保持稳定，避免不必要的 Portal 重新挂载
 * - Host 侧用 useLayoutEffect 尽早注册 slot；本层只同步 append，不强制布局读
 */
export const TablePanePortalLayer: React.FC<TablePanePortalLayerProps> = ({
  tableIds,
  retentionTableIds = tableIds,
}) => {
  const { slots, parkingHost, setParkingHost, unloadedTableIds } = useTablePanePortal()
  const uniqueTableIds = useMemo(() => buildUniqueTableIds(tableIds), [tableIds])
  const uniqueRetentionTableIds = useMemo(
    () => buildUniqueTableIds(retentionTableIds),
    [retentionTableIds],
  )

  const retentionResult = useTablePaneRetention(
    uniqueTableIds,
    uniqueRetentionTableIds,
  )

  const retainedTableIds = retentionResult.retainedTableIds
  const retainedTableIdSet = useMemo(() => new Set(retainedTableIds), [retainedTableIds])

  const loadedTableIds = useMemo(() => {
    const ids = [...uniqueTableIds]
    for (const tableId of retainedTableIds) {
      if (!ids.includes(tableId)) ids.push(tableId)
    }
    if (unloadedTableIds.size === 0) return ids
    return ids.filter(id => retainedTableIdSet.has(id) || !unloadedTableIds.has(id))
  }, [uniqueTableIds, retainedTableIds, retainedTableIdSet, unloadedTableIds])

  const rootMapRef = useRef<Map<string, HTMLDivElement>>(new Map())

  const ensureRoot = useCallback((tableId: string): HTMLDivElement | null => {
    const existing = rootMapRef.current.get(tableId)
    if (existing) return existing
    if (typeof document === 'undefined') return null
    const root = document.createElement('div')
    root.dataset.tablePaneRoot = tableId
    root.style.height = '100%'
    root.style.width = '100%'
    root.style.minHeight = '0'
    root.style.minWidth = '0'
    rootMapRef.current.set(tableId, root)
    return root
  }, [])

  const resolveSlot = useCallback((slotList?: HTMLElement[] | null) => {
    if (!slotList || slotList.length === 0) return null
    for (let i = slotList.length - 1; i >= 0; i -= 1) {
      const slot = slotList[i]
      if (slot?.isConnected) return slot
    }
    return slotList[slotList.length - 1] ?? null
  }, [])

  // Host 在 layout effect 注册 slot 后，React 会在 paint 前同步刷新 context。
  // 此处只把已经存在的 root 归位，不负责 parking / 删除，避免恢复表格时
  // 标签已选中但 root 仍在 0×0 parking 中等待下一帧。
  useLayoutEffect(() => {
    loadedTableIds.forEach(tableId => {
      const root = rootMapRef.current.get(tableId)
      if (!root) return
      const slot = resolveSlot(slots.get(tableId) ?? null)
      if (!slot) return
      root.style.contentVisibility = 'visible'
      if (root.parentElement !== slot) {
        slot.appendChild(root)
      }
    })
  }, [loadedTableIds, slots, resolveSlot])

  // ⭐ 使用 useEffect + requestAnimationFrame，打破同步循环
  useEffect(() => {
    if (!parkingHost) return

    const rafId = requestAnimationFrame(() => {
      const active = new Set(loadedTableIds)
      loadedTableIds.forEach(tableId => {
        const root = ensureRoot(tableId)
        if (!root) return
        const slotList = slots.get(tableId) ?? null
        const slot = resolveSlot(slotList)
        const target = slot ?? parkingHost
        const isParked = target === parkingHost
        // Keep the React/provider tree alive, but stop the browser from doing
        // layout/paint work for an inactive pane in the zero-sized parking
        // host. This is intentionally CSS-only: unmounting here would lose
        // the very context/state retention this layer is meant to provide.
        root.style.contentVisibility = isParked ? 'hidden' : 'visible'
        if (root.parentElement !== target) {
          target.appendChild(root)
        }
      })
      rootMapRef.current.forEach((root, tableId) => {
        if (!active.has(tableId)) {
          root.remove()
          rootMapRef.current.delete(tableId)
        }
      })
    })

    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [ensureRoot, loadedTableIds, slots, parkingHost, resolveSlot])

  return (
    <>
      <div
        ref={setParkingHost}
        className="pointer-events-none absolute -left-[99999px] -top-[99999px] h-0 w-0 overflow-hidden"
        aria-hidden="true"
        data-table-pane-parking="true"
      />
      {loadedTableIds.map(tableId => {
        const root = ensureRoot(tableId)
        if (!root) return null
        return createPortal(
          <Suspense fallback={<TablePreviewSkeleton />}>
            <TablePaneView tableId={tableId} />
          </Suspense>,
          root,
          tableId,
        )
      })}
    </>
  )
}

TablePanePortalLayer.displayName = 'TablePanePortalLayer'
