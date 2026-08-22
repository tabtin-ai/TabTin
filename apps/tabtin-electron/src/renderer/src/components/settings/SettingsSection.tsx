import React from 'react'
import { cn } from '@utils/cn'
import { SETTINGS_CARD_TITLE, SETTINGS_HINT } from './settingsUi'
import { SettingsInfoTooltip } from './SettingsInfoTooltip'

/**
 * SettingsSection —— 设置面板里「扁平分区」统一出口（非卡片）。
 *
 * 分区标题与 `SettingsSectionCard` 共用 `SETTINGS_CARD_TITLE`（字号/颜色/字重一致）；
 * 标题行右侧可挂动作链接，下方可带副标题（`SETTINGS_HINT`）。
 * 有标题时子内容 `pl-3.5`，与卡片式分区父子层级一致。
 */
export interface SettingsSectionProps {
  title?: React.ReactNode
  /** 标题行右侧动作（通常是 SettingsLink）。 */
  action?: React.ReactNode
  subtitle?: React.ReactNode
  /**
   * true：subtitle 不占位，在 title 旁以 ⓘ 悬停展示。
   * 无 title 时仍回落为内联 subtitle，避免说明丢失。
   */
  subtitleAsTooltip?: boolean
  id?: string
  className?: string
  headerClassName?: string
  children: React.ReactNode
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  action,
  subtitle,
  subtitleAsTooltip = false,
  id,
  className,
  headerClassName,
  children,
}) => {
  const showSubtitleInline = Boolean(subtitle) && !(subtitleAsTooltip && title)
  const hasHeader = Boolean(title || action || showSubtitleInline)
  const titleNode = title ? (
    subtitleAsTooltip && subtitle ? (
      <div className="flex min-w-0 items-center gap-1">
        <h3 className={cn('min-w-0', SETTINGS_CARD_TITLE)}>{title}</h3>
        <SettingsInfoTooltip content={subtitle} />
      </div>
    ) : (
      <h3 className={SETTINGS_CARD_TITLE}>{title}</h3>
    )
  ) : null

  return (
    <section id={id} className={cn('space-y-3', className)}>
      {hasHeader && (
        <div className={headerClassName}>
          {(titleNode || action) && (
            <div className="flex items-center justify-between gap-2">
              {titleNode ?? <span />}
              {action ? <div className="shrink-0">{action}</div> : null}
            </div>
          )}
          {showSubtitleInline ? <p className={cn(SETTINGS_HINT, 'mt-1')}>{subtitle}</p> : null}
        </div>
      )}
      <div className={cn('space-y-3', hasHeader && 'pl-3.5')}>{children}</div>
    </section>
  )
}

SettingsSection.displayName = 'SettingsSection'
