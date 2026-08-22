/**
 * 图标按钮共用 Tooltip（ActivityRail / 侧栏 chrome 等）。
 * 自带 Provider，可在窄栏内外单独使用。
 */

import React from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@components/ui'

export function RailIconTooltip({
  label,
  children,
  disabled = false,
  side = 'right',
  sideOffset = 10,
}: {
  label: string
  children: React.ReactElement
  /** 为 true 时强制关闭（如「更多」Popover 已打开，避免叠层） */
  disabled?: boolean
  side?: 'top' | 'right' | 'bottom' | 'left'
  sideOffset?: number
}) {
  return (
    <TooltipProvider delayDuration={1000}>
      <Tooltip {...(disabled ? { open: false } : {})}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={sideOffset} className="text-caption">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
