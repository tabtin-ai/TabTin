import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 通过 ResizeObserver 测量容器的像素尺寸。
 *
 * 解决 CSS `height: 100%` 在 flex 布局链中无法传播的问题：
 * Grid 组件的 useResizeObserver 依赖其父元素有确定性高度，但
 * `flex-1` 计算出的高度不被浏览器视为 CSS "definite height"，
 * 导致 `height: 100%` 解析为 0。
 */
export function useMeasuredContainer() {
  const [dims, setDims] = useState({ w: 0, h: 0 })
  const observerRef = useRef<ResizeObserver | null>(null)
  const elementRef = useRef<HTMLDivElement | null>(null)

  const ref = useCallback((el: HTMLDivElement | null) => {
    if (elementRef.current === el) return
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    elementRef.current = el
    if (!el) return

    const measure = () => {
      const rect = el.getBoundingClientRect()
      const w = Math.round(rect.width)
      const h = Math.round(rect.height)
      setDims(prev => (prev.w === w && prev.h === h) ? prev : { w, h })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    observerRef.current = ro
  }, [])

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect()
    }
  }, [])

  return { ref, dims, ready: dims.w > 0 && dims.h > 0 }
}
