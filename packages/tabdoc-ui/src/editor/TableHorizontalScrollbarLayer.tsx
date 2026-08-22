import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type TableScrollbarState = {
  left: number
  width: number
  top: number
  contentWidth: number
  scrollLeft: number
}

function measureTableScrollbar(
  editorRoot: HTMLElement | null,
  scrollContainer: HTMLElement | null,
): TableScrollbarState | null {
  if (!editorRoot || !scrollContainer) return null
  let visibleNode: HTMLElement | null = editorRoot
  while (visibleNode) {
    const style = window.getComputedStyle(visibleNode)
    if (style.display === 'none' || style.visibility === 'hidden') return null
    visibleNode = visibleNode.parentElement
  }
  const table = Array.from(editorRoot.querySelectorAll<HTMLElement>('.tableWrapper'))
    .find(item => item.scrollWidth > item.clientWidth + 1)
  if (!table) return null

  const tableRect = table.getBoundingClientRect()
  const viewportRect = scrollContainer.getBoundingClientRect()
  const scrollbarHeight = 14
  const visibleTop = Math.max(tableRect.top, viewportRect.top)
  const visibleBottom = Math.min(tableRect.bottom, viewportRect.bottom)
  if (visibleBottom <= visibleTop) return null

  // 只要表格仍在文档视口内，滚动条始终贴在视口底部，避免随着表格内容
  // 被推到文档下方；表格离开视口后才隐藏代理。
  const top = viewportRect.bottom - scrollbarHeight
  const left = Math.max(tableRect.left, viewportRect.left)
  const right = Math.min(tableRect.right, viewportRect.right)
  const width = right - left
  if (width <= 1) return null

  return {
    left,
    width,
    top: Math.max(viewportRect.top, Math.min(top, viewportRect.bottom - scrollbarHeight)),
    contentWidth: table.scrollWidth,
    scrollLeft: table.scrollLeft,
  }
}

export function TableHorizontalScrollbarLayer({
  editorRootRef,
  scrollContainerRef,
}: {
  editorRootRef: React.RefObject<HTMLElement | null>
  scrollContainerRef: React.RefObject<HTMLElement | null>
}) {
  const [state, setState] = useState<TableScrollbarState | null>(null)
  const scrollbarRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let frame = 0
    let retryTimer: number | null = null
    let dispose: (() => void) | null = null
    const attach = () => {
      const editorRoot = editorRootRef.current
      const scrollContainer = scrollContainerRef.current
      if (!editorRoot || !scrollContainer) {
        retryTimer = window.setTimeout(attach, 50)
        return
      }

      const measure = () => {
      frame = 0
      setState(measureTableScrollbar(editorRoot, scrollContainer))
      }
      const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
      }
      const table = () => Array.from(editorRoot.querySelectorAll<HTMLElement>('.tableWrapper'))
      .find(item => item.scrollWidth > item.clientWidth + 1)
      const syncFromTable = () => {
      const current = table()
      if (current) setState(prev => prev ? { ...prev, scrollLeft: current.scrollLeft } : prev)
      schedule()
      }
      const observer = new MutationObserver(schedule)
      observer.observe(editorRoot, { childList: true, subtree: true, attributes: true })
      const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
      resizeObserver?.observe(editorRoot)
      resizeObserver?.observe(scrollContainer)
      scrollContainer.addEventListener('scroll', schedule, { passive: true })
      window.addEventListener('resize', schedule)
      editorRoot.addEventListener('scroll', syncFromTable, true)
      const visibilityTimer = window.setInterval(schedule, 200)
      schedule()

      dispose = () => {
      observer.disconnect()
      resizeObserver?.disconnect()
      scrollContainer.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      editorRoot.removeEventListener('scroll', syncFromTable, true)
      window.clearInterval(visibilityTimer)
      if (frame) window.cancelAnimationFrame(frame)
      }
    }
    attach()
    return () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      dispose?.()
    }
  }, [editorRootRef, scrollContainerRef])

  if (!state || typeof document === 'undefined') return null
  let visibleNode: HTMLElement | null = editorRootRef.current
  while (visibleNode) {
    const style = window.getComputedStyle(visibleNode)
    if (style.display === 'none' || style.visibility === 'hidden') return null
    visibleNode = visibleNode.parentElement
  }
  const table = editorRootRef.current?.querySelector<HTMLElement>('.tableWrapper')
  if (!table) return null

  if (scrollbarRef.current && scrollbarRef.current.scrollLeft !== state.scrollLeft) {
    scrollbarRef.current.scrollLeft = state.scrollLeft
  }

  return createPortal(
    <div
      ref={scrollbarRef}
      className="tabdoc-table-horizontal-scrollbar"
      data-testid="tabdoc-table-horizontal-scrollbar"
      style={{
        position: 'fixed',
        left: state.left,
        top: state.top,
        width: state.width,
        height: 14,
        overflowX: 'auto',
        overflowY: 'hidden',
        zIndex: 40,
      }}
      onScroll={(event) => {
        table.scrollLeft = event.currentTarget.scrollLeft
      }}
    >
      <div style={{ width: state.contentWidth, height: 1 }} />
    </div>,
    document.body,
  )
}
