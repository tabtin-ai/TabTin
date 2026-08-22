/**
 * Web 端的 DragRegion stub — Electron 的 SidebarDragRegion 在 Web 上不需要窗口拖拽，
 * 但保留相同的高度占位以保持布局一致。
 * @see apps/tabtin-electron/src/renderer/src/components/platform/drag-region.tsx
 */

export function SidebarDragRegion(_props: {
  className?: string
  excludeRight?: number
}) {
  return <div className="h-[36px] pointer-events-none flex-shrink-0" />
}
