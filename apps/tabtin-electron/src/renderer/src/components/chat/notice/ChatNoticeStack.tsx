/**
 * ChatNoticeStack — 对话区上方「通知带」分页容器
 *
 * 策略：永远只显示一条通知；≥2 条时在当前卡片内右下角 ◀ x/y ▶ 翻历史，
 * 默认停在最新一条（x=y）。翻页控件通过 Portal 挂载到可见 `[data-chat-notice]`
 * 节点内，不单独占一行。
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@utils/cn'
import { useScopedEffect } from '@/hooks/spaceActivity/useScopedEffect'

const NOTICE_SELECTOR = '[data-chat-notice]'
const SEQ_ATTR = 'noticeSeq'
const PAGER_SLOT_ATTR = 'data-notice-pager-slot'
const PAGER_HOST_CLASS = 'relative'
/** 卡片内右下角翻页预留底部空间（Tailwind 扫描用） */
const PAGER_RESERVE_CLASS = 'pb-9'
const PAGER_SLOT_CLASS = 'absolute bottom-1.5 right-2 z-floating'

/** ≥ 该条数时启用分页（只显示当前页一条）。 */
const PAGER_THRESHOLD = 2

interface ChatNoticeStackProps {
  children: React.ReactNode
  compactLeft?: boolean
}

interface NoticePagerProps {
  activeIndex: number
  count: number
  canGoPrev: boolean
  canGoNext: boolean
  onPrev: () => void
  onNext: () => void
}

function sortNoticesBySeq(nodes: HTMLElement[]): HTMLElement[] {
  return [...nodes].sort(
    (a, b) => Number(a.dataset[SEQ_ATTR] ?? 0) - Number(b.dataset[SEQ_ATTR] ?? 0),
  )
}

/** 卡片内右下角翻页条（Portal 到当前可见通知节点）。 */
const NoticePager: React.FC<NoticePagerProps> = ({
  activeIndex,
  count,
  canGoPrev,
  canGoNext,
  onPrev,
  onNext,
}) => {
  const { t } = useTranslation('chat')

  return (
    <div
      className="flex items-center gap-0.5 bg-transparent px-1 py-0.5"
      data-testid="chat-notice-stack-pager"
    >
      <button
        type="button"
        onClick={onPrev}
        disabled={!canGoPrev}
        aria-label={t('noticeStack.prev', { defaultValue: '上一条通知' })}
        data-testid="chat-notice-stack-prev"
        className={cn(
          'rounded p-0.5 transition-colors',
          canGoPrev
            ? 'text-muted-foreground/80 hover:bg-muted/40 hover:text-foreground'
            : 'cursor-not-allowed text-muted-foreground/30',
        )}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span
        className="min-w-[2.25rem] text-center text-caption tabular-nums text-muted-foreground/80 select-none"
        data-testid="chat-notice-stack-page"
        aria-live="polite"
      >
        {t('noticeStack.page', {
          current: activeIndex,
          total: count,
          defaultValue: '{{current}}/{{total}}',
        })}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={!canGoNext}
        aria-label={t('noticeStack.next', { defaultValue: '下一条通知' })}
        data-testid="chat-notice-stack-next"
        className={cn(
          'rounded p-0.5 transition-colors',
          canGoNext
            ? 'text-muted-foreground/80 hover:bg-muted/40 hover:text-foreground'
            : 'cursor-not-allowed text-muted-foreground/30',
        )}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function clearPagerHostStyles(node: HTMLElement): void {
  node.classList.remove(PAGER_HOST_CLASS, PAGER_RESERVE_CLASS)
  node.querySelector(`[${PAGER_SLOT_ATTR}]`)?.remove()
}

function ensurePagerSlot(card: HTMLElement): HTMLElement {
  let slot = card.querySelector<HTMLElement>(`[${PAGER_SLOT_ATTR}]`)
  if (!slot) {
    slot = document.createElement('div')
    slot.setAttribute(PAGER_SLOT_ATTR, '')
    slot.className = PAGER_SLOT_CLASS
    card.appendChild(slot)
  }
  return slot
}

export const ChatNoticeStack: React.FC<ChatNoticeStackProps> = ({ children, compactLeft: _compactLeft = false }) => {
  const innerRef = useRef<HTMLDivElement>(null)
  const seqCounterRef = useRef(0)
  const activeIndexRef = useRef(1)
  const prevCountRef = useRef(0)
  const pagerHostRef = useRef<HTMLElement | null>(null)
  const [count, setCount] = useState(0)
  const [activeIndex, setActiveIndex] = useState(1)
  const [pagerHost, setPagerHost] = useState<HTMLElement | null>(null)

  const setPagerAnchor = useCallback((card: HTMLElement | null) => {
    const prevSlot = pagerHostRef.current
    const prevCard = prevSlot?.parentElement
    if (prevCard instanceof HTMLElement && prevCard !== card) {
      clearPagerHostStyles(prevCard)
    }
    pagerHostRef.current = null
    setPagerHost(null)
    if (!card) return
    card.classList.add(PAGER_HOST_CLASS, PAGER_RESERVE_CLASS)
    const slot = ensurePagerSlot(card)
    pagerHostRef.current = slot
    setPagerHost(slot)
  }, [])

  const applyVisibility = useCallback((root: HTMLElement, sorted: HTMLElement[], index: number) => {
    const target = sorted[index - 1]
    if (!target) return
    const hostChildren = Array.from(root.children) as HTMLElement[]
    for (const node of sorted) {
      node.style.display = node === target ? '' : 'none'
      if (node !== target) clearPagerHostStyles(node)
    }
    for (const child of hostChildren) {
      child.style.display = child.contains(target) ? '' : 'none'
    }
  }, [])

  const sync = useCallback((index: number) => {
    const root = innerRef.current
    if (!root) return

    const nodes = Array.from(root.querySelectorAll<HTMLElement>(NOTICE_SELECTOR))
    for (const node of nodes) {
      if (!node.dataset[SEQ_ATTR]) {
        seqCounterRef.current += 1
        node.dataset[SEQ_ATTR] = String(seqCounterRef.current)
      }
    }

    const n = nodes.length
    setCount(prev => (prev === n ? prev : n))

    if (n < PAGER_THRESHOLD) {
      const hostChildren = Array.from(root.children) as HTMLElement[]
      for (const child of hostChildren) child.style.display = ''
      for (const node of nodes) {
        node.style.display = ''
        clearPagerHostStyles(node)
      }
      setPagerAnchor(null)
      return
    }

    const sorted = sortNoticesBySeq(nodes)
    const clamped = Math.max(1, Math.min(index, n))
    const target = sorted[clamped - 1]
    applyVisibility(root, sorted, clamped)
    if (target) setPagerAnchor(target)
  }, [applyVisibility, setPagerAnchor])

  useLayoutEffect(() => {
    activeIndexRef.current = activeIndex
    sync(activeIndex)
  })

  useScopedEffect(() => {
    const root = innerRef.current
    if (!root) return
    const observer = new MutationObserver(() => sync(activeIndexRef.current))
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [sync])

  useEffect(() => {
    if (count >= PAGER_THRESHOLD) {
      if (count > prevCountRef.current) {
        setActiveIndex(count)
      } else if (count < prevCountRef.current) {
        setActiveIndex(i => Math.max(1, Math.min(i, count)))
      }
    } else {
      setActiveIndex(1)
    }
    prevCountRef.current = count
  }, [count])

  useEffect(() => {
    return () => {
      const slot = pagerHostRef.current
      const card = slot?.parentElement
      if (card instanceof HTMLElement) clearPagerHostStyles(card)
    }
  }, [])

  const paginated = count >= PAGER_THRESHOLD
  const canGoPrev = activeIndex > 1
  const canGoNext = activeIndex < count

  const goPrev = useCallback(() => {
    setActiveIndex(i => Math.max(1, i - 1))
  }, [])

  const goNext = useCallback(() => {
    setActiveIndex(i => Math.min(count, i + 1))
  }, [count])

  return (
    <div className="relative z-floating flex-shrink-0" data-testid="chat-notice-stack">
      {/* Tailwind 扫描占位，确保 pr-28 进产物 */}
      <span className={cn('hidden', PAGER_RESERVE_CLASS, PAGER_SLOT_CLASS)} aria-hidden />
      <div ref={innerRef} data-testid="chat-notice-stack-inner">
        {children}
      </div>
      {paginated && pagerHost && createPortal(
        <NoticePager
          activeIndex={activeIndex}
          count={count}
          canGoPrev={canGoPrev}
          canGoNext={canGoNext}
          onPrev={goPrev}
          onNext={goNext}
        />,
        pagerHost,
      )}
    </div>
  )
}
