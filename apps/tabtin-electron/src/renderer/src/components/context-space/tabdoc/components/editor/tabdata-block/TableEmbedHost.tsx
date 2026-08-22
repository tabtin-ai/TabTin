import React, { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import {
  TableStoreProvider,
} from '@stores/useTableStore'
import { ViewStoreProvider } from '@stores/useViewStore'
import { RecordStoreProvider } from '@stores/useRecordStore'
import { EmbedBlockContent } from './EmbedBlockContent'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTabDocTableEmbedRuntime } from '@tabtin/tabdoc-ui'
import { useTableStore } from '@stores/useTableStore'
import {
  findVerticalScrollContainer,
  resolveStickyScrollbarOffset,
} from './embeddedTableScrollbar'

// ── Error Boundary ──

interface EmbedErrorBoundaryProps {
  children: ReactNode
  tableId: string
  fallbackTitle?: string
  fallbackRetry?: string
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
    console.error('[TableEmbedHost] Render error caught by boundary:', error, info)
  }

  handleRetry = () => {
    this.props.onRetry?.()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          aria-live="assertive"
          className="flex h-full flex-col items-center justify-center gap-2 text-body text-muted-foreground"
        >
          <AlertTriangle className="size-5 text-warning" />
          <span>{this.props.fallbackTitle || '表格加载异常'}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-body hover:bg-muted"
            aria-label={this.props.fallbackRetry || '重试'}
            onClick={this.handleRetry}
          >
            <RefreshCw className="size-3" />
            {this.props.fallbackRetry || '重试'}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// ── Host Component ──

interface TableEmbedHostProps {
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

/**
 * Provider shell — sets up the Zustand store tree (Table -> View -> Record)
 * then renders EmbedBlockContent inside, so both the header and the table
 * body can access the stores.
 *
 * Wrapped in EmbedErrorBoundary to prevent render errors from crashing
 * the entire document editor.
 */
const TableEmbedHostInner: React.FC<TableEmbedHostProps> = ({
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
  const embedRuntime = useTabDocTableEmbedRuntime()
  const hostRef = useRef<HTMLDivElement>(null)
  const stores = useMemo(
    () => embedRuntime.getOrCreateStores(tableId, surfaceId),
    [embedRuntime, surfaceId, tableId],
  )

  useEffect(() => {
    embedRuntime.retainStore(tableId, surfaceId)
    return () => embedRuntime.releaseStore(tableId, surfaceId)
  }, [embedRuntime, surfaceId, tableId])

  // BIZ-029: 监听 table store 中的名称变化，同步到嵌入块 attrs
  const storeName = useTableStore(state => state.tables.find(item => item.id === tableId)?.name)
  const titleRef = useRef(title)
  titleRef.current = title
  useEffect(() => {
    if (storeName && storeName !== titleRef.current) {
      onUpdateAttributes({ title: storeName })
    }
  }, [storeName, onUpdateAttributes])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const scrollContainer = findVerticalScrollContainer(host)
    if (!scrollContainer) return

    let frame: number | null = null
    const update = () => {
      frame = null
      const embedRect = host.getBoundingClientRect()
      const viewportRect = scrollContainer.getBoundingClientRect()
      const offset = resolveStickyScrollbarOffset({
        viewportBottom: viewportRect.bottom,
        embedTop: embedRect.top,
        embedBottom: embedRect.bottom,
        scrollbarHeight: 16,
      })
      host.style.setProperty('--tt-grid-horizontal-scrollbar-offset-y', `${offset}px`)
    }
    const scheduleUpdate = () => {
      if (frame === null) frame = window.requestAnimationFrame(update)
    }
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleUpdate)
    resizeObserver?.observe(host)
    resizeObserver?.observe(scrollContainer)
    scrollContainer.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)
    scheduleUpdate()

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      scrollContainer.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      host.style.removeProperty('--tt-grid-horizontal-scrollbar-offset-y')
    }
  }, [])

  return (
    <div ref={hostRef} className="h-full" data-tabdoc-table-embed="true">
      <TableStoreProvider store={stores.tableStore}>
        <ViewStoreProvider store={stores.viewStore}>
          <RecordStoreProvider store={stores.recordStore}>
            <EmbedBlockContent
              tableId={tableId}
              viewId={viewId}
              title={title}
              maxHeight={maxHeight}
              onOpenInTab={onOpenInTab}
              onDelete={onDelete}
              onUpdateAttributes={onUpdateAttributes}
              surfaceId={surfaceId}
              isSurfaceActive={isSurfaceActive}
            />
          </RecordStoreProvider>
        </ViewStoreProvider>
      </TableStoreProvider>
    </div>
  )
}

TableEmbedHostInner.displayName = 'TableEmbedHostInner'

export const TableEmbedHost: React.FC<TableEmbedHostProps> = (props) => {
  const { t } = useTranslation('tabdoc')
  const embedRuntime = useTabDocTableEmbedRuntime()
  const [retryCount, setRetryCount] = useState(0)
  const handleRetry = useCallback(() => {
    if (props.tableId) embedRuntime.rebuildStore(props.tableId, props.surfaceId)
    setRetryCount((c) => c + 1)
  }, [embedRuntime, props.surfaceId, props.tableId])

  return (
    <EmbedErrorBoundary
      key={retryCount}
      tableId={props.tableId}
      fallbackTitle={t('tabdataBlock.errorBoundaryTitle', { defaultValue: '表格加载异常' })}
      fallbackRetry={t('tabdataBlock.errorBoundaryRetry', { defaultValue: '重试' })}
      onRetry={handleRetry}
    >
      <TableEmbedHostInner {...props} />
    </EmbedErrorBoundary>
  )
}

TableEmbedHost.displayName = 'TableEmbedHost'
