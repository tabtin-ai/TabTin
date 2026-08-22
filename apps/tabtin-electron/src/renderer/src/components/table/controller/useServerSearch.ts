/**
 * useServerSearch - 服务端搜索 hook
 *
 * - 防抖调用服务端搜索 API（单层 300ms）
 * - 分页缓存（累积多页结果）
 * - 自动加载下一页（当导航到已缓存结果边界时）
 * - 搜索参数变化时自动重置缓存
 * - 主搜索与分页加载使用独立的 AbortController，互不干扰
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { TableApiService, type SearchIndexHit } from '@tabtin/table-core'

const PAGE_SIZE = 100
const DEBOUNCE_MS = 300
/** 搜索关键词最大长度（超出截断） */
const MAX_SEARCH_VALUE_LENGTH = 1000

export interface ServerSearchParams {
  tableId: string | null
  searchValue: string
  fieldId: string | undefined
  hideNotMatchRow: boolean
  viewId: string | null
  enabled: boolean
}

export interface ServerSearchState {
  /** 累积的所有已加载搜索命中 */
  hits: SearchIndexHit[] | null
  /** 服务端返回的总计数 */
  totalCount: number | null
  /** 是否正在加载 */
  loading: boolean
  /** 是否还有更多页 */
  hasMore: boolean
  /** 加载下一页 */
  loadNextPage: () => void
}

/**
 * 搜索缓存 key，用于判断搜索参数是否变化
 */
function buildCacheKey(params: ServerSearchParams): string {
  return `${params.tableId ?? ''}::${params.searchValue}::${params.fieldId ?? 'all'}::${params.hideNotMatchRow}::${params.viewId ?? ''}`
}

/** 截断并清理搜索输入 */
function sanitizeSearchValue(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.length > MAX_SEARCH_VALUE_LENGTH
    ? trimmed.slice(0, MAX_SEARCH_VALUE_LENGTH)
    : trimmed
}

export function useServerSearch(params: ServerSearchParams): ServerSearchState {
  const { tableId, searchValue, fieldId, hideNotMatchRow, viewId, enabled } = params

  const [hits, setHits] = useState<SearchIndexHit[] | null>(null)
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)

  // 缓存 key
  const cacheKeyRef = useRef<string>('')
  // 主搜索使用独立的 AbortController
  const primaryAbortRef = useRef<AbortController | null>(null)
  // 分页加载使用独立的 AbortController，避免与主搜索互相干扰
  const paginationAbortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedPagesRef = useRef<number>(0)
  const isLoadingNextRef = useRef<boolean>(false)
  // 组件卸载标记，防止异步回调中更新已卸载组件的状态
  const unmountedRef = useRef(false)

  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  // 清理主搜索（取消请求 + 取消防抖 + 取消分页加载）
  const cleanup = useCallback(() => {
    if (primaryAbortRef.current) {
      primaryAbortRef.current.abort()
      primaryAbortRef.current = null
    }
    if (paginationAbortRef.current) {
      paginationAbortRef.current.abort()
      paginationAbortRef.current = null
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    isLoadingNextRef.current = false
  }, [])

  // 执行搜索请求（单页）
  // 首页请求时，后端在结果数组的第一个元素中内嵌 __meta.total_count，
  // 无需单独调用 count API，减少一次网络请求。
  const fetchPage = useCallback(
    async (
      skip: number,
      signal: AbortSignal,
    ): Promise<{ pageHits: SearchIndexHit[] | null; count: number }> => {
      if (!tableId || !searchValue.trim()) {
        return { pageHits: null, count: 0 }
      }

      const safeValue = sanitizeSearchValue(searchValue)

      const rawResult = await TableApiService.searchRecordsByIndex(tableId, {
        search: safeValue,
        field_id: fieldId,
        hide_not_match_row: hideNotMatchRow,
        view_id: viewId ?? undefined,
        skip,
        take: PAGE_SIZE,
      })

      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      // 从首页结果中提取内嵌的 total_count 元信息
      // 后端在 skip=0 时在结果数组首位插入 {__meta: true, total_count: N}
      let embeddedCount = -1
      let pageHits = rawResult
      if (rawResult && rawResult.length > 0) {
        const first = rawResult[0] as unknown as Record<string, unknown>
        if (first && first.__meta === true && typeof first.total_count === 'number') {
          embeddedCount = first.total_count as number
          pageHits = rawResult.slice(1) as SearchIndexHit[]
        }
      }

      // 首页无内嵌 count 时回退到单独查询（兼容旧后端）
      let count = embeddedCount
      if (skip === 0 && embeddedCount < 0) {
        try {
          const countResult = await TableApiService.getSearchCount(tableId, {
            search: safeValue,
            field_id: fieldId,
            view_id: viewId ?? undefined,
          })
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          count = countResult?.count ?? -1
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err
          // count 失败不影响主结果
          count = -1
        }
      }

      return { pageHits, count }
    },
    [tableId, searchValue, fieldId, hideNotMatchRow, viewId],
  )

  // 主搜索 effect：当搜索参数变化时重新搜索
  useEffect(() => {
    cleanup()

    const trimmedValue = searchValue.trim()
    const currentKey = buildCacheKey(params)

    if (!enabled || !tableId || !trimmedValue) {
      // 重置状态
      if (cacheKeyRef.current !== '') {
        cacheKeyRef.current = ''
        loadedPagesRef.current = 0
        setHits(null)
        setTotalCount(null)
        setLoading(false)
        setHasMore(false)
      }
      return
    }

    // 如果参数没变（例如重复渲染），跳过
    if (cacheKeyRef.current === currentKey) {
      return
    }

    cacheKeyRef.current = currentKey
    loadedPagesRef.current = 0
    setLoading(true)

    debounceRef.current = setTimeout(() => {
      const abortController = new AbortController()
      primaryAbortRef.current = abortController

      const run = async () => {
        try {
          const { pageHits, count } = await fetchPage(0, abortController.signal)

          if (abortController.signal.aborted || unmountedRef.current) return
          // 验证缓存 key 未变化
          if (cacheKeyRef.current !== currentKey) return

          const normalizedHits = pageHits ?? []
          loadedPagesRef.current = 1
          setHits(normalizedHits.length > 0 ? normalizedHits : null)
          if (count >= 0) setTotalCount(count)
          setHasMore(normalizedHits.length >= PAGE_SIZE)
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return
          if (unmountedRef.current) return
          // 服务端搜索失败时清空结果（不静默回退本地，避免大表只搜已加载行造成误导）。
          console.warn('服务端搜索失败', err)
          setHits(null)
          setTotalCount(null)
          setHasMore(false)
        } finally {
          if (!abortController.signal.aborted && !unmountedRef.current && cacheKeyRef.current === currentKey) {
            setLoading(false)
          }
        }
      }

      void run()
    }, DEBOUNCE_MS)

    return cleanup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tableId, searchValue, fieldId, hideNotMatchRow, viewId])

  // 加载下一页（使用独立的 AbortController）
  const loadNextPage = useCallback(() => {
    if (!enabled || !tableId || !searchValue.trim() || !hasMore || loading) return
    if (isLoadingNextRef.current) return

    const currentKey = cacheKeyRef.current
    const skip = loadedPagesRef.current * PAGE_SIZE

    isLoadingNextRef.current = true
    // 取消上一次分页请求（如果存在）
    if (paginationAbortRef.current) {
      paginationAbortRef.current.abort()
    }
    const abortController = new AbortController()
    paginationAbortRef.current = abortController

    const run = async () => {
      try {
        const { pageHits } = await fetchPage(skip, abortController.signal)

        if (abortController.signal.aborted || unmountedRef.current) return
        if (cacheKeyRef.current !== currentKey) return

        const newHits = pageHits ?? []
        loadedPagesRef.current += 1

        setHits((prev) => {
          if (!prev) return newHits.length > 0 ? newHits : null
          return [...prev, ...newHits]
        })
        setHasMore(newHits.length >= PAGE_SIZE)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        if (unmountedRef.current) return
        console.warn('加载更多搜索结果失败', err)
      } finally {
        isLoadingNextRef.current = false
      }
    }

    void run()
  }, [enabled, tableId, searchValue, hasMore, loading, fetchPage])

  return {
    hits,
    totalCount,
    loading,
    hasMore,
    loadNextPage,
  }
}
