import React, { createContext, useContext } from 'react'
import { cn } from '@utils/cn'
import { SETTINGS_HINT } from './settingsUi'

interface SettingsPanelHeaderProps {
  icon: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  meta?: React.ReactNode
  className?: string
}

const SettingsPanelHeaderFooterContext = createContext<React.ReactNode>(null)

/** composite 内非激活 tab 不重复渲染顶部 tab 条（forceMount 保活时避免 DOM 重复）。 */
const CompositeTabActiveContext = createContext(true)

export const SettingsPanelHeaderFooterProvider = SettingsPanelHeaderFooterContext.Provider

export const CompositeTabActiveProvider = CompositeTabActiveContext.Provider

export function useSettingsPanelHeaderFooter(): React.ReactNode {
  return useContext(SettingsPanelHeaderFooterContext)
}

export function useCompositeTabActive(): boolean {
  return useContext(CompositeTabActiveContext)
}

/**
 * 个人 / 团队设置面板统一页眉。
 * 图标与「标题 + 副标题」整块并排；图标外统一浅色圆形底（bg-muted/10），
 * 不用 ContextPageHeader 的大图标块（那是工作台 App 页专用）。
 */
export const SettingsPanelHeader: React.FC<SettingsPanelHeaderProps> = ({
  icon,
  title,
  subtitle,
  meta,
  className
}) => {
  const footer = useSettingsPanelHeaderFooter()
  const showCompositeFooter = useCompositeTabActive()

  return (
    <div className={cn('mb-4', className)}>
      <header className="flex items-start justify-between gap-4 border-b border-foreground/[0.06] pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted/40 text-primary-text [&_svg]:!h-6 [&_svg]:!w-6">
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-subtitle font-medium text-foreground">{title}</h2>
            {subtitle != null && subtitle !== false ? (
              <div className={cn(SETTINGS_HINT, 'mt-1')}>{subtitle}</div>
            ) : null}
          </div>
        </div>
        {meta != null ? <div className="shrink-0">{meta}</div> : null}
      </header>
      {footer != null && showCompositeFooter ? <div className="mt-3">{footer}</div> : null}
    </div>
  )
}
