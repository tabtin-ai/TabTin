/**
 * OverflowPopover —— 标签条右上角的 +N 溢出列表
 *
 * 当某些 tab 在水平滚动视口外被滚到看不见时（详见 useOverflowDetection），
 * 在右上角显示 "+N" 按钮，点开 popover 列出隐藏的 tab，可：
 *   - 单击/Enter → 切换到该 tab（group 走 anchorTabKey fallback 链）
 *   - 中键 → 关闭该 tab
 *   - hover 时显示关闭按钮 → 关闭该 tab
 *
 * 不实现关闭动画 —— popover 内的 item 被关闭后，下次重算 overflowKeys 自然消失，
 * 用户视线已不在标签条上，无需为 popover 项加额外动画。
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
} from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT } from '@components/layout/canvasUi'
import type { ContextItem } from '@components/context-space/registry'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import type { ContextTabsT } from './NormalTab'

interface OverflowPopoverProps {
  overflowTabKeys: string[]
  activeTabKey: string | null
  groupLookup: Map<string, CanvasLayoutGroup>
  tabKeyToItem: Map<string, ContextItem>
  tabKeyToGroup: Map<string, CanvasLayoutGroup>
  t: ContextTabsT
  getLabelForTabKey: (tabKey: string | null) => string
  getIconForTabKey: (tabKey: string | null) => React.ReactNode
  isItemClosable?: (item: ContextItem) => boolean
  onActivateTabKey: (tabKey: string | null) => void
  onCloseItem: (item: ContextItem) => void
}

function resolvePreferredGroupTabKey(group: CanvasLayoutGroup): string | null {
  return (
    group.panes.find(p => p.id === group.activePaneId)?.content?.tabKey ||
    group.anchorTabKey ||
    group.panes.find(p => p.content?.tabKey)?.content?.tabKey ||
    null
  )
}

export function OverflowPopover({
  overflowTabKeys,
  activeTabKey,
  groupLookup,
  tabKeyToItem,
  tabKeyToGroup,
  t,
  getLabelForTabKey,
  getIconForTabKey,
  isItemClosable,
  onActivateTabKey,
  onCloseItem,
}: OverflowPopoverProps) {
  const [overflowOpen, setOverflowOpen] = useState(false)
  if (overflowTabKeys.length === 0) return null

  return (
    <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('tab.overflow.open', {
            count: overflowTabKeys.length,
            defaultValue: `查看隐藏的 ${overflowTabKeys.length} 个标签`,
          })}
          title={t('tab.overflow.title', { defaultValue: '隐藏的标签' })}
          className={cn('mx-1 h-6 shrink-0 self-center rounded-md px-1.5 text-muted-foreground/80 transition-colors hover:bg-muted/30 hover:text-foreground', CANVAS_TAB_TEXT)}
        >
          +{overflowTabKeys.length}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={4} className="w-60 p-1">
        <ScrollArea className="max-h-72" scrollBar="vertical" type="scroll">
          <div className="flex flex-col py-0.5">
            {overflowTabKeys.map(key => {
              const groupMatch = key.startsWith('group:')
                ? groupLookup.get(key.slice('group:'.length))
                : null
              const targetGroup = groupMatch ?? tabKeyToGroup.get(key) ?? null
              const label = targetGroup ? t('tab.group') : getLabelForTabKey(key)
              const icon = targetGroup ? null : getIconForTabKey(key)
              const isActive = !targetGroup && activeTabKey === key
              const targetItem = !targetGroup ? tabKeyToItem.get(key) ?? null : null
              const isClosable = targetItem ? (isItemClosable?.(targetItem) ?? true) : false

              const activate = () => {
                if (targetGroup) {
                  onActivateTabKey(resolvePreferredGroupTabKey(targetGroup))
                } else {
                  onActivateTabKey(key)
                }
                setOverflowOpen(false)
              }

              return (
                <div
                  key={key}
                  data-overflow-item
                  data-tab-key={key}
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
                    if (targetItem && isClosable) onCloseItem(targetItem)
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
                  {icon && <span className="shrink-0 grayscale opacity-70">{icon}</span>}
                  <span className="flex-1 min-w-0 truncate">{label}</span>
                  {targetItem && isClosable && (
                    <button
                      type="button"
                      aria-label={t('tab.menu.close')}
                      className="shrink-0 h-5 w-5 flex items-center justify-center rounded-sm text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 opacity-0 group-hover/overflow:opacity-100 transition-opacity"
                      onClick={e => {
                        e.stopPropagation()
                        onCloseItem(targetItem)
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
