/**
 * EmbeddedCrawlViews
 *
 * ⚠️ 重要：这是 crawlspace-core 包内的组件，不能直接依赖应用层的 EmbeddedCrawlView
 *
 * 策略：提供占位容器，由宿主应用注入实际的 EmbeddedCrawlView 组件
 */

import React from 'react'
import type { ViewInfo, ViewId } from '../../types'
import { t } from '../../i18n'

export interface EmbeddedCrawlViewsProps {
  views: ViewInfo[]
  activeViewId: ViewId | null
  /**
   * 🆕 渲染单个 View 的函数（由宿主应用注入）
   * 如果不提供，则只渲染占位容器
   */
  renderView?: (view: ViewInfo, isActive: boolean) => React.ReactNode
}

/**
 * EmbeddedCrawlViews 组件
 *
 * 渲染策略：
 * 1. 如果提供了 renderView，使用它渲染每个 view
 * 2. 否则，渲染占位容器（data-view-id）供外部挂载
 */
export const EmbeddedCrawlViews: React.FC<EmbeddedCrawlViewsProps> = ({
  views,
  activeViewId,
  renderView
}) => {
  if (views.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-muted/30">
        <div className="text-center p-8">
          <div className="text-display mb-4">🌐</div>
          <p className="text-body text-muted-foreground">{t('views.empty')}</p>
        </div>
      </div>
    )
  }

  // 如果提供了 renderView，使用它
  if (renderView) {
    // map渲染日志已移除
    return (
      <div className="relative w-full h-full">
        {views.map((view) => {
          const isActive = view.viewId === activeViewId
          // 循环日志已移除
          return (
            <div
              key={view.viewId}
              className="absolute inset-0"
              style={{
                display: isActive ? 'block' : 'none'
              }}
            >
              {renderView(view, isActive)}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="relative w-full h-full">
      {views.map((view) => (
        <div
          key={view.viewId}
          className="absolute inset-0"
          style={{
            display: view.viewId === activeViewId ? 'block' : 'none'
          }}
        >
          {/* Webview 占位容器 */}
          <div
            id={`crawl-view-${view.viewId}`}
            className="w-full h-full bg-background"
            data-view-id={view.viewId}
            data-url={view.url}
          />
        </div>
      ))}
    </div>
  )
}
