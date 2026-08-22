import React from 'react'
import { cn } from '@utils/cn'
import { SettingsInfoTooltip } from './SettingsInfoTooltip'

type TitleTag = 'span' | 'h2' | 'h3' | 'div'

interface SettingsTitleTooltipProps {
  title: React.ReactNode
  /** 空则只渲染标题；有值则在标题旁 ⓘ，悬停图标出说明 */
  tooltip?: React.ReactNode
  as?: TitleTag
  titleClassName?: string
  contentClassName?: string
  infoLabel?: string
}

/**
 * 设置页「标题 + 可选 ⓘ」：长说明悬停图标展示，标题本身不再整段可点。
 */
export const SettingsTitleTooltip: React.FC<SettingsTitleTooltipProps> = ({
  title,
  tooltip,
  as: Tag = 'span',
  titleClassName,
  contentClassName,
  infoLabel,
}) => {
  if (tooltip == null || tooltip === false || tooltip === '') {
    return <Tag className={titleClassName}>{title}</Tag>
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Tag className={cn('min-w-0', titleClassName)}>{title}</Tag>
      <SettingsInfoTooltip
        content={tooltip}
        contentClassName={contentClassName}
        label={infoLabel}
      />
    </div>
  )
}
