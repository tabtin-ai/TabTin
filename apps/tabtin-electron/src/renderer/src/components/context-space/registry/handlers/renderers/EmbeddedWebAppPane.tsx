/**
 * EmbeddedWebAppPane — 通用的嵌入式 Web 应用渲染器
 *
 * 复用 TabWeb 的 CrawlViewPortalHost 技术栈，将第三方 Web 应用嵌入 Context Space。
 * 与 BrowserPaneRenderer 的区别：绑定特定 appId，有独立的 session 隔离。
 * 适用于所有 marketplace app 的 embeddedWeb 渲染。
 */

import React from 'react'
import { CrawlViewPortalHost } from '@components/crawl/portal/CrawlViewPortalHost'

interface EmbeddedWebAppPaneProps {
  appId: string
  viewId: string
  isGroupActive?: boolean
  onPaneInteraction?: () => void
}

export const EmbeddedWebAppPane: React.FC<EmbeddedWebAppPaneProps> = ({
  appId,
  viewId,
  isGroupActive,
  onPaneInteraction,
}) => {
  return (
    <CrawlViewPortalHost
      viewId={viewId}
      isActive={isGroupActive}
      priority={1}
      source="canvas"
      enabled={Boolean(isGroupActive)}
      className="h-full w-full"
      data-canvas-view-id={viewId}
      data-marketplace-app={appId}
      onInteraction={onPaneInteraction}
    />
  )
}
