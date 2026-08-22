/**
 * CloudDocsMainCanvas —— 云文档一级域主画布。
 *
 * 只渲染云文档内容（apphome:cloud-resources / 已打开的文档表格 tab），
 * 不挂 Space 工作台标签栏、桌面侧栏 portal 等任务域 chrome。
 *
 * HTML 块「在浏览器打开」的 tabweb 与 tabdoc 共用 cloud-docs scope：侧栏 Dock 列出标签，
 * 主区切换展示；需挂 workspaceLayerHost + CrawlspaceWorkspace（与 SpaceWorkbenchHost 同构）。
 */
import React, { Activity, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { OverlayContainerProvider } from '@components/ui'
import { SpaceContextContainer } from '@components/context-space/SpaceContextContainer'
import type { SpaceContext } from '@components/context-space/SpaceContextContainer'
import { SpaceActivityProvider } from './SpaceActivityContext'
import type { CrawlspaceConfig } from '@stores/useCrawlTabStore'

const CrawlspaceWorkspace = React.lazy(() =>
  import('@components/crawlspace-workspace/CrawlspaceWorkspace').then(m => ({ default: m.CrawlspaceWorkspace }))
)

function createWorkspaceHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.style.display = 'contents'
  return host
}

interface CloudDocsMainCanvasProps {
  activeSpaceContext: SpaceContext
  tabScopeKey: string
  shellCanvasVisible?: boolean
  crawlspaceConfigById: Record<string, CrawlspaceConfig>
  workspaceLayerVisible?: boolean
}

export const CloudDocsMainCanvas: React.FC<CloudDocsMainCanvasProps> = ({
  activeSpaceContext,
  tabScopeKey,
  shellCanvasVisible = true,
  crawlspaceConfigById,
  workspaceLayerVisible = false,
}) => {
  const overlayContainerRef = useRef<HTMLDivElement>(null)
  const workspaceLayerOverlayRef = useRef<HTMLDivElement>(null)
  const workspaceLayerHostRef = useRef<HTMLDivElement | null>(null)
  if (!workspaceLayerHostRef.current) {
    workspaceLayerHostRef.current = createWorkspaceHost()
  }
  const workspaceLayerHost = workspaceLayerHostRef.current

  const crawlspaceId = useMemo(() => {
    for (const config of Object.values(crawlspaceConfigById)) {
      const carrierKey = config.browserScopeKey ?? config.spaceId
      if (carrierKey === tabScopeKey) {
        return config.crawlspaceId
      }
    }
    for (const config of Object.values(crawlspaceConfigById)) {
      if (config.spaceId === activeSpaceContext.id) {
        return config.crawlspaceId
      }
    }
    return null
  }, [activeSpaceContext.id, crawlspaceConfigById, tabScopeKey])

  const crawlspaceConfig = crawlspaceId ? crawlspaceConfigById[crawlspaceId] : null
  const crawlspaceVisible = workspaceLayerVisible && Boolean(crawlspaceId)

  return (
    <SpaceActivityProvider activity="foreground">
      <OverlayContainerProvider containerRef={overlayContainerRef}>
        <div ref={overlayContainerRef} className="flex h-full min-h-0 w-full min-w-0 flex-col">
          {crawlspaceId && crawlspaceConfig
            ? createPortal(
                <Activity mode={crawlspaceVisible ? 'visible' : 'hidden'}>
                  <OverlayContainerProvider containerRef={workspaceLayerOverlayRef}>
                    <div ref={workspaceLayerOverlayRef} className="absolute inset-0">
                      <React.Suspense fallback={null}>
                        <CrawlspaceWorkspace
                          crawlspaceId={crawlspaceId}
                          crawlspaceConfig={crawlspaceConfig}
                          tabScopeKey={tabScopeKey}
                          isActive={crawlspaceVisible}
                        />
                      </React.Suspense>
                    </div>
                  </OverlayContainerProvider>
                </Activity>,
                workspaceLayerHost,
              )
            : null}
          <SpaceContextContainer
            space={activeSpaceContext}
            tabScopeKey={tabScopeKey}
            crawlspaceId={crawlspaceId}
            workspaceLayerHost={workspaceLayerHost}
            hideTabsBar
            shellCanvasVisible={shellCanvasVisible}
          />
        </div>
      </OverlayContainerProvider>
    </SpaceActivityProvider>
  )
}

CloudDocsMainCanvas.displayName = 'CloudDocsMainCanvas'
