import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn, Popover, PopoverContent, PopoverTrigger } from '@tabtin/smartsheet-ui'
import { Gauge } from 'lucide-react'
import {
  TOPBAR_CHROME_ACTION,
  TOPBAR_CHROME_ICON_SIZE,
  TOPBAR_CHROME_ICON_STROKE,
} from '@components/layout/sidebarUi'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { ResourceMonitorPanelContent } from './ResourceMonitorPanel'
import type { ResourceMonitorSeverityLevel } from './severity'
import { useResourceMonitorController } from './useResourceMonitorController'

const severityDotClass: Record<ResourceMonitorSeverityLevel, string> = {
  healthy: 'bg-success',
  attention: 'bg-warning',
  heavy: 'bg-destructive',
}

export type ResourceMonitorIndicatorPlacement = 'sidebar' | 'topbar'

export interface ResourceMonitorSidebarIndicatorProps {
  /** sidebar：Popover 向右展开；topbar：从顶栏右下角向下展开 */
  placement?: ResourceMonitorIndicatorPlacement
  className?: string
  'data-testid'?: string
}

export const ResourceMonitorSidebarIndicator: React.FC<ResourceMonitorSidebarIndicatorProps> = ({
  placement = 'sidebar',
  className,
  'data-testid': dataTestId,
}) => {
  const { t } = useTranslation('monitor')
  const [open, setOpen] = React.useState(false)
  const hoverTimerRef = React.useRef<number | null>(null)
  const controller = useResourceMonitorController(open ? 'interactive' : 'idle')

  const handleMouseEnter = React.useCallback(() => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = window.setTimeout(() => setOpen(true), 300)
  }, [])

  const handleMouseLeave = React.useCallback(() => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = window.setTimeout(() => setOpen(false), 400)
  }, [])

  const handlePopoverMouseEnter = React.useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  const handlePopoverMouseLeave = React.useCallback(() => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = window.setTimeout(() => setOpen(false), 400)
  }, [])

  React.useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current)
    }
  }, [])

  const handleOpenFullSettings = React.useCallback(() => {
    setOpen(false)
    useSettingsSpaceStore.getState().openSettings({ category: 'device', section: 'performance' })
  }, [])

  const isHeavy = controller.surfaceSeverityLevel === 'heavy'
  const isAttention = controller.surfaceSeverityLevel === 'attention'
  const severityLabel = controller.viewModel.overview.severity.label
  const indicatorTitle = t('resourceMonitor.indicatorTitle')
  const ariaLabel = `${indicatorTitle} · ${severityLabel}`

  const isTopBar = placement === 'topbar'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          data-testid={dataTestId ?? (isTopBar ? 'shell-top-bar-performance-monitor' : undefined)}
          className={cn(
            'relative',
            isTopBar
              ? cn(TOPBAR_CHROME_ACTION, 'no-drag text-muted-foreground/60 hover:text-foreground')
              : 'h-7 w-7 flex items-center justify-center rounded-md transition-colors',
            isHeavy
              ? 'text-destructive hover:text-destructive hover:bg-destructive/10'
              : isAttention
                ? 'text-warning hover:text-warning hover:bg-warning/10'
                : !isTopBar && 'text-muted-foreground/60 hover:text-foreground hover:bg-muted/30',
            open && (
              isHeavy
                ? 'bg-destructive/10'
                : isAttention
                  ? 'bg-warning/10 text-warning'
                  : isTopBar
                    ? 'bg-foreground/[0.06] text-foreground'
                    : 'bg-muted/30 text-foreground'
            ),
            className,
          )}
          title={ariaLabel}
          aria-label={ariaLabel}
        >
          <Gauge
            size={isTopBar ? TOPBAR_CHROME_ICON_SIZE : 14}
            strokeWidth={isTopBar ? TOPBAR_CHROME_ICON_STROKE : 2}
            className="shrink-0"
            aria-hidden
          />
          <span
            className={cn(
              'absolute bottom-0.5 right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background',
              severityDotClass[controller.surfaceSeverityLevel],
              (isHeavy || isAttention) && 'animate-pulse',
            )}
            data-testid="resource-monitor-severity-dot"
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side={isTopBar ? 'bottom' : 'right'}
        sideOffset={isTopBar ? 8 : 4}
        className="w-[380px] rounded-xl p-0"
        onMouseEnter={handlePopoverMouseEnter}
        onMouseLeave={handlePopoverMouseLeave}
      >
        <ResourceMonitorPanelContent
          variant="popover"
          viewModel={controller.viewModel}
          isLoading={controller.isLoading}
          isRefreshing={controller.isRefreshing}
          error={controller.error}
          governanceEvents={controller.recentGovernanceEvents}
          rankedSpaces={controller.rankedSpaces}
          spaceNameById={controller.spaceNameById}
          onRefresh={controller.onRefresh}
          onNavigateToSpace={controller.onNavigateToSpace}
          onNavigateToItem={controller.onNavigateToItem}
          onNavigateToDataRuntime={controller.onNavigateToDataRuntime}
          onNavigateToDocRuntime={controller.onNavigateToDocRuntime}
          onCloseGovernanceItems={controller.onCloseGovernanceItems}
          onSuggestionAction={controller.onSuggestionAction}
          onOpenFullSettings={handleOpenFullSettings}
        />
      </PopoverContent>
    </Popover>
  )
}
