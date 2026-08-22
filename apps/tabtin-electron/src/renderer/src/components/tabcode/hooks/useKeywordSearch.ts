/**
 * Ripgrep 关键字搜索 hook
 *
 * 通过主进程 IPC 调用系统 rg 二进制，返回按文件分组的匹配结果。
 * 支持 glob 过滤、取消、300ms 自动防抖、单文件加载更多。
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { createLogger } from '@/utils/logger'
import { relativePath } from '../utils/path'
import type {
  RipgrepSearchOptions,
  RipgrepSearchRange,
  RipgrepSearchReplacement,
  RipgrepSearchResult,
} from '@shared/ripgrep-search-types'
import {
  RIPGREP_DEFAULT_PER_FILE_MAX_COUNT,
  RIPGREP_LOAD_MORE_PER_FILE_MAX_COUNT,
} from '@shared/ripgrep-search-types'

const log = createLogger('KeywordSearch')

function createSearchRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // IPC 仅校验非空且长度受限，不要求 UUID 格式。
  return `search-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export type KeywordSearchOptions = Pick<
  RipgrepSearchOptions,
  | 'glob'
  | 'includeGlobs'
  | 'excludeGlob'
  | 'excludeGlobs'
  | 'matchCase'
  | 'wholeWord'
  | 'isRegex'
  | 'includeIgnored'
  | 'replace'
>

export interface KeywordMatch {
  line: number
  column: number
  text: string
  matchText: string
  matchKind?: 'content' | 'path'
  ranges?: RipgrepSearchRange[]
  byteRange?: { start: number; end: number }
  replacement?: string
  replacementError?: 'missing_preview'
  replacements?: RipgrepSearchReplacement[]
  isBinary?: boolean
}

export interface GroupedResult {
  file: string
  relativePath: string
  matches: KeywordMatch[]
  /**
   * 内容匹配行数触达本次 per-file 上限时为 true，可「加载更多」。
   * 保守启发式：恰好等于上限也可能没有更多结果（false positive）；
   * 点击加载更多后若未再增长会收敛为 false。
   */
  mayHaveMore?: boolean
}

function countContentMatchLines(matches: KeywordMatch[]): number {
  const lines = new Set<number>()
  for (const match of matches) {
    if (match.matchKind === 'path') continue
    lines.add(match.line)
  }
  return lines.size
}

function countTotalMatches(groups: GroupedResult[]): number {
  return groups.reduce(
    (total, group) => total + group.matches.reduce(
      (count, match) => count + (match.ranges?.length || 1),
      0,
    ),
    0,
  )
}

function mapResultsToGroups(
  rootPath: string,
  results: RipgrepSearchResult[],
  perFileMaxCount: number | null,
): GroupedResult[] {
  const grouped = new Map<string, GroupedResult>()
  for (const r of results) {
    if (r.isDirectory) continue
    const rel = relativePath(rootPath, r.file)
    if (!grouped.has(r.file)) {
      grouped.set(r.file, { file: r.file, relativePath: rel, matches: [] })
    }
    const group = grouped.get(r.file)!
    if (r.replacements?.length) {
      for (const replacement of r.replacements) {
        group.matches.push({
          line: r.line,
          column: replacement.range.start,
          text: r.text,
          matchText: replacement.matchText,
          matchKind: r.matchKind,
          ranges: [replacement.range],
          byteRange: replacement.byteRange,
          replacement: replacement.replacement,
          replacementError: replacement.replacementError,
          isBinary: r.isBinary,
        })
      }
    } else {
      group.matches.push({
        line: r.line,
        column: r.column,
        text: r.text,
        matchText: r.matchText,
        matchKind: r.matchKind,
        ranges: r.ranges,
        byteRange: r.byteRange,
        replacement: r.replacement,
        replacementError: r.replacementError,
        replacements: r.replacements,
        isBinary: r.isBinary,
      })
    }
  }

  return Array.from(grouped.values()).map((group) => ({
    ...group,
    // 用 >= 保留「刚好满额且仍有更多」；假阳性靠 load-more 再收敛。
    mayHaveMore: perFileMaxCount != null
      && countContentMatchLines(group.matches) >= perFileMaxCount,
  }))
}

export function useKeywordSearch(rootPath: string | null) {
  const [results, setResults] = useState<GroupedResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [loadingMoreFiles, setLoadingMoreFiles] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [totalMatches, setTotalMatches] = useState(0)
  /** 任一维度未完整；普通结果提示可读这个。 */
  const [truncated, setTruncated] = useState(false)
  /** 内容结果不完整；唯一可阻断替换的信号。 */
  const [contentTruncated, setContentTruncated] = useState(false)
  /** 仅文件名/目录名遍历未完成；不阻断内容替换。 */
  const [pathMatchesTruncated, setPathMatchesTruncated] = useState(false)
  const searchNonceRef = useRef(0)
  const activeRequestIdRef = useRef<string | null>(null)
  const lastSearchRef = useRef<{ pattern: string; options: KeywordSearchOptions } | null>(null)

  const resetTruncationFlags = useCallback(() => {
    setTruncated(false)
    setContentTruncated(false)
    setPathMatchesTruncated(false)
  }, [])

  const cancelRequest = useCallback(async (requestId: string) => {
    try {
      await window.tabtin.fileSystem.ripgrepSearchCancel(requestId)
    } catch (err) {
      log.warn('取消搜索请求失败', {
        requestId: requestId.slice(-12),
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [])

  useEffect(() => {
    searchNonceRef.current++
    setResults([])
    setTotalMatches(0)
    setError(null)
    setErrorCode(null)
    resetTruncationFlags()
    setIsSearching(false)
    setLoadingMoreFiles(new Set())
    lastSearchRef.current = null
    const requestId = activeRequestIdRef.current
    activeRequestIdRef.current = null
    if (requestId) void cancelRequest(requestId)
  }, [cancelRequest, resetTruncationFlags, rootPath])

  useEffect(() => () => {
    const requestId = activeRequestIdRef.current
    activeRequestIdRef.current = null
    if (requestId) void cancelRequest(requestId)
  }, [cancelRequest])

  const search = useCallback(
    async (pattern: string, optionsOrGlob?: KeywordSearchOptions | string) => {
      const options: KeywordSearchOptions = typeof optionsOrGlob === 'string'
        ? { glob: optionsOrGlob.trim() || undefined }
        : optionsOrGlob ?? {}
      if (!rootPath || !pattern.trim()) {
        searchNonceRef.current++
        const requestId = activeRequestIdRef.current
        activeRequestIdRef.current = null
        if (requestId) void cancelRequest(requestId)
        setResults([])
        setTotalMatches(0)
        setError(null)
        setErrorCode(null)
        resetTruncationFlags()
        setIsSearching(false)
        setLoadingMoreFiles(new Set())
        lastSearchRef.current = null
        return
      }

      const previousRequestId = activeRequestIdRef.current
      if (previousRequestId) void cancelRequest(previousRequestId)

      const nonce = ++searchNonceRef.current
      const requestId = createSearchRequestId()
      activeRequestIdRef.current = requestId
      lastSearchRef.current = { pattern: pattern.trim(), options }
      setIsSearching(true)
      setResults([])
      setTotalMatches(0)
      resetTruncationFlags()
      setError(null)
      setErrorCode(null)
      setLoadingMoreFiles(new Set())

      const hasReplacement = options.replace !== undefined
      const perFileMaxCount = hasReplacement ? null : RIPGREP_DEFAULT_PER_FILE_MAX_COUNT

      try {
        const rgRes = await window.tabtin.fileSystem.ripgrepSearch({
          cwd: rootPath,
          pattern: pattern.trim(),
          ...options,
          glob: options.glob?.trim() || undefined,
          maxResults: 500,
          ...(perFileMaxCount != null ? { maxCount: perFileMaxCount } : {}),
          requestId,
          // 文件过滤只约束 rg 内容搜索；主进程的路径遍历不解析 glob。开启过滤时
          // 不混入文件名结果，避免显示不符合筛选条件的文件。
          includePathMatches: !options.glob?.trim()
            && !options.excludeGlob?.trim()
            && !options.includeGlobs?.length
            && !options.excludeGlobs?.length
            && !options.includeIgnored
            && !options.isRegex,
        })

        if (nonce !== searchNonceRef.current) return

        if (!rgRes.success && rgRes.canceled) return
        if (!rgRes.success) {
          const searchError = new Error(rgRes.error || '搜索失败') as Error & { errorCode?: string }
          searchError.errorCode = rgRes.errorCode
          throw searchError
        }

        const groupedResults = mapResultsToGroups(rootPath, rgRes.results, perFileMaxCount)
        setResults(groupedResults)
        setTotalMatches(countTotalMatches(groupedResults))
        const nextContentTruncated = Boolean(rgRes.contentTruncated)
        const nextPathMatchesTruncated = Boolean(rgRes.pathMatchesTruncated)
        // 旧字段兜底：若主进程尚未返回细分字段，仍按 truncated 阻断替换。
        setContentTruncated(
          rgRes.contentTruncated != null
            ? nextContentTruncated
            : Boolean(rgRes.truncated),
        )
        setPathMatchesTruncated(nextPathMatchesTruncated)
        setTruncated(
          Boolean(rgRes.truncated)
          || nextContentTruncated
          || nextPathMatchesTruncated,
        )
        return groupedResults
      } catch (err) {
        const searchError = err as Error & { errorCode?: string; name?: string }
        if (
          searchError.name === 'AbortError'
          || searchError.message === 'ripgrep search canceled'
          || nonce !== searchNonceRef.current
        ) {
          return
        }
        log.error('搜索失败', {
          requestId: requestId.slice(-12),
          errorCode: searchError.errorCode,
          errorName: searchError.name,
        })
        if (nonce === searchNonceRef.current) {
          setError(searchError.message || String(err))
          setErrorCode(searchError.errorCode ?? null)
          setResults([])
          setTotalMatches(0)
          resetTruncationFlags()
        }
      } finally {
        if (activeRequestIdRef.current === requestId) {
          activeRequestIdRef.current = null
        }
        if (nonce === searchNonceRef.current) {
          setIsSearching(false)
        }
      }
    },
    [cancelRequest, resetTruncationFlags, rootPath],
  )

  const loadMoreForFile = useCallback(
    async (filePath: string) => {
      const lastSearch = lastSearchRef.current
      if (!rootPath || !lastSearch || !filePath) return
      // 替换预览本身不做 per-file max-count，无需加载更多。
      if (lastSearch.options.replace !== undefined) return

      const nonce = searchNonceRef.current
      setLoadingMoreFiles((current) => {
        if (current.has(filePath)) return current
        const next = new Set(current)
        next.add(filePath)
        return next
      })

      try {
        const rgRes = await window.tabtin.fileSystem.ripgrepSearch({
          cwd: rootPath,
          pattern: lastSearch.pattern,
          ...lastSearch.options,
          glob: lastSearch.options.glob?.trim() || undefined,
          searchPath: filePath,
          maxCount: RIPGREP_LOAD_MORE_PER_FILE_MAX_COUNT,
          maxResults: RIPGREP_LOAD_MORE_PER_FILE_MAX_COUNT,
          includePathMatches: false,
          requestId: createSearchRequestId(),
        })

        if (nonce !== searchNonceRef.current) return
        if (!rgRes.success && rgRes.canceled) return
        if (!rgRes.success) {
          log.warn('单文件加载更多失败', {
            error: rgRes.error,
            errorCode: rgRes.errorCode,
          })
          // 统一用 load_more_failed，便于面板显示 i18n 前缀；细节放在 error 文本。
          setError(rgRes.error || 'load more failed')
          setErrorCode('load_more_failed')
          return
        }

        const refreshed = mapResultsToGroups(
          rootPath,
          rgRes.results,
          RIPGREP_LOAD_MORE_PER_FILE_MAX_COUNT,
        )
        const refreshedGroup = refreshed.find((group) => group.file === filePath)
          ?? refreshed[0]

        let nextGroups: GroupedResult[] | null = null
        setResults((current) => {
          nextGroups = current.map((group) => {
            if (group.file !== filePath) return group
            const pathMatches = group.matches.filter((match) => match.matchKind === 'path')
            const contentMatches = refreshedGroup?.matches.filter(
              (match) => match.matchKind !== 'path',
            ) ?? []
            return {
              ...group,
              matches: [...pathMatches, ...contentMatches],
              mayHaveMore: Boolean(refreshedGroup?.mayHaveMore),
            }
          })
          return nextGroups
        })
        if (nextGroups) {
          setTotalMatches(countTotalMatches(nextGroups))
          setError(null)
          setErrorCode(null)
        }
      } catch (err) {
        if (nonce !== searchNonceRef.current) return
        const message = err instanceof Error ? err.message : String(err)
        log.warn('单文件加载更多异常', { error: message })
        setError(message || 'load more failed')
        setErrorCode('load_more_failed')
      } finally {
        if (nonce === searchNonceRef.current) {
          setLoadingMoreFiles((current) => {
            if (!current.has(filePath)) return current
            const next = new Set(current)
            next.delete(filePath)
            return next
          })
        }
      }
    },
    [rootPath],
  )

  const cancel = useCallback(() => {
    searchNonceRef.current++
    const requestId = activeRequestIdRef.current
    activeRequestIdRef.current = null
    if (requestId) void cancelRequest(requestId)
    setIsSearching(false)
    setLoadingMoreFiles(new Set())
  }, [cancelRequest])

  const clear = useCallback(() => {
    searchNonceRef.current++
    const requestId = activeRequestIdRef.current
    activeRequestIdRef.current = null
    if (requestId) void cancelRequest(requestId)
    setResults([])
    setTotalMatches(0)
    setError(null)
    setErrorCode(null)
    resetTruncationFlags()
    setIsSearching(false)
    setLoadingMoreFiles(new Set())
    lastSearchRef.current = null
  }, [cancelRequest, resetTruncationFlags])

  return {
    results,
    isSearching,
    loadingMoreFiles,
    error,
    errorCode,
    totalMatches,
    truncated,
    contentTruncated,
    pathMatchesTruncated,
    search,
    loadMoreForFile,
    cancel,
    clear,
  }
}
