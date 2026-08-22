import type { ReactNode } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
  type TooltipContentProps,
} from '@tabtin/smartsheet-ui'

interface ChatIconTooltipProps {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: TooltipContentProps['align']
  sideOffset?: TooltipContentProps['sideOffset']
  collisionPadding?: TooltipContentProps['collisionPadding']
  delayDuration?: number
  open?: boolean
  className?: string
  triggerClassName?: string
}

export function ChatIconTooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  sideOffset,
  collisionPadding,
  delayDuration,
  open,
  className,
  triggerClassName,
}: ChatIconTooltipProps) {
  const hasContent = content !== null && content !== undefined
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <Tooltip open={open}>
        <TooltipTrigger asChild>
          <span className={cn('inline-flex shrink-0', triggerClassName)}>
            {children}
          </span>
        </TooltipTrigger>
        {hasContent ? (
          <TooltipContent
            side={side}
            align={align}
            sideOffset={sideOffset}
            collisionPadding={collisionPadding}
            className={className}
          >
            {content}
          </TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
  )
}
