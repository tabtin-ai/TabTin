import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  createDocument,
  listDocuments,
  searchDocuments,
  type TabdocDocument,
  type TabdocSearchItem,
} from './api-client'
import { useAppHostClient } from '@tabtin/app-host-sdk'

const SEARCH_PAGE_SIZE = 10
const SEARCH_DEBOUNCE_MS = 350
const DOC_LIST_PAGE_SIZE = 50

export interface UseDocListInput {
  organizationId: string | null
  /** 遗留可选上下文；不传则按 organization 作用域列表/创建/搜索 */
  spaceId?: string | null
}

export interface UseDocListReturn {
  documents: TabdocDocument[]
  searchItems: TabdocSearchItem[]
  isSearchMode: boolean
  visibleDocuments: TabdocDocument[]
  selectedDocumentId: string | null
  isLoading: boolean
  isLoadingMore: boolean
  isSearching: boolean
  isCreating: boolean
  searchInput: string
  searchTotal: number
  searchPage: number
  searchTotalPages: number
  hasMore: boolean
  error: string | null
  setSearchInput: (value: string) => void
  setSearchPage: (page: number) => void
  selectDocument: (id: string) => void
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  createNew: () => Promise<TabdocDocument | null>
}

export function useDocList({ organizationId, spaceId }: UseDocListInput): UseDocListReturn {
  const resolvedSpaceId = spaceId?.trim() || undefined
  const { t } = useTranslation('tabdoc')
  const tRef = useRef(t)
  tRef.current = t

  const client = useAppHostClient()
  const clientRef = useRef(client)
  clientRef.current = client

  const hasContext = Boolean(organizationId)

  const [documents, setDocuments] = useState<TabdocDocument[]>([])
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const isCreatingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const docPageRef = useRef(1)

  const selectedDocumentIdRef = useRef(selectedDocumentId)
  selectedDocumentIdRef.current = selectedDocumentId

  const [searchInput, setSearchInput] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchItems, setSearchItems] = useState<TabdocSearchItem[]>([])
  const [searchTotal, setSearchTotal] = useState(0)
  const [searchPage, setSearchPage] = useState(1)
  const [searchTotalPages, setSearchTotalPages] = useState(1)
  const [isSearching, setIsSearching] = useState(false)

  const isSearchMode = debouncedQuery.length > 0

  const visibleDocuments = useMemo(
    () => (isSearchMode ? searchItems.map((item) => item.document) : documents),
    [documents, isSearchMode, searchItems],
  )

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchInput.trim()
      setDebouncedQuery(next)
      setSearchPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  const loadDocuments = useCallback(async () => {
    if (!hasContext || !organizationId) {
      setDocuments([])
      setSelectedDocumentId(null)
      setHasMore(false)
      return
    }

    setIsLoading(true)
    setError(null)
    docPageRef.current = 1

    try {
      const result = await listDocuments(clientRef.current, {
        organizationId,
        spaceId: resolvedSpaceId,
        page: 1,
        pageSize: DOC_LIST_PAGE_SIZE,
      })
      setDocuments(result.documents)
      setHasMore(result.documents.length < result.total)

      if (result.documents.length > 0 && !selectedDocumentIdRef.current) {
        setSelectedDocumentId(result.documents[0].id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : tRef.current('loadListFailed'))
    } finally {
      setIsLoading(false)
    }
  }, [hasContext, resolvedSpaceId, organizationId])

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore || isLoading || !hasContext || !organizationId) return

    setIsLoadingMore(true)
    const nextPage = docPageRef.current + 1
    try {
      const result = await listDocuments(clientRef.current, {
        organizationId,
        spaceId: resolvedSpaceId,
        page: nextPage,
        pageSize: DOC_LIST_PAGE_SIZE,
      })
      docPageRef.current = nextPage
      setDocuments((prev) => {
        const existingIds = new Set(prev.map((d) => d.id))
        const newDocs = result.documents.filter((d) => !existingIds.has(d.id))
        return [...prev, ...newDocs]
      })
      setHasMore(nextPage * DOC_LIST_PAGE_SIZE < result.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : tRef.current('loadListFailed'))
    } finally {
      setIsLoadingMore(false)
    }
  }, [hasMore, isLoadingMore, isLoading, hasContext, organizationId, resolvedSpaceId])

  useEffect(() => {
    if (!hasContext || !debouncedQuery || !organizationId) {
      setSearchItems([])
      setSearchTotal(0)
      setSearchTotalPages(1)
      setIsSearching(false)
      return
    }

    let cancelled = false
    setIsSearching(true)

    void searchDocuments(clientRef.current, {
      organizationId,
      spaceId: resolvedSpaceId,
      q: debouncedQuery,
      page: searchPage,
      pageSize: SEARCH_PAGE_SIZE,
    })
      .then((result) => {
        if (cancelled) return
        setSearchItems(result.items)
        setSearchTotal(result.total)
        setSearchTotalPages(Math.max(1, result.total_pages))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : tRef.current('searchFailed'))
        setSearchItems([])
        setSearchTotal(0)
        setSearchTotalPages(1)
      })
      .finally(() => {
        if (!cancelled) setIsSearching(false)
      })

    return () => {
      cancelled = true
    }
  }, [debouncedQuery, hasContext, resolvedSpaceId, searchPage, organizationId])

  useEffect(() => {
    void loadDocuments()
  }, [loadDocuments])

  const createNew = useCallback(async (): Promise<TabdocDocument | null> => {
    if (!organizationId) return null
    if (isCreatingRef.current) return null

    isCreatingRef.current = true
    setIsCreating(true)
    try {
      const now = new Date().toLocaleString(undefined, { hour12: false })
      // ：文档只挂 Organization，创建不再传 spaceId
      const result = await createDocument(clientRef.current, {
        organizationId,
        title: tRef.current('newDocTitle', { time: now }),
        markdown: '',
      })

      setDocuments((prev) => [result.document, ...prev.filter((doc) => doc.id !== result.document.id)])
      setSelectedDocumentId(result.document.id)
      return result.document
    } catch (err) {
      setError(err instanceof Error ? err.message : tRef.current('createFailed'))
      return null
    } finally {
      isCreatingRef.current = false
      setIsCreating(false)
    }
  }, [organizationId])

  return {
    documents,
    searchItems,
    isSearchMode,
    visibleDocuments,
    selectedDocumentId,
    isLoading,
    isLoadingMore,
    isSearching,
    isCreating,
    searchInput,
    searchTotal,
    searchPage,
    searchTotalPages,
    hasMore,
    error,
    setSearchInput,
    setSearchPage,
    selectDocument: setSelectedDocumentId,
    refresh: loadDocuments,
    loadMore,
    createNew,
  }
}
