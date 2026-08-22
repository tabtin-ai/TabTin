import React, { useCallback, useEffect, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import {
  adjustBrowserZoom,
  browserZoomLevelToPercent,
  getBrowserZoomLevel,
  subscribeBrowserZoomLevel,
  syncBrowserZoomLevel,
} from '@/services/browserZoomController'

interface BrowserZoomControlsProps {
  viewId: string
  disabled?: boolean
}

const buttonClass =
  'flex h-8 w-8 items-center justify-center transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

export const BrowserZoomControls: React.FC<BrowserZoomControlsProps> = ({
  viewId,
  disabled = false,
}) => {
  const [zoomLevel, setZoomLevel] = useState(() => getBrowserZoomLevel(viewId))

  useEffect(() => {
    setZoomLevel(getBrowserZoomLevel(viewId))
    return subscribeBrowserZoomLevel(viewId, setZoomLevel)
  }, [viewId])

  useEffect(() => {
    let cancelled = false
    window.tabtin?.crawlView?.getZoomLevel?.(viewId)
      .then((result) => {
        if (cancelled || !result?.success || typeof result.level !== 'number') return
        syncBrowserZoomLevel(viewId, result.level)
      })
      .catch(() => {
        // View may not exist yet during lazy tab materialization; later events will sync it.
      })

    return () => {
      cancelled = true
    }
  }, [viewId])

  useEffect(() => {
    return window.tabtin?.crawlView?.onZoomLevelChanged?.(({ tabId, level }) => {
      if (tabId !== viewId) return
      syncBrowserZoomLevel(viewId, level)
    }) ?? undefined
  }, [viewId])

  const handleZoom = useCallback((direction: 'in' | 'out' | 'reset') => {
    adjustBrowserZoom(viewId, direction)
  }, [viewId])

  const zoomPercent = browserZoomLevelToPercent(zoomLevel)
  const resetLabel = `重置网页缩放，当前 ${zoomPercent}%`

  return (
    <div
      role="group"
      aria-label="网页缩放"
      className="inline-flex h-8 items-center overflow-hidden rounded-md border border-border/40 bg-background/60 text-muted-foreground shadow-sm"
    >
      <button
        type="button"
        className={buttonClass}
        onClick={() => handleZoom('out')}
        title="缩小网页 (Ctrl/Cmd -)"
        aria-label="缩小网页"
        disabled={disabled}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="flex h-8 min-w-12 items-center justify-center border-x border-border/40 px-2 text-caption font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => handleZoom('reset')}
        title="重置网页缩放 (Ctrl/Cmd 0)"
        aria-label={resetLabel}
        disabled={disabled}
      >
        {zoomPercent}%
      </button>
      <button
        type="button"
        className={buttonClass}
        onClick={() => handleZoom('in')}
        title="放大网页 (Ctrl/Cmd +)"
        aria-label="放大网页"
        disabled={disabled}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

BrowserZoomControls.displayName = 'BrowserZoomControls'
