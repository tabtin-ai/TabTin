import React from 'react'
import { CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { cn } from '@utils/cn'

interface ContextPageHeaderProps {
  icon: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** 覆盖副标题默认 `truncate`；含可点击链接时建议传空或 `whitespace-normal`。 */
  descriptionClassName?: string
  actions?: React.ReactNode
  footer?: React.ReactNode
  className?: string
  iconClassName?: string
  /**
   * 完整 App 图标自身已经带有圆角底板，不应再叠加页头的灰色图标底座。
   * 普通线性图标继续使用默认 muted 底座。
   */
  iconSurface?: 'muted' | 'none'
  titleClassName?: string
  titleAs?: 'div' | 'h1' | 'h2' | 'h3'
}

export const ContextPageHeader: React.FC<ContextPageHeaderProps> = ({
  icon,
  title,
  description,
  descriptionClassName,
  actions,
  footer,
  className,
  iconClassName,
  iconSurface = 'muted',
  titleClassName,
  titleAs: Title = 'div',
}) => {
  return (
    <div className={cn('min-w-0 w-full', className)}>
      <div className="flex min-w-0 items-end justify-between gap-4">
        <div className="flex min-w-0 items-end gap-4">
          <span className={cn(
            'flex h-14 w-14 shrink-0 items-center justify-center rounded-[12px] text-primary-text',
            iconSurface === 'muted' && 'bg-foreground/[0.04]',
            iconClassName,
          )}>
            {icon}
          </span>
          <div className="min-w-0">
            <Title className={cn('truncate text-subtitle font-semibold text-foreground', titleClassName)}>
              {title}
            </Title>
            {description != null && description !== false ? (
              <div className={cn('mt-0.5', CANVAS_TEXT_SECONDARY, descriptionClassName ?? 'truncate')}>
                {description}
              </div>
            ) : null}
          </div>
        </div>
        {actions != null ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {footer != null ? (
        <div className="mt-3">{footer}</div>
      ) : null}
    </div>
  )
}
