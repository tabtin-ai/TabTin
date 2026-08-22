/**
 * ViewTypeIcon — 视图类型图标
 *
 * 从 TableHistoryModal.tsx 中提炼的内联 SVG。
 * 支持 grid / kanban / calendar / gallery 四种视图类型。
 */

import * as React from 'react'

const ICONS: Record<string, (size: number) => React.ReactNode> = {
  grid: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
    </svg>
  ),
  kanban: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  ),
  calendar: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  gallery: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
}

export interface ViewTypeIconProps {
  /** 视图类型：grid / kanban / calendar / gallery */
  type: string
  /** 图标尺寸（px），默认 14 */
  size?: number
  /** 额外 className */
  className?: string
}

export const ViewTypeIcon: React.FC<ViewTypeIconProps> = ({
  type,
  size = 14,
  className,
}) => {
  const renderer = ICONS[type]
  if (!renderer) return null
  return <span className={className}>{renderer(size)}</span>
}

ViewTypeIcon.displayName = 'ViewTypeIcon'
