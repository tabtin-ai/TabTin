import React from 'react'
import { DialogDescription, DialogHeader, DialogTitle } from '@components/ui'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'

interface ContextDialogHeaderProps {
  icon: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** 紧跟标题右侧的附属控件（如次要操作），不计入 DialogTitle 可访问名 */
  titleAccessory?: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
  iconClassName?: string
  titleClassName?: string
}

export const ContextDialogHeader: React.FC<ContextDialogHeaderProps> = ({
  icon,
  title,
  description,
  titleAccessory,
  actions,
  children,
  className,
  iconClassName,
  titleClassName,
}) => {
  return (
    <DialogHeader className={cn('px-5 pt-5 pb-3 shrink-0', className)}>
      <div className="flex min-w-0 items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <span className={cn(
            'flex h-14 w-14 shrink-0 items-center justify-center rounded-[12px] bg-foreground/[0.04] text-primary-text',
            iconClassName,
          )}>
            {icon}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <DialogTitle className={cn('truncate text-title font-semibold text-foreground', titleClassName)}>
                {title}
              </DialogTitle>
              {titleAccessory != null ? (
                <div className="flex shrink-0 items-center gap-2">{titleAccessory}</div>
              ) : null}
            </div>
            {description != null && description !== false ? (
              <DialogDescription asChild>
                <div className={cn('mt-0.5', 'leading-relaxed', 'text-muted-foreground/60', CANVAS_TEXT_META)}>
                {description}
                </div>
              </DialogDescription>
            ) : null}
          </div>
        </div>
        {actions != null ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {children}
    </DialogHeader>
  )
}
