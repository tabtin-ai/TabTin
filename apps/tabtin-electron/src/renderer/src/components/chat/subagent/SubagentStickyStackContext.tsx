/**
 * SubagentStickyStackContext — 嵌套子/孙代理 sticky 吸顶堆叠
 *
 * 行内详情把滚动交给主对话，父层与孙层的派发行会相对同一 scroller 吸顶。
 * 若都写死 `top: 0` 会重叠。本 context 传递「当前层 sticky 的 top 偏移」；
 * 展开行测高后，内层 InlineDetail 再提供 `offset + 行高`。
 */

import React, { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@utils/cn'
import { useScopedResizeObserver } from '@hooks/spaceActivity'

/** 首帧 / ResizeObserver 尚未回报时的行高兜底（约一行派发行）。 */
export const SUBAGENT_STICKY_ROW_FALLBACK_PX = 40

interface SubagentStickyStackContextValue {
  offsetPx: number
}

const SubagentStickyStackContext = createContext<SubagentStickyStackContextValue>({ offsetPx: 0 })

export function SubagentStickyStackProvider({
  offsetPx,
  children,
}: {
  offsetPx: number
  children: React.ReactNode
}) {
  return (
    <SubagentStickyStackContext.Provider value={{ offsetPx }}>{children}</SubagentStickyStackContext.Provider>
  )
}

export function useSubagentStickyOffset(): number {
  return useContext(SubagentStickyStackContext).offsetPx
}

/**
 * 展开态派发行外壳：自身 sticky 使用父级 offset；子树（InlineDetail）升一层 offset。
 */
export function SubagentStickyHeaderShell({
  sticky,
  className,
  children,
  nested,
}: {
  sticky: boolean
  className?: string
  children: React.ReactNode
  nested?: React.ReactNode
}) {
  const offsetPx = useSubagentStickyOffset()
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerEl, setHeaderEl] = useState<HTMLDivElement | null>(null)
  const [heightPx, setHeightPx] = useState(SUBAGENT_STICKY_ROW_FALLBACK_PX)

  const setHeaderRef = useCallback((node: HTMLDivElement | null) => {
    headerRef.current = node
    setHeaderEl(node)
  }, [])

  const applyHeight = useCallback((el: Element | null) => {
    if (!el) return
    const next = el.getBoundingClientRect().height
    if (next > 0) setHeightPx(next)
  }, [])

  // 展开首帧立刻测高（jsdom 无 RO 时也够用）。
  useLayoutEffect(() => {
    if (!sticky) return
    applyHeight(headerRef.current)
  }, [sticky, applyHeight])

  useScopedResizeObserver(
    sticky ? headerEl : null,
    (entries) => {
      const entry = entries[0]
      if (!entry) return
      applyHeight(entry.target)
    },
  )

  const childOffsetPx = sticky ? offsetPx + heightPx : offsetPx

  return (
    <>
      <div
        ref={setHeaderRef}
        className={cn(sticky && 'sticky z-sticky', className)}
        style={sticky ? { top: offsetPx } : undefined}
        data-subagent-sticky-offset={sticky ? String(offsetPx) : undefined}
      >
        {children}
      </div>
      {nested != null ? (
        <SubagentStickyStackProvider offsetPx={childOffsetPx}>{nested}</SubagentStickyStackProvider>
      ) : null}
    </>
  )
}
