import React from 'react'
import { cn } from '@utils/cn'
import { SETTINGS_HINT, SETTINGS_LABEL } from './settingsUi'
import { SettingsTitleTooltip } from './SettingsTitleTooltip'

interface SettingsRowProps {
  icon?: React.ReactNode
  label: React.ReactNode
  description?: React.ReactNode
  /**
   * true：description 不占位，在 label 旁以 ⓘ 悬停展示。
   * 无 description 时行为与原先一致。
   */
  descriptionAsTooltip?: boolean
  control?: React.ReactNode
  disabled?: boolean
  className?: string
  contentClassName?: string
  controlClassName?: string
  /** 覆盖默认 SETTINGS_LABEL；用于与卡片标题同级的行名 */
  labelClassName?: string
  children?: React.ReactNode
}

export const SettingsRow: React.FC<SettingsRowProps> = ({
  icon,
  label,
  description,
  descriptionAsTooltip = false,
  control,
  disabled = false,
  className,
  contentClassName,
  controlClassName,
  labelClassName,
  children,
}) => {
  const showDescriptionInline = Boolean(description) && !descriptionAsTooltip
  const resolvedLabelClassName = labelClassName ?? SETTINGS_LABEL

  return (
    <div
      className={cn(
        'flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5',
        disabled && 'opacity-50',
        className,
      )}
      aria-disabled={disabled || undefined}
    >
      <div className={cn('flex min-w-0 flex-1 items-start gap-2.5', contentClassName)}>
        {icon ? (
          <span className="mt-0.5 shrink-0 text-muted-foreground/60">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          {descriptionAsTooltip && description ? (
            <SettingsTitleTooltip
              title={label}
              tooltip={description}
              titleClassName={resolvedLabelClassName}
            />
          ) : (
            <div className={resolvedLabelClassName}>{label}</div>
          )}
          {showDescriptionInline ? (
            <div className={cn(SETTINGS_HINT, 'mt-1')}>{description}</div>
          ) : null}
          {children}
        </div>
      </div>
      {control ? (
        <div className={cn('flex shrink-0 items-center justify-start sm:justify-end', controlClassName)}>
          {control}
        </div>
      ) : null}
    </div>
  )
}

interface SettingsRowGroupProps {
  children: React.ReactNode
  className?: string
}

export const SettingsRowGroup: React.FC<SettingsRowGroupProps> = ({
  children,
  className,
}) => (
  <div className={cn('divide-y divide-border/20', className)}>
    {children}
  </div>
)
