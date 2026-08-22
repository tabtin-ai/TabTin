/**
 * IM 消息列表滚动锁——「更多」菜单 / 表情面板打开时禁止列表滑动，
 * 对齐飞书等 IM：浮层打开期间锚点消息不滚出视口。
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

type SetScrollLocked = (locked: boolean) => void

const IMMessageScrollLockContext = createContext<SetScrollLocked | null>(null)

export function useIMMessageScrollLock(locked: boolean): void {
  const setLocked = useContext(IMMessageScrollLockContext)
  useEffect(() => {
    if (!setLocked || !locked) return
    setLocked(true)
    return () => setLocked(false)
  }, [locked, setLocked])
}

interface ProviderProps {
  scrollerRef: React.RefObject<HTMLElement | null>
  /** 消息列表视口根（含列表区域几何），用于判断滚轮落点是否在聊天区内 */
  viewportRef: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}

export function IMMessageScrollLockProvider({
  scrollerRef,
  viewportRef,
  children,
}: ProviderProps) {
  const lockCountRef = useRef(0)
  const [scrollLocked, setScrollLocked] = useState(false)

  const setLocked = useCallback<SetScrollLocked>((locked) => {
    lockCountRef.current = Math.max(0, lockCountRef.current + (locked ? 1 : -1))
    setScrollLocked(lockCountRef.current > 0)
  }, [])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scrollLocked || !scroller) return

    const prevOverflowY = scroller.style.overflowY
    scroller.style.overflowY = 'hidden'

    const shouldBlock = (event: Event) => {
      const target = event.target
      if (target instanceof Element) {
        // 菜单 / 表情面板自身若可滚动，放行；当前更多菜单很短，基本不触发。
        if (target.closest('[data-im-scroll-lock-exempt]')) return false
      }
      const viewport = viewportRef.current
      if (!viewport) return true
      if (!(event instanceof WheelEvent) && !(event instanceof TouchEvent)) return true

      let clientX: number | null = null
      let clientY: number | null = null
      if (event instanceof WheelEvent) {
        clientX = event.clientX
        clientY = event.clientY
      } else if (event.touches[0]) {
        clientX = event.touches[0].clientX
        clientY = event.touches[0].clientY
      }
      if (clientX == null || clientY == null) return true

      const rect = viewport.getBoundingClientRect()
      return (
        clientX >= rect.left
        && clientX <= rect.right
        && clientY >= rect.top
        && clientY <= rect.bottom
      )
    }

    const block = (event: Event) => {
      if (!shouldBlock(event)) return
      event.preventDefault()
    }

    // capture + 非 passive：盖住 portal 菜单上的滚轮穿透（scroll chaining）。
    // 不用 useScopedEventListener：本模块被气泡静态导入，再挂 spaceActivity
    // 会把 vitest 下 IMMessageBubble 动态 import 拖进循环依赖 / 超时。
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- IM 列表滚动锁需非 passive capture；避免与气泡静态 import 形成测试期环依赖
    document.addEventListener('wheel', block, { passive: false, capture: true })
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 同上
    document.addEventListener('touchmove', block, { passive: false, capture: true })

    return () => {
      scroller.style.overflowY = prevOverflowY
      document.removeEventListener('wheel', block, { capture: true })
      document.removeEventListener('touchmove', block, { capture: true })
    }
  }, [scrollLocked, scrollerRef, viewportRef])

  const value = useMemo(() => setLocked, [setLocked])

  return (
    <IMMessageScrollLockContext.Provider value={value}>
      {children}
    </IMMessageScrollLockContext.Provider>
  )
}
