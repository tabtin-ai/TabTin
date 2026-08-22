import React from 'react'
import { Info } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@components/ui'
import { cn } from '@utils/cn'

interface SettingsInfoTooltipProps {
  /** 空则不渲染 */
  content?: React.ReactNode
  contentClassName?: string
  className?: string
  label?: string
}

/** 设置页说明入口：标题旁 ⓘ，悬停图标展示文案。 */
export const SettingsInfoTooltip: React.FC<SettingsInfoTooltipProps> = ({
  content,
  contentClassName,
  className,
  label = '说明',
}) => {
  if (content == null || content === false || content === '') {
    return null
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex shrink-0 cursor-help text-muted-foreground/60 hover:text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm',
              className,
            )}
            aria-label={label}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className={cn('max-w-[320px] text-left leading-relaxed', contentClassName)}
        >
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
