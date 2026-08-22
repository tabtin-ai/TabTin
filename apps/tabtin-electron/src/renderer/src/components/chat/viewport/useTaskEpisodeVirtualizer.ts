import { useCallback, useRef, type Key, type RefObject } from 'react'
import { useSafeVirtualizer } from '@hooks/useSafeVirtualizer'
import type { ViewportMode } from './types'
import { shouldAdjustForMeasuredSizeChange } from './virtualizerViewportBridge'

const ESTIMATED_ITEM_SIZE = 120

interface TaskEpisodeVirtualizerOptions {
  scrollElementRef: RefObject<HTMLDivElement | null>
  itemCount: number
  getItemKey: (index: number) => Key
  estimateSize?: (index: number) => number
  viewportMode: ViewportMode
  enabled: boolean
}

/**
 * 主会话的虚拟化适配器：封装稳定回调、行高预估、稳定 key 和阅读锚点校正。
 * 调用方只提供物化 item 的数量、key 与尺寸估算；不让视口层知道消息结构。
 */
export function useTaskEpisodeVirtualizer({
  scrollElementRef,
  itemCount,
  getItemKey: getItemKeyInput,
  estimateSize: estimateSizeInput,
  viewportMode,
  enabled,
}: TaskEpisodeVirtualizerOptions) {
  const getItemKeyRef = useRef(getItemKeyInput)
  getItemKeyRef.current = getItemKeyInput
  const estimateSizeRef = useRef(estimateSizeInput)
  estimateSizeRef.current = estimateSizeInput

  const getScrollElement = useCallback(() => scrollElementRef.current, [scrollElementRef])
  const estimateSize = useCallback((index: number) => {
    return estimateSizeRef.current?.(index) ?? ESTIMATED_ITEM_SIZE
  }, [])
  const getItemKey = useCallback((index: number) => getItemKeyRef.current(index), [])
  const shouldAdjustScrollPositionOnItemSizeChange = useCallback(
    (item: { start: number; end: number }, _delta: number, instance: { scrollOffset: number | null; scrollAdjustments?: number }) =>
      shouldAdjustForMeasuredSizeChange({
        mode: viewportMode,
        itemStart: item.start,
        itemEnd: item.end,
        scrollOffset: instance.scrollOffset ?? 0,
        scrollAdjustments: instance.scrollAdjustments,
      }),
    [viewportMode],
  )

  const virtualizer = useSafeVirtualizer({
    count: itemCount,
    getScrollElement,
    estimateSize,
    overscan: 5,
    getItemKey,
    enabled,
  })
  ;(
    virtualizer as unknown as {
      shouldAdjustScrollPositionOnItemSizeChange?: typeof shouldAdjustScrollPositionOnItemSizeChange
    }
  ).shouldAdjustScrollPositionOnItemSizeChange = shouldAdjustScrollPositionOnItemSizeChange

  return virtualizer
}
