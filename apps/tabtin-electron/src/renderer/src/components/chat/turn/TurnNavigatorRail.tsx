/**
 * TurnNavigatorRail — 对话轮次快捷导航列
 *
 * 消息列表左边缘的一列小点，每个点对应一轮用户输入：
 *   - hover 显示该轮用户消息的文本预览（Tooltip 右弹）
 *   - 点击滚动定位到该轮
 *   - 滚动时高亮当前视口所在轮次（scroll-spy）
 *
 * 列表是虚拟化的（视口外 DOM 不存在），所以 scroll-spy 不走 IntersectionObserver，
 * 而是监听滚动容器 scroll 事件 + virtualizer.getVirtualItems() 推导视口顶部消息。
 *
 * 布局：flex 列 + 每项「基准 18px、可收缩到 6px」，轮次多时自动压缩间距，
 * 不需要 JS 测量。极端超长对话（点压缩到底仍放不下）时两端溢出裁切。
 */
import React, { useCallback, useEffect, useState } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { resolveActiveTurnIndex, type TurnNavigatorEntry } from './turnNavigator'

interface TurnNavigatorRailProps {
  entries: TurnNavigatorEntry[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
  scrollElementRef: React.RefObject<HTMLDivElement | null>
  onSelect: (entry: TurnNavigatorEntry) => void
}

export function TurnNavigatorRail({
  entries,
  virtualizer,
  scrollElementRef,
  onSelect,
}: TurnNavigatorRailProps) {
  const { t } = useTranslation('chat')
  // 列表初始停在底部 → 默认最后一轮；挂载后 recompute 立即校正
  const [activeIdx, setActiveIdx] = useState(entries.length - 1)

  const recompute = useCallback(() => {
    const container = scrollElementRef.current
    if (!container) return
    // 贴底特例：末轮很短时按「视口顶部」永远轮不到它——贴底即最后一轮
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    if (distanceFromBottom <= 8) {
      setActiveIdx(entries.length - 1)
      return
    }
    const items = virtualizer.getVirtualItems()
    if (items.length === 0) return
    // 视口顶部第一条可见消息（end 越过 scrollTop 的第一项；overscan 项 end 在其上方）
    const top = container.scrollTop + 1
    let topIndex = items[items.length - 1].index
    for (const item of items) {
      if (item.start + item.size > top) {
        topIndex = item.index
        break
      }
    }
    setActiveIdx(resolveActiveTurnIndex(entries, topIndex))
  }, [entries, virtualizer, scrollElementRef])

  // 每次渲染后无条件重算：覆盖初挂载（虚拟行未测量）、hot-spaces 隐藏→可见
  // （无 scroll 事件）、消息增删等所有非滚动路径。setState 同值 bail out，
  // 不会造成渲染循环。
  useEffect(() => {
    recompute()
  })

  useEffect(() => {
    const container = scrollElementRef.current
    if (!container) return
    let rafId: number | null = null
    const onScroll = () => {
      if (rafId != null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        recompute()
      })
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (rafId != null) cancelAnimationFrame(rafId)
    }
  }, [recompute, scrollElementRef])

  return (
    <nav
      aria-label={t('turnNav.railLabel', '对话轮次导航')}
      className="pointer-events-none absolute bottom-0 left-0 top-0 z-sticky flex w-3 flex-col items-center justify-center overflow-hidden py-4"
      data-testid="turn-navigator-rail"
    >
      {entries.map((entry, i) => {
        const isActive = i === activeIdx
        const preview = entry.preview || t('turnNav.emptyPreview', '（无文本内容）')
        return (
          <ChatIconTooltip
            key={entry.id}
            content={preview}
            side="right"
            align="center"
            triggerClassName="pointer-events-auto w-full min-h-1.5 shrink basis-5 justify-center"
          >
            <button
              type="button"
              onClick={() => onSelect(entry)}
              aria-label={t('turnNav.jumpToTurn', {
                defaultValue: '跳转到第 {{index}} 轮：{{preview}}',
                index: i + 1,
                preview,
              })}
              aria-current={isActive ? 'true' : undefined}
              data-active={isActive ? 'true' : undefined}
              className="group/turn-dot flex h-full w-full items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 rounded-interactive"
            >
              <span
                aria-hidden
                className={cn(
                  'h-1 rounded-full transition-all duration-150',
                  isActive
                    ? 'w-2.5 bg-accent'
                    : 'w-1 bg-muted-foreground/30 group-hover/turn-dot:w-2 group-hover/turn-dot:bg-muted-foreground/80',
                )}
              />
            </button>
          </ChatIconTooltip>
        )
      })}
    </nav>
  )
}
