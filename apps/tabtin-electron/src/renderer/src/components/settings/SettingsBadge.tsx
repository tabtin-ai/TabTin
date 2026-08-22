import React from 'react'
import { cn } from '@utils/cn'
import { SETTINGS_TEXT_MICRO } from './settingsUi'

/**
 * SettingsBadge —— 设置面板里的「软底角标」统一出口。
 *
 * 沉淀设计系统决策：角标用 `SETTINGS_TEXT_MICRO`（§2），底用纯灰 `bg-foreground/[0.06]`、
 * 文字用降饱和主题色 `text-accent-text`（§6.8 实色用灰、主题色只点睛）。
 * 语义状态角标用 tone 切换（小面积语义色，§16.2）。
 */
type SettingsBadgeTone = 'accent' | 'muted' | 'success' | 'warning' | 'destructive' | 'info'

const TONE_CLASS: Record<SettingsBadgeTone, string> = {
  accent: 'text-accent-text bg-foreground/[0.06]',
  muted: 'text-muted-foreground/60 bg-muted/30',
  success: 'text-success bg-success/10',
  warning: 'text-warning bg-warning/10',
  destructive: 'text-destructive bg-destructive/10',
  info: 'text-info bg-info/10',
}

export interface SettingsBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: SettingsBadgeTone
}

export const SettingsBadge: React.FC<SettingsBadgeProps> = ({
  tone = 'accent',
  className,
  ...props
}) => (
  <span
    className={cn(
      SETTINGS_TEXT_MICRO,
      'inline-flex items-center px-2 py-0.5 rounded',
      TONE_CLASS[tone],
      className,
    )}
    {...props}
  />
)

SettingsBadge.displayName = 'SettingsBadge'
