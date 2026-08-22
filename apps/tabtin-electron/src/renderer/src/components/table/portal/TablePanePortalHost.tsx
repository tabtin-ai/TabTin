import React, { useLayoutEffect, useRef } from 'react'
import { useTablePanePortal } from './TablePanePortalContext'

export interface TablePanePortalHostProps extends React.HTMLAttributes<HTMLDivElement> {
  tableId: string
  onInteraction?: () => void
}

/**
 * TablePanePortalHost - 表格 Portal 的宿主组件
 *
 * ⚠️ 重要设计决策：
 * - 使用 useLayoutEffect 注册 slot，让 PortalLayer 在 paint 前就能把 root
 *   从 parking（0×0）挪到真实槽位，避免 Canvas 首帧锁在零尺寸
 * - 依赖数组只包含 tableId，不包含 registerSlot/unregisterSlot
 * - 使用 ref 追踪组件挂载状态，避免在卸载后更新
 */
export const TablePanePortalHost: React.FC<TablePanePortalHostProps> = ({
  tableId,
  onInteraction,
  ...props
}) => {
  const { registerSlot, unregisterSlot } = useTablePanePortal()
  const divRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const element = divRef.current
    if (element) {
      registerSlot(tableId, element)
    }

    return () => {
      if (element) {
        unregisterSlot(tableId, element)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId])

  return (
    <div
      ref={divRef}
      data-table-pane-slot={tableId}
      onPointerDownCapture={() => onInteraction?.()}
      onFocusCapture={() => onInteraction?.()}
      onKeyDownCapture={() => onInteraction?.()}
      {...props}
    />
  )
}

TablePanePortalHost.displayName = 'TablePanePortalHost'
