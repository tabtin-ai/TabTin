/**
 * Changes「当前变更」页面级搜索状态：防抖查询 → 全文件 Diff 行索引 → 命中导航。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeFile } from '@components/tabcode/components/git-workflow/useGitWorkflowData'
import {
  buildChangesSearchIndex,
  stepSearchHitIndex,
  type ChangesSearchHit,
} from './changesPageSearch'

const SEARCH_DEBOUNCE_MS = 280

export interface UseChangesPageSearchParams {
  rootPath: string
  files: ChangeFile[]
  contentRevisions: Record<string, number>
  enabled: boolean
}

export function useChangesPageSearch({
  rootPath,
  files,
  contentRevisions,
  enabled,
}: UseChangesPageSearchParams) {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [hits, setHits] = useState<ChangesSearchHit[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)
  const [isIndexing, setIsIndexing] = useState(false)
  const [indexedFileCount, setIndexedFileCount] = useState(0)
  const [skippedFileCount, setSkippedFileCount] = useState(0)
  const [errorFileCount, setErrorFileCount] = useState(0)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [requestId, setRequestId] = useState(0)
  const generationRef = useRef(0)
  const cancelRef = useRef({ cancelled: false })
  const filesSignature = useMemo(
    () => files.map((file) => `${file.path}:${contentRevisions[file.path] ?? ''}`).join('\n'),
    [files, contentRevisions],
  )

  useEffect(() => {
    if (!enabled) {
      setQuery('')
      setDebouncedQuery('')
      setHits([])
      setActiveIndex(-1)
      setIsIndexing(false)
      return
    }
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query, enabled])

  useEffect(() => {
    if (!enabled) return
    cancelRef.current.cancelled = true
    cancelRef.current = { cancelled: false }
    const signal = cancelRef.current
    const generation = ++generationRef.current
    const trimmed = debouncedQuery.trim()
    if (!trimmed) {
      setHits([])
      setActiveIndex(-1)
      setIsIndexing(false)
      setIndexedFileCount(0)
      setSkippedFileCount(0)
      setErrorFileCount(0)
      setProgress({ done: 0, total: 0 })
      return
    }

    setIsIndexing(true)
    setProgress({ done: 0, total: files.length })
    void buildChangesSearchIndex({
      rootPath,
      files,
      contentRevisions,
      query: trimmed,
      generation,
      signal,
      onProgress: (done, total) => {
        if (signal.cancelled || generation !== generationRef.current) return
        setProgress({ done, total })
      },
    }).then((result) => {
      if (signal.cancelled || result.generation !== generationRef.current) return
      setHits(result.hits)
      setActiveIndex(result.hits.length > 0 ? 0 : -1)
      setIndexedFileCount(result.indexedFileCount)
      setSkippedFileCount(result.skippedFileCount)
      setErrorFileCount(result.errorFileCount)
      setIsIndexing(false)
      if (result.hits.length > 0) setRequestId((prev) => prev + 1)
    })

    return () => {
      signal.cancelled = true
    }
    // filesSignature 已覆盖 files + contentRevisions 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, enabled, filesSignature, rootPath])

  const clear = useCallback(() => {
    setQuery('')
    setDebouncedQuery('')
    setHits([])
    setActiveIndex(-1)
    setIsIndexing(false)
  }, [])

  const goNext = useCallback(() => {
    setActiveIndex((prev) => {
      const next = stepSearchHitIndex(prev, hits.length, 1)
      if (next >= 0) setRequestId((id) => id + 1)
      return next
    })
  }, [hits.length])

  const goPrev = useCallback(() => {
    setActiveIndex((prev) => {
      const next = stepSearchHitIndex(prev, hits.length, -1)
      if (next >= 0) setRequestId((id) => id + 1)
      return next
    })
  }, [hits.length])

  const activeHit = activeIndex >= 0 ? hits[activeIndex] ?? null : null
  const searchHit = useMemo(() => {
    if (!activeHit) return null
    return {
      path: activeHit.path,
      rowId: activeHit.rowId,
      requestId,
    }
  }, [activeHit, requestId])

  return {
    query,
    setQuery,
    clear,
    goNext,
    goPrev,
    hits,
    activeIndex,
    activeHit,
    searchHit,
    isIndexing,
    indexedFileCount,
    skippedFileCount,
    errorFileCount,
    progress,
    hasQuery: query.trim().length > 0,
  }
}
