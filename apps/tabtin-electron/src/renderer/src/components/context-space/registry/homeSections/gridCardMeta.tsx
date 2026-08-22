import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { cn } from '@utils/cn'
/**
 * 宫格卡片底部元信息行 — 统一单行布局与截断策略。
 *
 * 优先级：时间（必保完整）> 类型（可截断）> 尾部 badge（图标化）。
 */
import React from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@tabtin/smartsheet-ui'

export interface GridCardMetaRowProps {
  typeLabel?: string | null
  /** 自定义左侧内容（如状态 chip），与 typeLabel 互斥，typeLabel 优先 */
  prefix?: React.ReactNode
  time?: string
  statusLabel?: string
  trailing?: React.ReactNode
}

export const GridCardMetaRow: React.FC<GridCardMetaRowProps> = ({
  typeLabel,
  prefix,
  time,
  statusLabel,
  trailing,
}) => (
  <div className="flex min-w-0 w-full flex-nowrap items-center gap-1 overflow-hidden">
    {statusLabel ? (
      <span className="min-w-0 flex-1 truncate text-destructive/80">{statusLabel}</span>
    ) : typeLabel ? (
      <span className="min-w-0 flex-1 truncate text-muted-foreground/80">{typeLabel}</span>
    ) : prefix ? (
      <span className="min-w-0 flex-1 truncate">{prefix}</span>
    ) : null}
    {time && (
      <span className="shrink-0 whitespace-nowrap">{time}</span>
    )}
    {trailing && (
      <span className="ml-auto shrink-0">{trailing}</span>
    )}
  </div>
)

export interface ResourceGridSpaceBadgeProps {
  spaceName: string
}

/** 跨 Space 来源标识：宫格内只显示 ↗，完整 Space 名 hover 展示。 */
export const ResourceGridSpaceBadge: React.FC<ResourceGridSpaceBadgeProps> = ({ spaceName }) => {
  if (!spaceName) return null

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn('inline-flex', 'h-4', 'w-4', 'items-center', 'justify-center', 'rounded', 'hover:text-muted-foreground/80', CANVAS_TEXT_META)}
            aria-label={spaceName}
          >
            ↗
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{spaceName}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
