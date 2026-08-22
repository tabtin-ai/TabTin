import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ViewContainer } from '@components/view/ViewContainer'
import { tableStore, useTableStore } from '@stores/useTableStore'
import { useViewStore } from '@stores/useViewStore'
import { useTranslation } from 'react-i18next'
import {
  LoadingSpinner,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ConfirmDialog,
  toast,
} from '@tabtin/smartsheet-ui'
import {
  Table2,
  Maximize2,
  MoreHorizontal,
  Trash2,
  ExternalLink,
  Copy,
  RefreshCw,
  AlertTriangle,
  SlidersHorizontal,
} from 'lucide-react'
import { EmbedViewSwitcher } from './EmbedViewSwitcher'
import { EmbedToolbar } from './EmbedToolbar'
import { EMBED_LOADING_TIMEOUT_MS, isEmbedFieldsReady } from '@tabtin/tabdoc-ui/editor'
import { useTabDocTableEmbedRuntime } from '@tabtin/tabdoc-ui'
import { DUPLICATE_NAME_ERROR_TITLE, isDuplicateNameErrorMessage } from '@/lib/duplicateNameError'

interface EmbedBlockContentProps {
  tableId: string
  viewId?: string | null
  title: string
  maxHeight: number
  onOpenInTab: () => void
  onDelete: () => void
  onUpdateAttributes: (attrs: Record<string, unknown>) => void
  surfaceId: string
  isSurfaceActive: boolean
}

export const EmbedBlockContent: React.FC<EmbedBlockContentProps> = ({
  tableId,
  viewId,
  title,
  maxHeight,
  onOpenInTab,
  onDelete,
  onUpdateAttributes,
  surfaceId,
  isSurfaceActive,
}) => {
  const { t } = useTranslation(['tabdoc', 'table'])
  const embedRuntime = useTabDocTableEmbedRuntime()

  const tables = useTableStore((state) => state.tables)
  const getTable = useTableStore((state) => state.getTable)
  const selectedTableId = useTableStore((state) => state.selectedTable?.id ?? null)
  const selectTable = useTableStore((state) => state.selectTable)
  const fields = useTableStore((state) => state.fields)
  const loadFields = useTableStore((state) => state.loadFields)
  const updateTable = useTableStore((state) => state.updateTable)

  const initializeView = useViewStore((state) => state.initialize)
  const initializeViewRef = useRef(initializeView)
  useEffect(() => { initializeViewRef.current = initializeView }, [initializeView])
  const viewTableId = useViewStore((state) => state.tableId)
  const currentViewId = useViewStore((state) => state.currentViewId)

  const [, setIsLoading] = useState(false)
  const [tableFetchFailed, setTableFetchFailed] = useState(false)
  const [viewInitFailed, setViewInitFailed] = useState(false)
  const [loadingTimedOut, setLoadingTimedOut] = useState(false)
  const [showToolbar, setShowToolbar] = useState(false)

  // ── Title inline editing ──
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editingTitle, setEditingTitle] = useState(title)
  const [isSavingTitle, setIsSavingTitle] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleSelectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const initializedRef = useRef<{
    tableId: string | null
    viewInitialized: boolean
    viewInitializing: boolean
  }>({
    tableId: null,
    viewInitialized: false,
    viewInitializing: false,
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (titleSelectTimerRef.current !== null) {
        clearTimeout(titleSelectTimerRef.current)
        titleSelectTimerRef.current = null
      }
    }
  }, [])

  const table = tables.find((item) => item.id === tableId) || null
  const tableLoadRef = useRef<string | null>(null)
  const fieldsLoadAttemptedRef = useRef<string | null>(null)
  /** 发起字段加载前的 field_count 快照（避免失败路径把 count 清 0 后误判就绪） */
  const [expectedFieldCount, setExpectedFieldCount] = useState<number | null | undefined>(undefined)
  const [fieldsLoadAttemptedFor, setFieldsLoadAttemptedFor] = useState<string | null>(null)

  // /#6020: 隔离 embed store 只有 selectTable 才会 loadFields。
  // 已选中但 fields 仍空时补拉一次，避免只渲染行号与「+」加列、单元格浅蓝空条。
  useEffect(() => {
    if (!table) return
    if (selectedTableId !== table.id) {
      fieldsLoadAttemptedRef.current = null
      setFieldsLoadAttemptedFor(null)
      setExpectedFieldCount(table.field_count ?? null)
      selectTable(table)
      return
    }
    if (fields.length > 0) {
      fieldsLoadAttemptedRef.current = table.id
      setFieldsLoadAttemptedFor(table.id)
      return
    }
    if (fieldsLoadAttemptedRef.current === table.id) return

    let snapshot: number | null | undefined
    setExpectedFieldCount((prev) => {
      snapshot = prev === undefined ? (table.field_count ?? null) : prev
      return snapshot
    })
    fieldsLoadAttemptedRef.current = table.id
    setFieldsLoadAttemptedFor(table.id)
    if (snapshot === 0) return
    void loadFields(table.id)
  }, [fields.length, loadFields, selectTable, selectedTableId, table])

  useEffect(() => {
    if (table || !tableId) return
    if (tableLoadRef.current === tableId) return
    tableLoadRef.current = tableId
    setTableFetchFailed(false)
    let cancelled = false
    void getTable(tableId)
      .then((result) => {
        if (!cancelled && !result) setTableFetchFailed(true)
      })
      .catch(() => {
        if (!cancelled) setTableFetchFailed(true)
      })
      .finally(() => {
        if (!cancelled && tableLoadRef.current === tableId) {
          tableLoadRef.current = null
        }
      })
    return () => { cancelled = true }
  }, [getTable, tableId, table?.id])

  useEffect(() => {
    if (initializedRef.current.tableId !== tableId) {
      initializedRef.current = { tableId, viewInitialized: false, viewInitializing: false }
      fieldsLoadAttemptedRef.current = null
      setFieldsLoadAttemptedFor(null)
      setExpectedFieldCount(undefined)
    }
  }, [tableId])

  const tableForInit = table

  useEffect(() => {
    if (initializedRef.current.viewInitialized) return
    if (initializedRef.current.viewInitializing) return
    if (!tableForInit) return

    initializedRef.current.viewInitializing = true
    setIsLoading(true)
    const gen = ++generationRef.current

    const initView = async () => {
      try {
        await initializeViewRef.current(
          tableForInit.id,
          viewId ? { defaultViewId: viewId } : undefined
        )
        if (gen !== generationRef.current || !mountedRef.current) return
        initializedRef.current.viewInitialized = true
        initializedRef.current.viewInitializing = false
        setIsLoading(false)
      } catch (error) {
        console.error('[EmbedBlockContent] Failed to initialize view:', error)
        if (gen !== generationRef.current || !mountedRef.current) return
        initializedRef.current.viewInitializing = false
        setIsLoading(false)
        setViewInitFailed(true)
      }
    }
    initView()
  }, [tableId, tableForInit?.id, viewId])

  const isTableReady = Boolean(table)
  const isViewReady = viewTableId === tableId && Boolean(currentViewId)
  // 字段未就绪时不渲染网格，避免 「有行号无列」空态。
  const isFieldsReady = isEmbedFieldsReady(fields.length, {
    loadAttempted: fieldsLoadAttemptedFor === tableId,
    expectedFieldCount,
  })
  // 与 useTableInitFlow 一致：不等待首屏 records；但 embed 必须等 fields。
  const showLoadingState = !isTableReady || !isViewReady || !isFieldsReady

  // Sync currentViewId back to ProseMirror attrs
  const prevSyncedViewIdRef = useRef<string | null>(viewId ?? null)
  useEffect(() => {
    prevSyncedViewIdRef.current = viewId ?? null
  }, [viewId])
  useEffect(() => {
    if (!currentViewId || !isViewReady) return
    if (currentViewId === prevSyncedViewIdRef.current) return
    prevSyncedViewIdRef.current = currentViewId
    onUpdateAttributes({ viewId: currentViewId })
  }, [currentViewId, isViewReady, onUpdateAttributes])

  useEffect(() => {
    if (!showLoadingState) { setLoadingTimedOut(false); return }
    const timer = setTimeout(() => setLoadingTimedOut(true), EMBED_LOADING_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [showLoadingState])

  const handleRetry = useCallback(() => {
    setLoadingTimedOut(false)
    setTableFetchFailed(false)
    setViewInitFailed(false)
    initializedRef.current = { tableId, viewInitialized: false, viewInitializing: false }
    tableLoadRef.current = null
    fieldsLoadAttemptedRef.current = null
    setFieldsLoadAttemptedFor(null)
    setExpectedFieldCount(undefined)
    setIsLoading(true)
    const gen = ++generationRef.current
    const doRetry = async () => {
      let viewInitAttempted = false
      try {
        const freshTable = await getTable(tableId)
        if (gen !== generationRef.current || !mountedRef.current) return
        const retryTable = freshTable ?? table
        if (retryTable) {
          selectTable(retryTable, { force: true })
          viewInitAttempted = true
          await initializeViewRef.current(
            retryTable.id,
            viewId ? { defaultViewId: viewId } : undefined
          )
          if (gen !== generationRef.current || !mountedRef.current) return
          initializedRef.current.viewInitialized = true
          initializedRef.current.viewInitializing = false
        } else {
          setTableFetchFailed(true)
        }
      } catch {
        if (!mountedRef.current) return
        if (viewInitAttempted) setViewInitFailed(true)
        else setTableFetchFailed(true)
      } finally {
        if (gen === generationRef.current && mountedRef.current) setIsLoading(false)
      }
    }
    doRetry()
  }, [getTable, selectTable, tableId, table, viewId])

  // ── Title editing handlers ──
  const startTitleEdit = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (isSavingTitle) return
    setEditingTitle(title || '')
    setIsEditingTitle(true)
    titleSelectTimerRef.current = setTimeout(() => titleInputRef.current?.select(), 0)
  }, [isSavingTitle, title])

  const cancelTitleEdit = useCallback(() => {
    setEditingTitle(title)
    setIsEditingTitle(false)
  }, [title])

  const showTitleUpdateFailedToast = useCallback((errorMessage?: string | null) => {
    const normalizedMessage = errorMessage?.trim()
    const isDuplicateNameError = isDuplicateNameErrorMessage(normalizedMessage)
      || !normalizedMessage
      || normalizedMessage === t('table:apiErrors.updateFailed', { defaultValue: '更新表格失败' })
      || normalizedMessage === '更新表格失败'
      || normalizedMessage === 'update table failed'
    toast({
      title: isDuplicateNameError
        ? DUPLICATE_NAME_ERROR_TITLE
        : t('table:apiErrors.updateFailed', { defaultValue: '更新失败' }),
      description: isDuplicateNameError ? undefined : normalizedMessage,
      variant: 'destructive',
    })
  }, [t])

  const submitTitleEdit = useCallback(async () => {
    if (isSavingTitle) return
    const nextName = editingTitle.trim()
    if (!nextName) { cancelTitleEdit(); return }
    if (nextName === title) { setIsEditingTitle(false); return }
    setIsSavingTitle(true)
    try {
      const updated = await updateTable(tableId, { name: nextName })
      if (!mountedRef.current) return
      if (!updated) {
        showTitleUpdateFailedToast(tableStore.getState().error)
        cancelTitleEdit()
        return
      }
      onUpdateAttributes({ title: nextName })
      setIsEditingTitle(false)
    } catch (error) {
      if (!mountedRef.current) return
      showTitleUpdateFailedToast(error instanceof Error ? error.message : undefined)
      cancelTitleEdit()
    } finally {
      if (mountedRef.current) setIsSavingTitle(false)
    }
  }, [
    cancelTitleEdit,
    editingTitle,
    isSavingTitle,
    showTitleUpdateFailedToast,
    tableId,
    title,
    updateTable,
    onUpdateAttributes,
  ])

  const handleCopyTableId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(tableId)
      toast({ title: t('tabdoc:tabdataBlock.copiedId') })
    } catch {
      toast({ title: t('tabdoc:tabdataBlock.copyFailed'), variant: 'destructive' })
    }
  }, [tableId, t])

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // ── Loading / Error states ──
  if (tableFetchFailed && !table) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-body text-muted-foreground">
        <AlertTriangle className="size-5 text-warning" />
        <span>{t('table:pane.loadFailed', { defaultValue: '表格加载失败' })}</span>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-body" onClick={handleRetry}>
          <RefreshCw className="size-3" />
          {t('table:pane.retry', { defaultValue: '重试' })}
        </Button>
      </div>
    )
  }

  if (viewInitFailed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-body text-muted-foreground">
        <AlertTriangle className="size-5 text-warning" />
        <span>{t('tabdoc:tabdataBlock.viewInitFailed', { defaultValue: '视图加载失败' })}</span>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-body" onClick={handleRetry}>
          <RefreshCw className="size-3" />
          {t('table:pane.retry', { defaultValue: '重试' })}
        </Button>
      </div>
    )
  }

  if (showLoadingState) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-body text-muted-foreground">
        <LoadingSpinner size="sm" />
        <span>{t('table:pane.loading', { defaultValue: '加载中...' })}</span>
        {loadingTimedOut && (
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-body mt-1" onClick={handleRetry}>
            <RefreshCw className="size-3" />
            {t('table:pane.retry', { defaultValue: '重试' })}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Table2 className="size-4 shrink-0 text-muted-foreground" />
          {isEditingTitle ? (
            <input
              ref={titleInputRef}
              aria-label={t('tabdoc:tabdataBlock.editTitleLabel')}
              className="min-w-0 flex-1 truncate border-none bg-transparent text-body font-medium text-foreground outline-none ring-0 focus:outline-none disabled:opacity-60"
              value={editingTitle}
              disabled={isSavingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={() => void submitTitleEdit()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submitTitleEdit()
                if (e.key === 'Escape') cancelTitleEdit()
              }}
              autoFocus
            />
          ) : (
            <span
              className="truncate text-body font-medium text-foreground cursor-text hover:underline hover:decoration-muted-foreground/40 hover:underline-offset-2 focus:outline-none focus:underline focus:decoration-primary/60 focus:underline-offset-2"
              tabIndex={0}
              role="button"
              onDoubleClick={startTitleEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'F2') {
                  e.preventDefault()
                  startTitleEdit()
                }
              }}
              title={t('tabdoc:tabdataBlock.doubleClickEdit')}
            >
              {title || t('tabdoc:tabdataBlock.untitled')}
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <EmbedViewSwitcher />

          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showToolbar}
            aria-label={t('tabdoc:tabdataBlock.toggleToolbar')}
            className={`h-6 w-6 p-0 ${showToolbar ? 'text-primary' : ''}`}
            onClick={() => setShowToolbar((v) => !v)}
            title={t('tabdoc:tabdataBlock.toggleToolbar')}
          >
            <SlidersHorizontal className="size-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={onOpenInTab}
            aria-label={t('tabdoc:tabdataBlock.openInTab')}
            title={t('tabdoc:tabdataBlock.openInTab')}
          >
            <Maximize2 className="size-3.5" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                aria-label={t('tabdoc:tabdataBlock.moreActions')}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[160px]">
              <DropdownMenuItem onClick={onOpenInTab} className="text-body">
                <ExternalLink className="size-3.5" />
                {t('tabdoc:tabdataBlock.openInTab')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCopyTableId} className="text-body">
                <Copy className="size-3.5" />
                {t('tabdoc:tabdataBlock.copyId')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setShowDeleteConfirm(true)} className="text-body text-destructive focus:text-destructive">
                <Trash2 className="size-3.5" />
                {t('tabdoc:tabdataBlock.remove')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title={t('tabdoc:tabdataBlock.removeConfirmTitle', { defaultValue: '移除嵌入块' })}
        description={t('tabdoc:tabdataBlock.removeConfirmDesc', { defaultValue: '确定要从文档中移除此表格嵌入块吗？表格数据不会被删除。' })}
        confirmText={t('tabdoc:tabdataBlock.remove')}
        variant="destructive"
        onConfirm={onDelete}
      />

      {/* Toolbar (collapsible) */}
      {showToolbar && <EmbedToolbar />}

      {/* Table body */}
      <div className="relative flex-1 overflow-hidden">
        <ViewContainer
          className="h-full"
          embedded
          parentDocumentId={embedRuntime.parentDocumentId}
          surfaceId={surfaceId}
          isSurfaceActive={isSurfaceActive}
        />
      </div>
    </div>
  )
}

EmbedBlockContent.displayName = 'EmbedBlockContent'
