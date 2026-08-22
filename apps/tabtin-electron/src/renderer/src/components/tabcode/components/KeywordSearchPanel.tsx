/**
 * 关键字搜索面板 (⌘⇧F / Ctrl+Shift+F)
 *
 * 通过系统 ripgrep 执行本地代码全文搜索：
 * - 按文件分组展示结果
 * - 支持 glob 文件过滤
 * - 关键词高亮
 * - hover 右侧 Tooltip 展示匹配行相邻上下文
 * - 点击跳转到指定文件行号
 */

import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Search,
  Loader2,
  Replace,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  MoreHorizontal,
  X,
} from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  toast,
  ToastAction,
} from '@tabtin/smartsheet-ui'
import { FileIcon } from '@components/shared/file-icon/FileIcon'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'
import type { TextEditorState } from '@components/shared/file-preview/TextFileEditor'
import {
  useKeywordSearch,
  type GroupedResult,
  type KeywordMatch,
  type KeywordSearchOptions,
} from '../hooks/useKeywordSearch'
import { basename as fileBasename } from '../utils/path'
import {
  loadSearchResultContext,
  SEARCH_RESULT_CONTEXT_TOOLTIP_DELAY_MS,
  type SearchContextLine,
  type SearchResultContextCache,
} from '../utils/searchResultContext'
import type { ReplaceInFilesEdit } from '@shared/ripgrep-search-types'
import { dirtyEditorStatesForFile } from '../utils/editorStateKey'

const log = createLogger('KeywordSearchPanel')
const MAX_REPLACE_EDITS = 500

/** 三种替换入口共用的禁用原因优先级，避免全部/文件/单处文案不一致。 */
export function resolveReplaceAvailability(input: {
  editsCount: number
  maxEdits?: number
  truncated: boolean
  replaceBusy: boolean
  hasInvalidReplacementPreview: boolean
  enabledLabel: string
  labels: {
    truncated: string
    tooMany: string
    invalidPreview: string
    busy: string
    noPreview: string
  }
}): { disabled: boolean; reason: string } {
  const maxEdits = input.maxEdits ?? MAX_REPLACE_EDITS
  const { editsCount, truncated, replaceBusy, hasInvalidReplacementPreview, enabledLabel, labels } = input
  if (truncated) return { disabled: true, reason: labels.truncated }
  if (editsCount > maxEdits) return { disabled: true, reason: labels.tooMany }
  if (hasInvalidReplacementPreview) return { disabled: true, reason: labels.invalidPreview }
  if (replaceBusy) return { disabled: true, reason: labels.busy }
  if (editsCount === 0) return { disabled: true, reason: labels.noPreview }
  return { disabled: false, reason: enabledLabel }
}

/** 工程搜索点选目标：行号 + 可选匹配词，供编辑器 FindSession 高亮复用。 */
export interface KeywordSearchSelectTarget {
  line?: number
  /** 主进程返回的 0-based 字符列；TabCodePaneHost 传给 Monaco 前会转成 1-based。 */
  column?: number
  matchText?: string
  matchKind?: KeywordMatch['matchKind']
  findOptions?: {
    caseSensitive?: boolean
    isRegex?: boolean
    wholeWord?: boolean
  }
}

interface KeywordSearchPanelProps {
  rootPath: string
  editorSessionKey?: string
  editorStatesByFile?: ReadonlyMap<string, TextEditorState>
  onFileSelect: (filePath: string, target?: KeywordSearchSelectTarget) => void
  onClose: () => void
  /** 侧栏常挂载时：仅在可见时 focus，避免抢文件树焦点。 */
  isActive?: boolean
}

type ReplaceRequest = {
  edits: ReplaceInFilesEdit[]
  scope: 'one' | 'file' | 'all'
  target?: {
    file: string
    line: number
    matchText: string
  }
}

export function findUniqueRefreshedTarget(
  groups: GroupedResult[],
  target: NonNullable<ReplaceRequest['target']>,
): { group: GroupedResult; match: KeywordMatch } | undefined {
  const candidates = groups.flatMap((group) => (
    group.file === target.file
      ? group.matches
        .filter((match) => (
          match.matchKind !== 'path'
          && match.line === target.line
          && match.matchText === target.matchText
        ))
        .map((match) => ({ group, match }))
      : []
  ))
  return candidates.length === 1 ? candidates[0] : undefined
}

function highlightRanges(
  text: string,
  ranges?: ReadonlyArray<{ start: number; end: number }>,
): React.ReactNode {
  if (!ranges?.length) return <span>{text}</span>
  const safeRanges = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(range.start, text.length)),
      end: Math.max(0, Math.min(range.end, text.length)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start)
  if (!safeRanges.length) return <span>{text}</span>

  const parts: React.ReactNode[] = []
  let cursor = 0
  safeRanges.forEach((range, index) => {
    if (range.start > cursor) {
      parts.push(<span key={`text-${index}`}>{text.slice(cursor, range.start)}</span>)
    }
    parts.push(
      <mark
        key={`match-${index}`}
        className="rounded-sm bg-warning/20 px-0.5 text-foreground"
      >
        {text.slice(range.start, range.end)}
      </mark>,
    )
    cursor = Math.max(cursor, range.end)
  })
  if (cursor < text.length) {
    parts.push(<span key="text-tail">{text.slice(cursor)}</span>)
  }
  return <span>{parts}</span>
}

function replacementPreview(
  text: string,
  ranges: ReadonlyArray<{ start: number; end: number }> | undefined,
  replacement: string | undefined,
  replacementError?: string,
  replacementErrorLabel = 'Replacement preview unavailable',
): React.ReactNode {
  if (replacementError) {
    return (
      <span title={replacementErrorLabel} className="text-destructive">
        {highlightRanges(text, ranges)}
        <span className="ml-1 text-caption">({replacementErrorLabel})</span>
      </span>
    )
  }
  if (replacement === undefined || !ranges?.[0]) return highlightRanges(text, ranges)
  const range = ranges[0]
  const start = Math.max(0, Math.min(range.start, text.length))
  const end = Math.max(start, Math.min(range.end, text.length))
  return (
    <span>
      {text.slice(0, start)}
      <del className="text-destructive/80">{text.slice(start, end)}</del>
      <span className="px-1 text-muted-foreground/50" aria-hidden>→</span>
      <mark className="rounded-sm bg-success/15 px-0.5 text-success">
        {replacement || '∅'}
      </mark>
      {text.slice(end)}
    </span>
  )
}

interface SearchMatchRowProps {
  filePath: string
  match: KeywordMatch
  /** 面板搜索词（优先于单条 matchText，避免 IPC 切片异常导致怪 query） */
  searchQuery: string
  searchOptions: KeywordSearchSelectTarget['findOptions']
  contextCache: SearchResultContextCache
  onSelect: (filePath: string, target?: KeywordSearchSelectTarget) => void
  onReplace?: () => void
  replaceDisabled?: boolean
  replaceDisabledReason?: string
}

const SearchMatchRow: React.FC<SearchMatchRowProps> = ({
  filePath,
  match,
  searchQuery,
  searchOptions,
  contextCache,
  onSelect,
  onReplace,
  replaceDisabled = false,
  replaceDisabledReason,
}) => {
  const { t } = useTranslation('tabcode')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [contextLines, setContextLines] = useState<SearchContextLine[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const requestIdRef = useRef(0)

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (!next) return
      if (contextLines || unavailable) return
      if (match.isBinary) {
        setUnavailable(true)
        return
      }

      const requestId = ++requestIdRef.current
      setLoading(true)
      void loadSearchResultContext(filePath, match.line, contextCache).then((snippet) => {
        if (requestId !== requestIdRef.current) return
        setLoading(false)
        if (!snippet) {
          setUnavailable(true)
          setContextLines(null)
          return
        }
        setContextLines(snippet)
        setUnavailable(false)
      })
    },
    [contextCache, contextLines, filePath, match.line, unavailable],
  )

  const rowButton = (
    <div className="flex w-full items-start">
      <button
        type="button"
        className={cn(
          'flex min-w-0 flex-1 items-start text-left text-caption transition-colors hover:bg-primary/5',
          'gap-1.5 py-0.5 pl-5 pr-1.5',
        )}
        onClick={() =>
          onSelect(filePath, {
            line: match.line,
            column: match.column,
            matchText: searchQuery.trim() || match.matchText,
            matchKind: match.matchKind,
            findOptions: searchOptions,
          })
        }
      >
        <span
          className={cn(
            'shrink-0 text-right tabular-nums text-muted-foreground/40',
            'w-6',
          )}
        >
          {match.line}
        </span>
        <pre className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-foreground/80 font-mono">
          {replacementPreview(
            match.text,
            match.ranges,
            match.replacement,
            match.replacementError,
            t('keywordSearch.replaceInvalidPreview'),
          )}
        </pre>
      </button>
      {onReplace && (
        <span
          className="inline-flex shrink-0"
          title={replaceDisabled ? (replaceDisabledReason || t('keywordSearch.replaceThis')) : t('keywordSearch.replaceThis')}
        >
          <button
            type="button"
            className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={
              replaceDisabled
                ? (replaceDisabledReason || t('keywordSearch.replaceThis'))
                : t('keywordSearch.replaceThis')
            }
            disabled={replaceDisabled}
            onClick={(event) => {
              event.stopPropagation()
              onReplace()
            }}
          >
            <Replace className="h-3 w-3" />
          </button>
        </span>
      )}
    </div>
  )

  return (
    <Tooltip open={open} onOpenChange={handleOpenChange}>
      <TooltipTrigger asChild>{rowButton}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        sideOffset={8}
        collisionBoundary={null}
        className="max-w-[min(28rem,70vw)] p-2"
      >
        {loading && (
          <div className="flex items-center gap-1.5 text-caption text-muted-foreground/80">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>{t('keywordSearch.contextLoading')}</span>
          </div>
        )}
        {!loading && unavailable && (
          <span className="text-caption text-muted-foreground/80">
            {t('keywordSearch.contextUnavailable')}
          </span>
        )}
        {!loading && contextLines && (
          <div className="font-mono text-caption leading-relaxed">
            {contextLines.map((line) => (
              <div
                key={line.lineNumber}
                className={cn(
                  'flex gap-2 rounded-sm px-1 py-px',
                  line.isMatch && 'bg-warning/20',
                )}
              >
                <span className="w-7 shrink-0 select-none text-right tabular-nums text-muted-foreground/50">
                  {line.lineNumber}
                </span>
                <pre className="min-w-0 flex-1 overflow-hidden whitespace-pre-wrap break-all text-foreground/90">
                  {line.isMatch
                    ? replacementPreview(
                        line.text,
                        line.text === match.text ? match.ranges : undefined,
                        line.text === match.text ? match.replacement : undefined,
                        line.text === match.text ? match.replacementError : undefined,
                        t('keywordSearch.replaceInvalidPreview'),
                      )
                    : line.text || ' '}
                </pre>
              </div>
            ))}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

export const KeywordSearchPanel: React.FC<KeywordSearchPanelProps> = ({
  rootPath,
  editorSessionKey = '',
  editorStatesByFile,
  onFileSelect,
  onClose,
  isActive = true,
}) => {
  const { t } = useTranslation('tabcode')
  const dirtyStatesForFile = useCallback(
    (file: string) => dirtyEditorStatesForFile(editorStatesByFile, editorSessionKey, file),
    [editorSessionKey, editorStatesByFile],
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [globFilter, setGlobFilter] = useState('')
  const [excludeGlobFilter, setExcludeGlobFilter] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [isRegex, setIsRegex] = useState(false)
  const [includeIgnored, setIncludeIgnored] = useState(false)
  const [replaceText, setReplaceText] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [showGlob, setShowGlob] = useState(false)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [confirmAllOpen, setConfirmAllOpen] = useState(false)
  const [dirtyDialogOpen, setDirtyDialogOpen] = useState(false)
  const [pendingReplaceRequest, setPendingReplaceRequest] = useState<ReplaceRequest | null>(null)
  const [replaceBusy, setReplaceBusy] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contextCacheRef = useRef<SearchResultContextCache>(new Map())

  const {
    results,
    isSearching,
    loadingMoreFiles,
    error,
    errorCode,
    totalMatches,
    contentTruncated,
    pathMatchesTruncated,
    search,
    loadMoreForFile,
    cancel,
    clear,
  } =
    useKeywordSearch(rootPath)

  const searchRef = useRef(search)
  searchRef.current = search
  const clearRef = useRef(clear)
  clearRef.current = clear
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  useEffect(() => {
    if (!isActive) return
    inputRef.current?.focus()
  }, [isActive])

  useEffect(() => {
    setExpandedFiles(new Set(results.slice(0, 10).map((r) => r.file)))
    contextCacheRef.current = new Map()
  }, [results])

  const doSearch = useCallback(
    (q: string, options: KeywordSearchOptions) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (!q.trim()) {
        clearRef.current()
        return
      }
      // debounce 等待期间也不能保留旧结果，否则点击旧行会用新 query/options 定位。
      clearRef.current()
      debounceRef.current = setTimeout(() => {
        void searchRef.current(q, options)
      }, 300)
    },
    [],
  )

  const buildSearchOptions = useCallback(
    (overrides: Partial<KeywordSearchOptions> = {}): KeywordSearchOptions => {
      const hasMatchCaseOverride = Object.prototype.hasOwnProperty.call(overrides, 'matchCase')
      const hasReplaceOverride = Object.prototype.hasOwnProperty.call(overrides, 'replace')
      return {
        glob: overrides.glob ?? (globFilter.trim() || undefined),
        excludeGlob: overrides.excludeGlob ?? (excludeGlobFilter.trim() || undefined),
        matchCase: hasMatchCaseOverride ? overrides.matchCase : caseSensitive,
        wholeWord: overrides.wholeWord ?? wholeWord,
        isRegex: overrides.isRegex ?? isRegex,
        includeIgnored: overrides.includeIgnored ?? includeIgnored,
        replace: hasReplaceOverride
          ? overrides.replace
          : showReplace ? replaceText : undefined,
      }
    },
    [caseSensitive, excludeGlobFilter, globFilter, includeIgnored, isRegex, replaceText, showReplace, wholeWord],
  )

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value)
      doSearch(value, buildSearchOptions())
    },
    [buildSearchOptions, doSearch],
  )

  const handleGlobChange = useCallback(
    (value: string) => {
      setGlobFilter(value)
      if (query.trim()) doSearch(query, buildSearchOptions({ glob: value }))
    },
    [buildSearchOptions, doSearch, query],
  )

  const handleExcludeGlobChange = useCallback(
    (value: string) => {
      setExcludeGlobFilter(value)
      if (query.trim()) doSearch(query, buildSearchOptions({ excludeGlob: value }))
    },
    [buildSearchOptions, doSearch, query],
  )

  const handleOptionChange = useCallback(
    (next: Partial<KeywordSearchOptions>) => {
      if (query.trim()) doSearch(query, buildSearchOptions(next))
    },
    [buildSearchOptions, doSearch, query],
  )

  const handleReplaceTextChange = useCallback(
    (value: string) => {
      setReplaceText(value)
      if (query.trim()) doSearch(query, buildSearchOptions({ replace: value }))
    },
    [buildSearchOptions, doSearch, query],
  )

  const handleReplaceToggle = useCallback(() => {
    const next = !showReplace
    setShowReplace(next)
    if (query.trim()) {
      doSearch(query, buildSearchOptions({ replace: next ? replaceText : undefined }))
    }
  }, [buildSearchOptions, doSearch, query, replaceText, showReplace])

  const findOptions = useMemo<KeywordSearchSelectTarget['findOptions']>(() => ({
    caseSensitive,
    isRegex,
    wholeWord,
  }), [caseSensitive, isRegex, wholeWord])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [onClose],
  )

  const toggleFile = useCallback((file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }, [])

  /** 有内容匹配的文件才可展开；纯文件名命中没有子行。 */
  const expandableFiles = useMemo(
    () =>
      results
        .filter((group) => group.matches.some((m) => m.matchKind !== 'path'))
        .map((group) => group.file),
    [results],
  )

  const allExpanded =
    expandableFiles.length > 0 &&
    expandableFiles.every((file) => expandedFiles.has(file))

  const toggleExpandAll = useCallback(() => {
    if (allExpanded) {
      setExpandedFiles(new Set())
      return
    }
    setExpandedFiles(new Set(expandableFiles))
  }, [allExpanded, expandableFiles])

  // showReplace distinguishes “replace disabled” from a valid empty-string delete.
  const replacementEnabled = showReplace

  const collectReplaceEdits = useCallback((groups: GroupedResult[]): ReplaceInFilesEdit[] => {
    // 仅内容截断阻断写回；文件名遍历未完成不得清空已完整的内容预览 edits。
    if (!replacementEnabled || contentTruncated) return []
    const edits: ReplaceInFilesEdit[] = []
    for (const group of groups) {
      for (const match of group.matches) {
        if (
          match.matchKind === 'path'
          || match.isBinary
          || match.byteRange == null
          || match.replacement === undefined
          || match.replacementError !== undefined
        ) {
          continue
        }
        edits.push({
          file: group.file,
          byteStart: match.byteRange.start,
          byteEnd: match.byteRange.end,
          expectedText: match.matchText,
          replacement: match.replacement,
        })
      }
    }
    return edits
  }, [contentTruncated, replacementEnabled])

  const allReplaceEdits = useMemo(
    () => collectReplaceEdits(results),
    [collectReplaceEdits, results],
  )
  const hasInvalidReplacementPreview = results.some(group => group.matches.some(
    match => match.replacementError !== undefined,
  ))
  const replaceAvailabilityLabels = useMemo(() => ({
    truncated: t('keywordSearch.replaceTruncated'),
    tooMany: t('keywordSearch.replaceTooMany'),
    invalidPreview: t('keywordSearch.replaceInvalidPreview'),
    busy: t('keywordSearch.replaceBusy'),
    noPreview: t('keywordSearch.replaceNoPreview'),
  }), [t])
  const replaceAllAvailability = resolveReplaceAvailability({
    editsCount: allReplaceEdits.length,
    truncated: contentTruncated,
    replaceBusy,
    hasInvalidReplacementPreview,
    enabledLabel: t('keywordSearch.replaceAll'),
    labels: replaceAvailabilityLabels,
  })
  const hasActiveFilters = Boolean(
    globFilter.trim()
    || excludeGlobFilter.trim()
    || includeIgnored,
  )
  // 面板展开，或收起后仍有过滤条件生效时，保持高亮，避免「看着没开却在过滤」
  const filterButtonActive = showGlob || hasActiveFilters

  const executeReplace = useCallback(async (edits: ReplaceInFilesEdit[]) => {
    if (!edits.length) {
      setReplaceBusy(false)
      return
    }
    let shouldRefreshResults = false
    try {
      const checkpointApi = window.tabtin?.checkpoint
      if (!checkpointApi) {
        toast({
          title: t('keywordSearch.replaceFailed'),
          description: t('keywordSearch.checkpointUnavailable'),
          variant: 'destructive',
        })
        return
      }
      const initResult = await checkpointApi.init(rootPath)
      if (!initResult?.success) {
        toast({
          title: t('keywordSearch.replaceFailed'),
          description: initResult?.error || t('keywordSearch.checkpointFailed'),
          variant: 'destructive',
        })
        return
      }
      const commitResult = await checkpointApi.commit(rootPath, {
        kind: 'safety_before_replace',
        trigger: 'tabcode_replace',
        allowEmpty: true,
        visibleInHistory: false,
      })
      if (!commitResult?.success) {
        toast({
          title: t('keywordSearch.replaceFailed'),
          description: commitResult?.error || t('keywordSearch.checkpointFailed'),
          variant: 'destructive',
        })
        return
      }
      if (!commitResult.commitHash) {
        toast({
          title: t('keywordSearch.replaceFailed'),
          description: t('keywordSearch.checkpointFailed'),
          variant: 'destructive',
        })
        return
      }

      const result = await window.tabtin.fileSystem.replaceInFiles({ rootPath, edits })
      if (!result?.success && result.files.length === 0) {
        toast({
          title: t('keywordSearch.replaceFailed'),
          description: result?.error || t('keywordSearch.replaceFailed'),
          variant: 'destructive',
        })
        return
      }
      const failedCount = result.files.filter((file) => file.status === 'failed').length
      const skippedCount = result.files.filter((file) => file.status === 'skipped').length
      const fileReasons = result.files
        .filter((file) => file.status !== 'success' && file.reason)
        .slice(0, 5)
        .map((file) => t('keywordSearch.replaceFileReason', {
          file: fileBasename(file.file),
          reason: file.reason,
        }))
      const commitHash = commitResult.commitHash
      const undoAction = commitHash && result.totalReplacements > 0 ? (
        <ToastAction
          altText={t('keywordSearch.undoReplace')}
          onClick={() => {
            void (async () => {
              try {
                const restoreResult = await checkpointApi.restore(rootPath, commitHash)
                if (!restoreResult?.success) {
                  toast({
                    title: t('keywordSearch.undoFailed'),
                    description: restoreResult?.error || t('keywordSearch.undoFailed'),
                    variant: 'destructive',
                  })
                  return
                }
                toast({ title: t('keywordSearch.undoSuccess') })
                await searchRef.current(query, buildSearchOptions())
              } catch (error) {
                log.error('撤销替换失败', {
                  errorType: error instanceof Error ? error.name : typeof error,
                })
                toast({
                  title: t('keywordSearch.undoFailed'),
                  description: t('keywordSearch.undoFailed'),
                  variant: 'destructive',
                })
              }
            })()
          }}
        >
          {t('keywordSearch.undoReplace')}
        </ToastAction>
      ) : undefined
      const hasPartialFailure = failedCount > 0 || skippedCount > 0
      toast({
        title: result.status === 'failed'
          ? t('keywordSearch.replaceFailed')
          : hasPartialFailure
            ? t('keywordSearch.replacePartial')
            : t('keywordSearch.replaceSuccess'),
        description: [
          t('keywordSearch.replaceSummary', {
            files: result.files.filter((file) => file.status === 'success').length,
            replacements: result.totalReplacements,
            skipped: skippedCount,
            failed: failedCount,
          }),
          ...fileReasons,
          undoAction ? t('keywordSearch.undoWarning') : null,
        ].filter(Boolean).join(' '),
        // 默认 success/info 仅 2s，带撤销时加长，避免跨文件替换来不及点撤销。
        duration: undoAction ? 15_000 : hasPartialFailure ? 5_000 : undefined,
        ...(hasPartialFailure ? { variant: 'destructive' as const } : {}),
        ...(undoAction ? { action: undoAction } : {}),
      })
      // 写盘结束后立刻解锁按钮；结果刷新走独立搜索态，避免重搜慢/卡住时替换按钮假死。
      shouldRefreshResults = true
    } catch (error) {
      log.error('跨文件替换失败', {
        errorType: error instanceof Error ? error.name : typeof error,
      })
      toast({
        title: t('keywordSearch.replaceFailed'),
        description: t('keywordSearch.replaceFailed'),
        variant: 'destructive',
      })
    } finally {
      setReplaceBusy(false)
    }
    if (shouldRefreshResults) {
      try {
        await searchRef.current(query, buildSearchOptions())
      } catch (error) {
        log.warn('替换后刷新搜索失败', {
          errorType: error instanceof Error ? error.name : typeof error,
        })
      }
    }
  }, [buildSearchOptions, query, rootPath, t])

  const beginReplace = useCallback((request: ReplaceRequest) => {
    const { edits } = request
    if (!edits.length || edits.length > MAX_REPLACE_EDITS) {
      setReplaceBusy(false)
      setPendingReplaceRequest(null)
      setDirtyDialogOpen(false)
      setConfirmAllOpen(false)
      toast({
        title: t('keywordSearch.replaceUnavailable'),
        description: contentTruncated
          ? t('keywordSearch.replaceTruncated')
          : hasInvalidReplacementPreview
            ? t('keywordSearch.replaceInvalidPreview')
            : edits.length > MAX_REPLACE_EDITS
              ? t('keywordSearch.replaceTooMany')
              : t('keywordSearch.replaceNoContent'),
        variant: 'destructive',
      })
      return
    }
    const dirtyFiles = Array.from(new Set(
      edits
        .map((edit) => edit.file)
        .filter((file) => dirtyStatesForFile(file).length > 0),
    ))
    if (dirtyFiles.length > 0) {
      // 跳过脏文件等路径可能已先置 busy；进入脏文件对话框前必须复位，否则按钮会一直灰掉。
      setReplaceBusy(false)
      setPendingReplaceRequest(request)
      setDirtyDialogOpen(true)
      return
    }
    setReplaceBusy(true)
    void executeReplace(edits)
  }, [contentTruncated, dirtyStatesForFile, executeReplace, hasInvalidReplacementPreview, t])

  const handleReplaceAllRequest = useCallback(() => {
    const edits = collectReplaceEdits(results)
    if (!edits.length) {
      beginReplace({ edits, scope: 'all' })
      return
    }
    setPendingReplaceRequest({ edits, scope: 'all' })
    setConfirmAllOpen(true)
  }, [beginReplace, collectReplaceEdits, results])

  const handleSaveDirtyAndReplace = useCallback(async () => {
    if (!pendingReplaceRequest || replaceBusy) return
    setReplaceBusy(true)
    const pendingReplaceEdits = pendingReplaceRequest.edits
    const dirtyFiles = Array.from(new Set(
      pendingReplaceEdits
        .map((edit) => edit.file)
        .filter((file) => dirtyStatesForFile(file).length > 0),
    ))
    for (const file of dirtyFiles) {
      const dirtyStates = dirtyStatesForFile(file)
      if (dirtyStates.length > 1) {
        setReplaceBusy(false)
        toast({
          title: t('keywordSearch.replaceFailed'),
          description: t('keywordSearch.dirtyFileConflict', { file: fileBasename(file) }),
          variant: 'destructive',
        })
        return
      }
      const state = dirtyStates[0]?.[1]
      if (!state) continue
      let saved = false
      try {
        saved = await state.save()
      } catch (error) {
        log.error('保存脏文件失败', {
          file: fileBasename(file),
          errorType: error instanceof Error ? error.name : typeof error,
        })
      }
      if (!saved) {
        setReplaceBusy(false)
        toast({
          title: t('keywordSearch.replaceFailed'),
          description: t('keywordSearch.saveDirtyFailed', { file: fileBasename(file) }),
          variant: 'destructive',
        })
        return
      }
    }
    const refreshedResults = await searchRef.current(query, buildSearchOptions())
    if (!refreshedResults) {
      setReplaceBusy(false)
      toast({
        title: t('keywordSearch.replaceFailed'),
        description: t('keywordSearch.replaceNoPreview'),
        variant: 'destructive',
      })
      return
    }
    let edits: ReplaceInFilesEdit[] = []
    if (pendingReplaceRequest.scope === 'one' && pendingReplaceRequest.target) {
      const target = pendingReplaceRequest.target
      const candidate = findUniqueRefreshedTarget(refreshedResults, target)
      if (!candidate) {
        setReplaceBusy(false)
        toast({
          title: t('keywordSearch.replaceFailed'),
          description: t('keywordSearch.replaceTargetChanged'),
          variant: 'destructive',
        })
        return
      }
      const { group, match } = candidate
      edits = collectReplaceEdits([{ ...group, matches: [match] }])
    } else {
      const files = pendingReplaceRequest.scope === 'all'
        ? null
        : new Set(pendingReplaceEdits.map((edit) => edit.file))
      edits = collectReplaceEdits(
        files ? refreshedResults.filter((group) => files.has(group.file)) : refreshedResults,
      )
    }
    if (!edits.length || edits.length > MAX_REPLACE_EDITS) {
      setReplaceBusy(false)
      toast({
        title: t('keywordSearch.replaceUnavailable'),
        description: edits.length > MAX_REPLACE_EDITS
          ? t('keywordSearch.replaceTooMany')
          : t('keywordSearch.replaceTargetChanged'),
        variant: 'destructive',
      })
      return
    }
    setPendingReplaceRequest(null)
    setDirtyDialogOpen(false)
    await executeReplace(edits)
  }, [
    buildSearchOptions,
    collectReplaceEdits,
    dirtyStatesForFile,
    executeReplace,
    pendingReplaceRequest,
    query,
    replaceBusy,
    t,
  ])

  const handleSkipDirtyAndReplace = useCallback(() => {
    if (!pendingReplaceRequest || replaceBusy) return
    const pendingReplaceEdits = pendingReplaceRequest.edits
    const dirtyFiles = new Set(
      pendingReplaceEdits
        .map((edit) => edit.file)
        .filter((file) => dirtyStatesForFile(file).length > 0),
    )
    const edits = pendingReplaceEdits.filter((edit) => !dirtyFiles.has(edit.file))
    const request = { ...pendingReplaceRequest, edits }
    setPendingReplaceRequest(null)
    setDirtyDialogOpen(false)
    setConfirmAllOpen(false)
    if (edits.length === 0) {
      setReplaceBusy(false)
      toast({
        title: t('keywordSearch.replaceUnavailable'),
        description: t('keywordSearch.replaceNoContent'),
        variant: 'destructive',
      })
      return
    }
    setReplaceBusy(true)
    beginReplace(request)
  }, [beginReplace, dirtyStatesForFile, pendingReplaceRequest, replaceBusy, t])

  return (
    <div className="flex h-full flex-col" role="search" aria-label={t('keywordSearch.placeholder')}>
      {/* Header */}
      <div className="flex flex-col border-b border-border/30">
        <div className="relative min-w-0">
          <div className="flex min-w-0 items-stretch">
            <button
              type="button"
              onClick={handleReplaceToggle}
              className={cn(
                'flex w-4 shrink-0 items-center justify-center transition-colors',
                showReplace
                  ? 'bg-primary/5 text-primary'
                  : 'text-muted-foreground/40 hover:bg-muted/20 hover:text-foreground',
              )}
              title={t(showReplace ? 'keywordSearch.collapseReplace' : 'keywordSearch.expandReplace')}
              aria-label={t(showReplace ? 'keywordSearch.collapseReplace' : 'keywordSearch.expandReplace')}
              aria-pressed={showReplace}
            >
              {showReplace ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-1.5 pr-2">
              <div
                className={cn(
                  'flex min-w-0 items-center gap-1 rounded border border-border/30 bg-muted/20',
                  'px-2 py-1',
                )}
              >
                <input
                  ref={inputRef}
                  type="search"
                  className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground/30 [&::-webkit-search-cancel-button]:hidden"
                  placeholder={t('keywordSearch.placeholder')}
                  value={query}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                  aria-label={t('keywordSearch.searchInputLabel')}
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = !caseSensitive
                    setCaseSensitive(next)
                    handleOptionChange({ matchCase: next })
                  }}
                  className={cn(
                    'shrink-0 rounded-md p-1 transition-colors',
                    caseSensitive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground/60 hover:bg-muted/30 hover:text-foreground',
                  )}
                  title={t(`keywordSearch.caseMode.${caseSensitive ? 'sensitive' : 'insensitive'}`)}
                  aria-label={t(`keywordSearch.caseMode.${caseSensitive ? 'sensitive' : 'insensitive'}`)}
                  aria-pressed={caseSensitive}
                >
                  <span className="flex h-5 w-5 items-center justify-center text-caption font-medium leading-none">
                    Aa
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = !wholeWord
                    setWholeWord(next)
                    handleOptionChange({ wholeWord: next })
                  }}
                  className={cn(
                    'shrink-0 rounded-md p-1 transition-colors',
                    wholeWord
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground/60 hover:bg-muted/30 hover:text-foreground',
                  )}
                  title={t('keywordSearch.wholeWord')}
                  aria-label={t('keywordSearch.wholeWord')}
                  aria-pressed={wholeWord}
                >
                  <span className="flex h-5 w-5 items-center justify-center text-caption leading-none underline decoration-1 underline-offset-2">
                    ab
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = !isRegex
                    setIsRegex(next)
                    handleOptionChange({ isRegex: next })
                  }}
                  className={cn(
                    'shrink-0 rounded-md p-1 transition-colors',
                    isRegex
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground/60 hover:bg-muted/30 hover:text-foreground',
                  )}
                  title={t('keywordSearch.regex')}
                  aria-label={t('keywordSearch.regex')}
                  aria-pressed={isRegex}
                >
                  <span className="flex h-5 w-5 items-center justify-center font-mono text-caption leading-none">
                    .*
                  </span>
                </button>
                {isSearching && (
                  <button
                    type="button"
                    onClick={() => cancelRef.current()}
                    className="shrink-0 rounded-md p-1 text-primary/80 transition-colors hover:bg-primary/10 hover:text-primary"
                    title={t('keywordSearch.cancel')}
                    aria-label={t('keywordSearch.cancel')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                {query.length > 0 && !isSearching && (
                  <button
                    type="button"
                    onClick={() => handleQueryChange('')}
                    className="shrink-0 rounded-md p-1 text-muted-foreground/40 transition-colors hover:text-foreground"
                    title={t('keywordSearch.clearQuery')}
                    aria-label={t('keywordSearch.clearQuery')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              {showReplace && (
                <div className="flex min-w-0 items-center rounded border border-border/30 bg-muted/20 px-2 py-1">
                  <input
                    type="text"
                    className="min-w-0 w-full bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground/30"
                    placeholder={t('keywordSearch.replacePlaceholder')}
                    value={replaceText}
                    onChange={(event) => handleReplaceTextChange(event.target.value)}
                    aria-label={t('keywordSearch.replaceWith')}
                  />
                </div>
              )}
            </div>
          </div>
          {/* 绝对定位在搜索/替换块外右下方，不占布局行 */}
          <button
            type="button"
            onClick={() => setShowGlob((current) => !current)}
            className={cn(
              'absolute right-1 top-full z-floating mt-0.5 flex h-6 w-6 items-center justify-center rounded-md transition-colors',
              filterButtonActive
                ? 'bg-primary/5 text-primary'
                : 'text-muted-foreground/40 hover:bg-muted/30 hover:text-foreground',
            )}
            title={
              hasActiveFilters && !showGlob
                ? t('keywordSearch.filterGlobActive')
                : t('keywordSearch.filterGlob')
            }
            aria-label={
              hasActiveFilters && !showGlob
                ? t('keywordSearch.filterGlobActive')
                : t('keywordSearch.filterGlob')
            }
            aria-pressed={filterButtonActive}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
        {showGlob && (
          <div className="flex flex-col gap-2 pb-2 pl-4 pr-2 pt-3">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-caption text-muted-foreground/60">
                {t('keywordSearch.includeGlob')}
              </span>
              <input
                type="text"
                className="min-w-0 w-full rounded border border-border/30 bg-muted/20 px-2 py-1 text-body text-foreground outline-none placeholder:text-muted-foreground/30"
                placeholder={t('keywordSearch.globPlaceholder')}
                value={globFilter}
                onChange={(e) => handleGlobChange(e.target.value)}
                aria-label={t('keywordSearch.includeGlob')}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-caption text-muted-foreground/60">
                {t('keywordSearch.excludeGlob')}
              </span>
              <input
                type="text"
                className="min-w-0 w-full rounded border border-border/30 bg-muted/20 px-2 py-1 text-body text-foreground outline-none placeholder:text-muted-foreground/30"
                placeholder={t('keywordSearch.excludeGlobPlaceholder')}
                value={excludeGlobFilter}
                onChange={(e) => handleExcludeGlobChange(e.target.value)}
                aria-label={t('keywordSearch.excludeGlob')}
              />
            </label>
            <label className="flex items-center gap-2 text-caption text-muted-foreground/60">
              <input
                type="checkbox"
                checked={includeIgnored}
                onChange={(e) => {
                  const next = e.target.checked
                  setIncludeIgnored(next)
                  handleOptionChange({ includeIgnored: next })
                }}
              />
              {t('keywordSearch.includeIgnored')}
            </label>
          </div>
        )}
      </div>

      {/* Stats bar；过滤区收起时 … 绝对定位占位，需预留一行高度 */}
      {totalMatches > 0 && (
        <div
          className={cn(
            'flex items-center gap-1 border-b border-border/10 py-1 text-caption text-muted-foreground/60',
            'px-2',
            !showGlob && 'pt-7',
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {t('keywordSearch.matchCount', {
              count: totalMatches,
              files: results.length,
            })}
          </span>
          {expandableFiles.length > 0 && (
            <button
              type="button"
              onClick={toggleExpandAll}
              className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-muted/40 hover:text-foreground"
              title={
                allExpanded
                  ? t('keywordSearch.collapseAll')
                  : t('keywordSearch.expandAll')
              }
              aria-label={
                allExpanded
                  ? t('keywordSearch.collapseAll')
                  : t('keywordSearch.expandAll')
              }
              aria-pressed={allExpanded}
            >
              {allExpanded ? (
                <ChevronsDownUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronsUpDown className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {replacementEnabled && (
            // disabled 按钮本身不触发 hover/title，外包一层才能显示截断等原因
            <span className="inline-flex shrink-0" title={replaceAllAvailability.reason}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 gap-1 px-1.5 text-caption"
                disabled={replaceAllAvailability.disabled}
                aria-label={replaceAllAvailability.reason}
                onClick={handleReplaceAllRequest}
              >
                <Replace className="h-3 w-3" />
                {t('keywordSearch.replaceAll')}
              </Button>
            </span>
          )}
        </div>
      )}
      {/* Results */}
      <div className="flex-1 overflow-y-auto" role="region" aria-label={t('keywordSearch.searchResultsLabel')} aria-live="polite">
        {error && (
          <div
            className={cn(
              'py-3 text-body text-destructive/80',
              'px-2',
            )}
          >
            {errorCode === 'invalid_pattern' && (
              <span className="font-medium">{t('keywordSearch.invalidPattern')}: </span>
            )}
            {errorCode === 'load_more_failed' && (
              <span className="font-medium">{t('keywordSearch.loadMoreFailed')}: </span>
            )}
            {error}
          </div>
        )}

        {query.trim() && !isSearching && totalMatches === 0 && !error && (
          <div
            className={cn(
              'flex flex-col items-center justify-center text-center',
              'px-3 py-8',
            )}
          >
            <Search className="mb-3 h-6 w-6 text-muted-foreground/20" />
            <p className="text-body text-muted-foreground/60">
              {t('keywordSearch.noResults')}
            </p>
          </div>
        )}

        <TooltipProvider delayDuration={SEARCH_RESULT_CONTEXT_TOOLTIP_DELAY_MS}>
          {results.map((group) => {
            const pathMatch = group.matches.find((m) => m.matchKind === 'path')
            const contentMatches = group.matches.filter((m) => m.matchKind !== 'path')
            const hasContentMatches = contentMatches.length > 0
            const contentMatchCount = contentMatches.reduce(
              (count, match) => count + (match.ranges?.length || 1),
              0,
            )
            const fileReplaceEdits = collectReplaceEdits([group])
            const fileReplaceAvailability = resolveReplaceAvailability({
              editsCount: fileReplaceEdits.length,
              truncated: contentTruncated,
              replaceBusy,
              hasInvalidReplacementPreview,
              enabledLabel: t('keywordSearch.replaceFile'),
              labels: replaceAvailabilityLabels,
            })
            const isExpanded = expandedFiles.has(group.file)
            const fileName = fileBasename(group.file)

            return (
              <div key={group.file}>
                <div className="flex w-full items-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-1 text-left text-body transition-colors hover:bg-muted/15',
                          'px-1.5 py-1',
                        )}
                        onClick={() => {
                          if (hasContentMatches) {
                            toggleFile(group.file)
                            return
                          }
                          // 仅文件名命中：点文件头直接打开，不再展开空列表
                          onFileSelect(group.file)
                        }}
                      >
                      {hasContentMatches ? (
                        isExpanded ? (
                          <ChevronDown className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                        )
                      ) : (
                        <span className="h-3 w-3 shrink-0" aria-hidden />
                      )}
                      <FileIcon
                        fileName={fileName}
                        isDirectory={false}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <span className="truncate text-foreground/80 font-medium">
                        {pathMatch
                          ? highlightRanges(fileName, pathMatch.ranges)
                          : fileName}
                      </span>
                      <span className="ml-auto text-muted-foreground/40 truncate text-caption max-w-[40%]">
                        {group.relativePath}
                      </span>
                      {group.matches.some((match) => match.isBinary) && (
                        <span className="shrink-0 text-caption text-warning/80">
                          {t('keywordSearch.binary')}
                        </span>
                      )}
                      {hasContentMatches && (
                        <span className="shrink-0 ml-1 rounded-full bg-muted/30 px-1.5 text-caption text-muted-foreground/60 tabular-nums">
                          {contentMatchCount}
                        </span>
                      )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      align="start"
                      sideOffset={8}
                      collisionBoundary={null}
                      className="max-w-[min(28rem,70vw)] break-all px-2 py-1.5 font-mono text-caption"
                    >
                      {group.file}
                    </TooltipContent>
                  </Tooltip>
                  {replacementEnabled && hasContentMatches && (
                    <span
                      className="inline-flex shrink-0"
                      title={fileReplaceAvailability.reason}
                    >
                      <button
                        type="button"
                        className="rounded p-1 text-muted-foreground/50 transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label={fileReplaceAvailability.reason}
                        disabled={fileReplaceAvailability.disabled}
                        onClick={() => beginReplace({ edits: fileReplaceEdits, scope: 'file' })}
                      >
                        <Replace className="h-3 w-3" />
                      </button>
                    </span>
                  )}
                </div>
                {hasContentMatches && isExpanded && (
                  <>
                    {contentMatches.map((m, i) => {
                      const matchEdits = collectReplaceEdits([{
                        ...group,
                        matches: [m],
                      }])
                      const matchReplaceAvailability = resolveReplaceAvailability({
                        editsCount: matchEdits.length,
                        truncated: contentTruncated,
                        replaceBusy,
                        hasInvalidReplacementPreview,
                        enabledLabel: t('keywordSearch.replaceThis'),
                        labels: replaceAvailabilityLabels,
                      })
                      return (
                        <SearchMatchRow
                          key={`${group.file}-${m.line}-${i}`}
                          filePath={group.file}
                          match={m}
                          searchQuery={query}
                          searchOptions={findOptions}
                          contextCache={contextCacheRef.current}
                          onSelect={onFileSelect}
                          onReplace={
                            replacementEnabled
                              ? () => beginReplace({
                                edits: matchEdits,
                                scope: 'one',
                                target: {
                                  file: group.file,
                                  line: m.line,
                                  matchText: m.matchText,
                                },
                              })
                              : undefined
                          }
                          replaceDisabled={matchReplaceAvailability.disabled}
                          replaceDisabledReason={matchReplaceAvailability.reason}
                        />
                      )
                    })}
                    {group.mayHaveMore && (
                      <button
                        type="button"
                        className="flex w-full items-center gap-1 px-6 py-1 text-left text-caption text-primary/80 transition-colors hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={loadingMoreFiles.has(group.file) || isSearching}
                        onClick={() => void loadMoreForFile(group.file)}
                      >
                        {loadingMoreFiles.has(group.file)
                          ? t('keywordSearch.loadingMore')
                          : t('keywordSearch.loadMore')}
                      </button>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </TooltipProvider>
        {contentTruncated && (
          <div className="border-t border-warning/20 bg-warning/5 px-2 py-1 text-caption text-warning/80">
            {t('keywordSearch.truncated', { count: totalMatches })}
          </div>
        )}
        {!contentTruncated && pathMatchesTruncated && (
          <div className="border-t border-border/30 bg-muted/20 px-2 py-1 text-caption text-muted-foreground/80">
            {t('keywordSearch.pathMatchesTruncated')}
          </div>
        )}
      </div>
      <Dialog
        open={confirmAllOpen}
        onOpenChange={(open) => {
          setConfirmAllOpen(open)
          if (!open) setPendingReplaceRequest(null)
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('keywordSearch.confirmReplaceAllTitle')}</DialogTitle>
            <DialogDescription>
              {t('keywordSearch.confirmReplaceAllDescription', {
                files: new Set((pendingReplaceRequest?.edits ?? []).map((edit) => edit.file)).size,
                replacements: pendingReplaceRequest?.edits.length ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setConfirmAllOpen(false)
                setPendingReplaceRequest(null)
              }}
            >
              {t('confirm.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={replaceBusy}
              onClick={() => {
                const request = pendingReplaceRequest
                setConfirmAllOpen(false)
                setPendingReplaceRequest(null)
                if (request) beginReplace(request)
              }}
            >
              {t('keywordSearch.replaceAll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={dirtyDialogOpen}
        onOpenChange={(open) => {
          setDirtyDialogOpen(open)
          if (!open) setPendingReplaceRequest(null)
        }}
      >
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{t('keywordSearch.dirtyFilesTitle')}</DialogTitle>
            <DialogDescription>
              {t('keywordSearch.dirtyFilesDescription', {
                files: Array.from(new Set(
                  (pendingReplaceRequest?.edits ?? [])
                    .map((edit) => edit.file)
                    .filter((file) => dirtyStatesForFile(file).length > 0),
                )).map(fileBasename).join(', '),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDirtyDialogOpen(false)
                setPendingReplaceRequest(null)
              }}
            >
              {t('confirm.cancel')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={replaceBusy}
              onClick={handleSkipDirtyAndReplace}
            >
              {t('keywordSearch.skipDirty')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={replaceBusy}
              onClick={() => void handleSaveDirtyAndReplace()}
            >
              {t('keywordSearch.saveDirtyAndReplace')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
