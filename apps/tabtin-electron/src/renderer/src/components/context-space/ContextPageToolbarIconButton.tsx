import React from 'react'
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@components/ui'
import { cn } from '@utils/cn'
import { CONTEXT_PAGE_TOOLBAR_ICON_BTN } from './constants'

interface ContextPageToolbarIconButtonProps {
  label: string
  onClick: () => void
  disabled?: boolean
  className?: string
  children: React.ReactNode
}

/** 应用主列表工具行次级操作：outline 方图标按钮 + Tooltip（导入、新建文件夹等）。 */
export const ContextPageToolbarIconButton: React.FC<ContextPageToolbarIconButtonProps> = ({
  label,
  onClick,
  disabled = false,
  className,
  children,
}) => (
  <TooltipProvider delayDuration={200}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn(CONTEXT_PAGE_TOOLBAR_ICON_BTN, className)}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
)
