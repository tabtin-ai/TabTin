import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useUnifiedFonts, type FontItem } from '../../../fonts/font-list'
import { useT } from '../../../i18n'
import { ScrollArea } from '../../../components/ui/ScrollArea'

interface FontSelectProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

const MAX_VISIBLE = 200
const LOAD_STEP = 200
const LOAD_MORE_THRESHOLD = 24
const DROPDOWN_HEIGHT = 260

export const FontSelect: React.FC<FontSelectProps> = ({
  value,
  onChange,
  placeholder,
}) => {
  const translate = useT()
  const { fonts: fontItems, ensureLoaded } = useUnifiedFonts(translate)

  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [visibleCount, setVisibleCount] = useState(MAX_VISIBLE)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  useEffect(() => {
    setVisibleCount(MAX_VISIBLE)
  }, [open, search])

  const filtered = useMemo(() => {
    if (!search.trim()) return fontItems
    const kw = search.toLowerCase()
    return fontItems.filter(
      (item) => item.label.toLowerCase().includes(kw) || item.value.toLowerCase().includes(kw),
    )
  }, [fontItems, search])

  const displayItems = filtered.slice(0, visibleCount)

  const loadMoreFonts = useCallback(() => {
    setVisibleCount((prev) => {
      if (prev >= filtered.length) return prev
      return Math.min(filtered.length, prev + LOAD_STEP)
    })
  }, [filtered.length])

  const handleListScroll = useCallback((target: HTMLDivElement) => {
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    if (distanceToBottom <= LOAD_MORE_THRESHOLD) {
      loadMoreFonts()
    }
  }, [loadMoreFonts])

  useEffect(() => {
    if (!open) return
    const node = listRef.current
    if (!node) return
    if (visibleCount >= filtered.length) return
    if (node.scrollHeight <= node.clientHeight + 1) {
      loadMoreFonts()
    }
  }, [open, visibleCount, filtered.length, loadMoreFonts])

  const handleSelect = useCallback((v: string) => {
    if (v) ensureLoaded(v)
    onChange(v)
    setOpen(false)
    setSearch('')
  }, [onChange, ensureLoaded])

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const s = search.trim()
      if (s) {
        const firstVisible = filtered[0]
        if (firstVisible) {
          ensureLoaded(firstVisible.value)
          onChange(firstVisible.value)
        }
      }
      setOpen(false)
      setSearch('')
    }
    if (e.key === 'Escape') setOpen(false)
  }, [search, onChange, filtered, ensureLoaded])

  const handleBlur = useCallback(() => {
    setOpen(false)
  }, [])

  const renderItems = () => {
    const elements: React.ReactNode[] = []
    let lastGroup: string | undefined

    for (const item of displayItems) {
      if (item.group && item.group !== lastGroup) {
        if (lastGroup !== undefined) {
          elements.push(
            <div key={`sep-${item.group}`} className="mx-2 my-0.5 h-px bg-border/10" />,
          )
        }
        elements.push(
          <div
            key={`grp-${item.group}`}
            className="px-2.5 pb-0.5 pt-1 text-caption font-semibold tracking-wide text-muted-foreground/60"
          >
            {item.group}
          </div>,
        )
        lastGroup = item.group
      }

      const isSelected = item.value === value
      elements.push(
        <button
          key={item.value || '__default'}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => handleSelect(item.value)}
          className={`block w-full truncate px-2.5 py-1 text-left text-body transition-colors ${
            isSelected
              ? 'bg-accent/10 font-semibold text-accent'
              : 'text-foreground hover:bg-muted/80'
          }`}
          style={{ fontFamily: item.value ? `"${item.value}", inherit` : 'inherit' }}
        >
          {item.label}
        </button>,
      )
    }

    if (filtered.length > visibleCount) {
      elements.push(
        <button
          key="load-more"
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={loadMoreFonts}
          className="block w-full py-1.5 text-center text-caption text-muted-foreground hover:bg-muted/80"
        >
          … {filtered.length - visibleCount} more
        </button>,
      )
    }

    return elements
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={open ? search : (value || '')}
          onChange={(e) => {
            if (open) setSearch(e.target.value)
            else { setOpen(true); setSearch(e.target.value) }
          }}
          onFocus={() => { if (!open) { setOpen(true); setSearch('') } }}
          onBlur={handleBlur}
          onKeyDown={handleInputKeyDown}
          placeholder={open ? (value || placeholder || '') : (value || placeholder || '')}
          className="h-7 w-full rounded bg-muted/40 px-1.5 pr-6 text-body text-foreground outline-none transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:ring-1 focus:ring-accent/40"
          style={{ fontFamily: value ? `"${value}", inherit` : 'inherit' }}
        />
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => { e.preventDefault(); setOpen((v) => !v) }}
          className="absolute right-0.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 hover:text-foreground"
        >
          <svg
            width={10} height={10} viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth={2.5}
            strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform ${open ? 'rotate-180' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {open && (
        <ScrollArea
          native
          viewportRef={listRef}
          viewportProps={{
            onScroll: (e: React.UIEvent<HTMLDivElement>) => handleListScroll(e.currentTarget),
          }}
          className="absolute left-0 right-0 top-full z-dropdown mt-1 rounded-lg border border-border/30 bg-popover shadow-lg"
          style={{ height: DROPDOWN_HEIGHT }}
          viewportStyle={{ padding: '4px 0' }}
        >
          {displayItems.length === 0 ? (
            <div className="px-2.5 py-3 text-center text-caption text-muted-foreground">
              No matching fonts
            </div>
          ) : (
            renderItems()
          )}
        </ScrollArea>
      )}
    </div>
  )
}
