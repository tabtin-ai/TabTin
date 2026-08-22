/**
 * useOverflowDetection —— 标签条横向溢出检测
 *
 * 抽自原 ContextTabs 的 `updateOverflow` 逻辑：
 *   - 监听 viewport 的 scroll / resize / tablist size 变化
 *   - 计算每个 tab 的中心点是否在 viewport 视图内 → 不在 → 加入 overflow 集合
 *   - 同步暴露 canScrollLeft / canScrollRight 用于左右渐变蒙版
 *
 * 输入：viewportRef（ScrollArea 的 viewport DOM ref）+ 触发重算的依赖项 deps
 * 输出：canScrollLeft / canScrollRight / overflowTabKeys
 *
 * 副作用：仅添加事件监听 + ResizeObserver；卸载时清理；setState 内做相等性短路避免不必要 re-render。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface UseOverflowDetectionOptions {
  viewportRef: React.RefObject<HTMLDivElement | null>
  /** 滚动内容元素选择器，用于监听标签增减导致的内容宽度变化。 */
  contentSelector?: string
  /** 当此数组中任一值变化时强制重算（如 items.length / activeTabKey 等） */
  deps: ReadonlyArray<unknown>
}

interface UseOverflowDetectionResult {
  canScrollLeft: boolean
  canScrollRight: boolean
  overflowTabKeys: string[]
}

export function useOverflowDetection({
  viewportRef,
  contentSelector = '[role="tablist"]',
  deps,
}: UseOverflowDetectionOptions): UseOverflowDetectionResult {
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [overflowTabKeys, setOverflowTabKeys] = useState<string[]>([])

  // 用 ref 持稳 deps 数组，updateOverflow 本身不依赖 deps（每次执行同样动作）
  const updateOverflow = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const { scrollLeft, scrollWidth, clientWidth } = viewport
    setCanScrollLeft(scrollLeft > 0)
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1)

    const viewportRect = viewport.getBoundingClientRect()
    const tabEls = viewport.querySelectorAll('[data-tab-item][data-tab-key]')
    const hiddenKeys: string[] = []
    tabEls.forEach(tab => {
      const rect = tab.getBoundingClientRect()
      const center = rect.left + rect.width / 2
      if (center < viewportRect.left || center > viewportRect.right) {
        const key = (tab as HTMLElement).dataset.tabKey
        if (key) hiddenKeys.push(key)
      }
    })
    setOverflowTabKeys(prev => {
      if (prev.length === hiddenKeys.length && prev.every((k, i) => k === hiddenKeys[i])) {
        return prev
      }
      return hiddenKeys
    })
  }, [viewportRef])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    updateOverflow()
    viewport.addEventListener('scroll', updateOverflow, { passive: true })
    const ro = new ResizeObserver(updateOverflow)
    ro.observe(viewport)
    const content = viewport.querySelector(contentSelector)
    if (content) ro.observe(content)
    return () => {
      viewport.removeEventListener('scroll', updateOverflow)
      ro.disconnect()
    }
  }, [contentSelector, updateOverflow, viewportRef])

  // 单独的 raf 重算：items 长度 / canvas group 数 / activeKey 变化时（可能改变布局）
  // 用 ref 持有 deps 防止重新创建 raf timer
  const depsRef = useRef(deps)
  depsRef.current = deps
  useEffect(() => {
    const raf = requestAnimationFrame(updateOverflow)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, updateOverflow])

  return { canScrollLeft, canScrollRight, overflowTabKeys }
}
