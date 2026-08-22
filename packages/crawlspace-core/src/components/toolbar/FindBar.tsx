import React, { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react'
import { X, ChevronUp, ChevronDown, Search } from 'lucide-react'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'

export interface FindBarProps {
  onFind: (text: string, options: { forward?: boolean; findNext?: boolean }) => void
  onStopFind: () => void
  matchInfo?: { current: number; total: number } | null
  className?: string
}

export const FindBar: React.FC<FindBarProps> = ({
  onFind,
  onStopFind,
  matchInfo,
  className
}) => {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const doFind = useCallback((text: string, forward: boolean, findNext: boolean) => {
    if (!text.trim()) {
      onStopFind()
      return
    }
    onFind(text, { forward, findNext })
  }, [onFind, onStopFind])

  const handleChange = useCallback((value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doFind(value, true, false)
    }, 200)
  }, [doFind])

  const handleNext = useCallback(() => {
    doFind(query, true, true)
  }, [doFind, query])

  const handlePrev = useCallback(() => {
    doFind(query, false, true)
  }, [doFind, query])

  const handleClose = useCallback(() => {
    onStopFind()
  }, [onStopFind])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        handlePrev()
      } else {
        handleNext()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleClose()
    }
  }, [handleNext, handlePrev, handleClose])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const hasQuery = query.trim().length > 0
  const matchText = matchInfo && hasQuery
    ? `${matchInfo.current} / ${matchInfo.total}`
    : null

  return (
    <div className={cn(
      'absolute top-0 right-4 z-modal flex items-center gap-1 px-3 py-1.5',
      'bg-background border border-border rounded-b-lg shadow-md',
      'animate-in slide-in-from-top-2 duration-150',
      className
    )}>
      <Search className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />

      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('findBar.placeholder')}
        spellCheck={false}
        autoComplete="off"
        className="w-44 bg-transparent border-none outline-none text-body px-1 text-foreground placeholder:text-muted-foreground/40"
      />

      {matchText && (
        <span className={cn(
          'text-body tabular-nums shrink-0 px-1',
          matchInfo && matchInfo.total === 0 ? 'text-destructive' : 'text-muted-foreground'
        )}>
          {matchText}
        </span>
      )}

      <button
        onClick={handlePrev}
        disabled={!hasQuery}
        className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:pointer-events-none transition-colors"
        title={t('findBar.previous')}
      >
        <ChevronUp className="w-3.5 h-3.5" />
      </button>

      <button
        onClick={handleNext}
        disabled={!hasQuery}
        className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:pointer-events-none transition-colors"
        title={t('findBar.next')}
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>

      <button
        onClick={handleClose}
        className="p-1 rounded hover:bg-muted transition-colors ml-0.5"
        title={t('findBar.close')}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
