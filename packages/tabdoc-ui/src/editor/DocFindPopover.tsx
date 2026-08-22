import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { cn } from '@tabtin/smartsheet-ui'

export interface DocFindPopoverProps {
  open: boolean
  focusRequest: number
  query: string
  currentIndex: number
  total: number
  onQueryChange: (query: string) => void
  onClose: () => void
  onNext: () => void
  onPrevious: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

export function DocFindPopover({
  open,
  focusRequest,
  query,
  currentIndex,
  total,
  onQueryChange,
  onClose,
  onNext,
  onPrevious,
  t,
}: DocFindPopoverProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const hasMatches = total > 0
  const countLabel = query.trim() ? `${hasMatches ? currentIndex + 1 : 0} / ${total}` : '0 / 0'

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [focusRequest, open])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label={t('find.title')}
      className="absolute right-4 top-2 z-modal flex w-[380px] max-w-[calc(100%-2rem)] items-center gap-1.5 rounded-lg border border-border bg-background/95 px-2 py-1.5 shadow-md backdrop-blur"
    >
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder={t('find.placeholder')}
          aria-label={t('find.placeholder')}
          className={cn(
            'h-7 w-full rounded-md border border-border bg-background pl-7 pr-12 text-caption text-foreground outline-none',
            'placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-primary/25',
          )}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (event.shiftKey) onPrevious()
              else onNext()
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              onNext()
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              onPrevious()
            }
          }}
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-caption text-muted-foreground">
          {countLabel}
        </span>
      </div>

      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!hasMatches}
        onClick={onPrevious}
        aria-label={t('find.previous')}
        title={t('find.previous')}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!hasMatches}
        onClick={onNext}
        aria-label={t('find.next')}
        title={t('find.next')}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={t('find.close')}
        title={t('find.close')}
        onClick={onClose}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
