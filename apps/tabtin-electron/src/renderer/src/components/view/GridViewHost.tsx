import React, { useEffect, useRef } from 'react'
import { OverlayContainerProvider, cn } from '@tabtin/smartsheet-ui'
import { DataGridProvider, useDataGridContext } from '@components/table/DataGridContext'
import { useTableReadonly } from '@components/table/TableReadonlyContext'
import { GridToolbar } from '@components/table/GridToolbar'
import { DataGridAdapter } from '@components/table/DataGridAdapter'
import { FieldSettingPanel } from '@components/field/FieldSettingPanel'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

// ---------------------------------------------------------------------------
// GridErrorBoundary — Canvas 渲染层崩溃兜底，避免整个表格区域白屏
// ---------------------------------------------------------------------------

const GridErrorFallback: React.FC<{ error: Error; onRetry: () => void }> = ({ error, onRetry }) => {
  const { t } = useTranslation('table')
  return (
    <div className="flex h-full items-center justify-center p-6 text-destructive">
      <div className="max-w-md text-center">
        <div className="text-title font-bold">{t('pane.gridRenderError')}</div>
        <pre className="mt-2 whitespace-pre-wrap text-body">{error.message}</pre>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-body text-primary-foreground hover:bg-primary/90"
        >
          <RefreshCw className="size-3.5" />
          {t('pane.gridRenderErrorRetry')}
        </button>
      </div>
    </div>
  )
}

class GridErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('[GridErrorBoundary]', error)
  }
  handleRetry = () => {
    this.setState({ error: null })
  }
  render() {
    if (this.state.error) {
      return <GridErrorFallback error={this.state.error} onRetry={this.handleRetry} />
    }
    return this.props.children
  }
}

// ---------------------------------------------------------------------------
// SyncTableReadonly — 把表级只读 SSOT 同步进 DataGridContext
// ---------------------------------------------------------------------------

const SyncTableReadonly: React.FC = () => {
  const { isTableReadonly: paneReadonly } = useTableReadonly()
  const { setTableReadonly } = useDataGridContext()

  useEffect(() => {
    setTableReadonly(paneReadonly)
  }, [paneReadonly, setTableReadonly])

  return null
}

// ---------------------------------------------------------------------------
// GridViewHost
// ---------------------------------------------------------------------------

interface GridViewHostProps {
  className?: string
  embedded?: boolean
  onOpenTableHistory?: () => void
}

const GridViewHost: React.FC<GridViewHostProps> = ({ className, embedded, onOpenTableHistory }) => {
  const overlayContainerRef = useRef<HTMLDivElement>(null)
  const fieldSettingHostId = React.useId()

  return (
    <DataGridProvider>
      <SyncTableReadonly />
      <OverlayContainerProvider containerRef={overlayContainerRef}>
        <div
          ref={overlayContainerRef}
          data-t-grid-view
          data-field-setting-host-id={embedded ? fieldSettingHostId : undefined}
          className={cn('relative flex h-full flex-1 flex-col overflow-hidden', className)}
        >
          {!embedded && (
            <div className="border-b border-border/60">
              <GridToolbar onOpenTableHistory={onOpenTableHistory} />
            </div>
          )}
          <div className="relative flex-1 overflow-hidden">
            <GridErrorBoundary>
              <DataGridAdapter
                onOpenTableHistory={onOpenTableHistory}
                fieldSettingHostId={embedded ? fieldSettingHostId : undefined}
              />
            </GridErrorBoundary>
          </div>
          {embedded && <FieldSettingPanel hostId={fieldSettingHostId} />}
        </div>
      </OverlayContainerProvider>
    </DataGridProvider>
  )
}

export default GridViewHost
