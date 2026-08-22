/**
 * useTabsOverflowDetection —— 横向标签条溢出检测（Crawlspace 简化版）
 *
 * 与 apps/tabtin-electron 的 useOverflowDetection 同结构，但精简到只关心
 * `data-tab-item[data-tab-key]` 的中心点是否在 viewport 内：
 *   - 监听 viewport 的 scroll / resize / tablist size 变化
 *   - 计算每个 tab 的中心点是否在视图内 → 不在 → 加入 overflow 集合
 *   - 同步暴露 canScrollLeft / canScrollRight 供渐变蒙版使用
 *
 * 输入：viewportRef + 触发重算的依赖项 deps
 * 输出：canScrollLeft / canScrollRight / overflowKeys
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface UseTabsOverflowDetectionOptions {
  viewportRef: React.RefObject<HTMLDivElement | null>
  /** 当此数组中任一值变化时强制重算（如 views.length / activeViewId 等） */
  deps: ReadonlyArray<unknown>
}

interface UseTabsOverflowDetectionResult {
  canScrollLeft: boolean
  canScrollRight: boolean
  overflowKeys: string[]
}

export function useTabsOverflowDetection({
  viewportRef,
  deps,
}: UseTabsOverflowDetectionOptions): UseTabsOverflowDetectionResult {
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [overflowKeys, setOverflowKeys] = useState<string[]>([])

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
    setOverflowKeys(prev => {
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
    const tabList = viewport.querySelector('[role="tablist"]')
    if (tabList) ro.observe(tabList)
    return () => {
      viewport.removeEventListener('scroll', updateOverflow)
      ro.disconnect()
    }
  }, [updateOverflow, viewportRef])

  const depsRef = useRef(deps)
  depsRef.current = deps
  useEffect(() => {
    const raf = requestAnimationFrame(updateOverflow)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, updateOverflow])

  return { canScrollLeft, canScrollRight, overflowKeys }
}
