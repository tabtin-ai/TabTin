/**
 * Web 版 TabDoc 表格嵌入宿主组件
 *
 * 对标 Electron 的 TableEmbedHost + EmbedBlockContent，
 * 在文档中内嵌完整的表格视图（grid/kanban/calendar/gallery）。
 *
 * 与 Electron 的差异：
 * - 使用 Web 端的 store 体系（@/stores/table/*）
 * - 简化 UI（无 inline title 编辑、无 EmbedToolbar）
 * - 通过 router 导航到全屏表格页
 */
import React, { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  RefreshCw,
  Table2,
  Maximize2,
  MoreHorizontal,
  Trash2,
  ExternalLink,
  Copy,
} from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ConfirmDialog,
  LoadingSpinner,
  toast,
} from '@tabtin/smartsheet-ui'
import { useTabDocTableEmbedRuntime } from '@tabtin/tabdoc-ui'
import { EMBED_LOADING_TIMEOUT_MS, isEmbedFieldsReady } from '@tabtin/tabdoc-ui/editor'
import {
  TableStoreProvider,
  useTableStore,
} from '@/stores/table/useTableStore'
import {
  ViewStoreProvider,
  useViewStore,
} from '@/stores/table/useViewStore'
import { RecordStoreProvider } from '@/stores/table/useRecordStore'
import { WebViewRenderer } from '@/components/table/view/WebViewRenderer'

// ── Error Boundary ──

interface EmbedErrorBoundaryProps {
  children: ReactNode
  tableId: string
  onRetry?: () => void
}

interface EmbedErrorBoundaryState {
  hasError: boolean
}

class EmbedErrorBoundary extends Component<EmbedErrorBoundaryProps, EmbedErrorBoundaryState> {
  state: EmbedErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): EmbedErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[WebTableEmbedHost] Render error:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-body text-muted-foreground">
          <AlertTriangle className="size-5 text-warning" />
          <span>表格加载异常</span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-body hover:bg-muted"
            onClick={this.props.onRetry}
          >
            <RefreshCw className="size-3" />
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// ── Embed Content ──

interface EmbedContentProps {
  tableId: string
  viewId?: string | null
  title: string
  maxHeight: number
  onOpenInTab: () => void
  onDelete: () => void
  onUpdateAttributes: (attrs: Record<string, unknown>) => void
}

const EmbedContent: React.FC<EmbedContentProps> = ({
  tableId,
  viewId,
  title,
  maxHeight,
  onOpenInTab,
  onDelete,
  onUpdateAttributes,
}) => {
  const { t } = useTranslation(['tabdoc', 'table'])

  const tables = useTableStore((s) => s.tables)
  const getTable = useTableStore((s) => s.getTable)
  const selectedTableId = useTableStore((s) => s.selectedTable?.id ?? null)
  const selectTable = useTableStore((s) => s.selectTable)
  const fields = useTableStore((s) => s.fields)
  const loadFields = useTableStore((s) => s.loadFields)

  const initializeView = useViewStore((s) => s.initialize)
  const initializeViewRef = useRef(initializeView)
  useEffect(() => { initializeViewRef.current = initializeView }, [initializeView])
  const viewTableId = useViewStore((s) => s.tableId)
  const currentViewId = useViewStore((s) => s.currentViewId)
  const views = useViewStore((s) => s.views)
  const currentViewRecords = useViewStore((s) => s.currentViewRecords)

  const [, setIsLoading] = useState(false)
  const [tableFetchFailed, setTableFetchFailed] = useState(false)
  const [viewInitFailed, setViewInitFailed] = useState(false)
  const [loadingTimedOut, setLoadingTimedOut] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const initializedRef = useRef<{
    tableId: string | null
    viewInitialized: boolean
    viewInitializing: boolean
  }>({ tableId: null, viewInitialized: false, viewInitializing: false })

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const table = tables.find((item) => item.id === tableId) || null
  const tableLoadRef = useRef<string | null>(null)
  const fieldsLoadAttemptedRef = useRef<string | null>(null)
  /** 发起字段加载前的 field_count 快照（避免失败路径把 count 清 0 后误判就绪） */
  const [expectedFieldCount, setExpectedFieldCount] = useState<number | null | undefined>(undefined)
  const [fieldsLoadAttemptedFor, setFieldsLoadAttemptedFor] = useState<string | null>(null)

  // /#6020: 隔离 embed store 必须 selectTable 才会 loadFields。
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
      .then((result) => { if (!cancelled && !result) setTableFetchFailed(true) })
      .catch(() => { if (!cancelled) setTableFetchFailed(true) })
      .finally(() => { if (!cancelled && tableLoadRef.current === tableId) tableLoadRef.current = null })
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

  useEffect(() => {
    if (initializedRef.current.viewInitialized || initializedRef.current.viewInitializing || !table) return
    initializedRef.current.viewInitializing = true
    setIsLoading(true)
    const gen = ++generationRef.current
    void (async () => {
      try {
        await initializeViewRef.current(table.id, viewId ? { defaultViewId: viewId } : undefined)
        if (gen !== generationRef.current || !mountedRef.current) return
        initializedRef.current.viewInitialized = true
        initializedRef.current.viewInitializing = false
        setIsLoading(false)
      } catch (error) {
        console.error('[WebTableEmbedHost] View init failed:', error)
        if (gen !== generationRef.current || !mountedRef.current) return
        initializedRef.current.viewInitializing = false
        setIsLoading(false)
        setViewInitFailed(true)
      }
    })()
  }, [tableId, table?.id, viewId])

  const isTableReady = Boolean(table)
  const isViewReady = viewTableId === tableId && Boolean(currentViewId)
  const isFieldsReady = isEmbedFieldsReady(fields.length, {
    loadAttempted: fieldsLoadAttemptedFor === tableId,
    expectedFieldCount,
  })
  // 与 useTableInitFlow 一致：不等待首屏 records；但 embed 必须等 fields。
  const showLoadingState = !isTableReady || !isViewReady || !isFieldsReady

  const prevSyncedViewIdRef = useRef<string | null>(viewId ?? null)
  useEffect(() => { prevSyncedViewIdRef.current = viewId ?? null }, [viewId])
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
    void (async () => {
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
    })()
  }, [getTable, selectTable, tableId, table, viewId])

  const handleCopyTableId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(tableId)
      toast({ title: t('tabdoc:tabdataBlock.copiedId', { defaultValue: '已复制表格 ID' }) })
    } catch {
      toast({ title: t('tabdoc:tabdataBlock.copyFailed', { defaultValue: '复制失败' }), variant: 'destructive' })
    }
  }, [tableId, t])

  const currentView = views.find(v => v.id === currentViewId) ?? null

  if (tableFetchFailed && !table) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-body text-muted-foreground">
        <AlertTriangle className="size-5 text-warning" />
        <span>{t('table:pane.loadFailed', { defaultValue: '表格加载失败' })}</span>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-body" onClick={handleRetry}>
          <RefreshCw className="size-3" />{t('table:pane.retry', { defaultValue: '重试' })}
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
          <RefreshCw className="size-3" />{t('table:pane.retry', { defaultValue: '重试' })}
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
            <RefreshCw className="size-3" />{t('table:pane.retry', { defaultValue: '重试' })}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Table2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-body font-medium text-foreground">
            {title || t('tabdoc:tabdataBlock.untitled', { defaultValue: '未命名表格' })}
          </span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onOpenInTab}
            title={t('tabdoc:tabdataBlock.openInTab', { defaultValue: '在标签页中打开' })}>
            <Maximize2 className="size-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[160px]">
              <DropdownMenuItem onClick={onOpenInTab} className="text-body">
                <ExternalLink className="size-3.5" />
                {t('tabdoc:tabdataBlock.openInTab', { defaultValue: '在标签页中打开' })}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCopyTableId} className="text-body">
                <Copy className="size-3.5" />
                {t('tabdoc:tabdataBlock.copyId', { defaultValue: '复制表格 ID' })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setShowDeleteConfirm(true)} className="text-body text-destructive focus:text-destructive">
                <Trash2 className="size-3.5" />
                {t('tabdoc:tabdataBlock.remove', { defaultValue: '移除' })}
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
        confirmText={t('tabdoc:tabdataBlock.remove', { defaultValue: '移除' })}
        variant="destructive"
        onConfirm={onDelete}
      />

      <div className="relative flex-1 overflow-auto" style={{ maxHeight }}>
        <WebViewRenderer
          currentView={currentView}
          currentViewId={currentViewId}
          views={views}
          fields={fields}
          currentViewRecords={currentViewRecords}
        />
      </div>
    </div>
  )
}

// ── Host Component ──

interface WebTableEmbedHostProps {
  tableId: string
  viewId?: string | null
  title: string
  maxHeight: number
  onOpenInTab: () => void
  onDelete: () => void
  onUpdateAttributes: (attrs: Record<string, unknown>) => void
}

const WebTableEmbedHostInner: React.FC<WebTableEmbedHostProps> = (props) => {
  const embedRuntime = useTabDocTableEmbedRuntime()
  const stores = useMemo(() => embedRuntime.getOrCreateStores(props.tableId), [embedRuntime, props.tableId])

  useEffect(() => {
    embedRuntime.retainStore(props.tableId)
    return () => embedRuntime.releaseStore(props.tableId)
  }, [embedRuntime, props.tableId])

  return (
    <TableStoreProvider store={stores.tableStore}>
      <ViewStoreProvider store={stores.viewStore}>
        <RecordStoreProvider store={stores.recordStore}>
          <EmbedContent {...props} />
        </RecordStoreProvider>
      </ViewStoreProvider>
    </TableStoreProvider>
  )
}

export const WebTableEmbedHost: React.FC<WebTableEmbedHostProps> = (props) => {
  const embedRuntime = useTabDocTableEmbedRuntime()
  const [retryCount, setRetryCount] = useState(0)
  const handleRetry = useCallback(() => {
    if (props.tableId) embedRuntime.rebuildStore(props.tableId)
    setRetryCount((c) => c + 1)
  }, [embedRuntime, props.tableId])

  return (
    <EmbedErrorBoundary key={retryCount} tableId={props.tableId} onRetry={handleRetry}>
      <WebTableEmbedHostInner {...props} />
    </EmbedErrorBoundary>
  )
}
