import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useSafeVirtualizer } from '@hooks/useSafeVirtualizer'
import { useScrollPositionPreserve } from '@hooks/useScrollPositionPreserve'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import type { SessionListVirtualItem } from './buildSessionListVirtualItems'
import { shouldScrollToSession, type SessionListScrollIntent } from './sessionListScroll'

/**
 * 行高估测（含 ChatSessionSwitcherList 外层 pb-0.5）。
 * 行包装用 minHeight=size 占位；估高宜 ≥ 真内容高，避免 start 偏小叠层。
 */
function estimateVirtualItemSize(item: SessionListVirtualItem | undefined): number {
  if (!item) return 36
  if (item.type === 'tracker_error') return 58
  if (item.type === 'tracker_loading') return 36
  // header（含 space:）、space_section_header、session 统一 36
  return 36
}

export function useSessionListVirtualizer(params: {
  flatListItems: SessionListVirtualItem[]
  scopeKey?: string | null
  variant: 'tabs' | 'list'
  currentSessionId: string | null
  scrollIntent?: SessionListScrollIntent | null
  spaceNameById?: Record<string, string>
}) {
  const {
    flatListItems,
    scopeKey,
    variant,
    currentSessionId,
    scrollIntent = null,
    spaceNameById,
  } = params
  const listParentRef = useRef<HTMLDivElement>(null)
  const flatListItemsRef = useRef(flatListItems)
  flatListItemsRef.current = flatListItems

  const getScrollElement = useCallback(() => listParentRef.current, [])
  const estimateSize = useCallback((index: number) => {
    return estimateVirtualItemSize(flatListItemsRef.current[index])
  }, [])
  const getItemKey = useCallback((index: number) => {
    const item = flatListItemsRef.current[index]
    if (!item) return index
    if (item.type === 'header') return `hdr-${item.key}`
    if (item.type === 'space_section_header') {
      return `space-section-header:${item.sectionKey ?? 'default'}`
    }
    if (item.type === 'tracker_loading') return 'tracker-loading'
    if (item.type === 'tracker_error') return 'tracker-error'
    if (item.type === 'external_archive') {
      return `ext:${item.spaceId}:${item.archive.source}:${item.archive.sourceSessionId}`
    }
    return item.session.id
  }, [])

  const getEstimatedItemStart = useCallback((targetIndex: number) => {
    let offset = 0
    for (let index = 0; index < targetIndex; index += 1) {
      offset += estimateSize(index)
    }
    return offset
  }, [estimateSize])

  const { isForeground } = useSpaceActivity()
  const virtualizer = useSafeVirtualizer({
    count: flatListItems.length,
    getScrollElement,
    estimateSize,
    overscan: 8,
    getItemKey,
    enabled: isForeground,
  })

  // fork 展开/置顶树变化会插入多行；enabled false→true 会清空 measurementsCache。
  // 结构指纹变化时强制重测，避免子行高度仍按 0/旧缓存，导致与下方工作空间重叠。
  const listStructureKey = useMemo(() => (
    flatListItems.map((item) => {
      if (item.type === 'session') {
        return `s:${item.session.id}:d${item.forkDepth ?? 0}:b${item.forkBranch ? `${item.forkBranch.collapsed ? 1 : 0}-${item.forkBranch.childCount}` : '0'}`
      }
      if (item.type === 'header') return `h:${item.key}:${item.collapsed ? 1 : 0}`
      if (item.type === 'space_section_header') {
        return `ss:${item.sectionKey ?? 'default'}:${item.collapsed ? 1 : 0}`
      }
      if (item.type === 'external_archive') {
        return `e:${item.spaceId}:${item.archive.source}:${item.archive.sourceSessionId}`
      }
      return item.type
    }).join('|')
  ), [flatListItems])

  useLayoutEffect(() => {
    if (!isForeground) return
    virtualizer.measure()
  }, [isForeground, listStructureKey, virtualizer])

  useScrollPositionPreserve({
    scrollElementRef: listParentRef,
    totalSize: virtualizer.getTotalSize(),
    scopeKey: scopeKey ?? null,
  })

  // 仅在列表中的用户选择产生 scrollIntent 时 scrollToIndex。
  // 后台 currentSessionId 对齐、SWR、列表重排或父组件重渲染都不能拽回用户
  // 正在浏览的滚动位置；用户选择屏外会话时仍只定位一次。
  const lastConsumedScrollIntentSequenceRef = useRef<number | null>(null)

  useEffect(() => {
    if (variant !== 'list') return
    if (!currentSessionId || !scrollIntent) return

    const idx = flatListItems.findIndex(
      item => item.type === 'session' && item.session.id === currentSessionId,
    )
    if (idx < 0) return

    const scrollElement = listParentRef.current
    const shouldScroll = shouldScrollToSession({
      targetSessionId: currentSessionId,
      scrollIntent,
      lastConsumedIntentSequence: lastConsumedScrollIntentSequenceRef.current,
      targetIndex: idx,
      virtualItems: virtualizer.getVirtualItems(),
      scrollTop: scrollElement?.scrollTop ?? 0,
      viewportHeight: scrollElement?.clientHeight ?? 0,
    })
    if (
      scrollIntent.sessionId !== currentSessionId
      || (
        lastConsumedScrollIntentSequenceRef.current !== null
        && scrollIntent.sequence <= lastConsumedScrollIntentSequenceRef.current
      )
    ) return

    lastConsumedScrollIntentSequenceRef.current = scrollIntent.sequence
    if (shouldScroll) virtualizer.scrollToIndex(idx, { align: 'auto' })
  }, [currentSessionId, flatListItems, scrollIntent, variant, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()
  const scrollTop = listParentRef.current?.scrollTop ?? 0
  const firstVisibleVirtualItem = virtualItems.find((item) => {
    const size = typeof item.size === 'number' ? item.size : estimateSize(item.index)
    return item.start + size > scrollTop
  }) ?? virtualItems[0]

  const stickySpaceHeader = useMemo(() => {
    if (!spaceNameById || scrollTop <= 0 || firstVisibleVirtualItem == null) return null
    for (let index = firstVisibleVirtualItem.index; index >= 0; index -= 1) {
      const item = flatListItems[index]
      if (item?.type === 'header' && item.key.startsWith('space:')) {
        if (scrollTop <= getEstimatedItemStart(index)) return null
        return item
      }
    }
    return null
  }, [firstVisibleVirtualItem, flatListItems, getEstimatedItemStart, scrollTop, spaceNameById])

  return {
    listParentRef,
    virtualizer,
    virtualItems,
    stickySpaceHeader,
    estimateSize,
  }
}
