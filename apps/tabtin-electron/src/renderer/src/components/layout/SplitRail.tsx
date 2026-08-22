import React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { PanelToggleButton } from './PanelToggleButton'

type RailSide = 'left' | 'right'

interface SplitRailProps {
  collapsed: boolean
  onToggle?: () => void
  onResizeStart?: (event: React.PointerEvent<HTMLDivElement>) => void
  titleCollapsed: string
  titleExpanded: string
  side: RailSide
  className?: string
}

export const SplitRail: React.FC<SplitRailProps> = ({
  collapsed,
  onToggle,
  onResizeStart,
  titleCollapsed,
  titleExpanded,
  side,
  className,
}) => {
  const title = collapsed ? titleCollapsed : titleExpanded
  const showLeftChevron = side === 'left' ? !collapsed : collapsed
  const ChevronIcon = showLeftChevron ? ChevronLeft : ChevronRight
  const railClassName = onResizeStart ? 'cursor-col-resize' : 'cursor-default'

  return (
    <div
      className={`relative flex-shrink-0 w-3 group ${railClassName} ${className || ''}`}
      onPointerDown={onResizeStart}
      style={{ touchAction: 'none' }}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/0 group-hover:bg-border/60 group-active:bg-border/80 transition-colors" />
      {onToggle && (
        <PanelToggleButton
          onClick={onToggle}
          onPointerDown={(event) => event.stopPropagation()}
          title={title}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-7 w-7"
        >
          <ChevronIcon className="h-4 w-4" />
        </PanelToggleButton>
      )}
    </div>
  )
}
