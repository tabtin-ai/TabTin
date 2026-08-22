/**
 * CrawlspaceTabsOverflowPopover —— 标签条右侧的 +N 溢出列表
 *
 * 当 tabs 总宽超过容器，被 useTabsOverflowDetection 检测出滚到视口外的 view，
 * 在右上角显示 "+N" 按钮，点开 popover 列出隐藏的 tab：
 *   - 单击/Enter → 切换并关闭 popover
 *   - 中键 / hover X 按钮 → 关闭该 view
 *
 * 与 ContextTabs 的 OverflowPopover 同结构，但 Crawlspace 没有 group 概念，简化为单层 view 列表。
 */
import React, { useState } from 'react'
import { Globe, X } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent, ScrollArea } from '@tabtin/smartsheet-ui'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'
import type { ViewInfo } from '../../types'

export interface CrawlspaceTabsOverflowPopoverProps {
  overflowKeys: string[]
  views: ViewInfo[]
  activeViewId: string | null
  onSelectView: (viewId: string) => void
  onCloseView: (viewId: string) => void
  showClose?: boolean
}

export const CrawlspaceTabsOverflowPopover: React.FC<CrawlspaceTabsOverflowPopoverProps> = ({
  overflowKeys,
  views,
  activeViewId,
  onSelectView,
  onCloseView,
  showClose = true,
}) => {
  const [open, setOpen] = useState(false)
  if (overflowKeys.length === 0) return null

  const viewMap = new Map(views.map(v => [v.viewId, v]))
  const overflowViews = overflowKeys
    .map(k => viewMap.get(k))
    .filter((v): v is ViewInfo => Boolean(v))

  if (overflowViews.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('tabs.overflow.open', { count: overflowViews.length })}
          title={t('tabs.overflow.title')}
          className="h-7 self-center mx-1 px-1.5 rounded-md text-caption text-muted-foreground/80 hover:text-foreground hover:bg-muted/30 transition-colors shrink-0"
        >
          +{overflowViews.length}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={4} className="w-60 p-1">
        <ScrollArea className="max-h-72" scrollBar="vertical" type="scroll">
          <div className="flex flex-col py-0.5">
            {overflowViews.map(view => {
              const isActive = activeViewId === view.viewId

              const activate = () => {
                onSelectView(view.viewId)
                setOpen(false)
              }

              return (
                <div
                  key={view.viewId}
                  data-overflow-item
                  data-tab-key={view.viewId}
                  className={cn(
                    'group/overflow flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-body transition-colors cursor-pointer',
                    isActive
                      ? 'bg-accent/10 text-foreground'
                      : 'text-foreground/80 hover:bg-muted/30',
                  )}
                  role="button"
                  tabIndex={0}
                  onClick={activate}
                  onAuxClick={e => {
                    if (e.button !== 1) return
                    e.preventDefault()
                    e.stopPropagation()
                    onCloseView(view.viewId)
                  }}
                  onMouseDown={e => {
                    if (e.button === 1) e.preventDefault()
                  }}
                  onKeyDown={e => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    activate()
                  }}
                >
                  <span className="shrink-0 w-4 h-4 flex items-center justify-center">
                    {view.favicon ? (
                      <img
                        src={view.favicon}
                        alt=""
                        draggable={false}
                        className="w-4 h-4 object-contain"
                        onError={e => {
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    ) : (
                      <Globe className="w-3.5 h-3.5 text-muted-foreground" />
                    )}
                  </span>
                  <span className="flex-1 min-w-0 truncate" title={view.title}>
                    {view.title}
                  </span>
                  {showClose && (
                    <button
                      type="button"
                      aria-label={t('common.close')}
                      className="shrink-0 h-5 w-5 flex items-center justify-center rounded-sm text-muted-foreground/50 hover:text-foreground hover:bg-muted/40 opacity-0 group-hover/overflow:opacity-100 transition-opacity"
                      onClick={e => {
                        e.stopPropagation()
                        onCloseView(view.viewId)
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
