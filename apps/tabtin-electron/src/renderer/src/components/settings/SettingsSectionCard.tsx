import React from 'react'
import { cn } from '@utils/cn'
import { SETTINGS_CARD_TITLE, SETTINGS_HINT } from './settingsUi'
import { SettingsInfoTooltip } from './SettingsInfoTooltip'

type SettingsSectionTone = 'default' | 'muted' | 'danger'

interface SettingsSectionCardProps {
  title?: React.ReactNode
  subtitle?: React.ReactNode
  /**
   * true：subtitle 不占位，在 title 旁以 ⓘ 悬停展示。
   * 无 title 时仍回落为内联 subtitle，避免说明丢失。
   */
  subtitleAsTooltip?: boolean
  icon?: React.ReactNode
  actions?: React.ReactNode
  tone?: SettingsSectionTone
  /** 是否使用扁平模式（无边框、无阴影、无背景） */
  flat?: boolean
  id?: string
  className?: string
  headerClassName?: string
  bodyClassName?: string
  children: React.ReactNode
}

const toneClasses: Record<SettingsSectionTone, string> = {
  default: 'bg-muted/10',
  muted: 'bg-muted/15',
  danger: 'bg-destructive/[0.05]'
}

export const SettingsSectionCard: React.FC<SettingsSectionCardProps> = ({
  title,
  subtitle,
  subtitleAsTooltip = false,
  icon,
  actions,
  tone = 'default',
  flat = false,
  id,
  className,
  headerClassName,
  bodyClassName,
  children
}) => {
  const showSubtitleInline = Boolean(subtitle) && !(subtitleAsTooltip && title)
  const titleTooltip = subtitleAsTooltip && title ? subtitle : undefined
  const hasHeader = Boolean(title || showSubtitleInline || icon || actions)
  const titleClassName = cn(flat ? undefined : 'truncate', SETTINGS_CARD_TITLE)

  const titleNode = title ? (
    titleTooltip ? (
      <div className="flex min-w-0 items-center gap-1">
        <h3 className={cn('min-w-0', titleClassName)}>{title}</h3>
        <SettingsInfoTooltip content={titleTooltip} />
      </div>
    ) : (
      <h3 className={titleClassName}>{title}</h3>
    )
  ) : null

  if (flat) {
    return (
      <section id={id} className={cn('w-full', className)}>
        {hasHeader ? (
          <div className={cn('mb-3 flex flex-col gap-1', headerClassName)}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {icon && <span className="text-muted-foreground/60">{icon}</span>}
                {titleNode}
              </div>
              {actions && <div className="flex items-center gap-2">{actions}</div>}
            </div>
            {showSubtitleInline ? <p className={SETTINGS_HINT}>{subtitle}</p> : null}
          </div>
        ) : null}
        <div className={cn(hasHeader && 'pl-3.5', bodyClassName)}>
          {children}
        </div>
      </section>
    )
  }

  return (
    <section
      id={id}
      className={cn(
        'rounded-[12px] px-4 py-3',
        toneClasses[tone],
        className
      )}
    >
      {hasHeader ? (
        <div className={cn('flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between', headerClassName)}>
          <div className="flex min-w-0 items-start gap-2.5">
            {icon ? (
              <span className="text-muted-foreground/60 shrink-0 mt-0.5">{icon}</span>
            ) : null}
            <div className="min-w-0">
              {titleNode}
              {showSubtitleInline ? (
                <p className={cn('mt-0.5', SETTINGS_HINT)}>{subtitle}</p>
              ) : null}
            </div>
          </div>
          {actions ? (
            <div className="flex items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : null}

      <div className={cn(hasHeader && 'mt-3 pl-3.5', bodyClassName)}>
        {children}
      </div>
    </section>
  )
}
