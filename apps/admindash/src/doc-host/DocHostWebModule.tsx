import { spaceAdminApi } from '@/api/space-admin'
import {
  type DocHistoryItem,
  type TabdocDocument,
  type TabdocMetricsSummary,
  type TabdocRevision,
  type TabdocSearchItem,
  createTabdocDocument,
  exportTabdocDocument,
  getTabdocDocument,
  getTabdocMetricsSummary,
  importTabdocMarkdown,
  listTabdocDocuments,
  listTabdocHistories,
  restoreTabdocHistory,
  saveTabdocContent,
  searchTabdocDocuments,
} from '@/api/tabdoc'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  hasAccessToken as hasStoredAccessToken,
  normalizeRouteParam,
  readSavedDocContext,
  saveDocContext,
} from '@/doc-host/context-storage'
import { cn } from '@/lib/utils'
import type { SpaceSummary, OrganizationSummary } from '@/types/space-admin'
import {
  type AutoSaveController,
  type DocumentContentDraft,
  type DocumentSavePayload,
  type DocumentSaveResult,
  configureDocEditorHost,
  createAutoSaveController,
  createDefaultDocExtensions,
  markdownToPmJson,
  pmJsonToMarkdown,
  resetDocEditorHost,
} from '@tabtin/doc-editor'
import { renderMarkdown } from '@tabtin/doc-renderer'
import { EditorContent, useEditor } from '@tiptap/react'
import { FileDown, FileUp, History, Loader2, Plus, RefreshCw, RotateCcw, Save } from 'lucide-react'
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface DocHostWebModuleProps {
  organizationId?: string | null
  spaceId?: string | null
  currentPathname?: string
  onNavigateToContext?: (organizationId: string, spaceId: string) => void
  onNavigateToLogin?: (fromPathname: string) => void
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
const SEARCH_PAGE_SIZE = 8

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const buildFallbackPmJson = (markdown: string): Record<string, unknown> =>
  markdownToPmJson(markdown)

const resolvePmJsonContent = (
  input: unknown,
  markdownFallback: string
): Record<string, unknown> => {
  if (isRecordObject(input) && input.type === 'doc') {
    return input
  }
  return buildFallbackPmJson(markdownFallback)
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return '发生未知错误'
}

const toTimeText = (value: string | null): string => {
  if (!value) {
    return '-'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}

const saveStateLabelMap: Record<SaveState, string> = {
  idle: '未修改',
  dirty: '待保存',
  saving: '保存中',
  saved: '已保存',
  error: '保存失败',
}

const toPercentText = (ratio: number): string => `${Math.max(0, ratio * 100).toFixed(1)}%`

export function DocHostWebModule({
  organizationId: routeOrganizationIdInput,
  spaceId: routeSpaceIdInput,
  currentPathname = '/doc-host-web',
  onNavigateToContext,
  onNavigateToLogin,
}: DocHostWebModuleProps) {
  const savedContext = useMemo(() => readSavedDocContext(), [])
  const routeOrganizationId = normalizeRouteParam(routeOrganizationIdInput ?? undefined)
  const routeSpaceId = normalizeRouteParam(routeSpaceIdInput ?? undefined)
  const hasRouteContext = Boolean(routeOrganizationId && routeSpaceId)
  const initialContext = hasRouteContext
    ? { organizationId: routeOrganizationId, spaceId: routeSpaceId }
    : savedContext

  const [organizationIdInput, setOrganizationIdInput] = useState(initialContext.organizationId)
  const [spaceIdInput, setSpaceIdInput] = useState(initialContext.spaceId)
  const [activeOrganizationId, setActiveOrganizationId] = useState(initialContext.organizationId)
  const [activeSpaceId, setActiveSpaceId] = useState(initialContext.spaceId)
  const [hasAccessToken, setHasAccessToken] = useState(() => hasStoredAccessToken())
  const [organizationOptions, setOrganizationOptions] = useState<OrganizationSummary[]>([])
  const [spaceOptions, setSpaceOptions] = useState<SpaceSummary[]>([])
  const [organizationOptionsLoading, setOrganizationOptionsLoading] = useState(false)
  const [spaceOptionsLoading, setSpaceOptionsLoading] = useState(false)

  const [documents, setDocuments] = useState<TabdocDocument[]>([])
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [currentDocument, setCurrentDocument] = useState<TabdocDocument | null>(null)
  const [currentRevision, setCurrentRevision] = useState<TabdocRevision | null>(null)
  const [historyItems, setHistoryItems] = useState<DocHistoryItem[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchPage, setSearchPage] = useState(1)
  const [searchTotal, setSearchTotal] = useState(0)
  const [searchTotalPages, setSearchTotalPages] = useState(1)
  const [searchItems, setSearchItems] = useState<TabdocSearchItem[]>([])

  const [editorMarkdown, setEditorMarkdown] = useState('')
  const [previewHtml, setPreviewHtml] = useState('')
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)

  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [restoringHistoryId, setRestoringHistoryId] = useState<string | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)

  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveMessage, setSaveMessage] = useState('未修改')
  const [statusMessage, setStatusMessage] = useState('')
  const [metricsSummary, setMetricsSummary] = useState<TabdocMetricsSummary | null>(null)

  const draftRef = useRef<DocumentContentDraft>({
    pmJson: buildFallbackPmJson(''),
    markdown: '',
    plaintext: '',
  })
  const selectedDocumentIdRef = useRef<string | null>(null)
  const baseVersionRef = useRef<number | null>(null)
  const baseUpdatedAtRef = useRef<string | null>(null)
  const activeDocumentIdRef = useRef<string | null>(null)
  const autoSaveControllerRef = useRef<AutoSaveController | null>(null)
  const importFileInputRef = useRef<HTMLInputElement | null>(null)
  const createLoadingRef = useRef(false)

  const hasActiveContext = Boolean(activeOrganizationId && activeSpaceId)
  const isSearchMode = Boolean(searchKeyword)
  const visibleDocuments = isSearchMode ? searchItems.map((item) => item.document) : documents
  const editorExtensions = useMemo(() => createDefaultDocExtensions(), [])
  const editor = useEditor({
    extensions: editorExtensions,
    content: buildFallbackPmJson(''),
    editable: false,
    onUpdate: ({ editor: currentEditor }) => {
      const nextPmJson = currentEditor.getJSON() as Record<string, unknown>
      const nextMarkdown = pmJsonToMarkdown(nextPmJson)
      const nextPlaintext = currentEditor.getText({ blockSeparator: '\n\n' }).trim()

      draftRef.current = {
        pmJson: nextPmJson,
        markdown: nextMarkdown,
        plaintext: nextPlaintext,
      }
      setEditorMarkdown(nextMarkdown)

      if (!activeDocumentIdRef.current) {
        return
      }

      setSaveState('dirty')
      setSaveMessage('内容已修改，等待自动保存')
      autoSaveControllerRef.current?.markDirty()
    },
  })
  const searchItemMap = useMemo(() => {
    const map = new Map<string, TabdocSearchItem>()
    for (const item of searchItems) {
      map.set(item.document.id, item)
    }
    return map
  }, [searchItems])

  const applyRevisionToEditor = useCallback(
    (revision: TabdocRevision | null, document: TabdocDocument | null = null) => {
      const sourceMarkdown = revision?.content_markdown ?? ''
      const pmJson = resolvePmJsonContent(revision?.content_pm_json, sourceMarkdown)
      const markdown = sourceMarkdown || pmJsonToMarkdown(pmJson)
      const plaintext = revision?.content_plaintext ?? markdown

      draftRef.current = {
        pmJson,
        markdown,
        plaintext,
      }

      baseVersionRef.current = document?.latest_version ?? null
      setEditorMarkdown(markdown)
      setCurrentRevision(revision)
      setLastSavedAt(revision?.created_at ?? null)
      setSaveState('idle')
      setSaveMessage('未修改')
    },
    []
  )

  useEffect(() => {
    baseUpdatedAtRef.current = currentDocument?.updated_at ?? null
  }, [currentDocument?.updated_at])

  const loadHistories = useCallback(async (documentId: string) => {
    setHistoryLoading(true)
    try {
      const nextHistories = await listTabdocHistories(documentId, 50)
      setHistoryItems(nextHistories)
    } catch (error) {
      setStatusMessage(`历史列表加载失败：${toErrorMessage(error)}`)
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const loadMetricsSummary = useCallback(async () => {
    try {
      const metrics = await getTabdocMetricsSummary()
      setMetricsSummary(metrics)
    } catch {
      // 指标加载失败不阻断核心文档链路
    }
  }, [])

  const loadDocumentDetail = useCallback(
    async (documentId: string) => {
      setDetailLoading(true)
      setStatusMessage('')

      try {
        const detail = await getTabdocDocument(documentId)
        setCurrentDocument(detail.document)
        activeDocumentIdRef.current = detail.document.id
        applyRevisionToEditor(detail.latest_revision, detail.document)
        await loadHistories(documentId)
      } catch (error) {
        setStatusMessage(`文档加载失败：${toErrorMessage(error)}`)
      } finally {
        setDetailLoading(false)
      }
    },
    [applyRevisionToEditor, loadHistories]
  )

  const loadDocuments = useCallback(async () => {
    if (!hasActiveContext) {
      setDocuments([])
      setSelectedDocumentId(null)
      setCurrentDocument(null)
      setHistoryItems([])
      setSearchItems([])
      setSearchTotal(0)
      setSearchTotalPages(1)
      applyRevisionToEditor(null, null)
      return
    }

    setDocumentsLoading(true)
    setStatusMessage('')

    try {
      const nextDocuments = await listTabdocDocuments({
        organizationId: activeOrganizationId,
        spaceId: activeSpaceId,
      })
      setDocuments(nextDocuments)

      if (nextDocuments.length === 0) {
        setSelectedDocumentId(null)
        setCurrentDocument(null)
        setHistoryItems([])
        activeDocumentIdRef.current = null
        applyRevisionToEditor(null, null)
        return
      }

      const hasCurrentSelection =
        selectedDocumentIdRef.current &&
        nextDocuments.some((item) => item.id === selectedDocumentIdRef.current)

      const targetDocumentId = hasCurrentSelection
        ? selectedDocumentIdRef.current
        : nextDocuments[0].id
      if (targetDocumentId !== selectedDocumentIdRef.current) {
        setSelectedDocumentId(targetDocumentId)
      }
    } catch (error) {
      setStatusMessage(`文档列表加载失败：${toErrorMessage(error)}`)
    } finally {
      setDocumentsLoading(false)
    }
  }, [activeSpaceId, activeOrganizationId, applyRevisionToEditor, hasActiveContext])

  useEffect(() => {
    const syncTokenState = () => {
      setHasAccessToken(hasStoredAccessToken())
    }

    syncTokenState()
    window.addEventListener('storage', syncTokenState)
    window.addEventListener('focus', syncTokenState)

    return () => {
      window.removeEventListener('storage', syncTokenState)
      window.removeEventListener('focus', syncTokenState)
    }
  }, [])

  useEffect(() => {
    if (!hasAccessToken) {
      onNavigateToLogin?.(currentPathname)
    }
  }, [hasAccessToken, currentPathname, onNavigateToLogin])

  useEffect(() => {
    if (!hasAccessToken) {
      setOrganizationOptions([])
      setSpaceOptions([])
      return
    }

    let cancelled = false
    const loadOrganizationOptions = async () => {
      setOrganizationOptionsLoading(true)
      try {
        const response = await spaceAdminApi.listOrganizations({ pageSize: 100 })
        if (cancelled) {
          return
        }
        setOrganizationOptions(response.organizations ?? [])
      } catch (error) {
        if (cancelled) {
          return
        }
        setOrganizationOptions([])
        setStatusMessage(`组织加载失败：${toErrorMessage(error)}`)
      } finally {
        if (!cancelled) {
          setOrganizationOptionsLoading(false)
        }
      }
    }

    void loadOrganizationOptions()

    return () => {
      cancelled = true
    }
  }, [hasAccessToken])

  useEffect(() => {
    if (!hasAccessToken) {
      setSpaceOptions([])
      return
    }

    const currentOrganizationId = organizationIdInput.trim()
    if (!currentOrganizationId) {
      setSpaceOptions([])
      return
    }

    let cancelled = false
    const loadSpaceOptions = async () => {
      setSpaceOptionsLoading(true)
      try {
        const response = await spaceAdminApi.listSpaces({
          organizationId: currentOrganizationId,
          page: 1,
          pageSize: 100,
        })
        if (cancelled) {
          return
        }

        const nextSpaces = response.spaces ?? []
        setSpaceOptions(nextSpaces)
        if (nextSpaces.length > 0) {
          setSpaceIdInput((previousSpaceId) =>
            previousSpaceId.trim() ? previousSpaceId : nextSpaces[0].id
          )
        }
      } catch (error) {
        if (cancelled) {
          return
        }
        setSpaceOptions([])
        setStatusMessage(`Space 加载失败：${toErrorMessage(error)}`)
      } finally {
        if (!cancelled) {
          setSpaceOptionsLoading(false)
        }
      }
    }

    void loadSpaceOptions()

    return () => {
      cancelled = true
    }
  }, [hasAccessToken, organizationIdInput])

  useEffect(() => {
    if (!routeOrganizationId || !routeSpaceId) {
      return
    }

    setOrganizationIdInput(routeOrganizationId)
    setSpaceIdInput(routeSpaceId)
    setActiveOrganizationId(routeOrganizationId)
    setActiveSpaceId(routeSpaceId)
  }, [routeSpaceId, routeOrganizationId])

  useEffect(() => {
    const timer = setTimeout(() => {
      const nextKeyword = searchInput.trim()
      setSearchKeyword(nextKeyword)
      setSearchPage(1)
    }, 350)
    return () => clearTimeout(timer)
  }, [searchInput])

  // biome-ignore lint/correctness/useExhaustiveDependencies: init-once effect, loadHistories accessed via closure in save callback
  useEffect(() => {
    configureDocEditorHost({
      notify: ({ level, message }) => {
        setStatusMessage(`${level.toUpperCase()}: ${message}`)
      },
      track: () => {
        // 当前宿主先不落地埋点，保留注入位。
      },
      now: () => Date.now(),
    })

    const controller = createAutoSaveController({
      getDraft: () => draftRef.current,
      getBaseVersion: () => baseVersionRef.current,
      save: async (payload: DocumentSavePayload): Promise<DocumentSaveResult> => {
        const documentId = activeDocumentIdRef.current
        if (!documentId) {
          throw new Error('当前未选择文档')
        }

        setSaveState('saving')
        setSaveMessage('正在保存...')

        const response = await saveTabdocContent(documentId, {
          baseVersion: payload.baseVersion,
          baseUpdatedAt: baseUpdatedAtRef.current,
          pmJson: payload.pmJson,
          markdown: payload.markdown,
          plaintext: payload.plaintext,
        })

        if (activeDocumentIdRef.current === documentId) {
          baseVersionRef.current = response.document.latest_version
          baseUpdatedAtRef.current = response.document.updated_at
          setCurrentDocument(response.document)
          setCurrentRevision(response.revision)
          setLastSavedAt(response.revision.created_at)
          setSaveState('saved')
          setSaveMessage(`已保存到 v${response.revision.version}`)
          void loadHistories(documentId)
        }

        return {
          version: response.revision.version,
          revisionId: response.revision.id,
          savedAt: response.revision.created_at
            ? new Date(response.revision.created_at).getTime()
            : Date.now(),
        }
      },
      onError: (error) => {
        setSaveState('error')
        setSaveMessage(error.message || '自动保存失败')
      },
    })

    autoSaveControllerRef.current = controller

    return () => {
      autoSaveControllerRef.current?.cancel()
      autoSaveControllerRef.current = null
      resetDocEditorHost()
    }
  }, [])

  useEffect(() => {
    void loadDocuments()
  }, [loadDocuments])

  useEffect(() => {
    void loadMetricsSummary()
  }, [loadMetricsSummary])

  useEffect(() => {
    if (!selectedDocumentId) {
      return
    }
    void loadDocumentDetail(selectedDocumentId)
  }, [loadDocumentDetail, selectedDocumentId])

  useEffect(() => {
    selectedDocumentIdRef.current = selectedDocumentId
  }, [selectedDocumentId])

  useEffect(() => {
    if (!editor) {
      return
    }

    editor.setEditable(Boolean(selectedDocumentId) && !detailLoading)
  }, [detailLoading, editor, selectedDocumentId])

  useEffect(() => {
    if (!editor) {
      return
    }

    const markdownFallback = currentRevision?.content_markdown ?? ''
    const preferredPmJson = resolvePmJsonContent(currentRevision?.content_pm_json, markdownFallback)

    try {
      editor.commands.setContent(preferredPmJson, false)
      return
    } catch {
      // 历史内容可能不是兼容 schema 的 PM JSON，回退到 markdown 解析结果。
    }

    const fallbackPmJson = buildFallbackPmJson(markdownFallback)
    try {
      editor.commands.setContent(fallbackPmJson, false)
    } catch {
      editor.commands.clearContent(false)
    }
  }, [currentRevision?.content_markdown, currentRevision?.content_pm_json, editor])

  useEffect(() => {
    let cancelled = false

    const doRender = async () => {
      try {
        const rendered = await renderMarkdown(editorMarkdown, {
          sanitize: true,
        })
        if (!cancelled) {
          setPreviewHtml(rendered.html)
        }
      } catch {
        if (!cancelled) {
          setPreviewHtml('<p>渲染失败</p>')
        }
      }
    }

    void doRender()

    return () => {
      cancelled = true
    }
  }, [editorMarkdown])

  useEffect(() => {
    if (!hasActiveContext || !searchKeyword) {
      setSearchItems([])
      setSearchTotal(0)
      setSearchTotalPages(1)
      setSearchLoading(false)
      return
    }

    let cancelled = false
    setSearchLoading(true)

    void searchTabdocDocuments({
      organizationId: activeOrganizationId,
      spaceId: activeSpaceId,
      q: searchKeyword,
      page: searchPage,
      pageSize: SEARCH_PAGE_SIZE,
    })
      .then((response) => {
        if (cancelled) {
          return
        }

        const totalPages = Math.max(1, response.total_pages)
        if (searchPage > totalPages) {
          setSearchPage(totalPages)
          return
        }

        setSearchItems(response.items)
        setSearchTotal(response.total)
        setSearchTotalPages(totalPages)
      })
      .catch((error) => {
        if (!cancelled) {
          setStatusMessage(`检索失败：${toErrorMessage(error)}`)
          setSearchItems([])
          setSearchTotal(0)
          setSearchTotalPages(1)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSearchLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeSpaceId, activeOrganizationId, hasActiveContext, searchKeyword, searchPage])

  const handleOrganizationSelect = (organizationId: string) => {
    setOrganizationIdInput(organizationId)
    if (organizationIdInput.trim() !== organizationId.trim()) {
      setSpaceIdInput('')
    }
  }

  const handleSpaceSelect = (spaceId: string) => {
    setSpaceIdInput(spaceId)
  }

  const handleApplyContext = () => {
    const organizationId = organizationIdInput.trim()
    const spaceId = spaceIdInput.trim()

    if (!hasAccessToken) {
      setStatusMessage('未检测到 access_token，请先登录后继续')
      return
    }

    if (!organizationId || !spaceId) {
      setStatusMessage('请输入 organization_id 与 space_id')
      return
    }

    setActiveOrganizationId(organizationId)
    setActiveSpaceId(spaceId)
    setSearchInput('')
    setSearchKeyword('')
    setSearchPage(1)
    setSearchTotal(0)
    setSearchTotalPages(1)
    setSearchItems([])
    saveDocContext({ organizationId, spaceId })
    onNavigateToContext?.(organizationId, spaceId)
  }

  const contextOptionsLoading = organizationOptionsLoading || spaceOptionsLoading

  const handleCreateDocument = async () => {
    if (createLoadingRef.current) {
      return
    }
    if (!hasActiveContext) {
      setStatusMessage('请先设置 organization + Space 上下文')
      return
    }

    createLoadingRef.current = true
    setCreateLoading(true)

    try {
      const now = new Date().toLocaleString('zh-CN', { hour12: false })
      const created = await createTabdocDocument({
        organizationId: activeOrganizationId,
        spaceId: activeSpaceId,
        title: `新文档 ${now}`,
        markdown: '# 新文档\n\n在这里开始编辑...\n',
      })

      setDocuments((previous) => [
        created.document,
        ...previous.filter((item) => item.id !== created.document.id),
      ])
      setSelectedDocumentId(created.document.id)
      setStatusMessage('已创建新文档')
    } catch (error) {
      setStatusMessage(`创建失败：${toErrorMessage(error)}`)
    } finally {
      createLoadingRef.current = false
      setCreateLoading(false)
    }
  }

  const handleDocumentChange = async (nextDocumentId: string) => {
    if (nextDocumentId === selectedDocumentId) {
      return
    }

    if (autoSaveControllerRef.current?.isDirty()) {
      try {
        await autoSaveControllerRef.current.flush()
      } catch {
        // flush 失败时保留现状，仍允许切换文档。
      }
    }

    setSelectedDocumentId(nextDocumentId)
  }

  const handleManualSave = async () => {
    if (!activeDocumentIdRef.current) {
      setStatusMessage('请先选择文档')
      return
    }

    try {
      await autoSaveControllerRef.current?.flush()
    } catch (error) {
      setStatusMessage(`保存失败：${toErrorMessage(error)}`)
    }
  }

  const handleRestoreHistory = async (history: DocHistoryItem) => {
    if (!activeDocumentIdRef.current) {
      setStatusMessage('请先选择文档')
      return
    }

    setRestoringHistoryId(history.id)

    try {
      const restored = await restoreTabdocHistory(activeDocumentIdRef.current, history.id, {
        baseVersion: baseVersionRef.current,
        baseUpdatedAt: baseUpdatedAtRef.current,
      })
      baseUpdatedAtRef.current = restored.document.updated_at
      setCurrentDocument(restored.document)
      applyRevisionToEditor(restored.revision, restored.document)
      setSaveState('saved')
      setSaveMessage(`已恢复历史版本（当前新版本 v${restored.revision.version}）`)
      await loadHistories(restored.document.id)
    } catch (error) {
      setStatusMessage(`恢复失败：${toErrorMessage(error)}`)
    } finally {
      setRestoringHistoryId(null)
    }
  }

  const canEdit = Boolean(activeDocumentIdRef.current && editor)

  const triggerFileDownload = (filename: string, content: string, mimeType: string): void => {
    const blob = new Blob([content], { type: mimeType })
    const downloadUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = downloadUrl
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(downloadUrl)
  }

  const applyImportedDraftToEditor = (imported: {
    pm_json: Record<string, unknown>
    markdown: string
    plaintext: string
  }): void => {
    if (!editor) {
      throw new Error('编辑器未初始化')
    }

    const importedPmJson = resolvePmJsonContent(imported.pm_json, imported.markdown)
    try {
      editor.commands.setContent(importedPmJson, false)
    } catch {
      editor.commands.setContent(buildFallbackPmJson(imported.markdown), false)
    }

    draftRef.current = {
      pmJson: importedPmJson,
      markdown: imported.markdown,
      plaintext: imported.plaintext,
    }
    setEditorMarkdown(imported.markdown)
    setSaveState('dirty')
    setSaveMessage('已导入 Markdown，等待自动保存')
    autoSaveControllerRef.current?.markDirty()
  }

  const handleClickImportMarkdown = () => {
    if (!activeDocumentIdRef.current) {
      setStatusMessage('请先选择文档，再导入 Markdown')
      return
    }
    importFileInputRef.current?.click()
  }

  const handleImportMarkdownFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }

    if (!activeDocumentIdRef.current) {
      setStatusMessage('请先选择文档，再导入 Markdown')
      return
    }

    if (!activeOrganizationId || !activeSpaceId) {
      setStatusMessage('请先设置 organization + Space 上下文')
      return
    }

    try {
      const markdown = await file.text()
      const imported = await importTabdocMarkdown({
        organizationId: activeOrganizationId,
        spaceId: activeSpaceId,
        markdown,
      })
      applyImportedDraftToEditor(imported)
      setStatusMessage(`导入成功：${file.name}`)
    } catch (error) {
      setStatusMessage(`导入失败：${toErrorMessage(error)}`)
    }
  }

  const handleExportDocument = async (format: 'markdown' | 'html') => {
    const documentId = activeDocumentIdRef.current
    if (!documentId) {
      setStatusMessage('请先选择文档，再导出')
      return
    }

    try {
      if (autoSaveControllerRef.current?.isDirty()) {
        await autoSaveControllerRef.current.flush()
      }
      const exported = await exportTabdocDocument(documentId, format)
      triggerFileDownload(exported.filename, exported.content, exported.mime_type)
      setStatusMessage(`导出成功：${exported.filename}`)
    } catch (error) {
      setStatusMessage(`导出失败：${toErrorMessage(error)}`)
    }
  }

  const handleRefreshAll = async () => {
    await Promise.all([loadDocuments(), loadMetricsSummary()])
  }

  return (
    <div className="panel-container">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span className="font-semibold">TabDoc 文档管理（Host）</span>
          <span className="text-body text-muted-foreground">
            上下文：{activeOrganizationId || '-'} / {activeSpaceId || '-'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleClickImportMarkdown}
            disabled={!canEdit}
          >
            <FileUp className="mr-1 h-3 w-3" />
            导入 MD
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleExportDocument('markdown')}
            disabled={!canEdit || saveState === 'saving'}
          >
            <FileDown className="mr-1 h-3 w-3" />
            导出 MD
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleExportDocument('html')}
            disabled={!canEdit || saveState === 'saving'}
          >
            <FileDown className="mr-1 h-3 w-3" />
            导出 HTML
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleRefreshAll()}
            disabled={documentsLoading}
          >
            {documentsLoading ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3 w-3" />
            )}
            刷新
          </Button>
          <Button
            size="sm"
            onClick={() => void handleManualSave()}
            disabled={!canEdit || saveState === 'saving'}
          >
            <Save className="mr-1 h-3 w-3" />
            立即保存
          </Button>
        </div>
      </div>

      <div className="border-b bg-muted/20 px-4 py-3">
        <input
          ref={importFileInputRef}
          type="file"
          accept=".md,text/markdown,text/plain"
          className="hidden"
          onChange={(event) => {
            void handleImportMarkdownFile(event)
          }}
        />
        <div className="space-y-2">
          <div className="grid gap-2 md:grid-cols-2">
            <Select
              value={organizationIdInput || undefined}
              onValueChange={handleOrganizationSelect}
              disabled={!hasAccessToken || contextOptionsLoading || organizationOptions.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder="请选择 organization" />
              </SelectTrigger>
              <SelectContent>
                {organizationOptions.map((organization) => (
                  <SelectItem key={organization.id} value={organization.id}>
                    {organization.name}
                    {organization.is_default ? '（默认）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={spaceIdInput || undefined}
              onValueChange={handleSpaceSelect}
              disabled={
                !hasAccessToken ||
                !organizationIdInput ||
                contextOptionsLoading ||
                spaceOptions.length === 0
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="请选择 Space" />
              </SelectTrigger>
              <SelectContent>
                {spaceOptions.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                    {space.is_archived ? '（已归档）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="text-body text-muted-foreground">高级调试：可直接手动输入 ID</div>

          <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto_auto]">
            <Input
              placeholder="organization_id"
              value={organizationIdInput}
              onChange={(event) => setOrganizationIdInput(event.target.value)}
              disabled={!hasAccessToken}
            />
            <Input
              placeholder="space_id"
              value={spaceIdInput}
              onChange={(event) => setSpaceIdInput(event.target.value)}
              disabled={!hasAccessToken}
            />
            <Button variant="outline" onClick={handleApplyContext} disabled={!hasAccessToken}>
              应用上下文
            </Button>
            <Button
              onClick={() => void handleCreateDocument()}
              disabled={createLoading || !hasActiveContext}
            >
              {createLoading ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1 h-4 w-4" />
              )}
              新建文档
            </Button>
          </div>
        </div>
      </div>

      {metricsSummary ? (
        <div className="grid gap-2 border-b bg-muted/10 px-4 py-2 text-body text-muted-foreground md:grid-cols-4">
          <div>保存成功率：{toPercentText(metricsSummary.save.success_rate)}</div>
          <div>保存冲突：{metricsSummary.save.conflicts}</div>
          <div>检索 P95：{metricsSummary.search.p95_latency_ms}ms</div>
          <div>导入失败率：{toPercentText(metricsSummary.import.failure_rate)}</div>
        </div>
      ) : null}

      <div className="border-b bg-background px-4 py-2 text-body">
        <span
          className={cn(
            'font-medium',
            saveState === 'saved' && 'text-success',
            saveState === 'dirty' && 'text-warning',
            saveState === 'saving' && 'text-info',
            saveState === 'error' && 'text-destructive'
          )}
        >
          {saveStateLabelMap[saveState]}
        </span>
        <span className="ml-2 text-muted-foreground">{saveMessage}</span>
        <span className="ml-4 text-muted-foreground">最近保存：{toTimeText(lastSavedAt)}</span>
        {currentRevision ? (
          <span className="ml-4 text-muted-foreground">当前版本：v{currentRevision.version}</span>
        ) : null}
      </div>

      {statusMessage ? (
        <div className="border-b bg-warning/10 px-4 py-2 text-body text-warning">
          {statusMessage}
        </div>
      ) : null}

      <div className="grid flex-1 gap-3 overflow-hidden p-3 lg:grid-cols-[260px_1fr_380px]">
        <Card className="overflow-hidden">
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-body">文档列表</CardTitle>
            <CardDescription>
              {isSearchMode
                ? `检索“${searchKeyword}” · 共 ${searchTotal} 条`
                : '仅显示当前 Space 下文档'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex h-[calc(100%-72px)] flex-col px-2 pb-2">
            <div className="mb-2 flex items-center gap-2">
              <Input
                className="h-8 text-body"
                placeholder="检索标题或正文（自动防抖）"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                onClick={() => setSearchInput('')}
                disabled={!searchInput}
              >
                清空
              </Button>
            </div>

            <div className="flex-1 overflow-auto">
              {searchLoading ? (
                <div className="flex items-center gap-2 px-2 text-body text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  检索中...
                </div>
              ) : visibleDocuments.length === 0 ? (
                <div className="px-2 text-body text-muted-foreground">
                  {isSearchMode ? '未命中结果' : '暂无文档'}
                </div>
              ) : (
                <div className="space-y-1">
                  {visibleDocuments.map((document) => {
                    const searchItem = searchItemMap.get(document.id)
                    return (
                      <button
                        key={document.id}
                        type="button"
                        onClick={() => void handleDocumentChange(document.id)}
                        className={cn(
                          'w-full rounded border px-3 py-2 text-left text-body transition-colors',
                          selectedDocumentId === document.id
                            ? 'border-primary bg-primary/10 text-foreground'
                            : 'border-transparent hover:border-border hover:bg-muted/40'
                        )}
                      >
                        <div className="line-clamp-1 font-medium">{document.title}</div>
                        <div className="mt-1 text-caption text-muted-foreground">
                          v{document.latest_version} · {toTimeText(document.updated_at)}
                        </div>
                        {isSearchMode ? (
                          <div className="mt-1 space-y-0.5">
                            <div className="line-clamp-2 text-caption text-muted-foreground">
                              {searchItem?.snippet || '正文暂无可预览片段'}
                            </div>
                            <div className="text-caption text-muted-foreground">
                              相关性 {searchItem?.relevance_score ?? 0}
                              {searchItem?.matched_on_title ? ' · 标题命中' : ''}
                            </div>
                          </div>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {isSearchMode ? (
              <div className="mt-2 flex items-center justify-between border-t pt-2 text-caption text-muted-foreground">
                <span>
                  第 {searchPage}/{searchTotalPages} 页 · 共 {searchTotal} 条
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-caption"
                    disabled={searchPage <= 1 || searchLoading}
                    onClick={() => setSearchPage((previous) => Math.max(1, previous - 1))}
                  >
                    上一页
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-caption"
                    disabled={searchPage >= searchTotalPages || searchLoading}
                    onClick={() =>
                      setSearchPage((previous) => Math.min(searchTotalPages, previous + 1))
                    }
                  >
                    下一页
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-body">编辑器（Tiptap）</CardTitle>
            <CardDescription>
              {detailLoading
                ? '文档加载中...'
                : currentDocument
                  ? `${currentDocument.title}（自动保存已启用）`
                  : '请选择或创建文档'}
            </CardDescription>
          </CardHeader>
          <CardContent className="h-[calc(100%-72px)] px-3 pb-3">
            <div className="h-full overflow-auto rounded border bg-background p-3 text-body leading-6">
              {editor ? (
                <EditorContent
                  editor={editor}
                  className={cn(
                    'h-full [&_.ProseMirror]:min-h-full [&_.ProseMirror]:outline-none',
                    '[&_.ProseMirror_h1]:text-heading [&_.ProseMirror_h1]:font-semibold',
                    '[&_.ProseMirror_h2]:text-title [&_.ProseMirror_h2]:font-semibold',
                    '[&_.ProseMirror_h3]:text-title [&_.ProseMirror_h3]:font-semibold',
                    '[&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-muted-foreground/30 [&_.ProseMirror_blockquote]:pl-3',
                    '[&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:rounded [&_.ProseMirror_pre]:bg-muted [&_.ProseMirror_pre]:p-2',
                    '[&_.ProseMirror_table]:w-full [&_.ProseMirror_table]:border-collapse [&_.ProseMirror_table_th]:border [&_.ProseMirror_table_td]:border [&_.ProseMirror_table_th]:p-1 [&_.ProseMirror_table_td]:p-1'
                  )}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-body text-muted-foreground">
                  编辑器初始化中...
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3 overflow-hidden">
          <Card className="overflow-hidden">
            <CardHeader className="px-4 py-3">
              <CardTitle className="text-body">预览（Sanitize 后 HTML）</CardTitle>
            </CardHeader>
            <CardContent className="h-[260px] overflow-auto px-4 pb-4 text-body">
              {previewHtml ? (
                <iframe
                  title="markdown-preview"
                  className="h-[220px] w-full rounded border-0 bg-white"
                  sandbox=""
                  srcDoc={previewHtml}
                />
              ) : (
                <span className="text-body text-muted-foreground">暂无内容</span>
              )}
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader className="px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-body">版本历史</CardTitle>
                  <CardDescription>恢复会生成新版本，不覆盖历史</CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!activeDocumentIdRef.current || historyLoading}
                  onClick={() => {
                    const documentId = activeDocumentIdRef.current
                    if (documentId) {
                      void loadHistories(documentId)
                    }
                  }}
                >
                  {historyLoading ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <History className="mr-1 h-3 w-3" />
                  )}
                  刷新
                </Button>
              </div>
            </CardHeader>
            <CardContent className="h-[calc(100%-78px)] overflow-auto px-3 pb-3">
              {historyItems.length === 0 ? (
                <div className="text-body text-muted-foreground">暂无历史</div>
              ) : (
                <div className="space-y-2">
                  {historyItems.map((history) => (
                    <div key={history.id} className="rounded border px-3 py-2">
                      <div className="flex items-center justify-between text-body">
                        <span className="font-medium">
                          {history.is_named && history.name
                            ? history.name
                            : history.is_snapshot
                              ? '自动快照'
                              : '历史记录'}
                        </span>
                        <span className="text-muted-foreground">
                          {toTimeText(history.created_at)}
                        </span>
                      </div>
                      <div className="mt-1 text-body text-muted-foreground">
                        {history.editor_type}
                        {history.pinned ? ' · 已置顶' : ''}
                      </div>
                      <div className="mt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleRestoreHistory(history)}
                          disabled={restoringHistoryId !== null || saveState === 'saving'}
                        >
                          {restoringHistoryId === history.id ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <RotateCcw className="mr-1 h-3 w-3" />
                          )}
                          恢复到此历史
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
