import React from 'react'
import { cn } from '@utils/cn'

/**
 * SettingsLink —— 设置/仪表盘面板里的「动作链接按钮」统一出口。
 *
 * 沉淀设计系统决策：操作按钮/可点文字一律 `text-body`（§2，禁 caption），
 * 主题色用降饱和 `text-accent-text`（§6.8）。跨页面统一动作链接外观。
 * 语义动作用 tone 切换（accent 默认 / destructive 危险 / muted 次要中性）。
 */
type SettingsLinkTone = 'accent' | 'destructive' | 'muted'

const TONE_CLASS: Record<SettingsLinkTone, string> = {
  accent: 'text-accent-text hover:text-accent-text/80',
  destructive: 'text-destructive hover:text-destructive/80',
  muted: 'text-muted-foreground/60 hover:text-foreground',
}

export interface SettingsLinkProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: SettingsLinkTone
}

export const SettingsLink = React.forwardRef<HTMLButtonElement, SettingsLinkProps>(
  ({ tone = 'accent', className, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center gap-1 text-body transition-colors disabled:opacity-40',
        TONE_CLASS[tone],
        className,
      )}
      {...props}
    />
  ),
)

SettingsLink.displayName = 'SettingsLink'
