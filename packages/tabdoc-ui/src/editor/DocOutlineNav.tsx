/**
 * 文档大纲导航组件
 *
 * 类似 Notion 的右侧 TOC 导航：
 * - 默认显示长短不一的横线，表示 H1/H2/H3 层级
 * - hover 时展开显示完整标题
 * - 点击跳转到对应章节
 * - 自动追踪当前可视区域的活跃标题
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@tabtin/smartsheet-ui'

export interface TocHeading {
  /** React key */
  id: string
  /** 标题文本 */
  text: string
  /** 标题层级 1-3 */
  level: number
  /** UI-17: heading 在 h1/h2/h3 节点列表中的索引，用于按需查询 DOM */
  headingIndex: number
}

interface DocOutlineNavProps {
  headings: TocHeading[]
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  /** UI-17: 编辑器 DOM 容器，用于按需查询 heading 元素 */
  editorDomRef: React.RefObject<HTMLElement | null>
}

/** 折叠态各层级横线宽度 (px) */
const BAR_WIDTHS: Record<number, number> = {
  1: 20,
  2: 13,
  3: 7,
}

export function DocOutlineNav({ headings, scrollContainerRef, editorDomRef }: DocOutlineNavProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const navRef = useRef<HTMLDivElement>(null)

  /** UI-17: 按需查询编辑器中的 heading DOM 元素（不存储引用） */
  const queryHeadingElements = useCallback((): NodeListOf<Element> | null => {
    const editorDom = editorDomRef.current
    if (!editorDom) return null
    return editorDom.querySelectorAll('h1, h2, h3')
  }, [editorDomRef])

  // ── 滚动追踪：判断当前 active heading ──
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || headings.length === 0) return

    let rafId: number

    const handleScroll = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        const nodes = queryHeadingElements()
        if (!nodes) return
        const containerTop = container.getBoundingClientRect().top
        const threshold = container.clientHeight * 0.25
        let idx = 0
        for (let i = 0; i < headings.length; i++) {
          const el = nodes[headings[i].headingIndex]
          if (!el) continue
          const rect = el.getBoundingClientRect()
          if (rect.top - containerTop <= threshold) {
            idx = i
          } else {
            break
          }
        }
        setActiveIdx(idx)
      })
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()

    return () => {
      container.removeEventListener('scroll', handleScroll)
      cancelAnimationFrame(rafId)
    }
  }, [headings, scrollContainerRef, queryHeadingElements])

  // BIZ-020 fix: 点击跳转后立即更新 active 高亮，不等待 scroll event
  const scrollToHeading = useCallback(
    (heading: TocHeading, idx: number) => {
      setActiveIdx(idx)
      const container = scrollContainerRef.current
      if (!container) return
      const nodes = queryHeadingElements()
      const el = nodes?.[heading.headingIndex]
      if (!el) return
      const cRect = container.getBoundingClientRect()
      const hRect = el.getBoundingClientRect()
      container.scrollTo({
        top: hRect.top - cRect.top + container.scrollTop - 24,
        behavior: 'smooth',
      })
    },
    [scrollContainerRef, queryHeadingElements],
  )

  // 少于 2 个标题不显示
  if (headings.length < 2) return null

  const headingButtons = headings.map((h, i) => {
    const isActive = i === activeIdx
    return (
      <button
        key={h.id}
        type="button"
        className={cn(
          'relative flex items-center shrink-0 text-left whitespace-nowrap',
          'transition-all duration-150',
          isHovered
            ? cn(
                'h-6 px-2 mx-0.5 rounded-sm',
                isActive ? '' : 'hover:bg-muted/50',
              )
            : cn(
                'h-[6px] px-[3px]',
                isActive ? 'opacity-100' : 'opacity-50 hover:opacity-80',
              ),
        )}
        onClick={() => scrollToHeading(h, i)}
        title={!isHovered ? h.text : undefined}
      >
        {/* ── 折叠态：短横线 ── */}
        <div
          className={cn(
            'shrink-0 rounded-full transition-all duration-200',
            isHovered ? 'h-0 opacity-0' : 'h-[1px] opacity-100',
            isActive ? 'bg-muted-foreground/60' : 'bg-muted-foreground/20',
          )}
          style={{
            width: isHovered ? 0 : `${BAR_WIDTHS[h.level] ?? 7}px`,
          }}
        />

        {/* ── 展开态：active 左侧指示条 ── */}
        {isHovered && isActive && (
          <div className="absolute left-0 top-1 bottom-1 w-[1.5px] rounded-full bg-muted-foreground/50" />
        )}

        {/* ── 展开态：标题文本 ── */}
        <span
          className={cn(
            'text-caption leading-tight truncate transition-all duration-200',
            isHovered ? 'opacity-100' : 'w-0 opacity-0',
            isActive
              ? 'text-foreground/80 font-medium'
              : 'text-muted-foreground/60 hover:text-muted-foreground',
          )}
          style={{
            paddingLeft: isHovered ? `${(h.level - 1) * 10}px` : 0,
          }}
        >
          {h.text}
        </span>
      </button>
    )
  })

  return (
    <div
      ref={navRef}
      className={cn(
        'transition-all duration-200 ease-out',
        isHovered
          ? 'flex h-full min-h-0 w-[172px] flex-col'
          : 'w-[24px] max-h-[40vh] overflow-hidden py-1.5',
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {isHovered ? (
        <div className="max-h-full overflow-y-auto overscroll-contain rounded-md bg-background/80 py-1 backdrop-blur-sm scrollbar-none">
          {headingButtons}
        </div>
      ) : (
        headingButtons
      )}
    </div>
  )
}
