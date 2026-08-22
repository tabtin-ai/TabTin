/**
 * CrawlspaceViewTabs - 标签栏组件
 *
 * 类似 Chrome 的标签栏，管理 Crawlspace 内的多个页面 View
 * 从 WorkspaceViewTabs 迁移
 */

import React, { useCallback, useRef } from 'react'
import { Plus } from 'lucide-react'
import { CrawlspaceViewTab } from './CrawlspaceViewTab'
import { CrawlspaceTabsOverflowPopover } from './CrawlspaceTabsOverflowPopover'
import { useTabsOverflowDetection } from '../../hooks/useTabsOverflowDetection'
import type { ViewInfo } from '../../types'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { t } from '../../i18n'
import { cn } from '../../utils/cn'

export interface CrawlspaceViewTabsProps {
  views: ViewInfo[]
  activeViewId: string | null
  onSelectView: (viewId: string) => void
  onCloseView: (viewId: string) => void
  onNewView: () => void
  showNewButton?: boolean
  className?: string
  showClose?: boolean
  /** Session 颜色标识，透传给每个标签页底部颜色条 */
  accentColor?: string
  getViewDragData?: (view: ViewInfo) => {
    text: string
    mimeData: Record<string, string>
    effectAllowed?: DataTransfer['effectAllowed']
  } | null
}

export const CrawlspaceViewTabs: React.FC<CrawlspaceViewTabsProps> = ({
  views,
  activeViewId,
  onSelectView,
  onCloseView,
  onNewView,
  showNewButton = true,
  className,
  showClose = true,
  accentColor,
  getViewDragData
}) => {
  const tablistRef = useRef<HTMLDivElement>(null)
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const { canScrollLeft, canScrollRight, overflowKeys } = useTabsOverflowDetection({
    viewportRef: scrollViewportRef,
    deps: [views.length, activeViewId],
  })

  const handleTablistKeyDown = useCallback((e: React.KeyboardEvent) => {
    const tabs = tablistRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')
    if (!tabs || tabs.length === 0) return

    const currentIndex = Array.from(tabs).findIndex(tab => tab === document.activeElement)
    if (currentIndex === -1) return

    let nextIndex: number | null = null
    if (e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % tabs.length
    } else if (e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
    } else if (e.key === 'Home') {
      nextIndex = 0
    } else if (e.key === 'End') {
      nextIndex = tabs.length - 1
    }

    if (nextIndex !== null) {
      e.preventDefault()
      tabs[nextIndex].focus()
      const viewId = views[nextIndex]?.viewId
      if (viewId) onSelectView(viewId)
    }
  }, [views, onSelectView])

  return (
    <div
      className={cn(
        'relative flex items-stretch rounded-md bg-muted/40 border border-border/50 overflow-hidden',
        className
      )}
    >
      <div className="relative min-w-0 flex-1">
        {canScrollLeft && (
          <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 bg-gradient-to-r from-muted/40 to-transparent z-10" />
        )}
        {canScrollRight && (
          <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-muted/40 to-transparent z-10" />
        )}
        <ScrollArea
          scrollBar="horizontal"
          type="scroll"
          viewportRef={scrollViewportRef}
        >
          <div
            ref={tablistRef}
            role="tablist"
            aria-label={t('tabs.tabListLabel')}
            className="flex items-center gap-1 px-2 py-1"
            onKeyDown={handleTablistKeyDown}
          >
            {views.map((view) => (
              <CrawlspaceViewTab
                key={view.viewId}
                viewId={view.viewId}
                title={view.title}
                url={view.url}
                favicon={view.favicon}
                isActive={view.viewId === activeViewId}
                onSelect={() => onSelectView(view.viewId)}
                onClose={() => onCloseView(view.viewId)}
                showClose={showClose}
                status={view.status}
                accentColor={accentColor}
                dragData={getViewDragData?.(view) ?? null}
              />
            ))}

            {/* 新建标签按钮 —— 跟随 tabs 滚动；溢出时由右侧 +N 兜底 */}
            {showNewButton && (
              <button
                className="flex-shrink-0 p-2 rounded-t hover:bg-muted/30 transition-colors"
                onClick={onNewView}
                title={t('tabs.newTabTitle')}
                aria-label={t('tabs.newTabTitle')}
              >
                <Plus className="w-4 h-4 text-muted-foreground" />
              </button>
            )}
          </div>
        </ScrollArea>
      </div>
      <CrawlspaceTabsOverflowPopover
        overflowKeys={overflowKeys}
        views={views}
        activeViewId={activeViewId}
        onSelectView={onSelectView}
        onCloseView={onCloseView}
        showClose={showClose}
      />
    </div>
  )
}
