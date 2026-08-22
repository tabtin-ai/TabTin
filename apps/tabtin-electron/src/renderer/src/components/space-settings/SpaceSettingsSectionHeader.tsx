import React from 'react'
import { cn } from '@utils/cn'
import { SETTINGS_HINT } from '@components/settings/settingsUi'
import { useSettingsPanelHeaderFooter, useCompositeTabActive } from '@components/settings/SettingsPanelHeader'

export interface SpaceSettingsSectionHeaderProps {
  title: React.ReactNode
  description?: React.ReactNode
  /** 追加到描述段落的 class（如多段说明中的第二段样式） */
  descriptionClassName?: string
  /** 右侧操作区（按钮等） */
  actions?: React.ReactNode
  className?: string
  /** 默认 mb-4；列表页可改为 mb-3 */
  marginBottomClassName?: string
}

/**
 * Agent 设置（SpaceSettingsPane）右侧子面板统一页眉：text-subtitle + SETTINGS_HINT。
 */
export const SpaceSettingsSectionHeader: React.FC<SpaceSettingsSectionHeaderProps> = ({
  title,
  description,
  descriptionClassName,
  actions,
  className,
  marginBottomClassName = 'mb-4',
}) => {
  const footer = useSettingsPanelHeaderFooter()
  const showCompositeFooter = useCompositeTabActive()

  return (
    <div
      className={cn(
        marginBottomClassName,
        className,
      )}
    >
      <div className="flex w-full shrink-0 items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h3 className="text-subtitle font-medium text-foreground">{title}</h3>
          {description != null && description !== false && (
            <div className={cn(SETTINGS_HINT, descriptionClassName)}>{description}</div>
          )}
        </div>
        {actions != null ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {footer != null && showCompositeFooter ? <div className="mt-3">{footer}</div> : null}
    </div>
  )
}
