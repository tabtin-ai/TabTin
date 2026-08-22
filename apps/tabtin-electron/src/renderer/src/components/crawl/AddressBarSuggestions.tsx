/**
 * AddressBarSuggestions - 地址栏输入建议列表
 *
 * 吸顶在导航栏下、盖住 webview。必须 portal 到 document.body 并用 z-modal：
 * WebviewManager 稳定层（body、z=10）会盖住 crawl 槽内的 absolute 浮层。
 */

import React, { useMemo, useCallback, useState, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Clock, Star } from 'lucide-react'
import { useBrowsingHistoryStore } from '@stores/useBrowsingHistoryStore'
import { useBookmarkStore } from '@stores/useBookmarkStore'
import { BrowserTabIcon } from '@components/context-space/registry/handlers/browser'
import { getAddressBarSuggestionsPortalStyle } from './browserSidePanelLayout'

const MAX_SUGGESTIONS = 8

export interface SuggestionItem {
  type: 'bookmark' | 'history'
  url: string
  title: string
  favicon?: string
}

function deduplicateByUrl(items: SuggestionItem[]): SuggestionItem[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = item.url.replace(/\/$/, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const AddressBarSuggestions: React.FC<{
  query: string
  onSelect: (url: string) => void
  visible: boolean
  /** 工具栏锚点：用于 portal 几何；缺省时退回 absolute（单测） */
  anchorRef?: React.RefObject<HTMLElement | null>
}> = React.memo(({ query, onSelect, visible, anchorRef }) => {
  const historyItems = useBrowsingHistoryStore(s => s.items)
  const bookmarkItems = useBookmarkStore(s => s.items)
  const [activeIndex, setActiveIndex] = useState(-1)
  const pointerEngagedRef = useRef(false)
  const [portalStyle, setPortalStyle] = useState<{ top: number; left: number; width: number } | null>(null)

  const suggestions = useMemo<SuggestionItem[]>(() => {
    if (!query.trim()) return []
    const q = query.trim().toLowerCase()

    const bookmarkMatches: SuggestionItem[] = bookmarkItems
      .filter(b => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q))
      .slice(0, 4)
      .map(b => ({ type: 'bookmark', url: b.url, title: b.title, favicon: b.favicon }))

    const historyMatches: SuggestionItem[] = historyItems
      .filter(h => h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q))
      .slice(0, 6)
      .map(h => ({ type: 'history', url: h.url, title: h.title, favicon: h.favicon }))

    return deduplicateByUrl([...bookmarkMatches, ...historyMatches]).slice(0, MAX_SUGGESTIONS)
  }, [query, bookmarkItems, historyItems])

  useEffect(() => {
    setActiveIndex(-1)
    pointerEngagedRef.current = false
  }, [visible, query])

  useLayoutEffect(() => {
    if (!visible || suggestions.length === 0 || !anchorRef) {
      setPortalStyle(null)
      return
    }
    const sync = () => {
      const el = anchorRef.current
      if (!el) {
        setPortalStyle(null)
        return
      }
      const rect = el.getBoundingClientRect()
      setPortalStyle(
        getAddressBarSuggestionsPortalStyle({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }),
      )
    }
    sync()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null
    if (anchorRef.current) ro?.observe(anchorRef.current)
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [visible, suggestions.length, anchorRef])

  const handleMouseDown = useCallback((e: React.MouseEvent, url: string) => {
    e.preventDefault()
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    onSelect(url)
  }, [onSelect])

  if (!visible || suggestions.length === 0) return null

  const list = (
    <div
      className={
        portalStyle
          ? 'fixed z-modal max-h-[280px] overflow-y-auto border border-border/40 bg-background shadow-md'
          : 'absolute left-0 right-0 top-full z-modal max-h-[280px] overflow-y-auto border border-border/40 bg-background shadow-md'
      }
      style={
        portalStyle
          ? {
              top: portalStyle.top,
              left: portalStyle.left,
              width: portalStyle.width,
            }
          : undefined
      }
      data-testid="address-bar-suggestions"
      onMouseLeave={() => setActiveIndex(-1)}
    >
      {suggestions.map((item, idx) => {
        const isActive = activeIndex === idx
        return (
          <button
            key={`${item.type}-${item.url}-${idx}`}
            type="button"
            className={`flex w-full items-center gap-4 px-3 py-2 text-left transition-colors min-w-0 focus-visible:outline-none ${
              isActive ? 'bg-muted/40' : ''
            }`}
            onMouseEnter={() => {
              if (pointerEngagedRef.current) setActiveIndex(idx)
            }}
            onPointerMove={() => {
              pointerEngagedRef.current = true
              setActiveIndex(idx)
            }}
            onMouseDown={(e) => handleMouseDown(e, item.url)}
          >
            <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
              {item.favicon ? (
                <BrowserTabIcon favicon={item.favicon} url={item.url} className="h-4 w-4" />
              ) : item.type === 'bookmark' ? (
                <Star className="h-4 w-4 text-warning" />
              ) : (
                <Clock className="h-4 w-4 text-muted-foreground/60" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-body text-foreground/90">
                {item.title}
              </span>
              <span className="block truncate text-caption text-muted-foreground/60" title={item.url}>
                {item.url}
              </span>
            </div>
            {item.type === 'bookmark' && (
              <Star className="h-3 w-3 flex-shrink-0 fill-warning/60 text-warning/60" />
            )}
          </button>
        )
      })}
    </div>
  )

  if (portalStyle && typeof document !== 'undefined') {
    return createPortal(list, document.body)
  }
  return list
})
AddressBarSuggestions.displayName = 'AddressBarSuggestions'
