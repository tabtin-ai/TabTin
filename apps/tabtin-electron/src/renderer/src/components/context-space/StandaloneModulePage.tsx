/**
 * 一级模块页（自动化 / AI分身 / 技能库等）统一页面壳：
 * CONTEXT_PAGE_SHELL_FILL 边距 + ContextPageHeader + 内容区间距。
 * 白底圆角画布由 Shell（SHELL_CANVAS_CARD_CLASS）承接，本组件只管页内边距。
 */
import React from 'react'
import { cn } from '@utils/cn'
import { ContextPageHeader } from './ContextPageHeader'
import {
  CONTEXT_PAGE_HEADER_GAP,
  CONTEXT_PAGE_SHELL_FILL,
} from './constants'

export interface StandaloneModulePageProps {
  icon: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  descriptionClassName?: string
  actions?: React.ReactNode
  titleAs?: 'div' | 'h1' | 'h2' | 'h3'
  testId?: string
  className?: string
  children: React.ReactNode
}

export const StandaloneModulePage: React.FC<StandaloneModulePageProps> = ({
  icon,
  title,
  description,
  descriptionClassName,
  actions,
  titleAs,
  testId,
  className,
  children,
}) => (
  <div
    data-testid={testId}
    className={cn('relative flex h-full min-h-0 flex-col', className)}
  >
    <div className={CONTEXT_PAGE_SHELL_FILL}>
      <ContextPageHeader
        icon={icon}
        title={title}
        titleAs={titleAs}
        description={description}
        descriptionClassName={descriptionClassName}
        actions={actions}
      />
      {/* ：内容槽必须是 flex 列，子层 flex-1/overflow-y-auto 才能拿到确定高度并滚动 */}
      <div className={cn(CONTEXT_PAGE_HEADER_GAP, 'flex min-h-0 flex-1 flex-col overflow-hidden')}>
        {children}
      </div>
    </div>
  </div>
)
