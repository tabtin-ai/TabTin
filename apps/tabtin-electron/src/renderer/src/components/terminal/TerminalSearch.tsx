/**
 * TerminalSearch - 终端搜索浮层
 *
 * 使用 xterm SearchAddon 在终端输出中搜索关键词，
 * 支持大小写敏感切换和前后导航。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { ChevronUp, ChevronDown, CaseSensitive, X } from 'lucide-react'
import { getTerminalSearchAddon } from './terminalRuntime'

interface TerminalSearchProps {
  sessionId: string
  onClose: () => void
}

// ── 常量（避免每次渲染创建新对象） ──

const SEARCH_DECORATIONS = {
  matchBackground: 'rgba(81, 92, 106, 0.4)',
  matchOverviewRuler: 'rgba(81, 92, 106, 0.4)',
  activeMatchBackground: 'rgba(255, 211, 61, 0.4)',
  activeMatchBorder: '#ffd33d',
  activeMatchColorOverviewRuler: '#ffd33d',
} as const

export const TerminalSearch: React.FC<TerminalSearchProps> = ({
  sessionId,
  onClose,
}) => {
  const { t } = useTranslation('terminal')
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [resultInfo, setResultInfo] = useState<{
    index: number
    count: number
  } | null>(null)

  // 自动聚焦
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // 卸载时清除高亮装饰（覆盖所有关闭路径：Escape、按钮、pane 切换、pane 关闭）
  useEffect(() => {
    return () => {
      const addon = getTerminalSearchAddon(sessionId)
      addon?.clearDecorations()
    }
  }, [sessionId])

  // 订阅 onDidChangeResults（如果可用）
  useEffect(() => {
    const addon = getTerminalSearchAddon(sessionId)
    if (!addon) return

    // SearchAddon 0.13+ 提供 onDidChangeResults
    const disposable = (addon as any).onDidChangeResults?.(
      (e: { resultIndex: number; resultCount: number }) => {
        setResultInfo({ index: e.resultIndex, count: e.resultCount })
      },
    )

    return () => disposable?.dispose?.()
  }, [sessionId])

  const doSearch = useCallback(
    (
      direction: 'next' | 'prev',
      overrideQuery?: string,
      overrideCaseSensitive?: boolean,
    ) => {
      const addon = getTerminalSearchAddon(sessionId)
      if (!addon) return

      const q = overrideQuery ?? query
      if (!q) {
        addon.clearDecorations()
        setResultInfo(null)
        return
      }

      const cs = overrideCaseSensitive ?? caseSensitive
      const opts = { caseSensitive: cs, decorations: SEARCH_DECORATIONS }
      const found =
        direction === 'next'
          ? addon.findNext(q, opts)
          : addon.findPrevious(q, opts)

      // 如果 onDidChangeResults 不可用，退回到 boolean 判断
      if (!(addon as any).onDidChangeResults) {
        setResultInfo(found ? { index: -1, count: -1 } : { index: 0, count: 0 })
      }
    },
    [sessionId, query, caseSensitive],
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value
      setQuery(val)
      if (val) {
        doSearch('next', val)
      } else {
        const addon = getTerminalSearchAddon(sessionId)
        addon?.clearDecorations()
        setResultInfo(null)
      }
    },
    [sessionId, doSearch],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        // 清除装饰由 useEffect cleanup 自动处理
        onClose()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        doSearch(e.shiftKey ? 'prev' : 'next')
      }
    },
    [onClose, doSearch],
  )

  const handleClose = useCallback(() => {
    // 清除装饰由 useEffect cleanup 自动处理
    onClose()
  }, [onClose])

  const toggleCaseSensitive = useCallback(() => {
    setCaseSensitive(prev => {
      const next = !prev
      // 直接用新值执行搜索，避免闭包中 caseSensitive 陈旧
      if (query) {
        const addon = getTerminalSearchAddon(sessionId)
        addon?.findNext(query, {
          caseSensitive: next,
          decorations: SEARCH_DECORATIONS,
        })
      }
      return next
    })
  }, [query, sessionId])

  // ── 匹配计数显示 ──
  const noResults = resultInfo != null && resultInfo.count === 0
  const hasResults = resultInfo != null && resultInfo.count !== 0

  const renderMatchInfo = () => {
    if (!query || !resultInfo) return null
    if (noResults) {
      return (
        <span className="text-destructive text-caption px-1 whitespace-nowrap">
          {t('search.noMatch')}
        </span>
      )
    }
    // onDidChangeResults 提供了精确计数
    if (resultInfo.count > 0 && resultInfo.index >= 0) {
      return (
        <span className="text-muted-foreground text-caption px-1 whitespace-nowrap">
          {resultInfo.index + 1}/{resultInfo.count}
        </span>
      )
    }
    // 降级路径（onDidChangeResults 不可用）：显示已找到
    if (hasResults) {
      return (
        <span className="text-muted-foreground text-caption px-1 whitespace-nowrap">
          {t('search.matchFound')}
        </span>
      )
    }
    return null
  }

  return (
    <div
      className={cn(
        'absolute top-1 right-2 z-floating',
        'flex items-center gap-0.5 px-1.5 py-0.5',
        OVERLAY_SURFACE_CLASS,
        'rounded-md',
        'text-body',
      )}
      onKeyDown={handleKeyDown}
      // 阻止事件冒泡到终端容器
      onPointerDownCapture={e => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleInputChange}
        placeholder={t('search.placeholder')}
        className={cn(
          'w-36 px-1.5 py-0.5 bg-transparent outline-none',
          'text-foreground placeholder:text-muted-foreground',
          'text-body',
        )}
      />

      {renderMatchInfo()}

      <button
        type="button"
        onClick={toggleCaseSensitive}
        className={cn(
          'p-0.5 rounded hover:bg-accent',
          caseSensitive && 'bg-accent text-accent-foreground',
        )}
        title={t('search.caseSensitive')}
      >
        <CaseSensitive className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        onClick={() => doSearch('prev')}
        disabled={noResults}
        className={cn(
          'p-0.5 rounded hover:bg-accent',
          noResults && 'opacity-40 pointer-events-none',
        )}
        title={t('search.previous')}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        onClick={() => doSearch('next')}
        disabled={noResults}
        className={cn(
          'p-0.5 rounded hover:bg-accent',
          noResults && 'opacity-40 pointer-events-none',
        )}
        title={t('search.next')}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        onClick={handleClose}
        className="p-0.5 rounded hover:bg-accent"
        title={t('search.close')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
