import React from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { cn, ScrollArea, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, Button } from '@tabtin/smartsheet-ui'
import {
  ArrowUpRight,
  Cpu,
  HardDrive,
  LayoutGrid,
  Lightbulb,
  Loader2,
  Monitor,
  RefreshCw,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import {
  type ResourceMonitorSpaceView,
  type ResourceMonitorSuggestion,
  type ResourceMonitorTabDataRuntimeView,
  type ResourceMonitorTabDocRuntimeView,
  type ResourceMonitorTrackedItem,
  type ResourceMonitorViewModel,
} from './model'
import type { ResourceMonitorGovernanceEvent } from './history'
import type { ResourceMonitorSeverityLevel } from './severity'
import {
  formatBytes,
  formatCpu,
  formatPercent,
  formatSnapshotTime,
  formatDuration,
  severitySurfaceClasses,
  itemStatusClasses,
} from './formatters'

const kindIconMap = {
  browser: Monitor,
  terminal: TerminalSquare,
} satisfies Record<ResourceMonitorTrackedItem['kind'], React.ComponentType<{ className?: string }>>

/** 手动刷新加载蒙层淡入淡出时长（需与 transition duration-200 对齐） */
const REFRESH_OVERLAY_FADE_MS = 200

// ── Atomic components ──

function MetricCell(props: {
  label: string
  value: string
  sub?: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="text-center">
      <div className="text-caption text-muted-foreground">{props.label}</div>
      <div className="text-body font-semibold text-foreground tabular-nums">{props.value}</div>
      {props.sub ? (
        <div className="flex items-center justify-center gap-1 text-caption text-muted-foreground">
          <span>{props.sub}</span>
          {props.actionLabel && props.onAction ? (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={props.onAction}
                  aria-label={props.actionLabel}
                  className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="resource-monitor-tabs-cleanup"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[220px] text-caption">
                {props.actionLabel}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const severityDotColor: Record<ResourceMonitorSeverityLevel, string> = {
  healthy: 'bg-success',
  attention: 'bg-warning',
  heavy: 'bg-destructive',
}

const severityLabelColor: Record<ResourceMonitorSeverityLevel, string> = {
  healthy: 'text-success',
  attention: 'text-foreground',
  heavy: 'text-destructive',
}

function buildTrendText(viewModel: ResourceMonitorViewModel, t: TFunction<'monitor'>): string | null {
  const parts: string[] = []
  const mem = viewModel.history.memoryTrend
  if (mem.direction === 'up' || mem.direction === 'down') {
    const delta = formatBytes(Math.abs(mem.delta ?? 0))
    parts.push(
      t(mem.direction === 'up' ? 'resourceMonitor.trend.memoryUp' : 'resourceMonitor.trend.memoryDown', { delta }),
    )
  }
  const cpu = viewModel.history.cpuTrend
  if (cpu.direction === 'up' || cpu.direction === 'down') {
    const delta = formatCpu(Math.abs(cpu.delta ?? 0))
    parts.push(
      t(cpu.direction === 'up' ? 'resourceMonitor.trend.cpuUp' : 'resourceMonitor.trend.cpuDown', { delta }),
    )
  }
  if (viewModel.history.stale) {
    parts.push(t('resourceMonitor.trend.stale', { duration: formatDuration(viewModel.history.staleMs) }))
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function ResourceRow(props: { item: ResourceMonitorTrackedItem; sub?: string; onOpen?: () => void }) {
  const Icon = kindIconMap[props.item.kind]
  const clickable = Boolean(props.onOpen)
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={props.onOpen}
      className={cn(
        'flex w-full items-center gap-2 px-2 py-1 text-left transition-colors rounded-md',
        clickable ? 'hover:bg-muted/20' : 'cursor-default',
      )}
    >
      <div className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className={cn('absolute -bottom-px -right-px h-1.5 w-1.5 rounded-full border border-background', itemStatusClasses[props.item.status])} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-body text-foreground">{props.item.title}</span>
          <span className="shrink-0 text-caption text-muted-foreground">{props.item.badgeLabel}</span>
        </div>
        {props.sub ? <div className="truncate text-caption text-muted-foreground">{props.sub}</div> : null}
      </div>
      <span className="shrink-0 text-body tabular-nums text-muted-foreground">{formatBytes(props.item.memory)}</span>
    </button>
  )
}

function SpaceGroup(props: {
  space: ResourceMonitorSpaceView
  onNavigateToSpace: (id: string) => void
  onNavigateToItem: (item: ResourceMonitorTrackedItem) => void
}) {
  const { t } = useTranslation('monitor')
  const hasTrackedMemory = props.space.totalMemory > 0
  const summaryText = hasTrackedMemory
    ? formatBytes(props.space.totalMemory)
    : props.space.tabCount > 0
      ? t('resourceMonitor.tabCount', { count: props.space.tabCount })
      : props.space.runCount > 0
        ? t('resourceMonitor.runCount', { count: props.space.runCount })
        : '—'
  return (
    <div>
      <button
        type="button"
        onClick={() => props.onNavigateToSpace(props.space.spaceId)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left transition-colors rounded-md hover:bg-muted/20"
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground">
          <LayoutGrid className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-body font-medium text-foreground">{props.space.spaceName}</span>
            {props.space.isCurrentSpace && (
              <span className="rounded-full bg-primary/10 px-1 text-caption text-primary">
                {t('resourceMonitor.current')}
              </span>
            )}
          </div>
        </div>
        <span className="shrink-0 text-body tabular-nums text-muted-foreground">{summaryText}</span>
        <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      </button>
      {props.space.topItems.length > 0 ? (
        <div className="ml-5 border-l border-border/30 pl-2">
          {props.space.topItems.map((item) => (
            <ResourceRow
              key={`${item.kind}:${item.id}`}
              item={item}
              sub={item.subtitle}
              onOpen={item.spaceId ? () => props.onNavigateToItem(item) : undefined}
            />
          ))}
        </div>
      ) : props.space.appBreakdown.length > 0 ? (
        <div className="ml-5 border-l border-border/30 pl-2 px-2 py-1">
          <span className="text-caption text-muted-foreground">
            {props.space.appBreakdown
              .map((entry) => t('resourceMonitor.appCount', { label: entry.label, count: entry.count }))
              .join(t('resourceMonitor.appBreakdownSeparator'))}
          </span>
        </div>
      ) : null}
    </div>
  )
}

function SystemOverheadRow(props: { label: string; icon: React.ComponentType<{ className?: string }>; value: string; detail?: string }) {
  const Icon = props.icon
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 px-2 py-1 rounded-md cursor-default transition-colors hover:bg-muted/15">
            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-body text-muted-foreground">{props.label}</span>
            <span className="ml-auto text-body tabular-nums text-muted-foreground">{props.value}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">
          <span className="text-caption">{props.detail}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// ── Main panel ──

export interface ResourceMonitorPanelProps {
  viewModel: ResourceMonitorViewModel
  isLoading: boolean
  isRefreshing: boolean
  error: string | null
  governanceEvents: ResourceMonitorGovernanceEvent[]
  rankedSpaces: ResourceMonitorSpaceView[]
  spaceNameById: Map<string, string>
  onRefresh: () => void
  onNavigateToSpace: (spaceId: string) => void
  onNavigateToItem: (item: ResourceMonitorTrackedItem) => void
  onNavigateToDataRuntime: (data: ResourceMonitorTabDataRuntimeView) => void
  onNavigateToDocRuntime: (doc: ResourceMonitorTabDocRuntimeView) => void
  onCloseGovernanceItems: (items: ResourceMonitorTrackedItem[]) => void
  onSuggestionAction: (suggestion: ResourceMonitorSuggestion) => void
  /** popover 底部「查看详情」→ 设置页性能监控 */
  onOpenFullSettings?: () => void
  /** popover = 侧栏悬浮面板；embedded = 设置页内嵌 */
  variant?: 'popover' | 'embedded'
}

export function ResourceMonitorPanelContent(props: ResourceMonitorPanelProps) {
  const { t } = useTranslation('monitor')
  const { viewModel, variant = 'popover' } = props
  const isEmbedded = variant === 'embedded'
  // Browser 检查卡常驻；其它建议另占一条，避免互相顶掉
  const browserSuggestion = viewModel.suggestions.find((s) => s.id === 'browser-runtime') ?? null
  const closeAllTabsSuggestion = viewModel.suggestions.find((s) => s.id === 'close-all-tabs') ?? null
  const topSuggestion = viewModel.suggestions.find(
    (s) => s.actionLabel && s.id !== 'browser-runtime' && s.id !== 'close-all-tabs',
  ) ?? null
  // model 里仍有中文占位；展示层用 monitor i18n，避免英文模式漏翻
  const browserCardCopy = React.useMemo(() => {
    if (!browserSuggestion) return null
    const closableCount = viewModel.browser.closableCount
    const closableTitle = viewModel.browser.closableItems[0]?.title ?? ''
    const reason = browserSuggestion.severity.reason
    const description = viewModel.browser.totalCount === 0
      ? t('resourceMonitor.browserReclaim.noBrowsers')
      : closableCount >= 2
        ? t('resourceMonitor.browserReclaim.reclaimMany', { reason, count: closableCount })
        : closableCount === 1
          ? t('resourceMonitor.browserReclaim.reclaimOne', { reason, title: closableTitle })
          : viewModel.browser.retainedOffscreenCount > 0
            ? t('resourceMonitor.browserReclaim.retained', { count: viewModel.browser.retainedOffscreenCount })
            : t('resourceMonitor.browserReclaim.overview', {
                reason,
                total: viewModel.browser.totalCount,
                share: formatPercent(viewModel.browser.totalMemorySharePercent),
              })
    return {
      title: t('resourceMonitor.browserReclaim.checkTitle'),
      description,
      actionLabel: browserSuggestion.actionDisabled
        ? t('resourceMonitor.browserReclaim.actionUnavailable')
        : t('resourceMonitor.browserReclaim.action'),
    }
  }, [browserSuggestion, t, viewModel.browser.closableCount, viewModel.browser.closableItems, viewModel.browser.retainedOffscreenCount, viewModel.browser.totalCount, viewModel.browser.totalMemorySharePercent])
  const allSpaces = viewModel.currentSpace
    ? [viewModel.currentSpace, ...props.rankedSpaces.filter((s) => s.spaceId !== viewModel.currentSpace?.spaceId)]
    : props.rankedSpaces
  const hasContent = allSpaces.length > 0 || viewModel.topItems.length > 0
  const severityLevel = viewModel.overview.severity.level
  const collectedAtLabel = viewModel.overview.collectedAt == null || viewModel.overview.collectedAt <= 0
    ? t('resourceMonitor.notCollected')
    : formatSnapshotTime(viewModel.overview.collectedAt)

  // 手动刷新结束后短暂高亮时间戳（不在刷新中 animate-pulse，否则会一直闪）。
  // 加载蒙层受控淡入淡出：先挂载再显、先隐再卸，避免硬切。
  const [justRefreshed, setJustRefreshed] = React.useState(false)
  const [overlayMounted, setOverlayMounted] = React.useState(false)
  const [overlayVisible, setOverlayVisible] = React.useState(false)
  const wasRefreshingRef = React.useRef(false)
  React.useEffect(() => {
    if (wasRefreshingRef.current && !props.isRefreshing) {
      setJustRefreshed(true)
      const timerId = window.setTimeout(() => setJustRefreshed(false), 700)
      wasRefreshingRef.current = false
      return () => window.clearTimeout(timerId)
    }
    wasRefreshingRef.current = props.isRefreshing
  }, [props.isRefreshing])

  React.useEffect(() => {
    if (props.isRefreshing) {
      setOverlayMounted(true)
      let raf2 = 0
      const raf1 = window.requestAnimationFrame(() => {
        raf2 = window.requestAnimationFrame(() => setOverlayVisible(true))
      })
      return () => {
        window.cancelAnimationFrame(raf1)
        window.cancelAnimationFrame(raf2)
      }
    }
    setOverlayVisible(false)
    const timerId = window.setTimeout(() => setOverlayMounted(false), REFRESH_OVERLAY_FADE_MS)
    return () => window.clearTimeout(timerId)
  }, [props.isRefreshing])

  const listBody = (
    <div className={cn(isEmbedded ? 'py-2' : 'py-1.5')}>
      {browserSuggestion && browserCardCopy && (
        <div className={cn(isEmbedded ? 'px-4 py-2' : 'px-3 py-1.5')}>
          <div className={cn('rounded-lg border px-2.5 py-2', severitySurfaceClasses[browserSuggestion.severity.level])}>
            <div className="flex items-start gap-2">
              <Lightbulb className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium text-foreground">{browserCardCopy.title}</div>
                <div className="mt-0.5 text-caption leading-[18px] text-muted-foreground">{browserCardCopy.description}</div>
              </div>
              {browserCardCopy.actionLabel && (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={Boolean(browserSuggestion.actionDisabled)}
                          aria-label={browserCardCopy.actionLabel}
                          onClick={() => {
                            if (browserSuggestion.actionDisabled) return
                            props.onSuggestionAction(browserSuggestion)
                          }}
                          className="h-6 shrink-0 px-2 text-caption"
                        >
                          {browserCardCopy.actionLabel}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[240px] text-caption">
                      {viewModel.browser.closableCount > 0
                        ? t('resourceMonitor.browserReclaim.available', { count: viewModel.browser.closableCount })
                        : viewModel.browser.totalCount > 0
                          ? t('resourceMonitor.browserReclaim.noneIdle')
                          : t('resourceMonitor.browserReclaim.noBrowsers')}
                      <span className="mt-1 block text-muted-foreground">
                        {t('resourceMonitor.browserReclaim.boundaryNote')}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
        </div>
      )}

      {topSuggestion && (
        <div className={cn(isEmbedded ? 'px-4 py-2' : 'px-3 py-1.5')}>
          <div className={cn('rounded-lg border px-2.5 py-2', severitySurfaceClasses[topSuggestion.severity.level])}>
            <div className="flex items-start gap-2">
              <Lightbulb className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium text-foreground">{topSuggestion.title}</div>
                <div className="mt-0.5 text-caption leading-[18px] text-muted-foreground">{topSuggestion.description}</div>
              </div>
              {topSuggestion.actionLabel && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(topSuggestion.actionDisabled)}
                  onClick={() => {
                    if (topSuggestion.actionDisabled) return
                    props.onSuggestionAction(topSuggestion)
                  }}
                  className="h-6 shrink-0 px-2 text-caption"
                >
                  {topSuggestion.actionLabel}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className={isEmbedded ? 'px-2' : 'px-1'}>
        <div className="px-2 py-1.5">
          <div className={cn('text-caption font-medium text-muted-foreground', isEmbedded && 'uppercase tracking-wider')}>
            {t('resourceMonitor.spaceSection')}
          </div>
        </div>
        {hasContent && allSpaces.map((space) => (
          <SpaceGroup
            key={space.spaceId}
            space={space}
            onNavigateToSpace={props.onNavigateToSpace}
            onNavigateToItem={props.onNavigateToItem}
          />
        ))}
        {viewModel.topItems.length > 0 && allSpaces.length === 0 && (
          <>
            <div className="px-2 py-1.5 text-caption font-medium text-muted-foreground">
              {t('resourceMonitor.resourcesSection')}
            </div>
            {viewModel.topItems.map((item) => (
              <ResourceRow
                key={`${item.kind}:${item.id}`}
                item={item}
                sub={item.spaceId ? props.spaceNameById.get(item.spaceId) : t('resourceMonitor.background')}
                onOpen={item.spaceId ? () => props.onNavigateToItem(item) : undefined}
              />
            ))}
          </>
        )}
      </div>

      {(viewModel.background.rendererResidualMemory > 0 || viewModel.background.hostOverheadMemory > 0) && (
        <div className={cn(isEmbedded ? 'px-2 mt-2' : 'px-1 mt-1')}>
          <div className={cn('px-2 py-1.5 text-caption font-medium text-muted-foreground', isEmbedded && 'uppercase tracking-wider')}>
            {t('resourceMonitor.systemOverhead')}
          </div>
          {viewModel.background.rendererResidualMemory > 0 && (
            <SystemOverheadRow
              icon={Monitor}
              label={t('resourceMonitor.uiEngine')}
              value={formatBytes(viewModel.background.rendererResidualMemory)}
              detail={t('resourceMonitor.uiEngineDetail', {
                cpu: formatCpu(viewModel.background.rendererResidualCpu),
              })}
            />
          )}
          {viewModel.background.hostOverheadMemory > 0 && (
            <SystemOverheadRow
              icon={Cpu}
              label={t('resourceMonitor.appHost')}
              value={formatBytes(viewModel.background.hostOverheadMemory)}
              detail={t('resourceMonitor.appHostDetail', {
                cpu: formatCpu(viewModel.background.hostOverheadCpu),
              })}
            />
          )}
          {viewModel.background.unassignedMemory > 0 && (
            <SystemOverheadRow
              icon={HardDrive}
              label={t('resourceMonitor.unassigned')}
              value={formatBytes(viewModel.background.unassignedMemory)}
              detail={t('resourceMonitor.unassignedDetail', {
                cpu: formatCpu(viewModel.background.unassignedCpu),
              })}
            />
          )}
        </div>
      )}
    </div>
  )

  return (
    <>
      <div className={cn(isEmbedded ? 'px-4 py-3' : 'px-3 py-2.5')}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', severityDotColor[severityLevel])} />
            <span className={cn('text-body font-semibold', severityLabelColor[severityLevel])}>
              {t(`resourceMonitor.severity.${severityLevel}`)}
            </span>
            <span
              className={cn(
                'text-caption truncate transition-colors duration-300',
                justRefreshed ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {collectedAtLabel}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onRefresh}
            disabled={props.isRefreshing}
            aria-label={t('resourceMonitor.refresh')}
            className={cn(
              'h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground',
              props.isRefreshing && 'text-foreground',
            )}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', props.isRefreshing && 'animate-spin')} />
          </Button>
        </div>
        <div className="mt-1 text-caption text-muted-foreground">
          {t(`resourceMonitor.tagline.${severityLevel}`)}
        </div>
        {severityLevel !== 'healthy' ? (
          <div
            className="mt-0.5 text-caption font-medium text-foreground"
            data-testid="resource-monitor-severity-reason"
          >
            {viewModel.overview.severity.reason}
          </div>
        ) : null}
        {(() => {
          const trend = buildTrendText(viewModel, t)
          if (!trend) return null
          return <div className="mt-0.5 text-caption text-muted-foreground/60">{trend}</div>
        })()}
        {props.error && (
          <div className="mt-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-caption text-destructive">{props.error}</div>
        )}
      </div>

      {/* 内容区包一层 relative：手动刷新时盖遮罩，不改 SPACE 列表自身 opacity / 不重挂载 */}
      <div className="relative">
        <div
          className={cn(
            'grid grid-cols-3 border-y border-border/30 divide-x divide-border/30',
            isEmbedded && 'bg-muted/[0.12]',
          )}
        >
          <div className="px-4 py-3">
            <MetricCell
              label={t('resourceMonitor.cpu')}
              value={formatCpu(viewModel.overview.totalCpu / viewModel.overview.cpuCoreCount)}
              sub={t('resourceMonitor.cpuCores', { count: viewModel.overview.cpuCoreCount })}
            />
          </div>
          <div className="px-4 py-3">
            <MetricCell
              label={t('resourceMonitor.memory')}
              value={formatBytes(viewModel.overview.totalMemory)}
              sub={t('resourceMonitor.ramShare', { percent: formatPercent(viewModel.overview.ramSharePercent) })}
            />
          </div>
          <div className="px-4 py-3">
            <MetricCell
              label={t('resourceMonitor.currentTabs')}
              value={`${viewModel.overview.currentTabCount}`}
              sub={t('resourceMonitor.allSessionTabs', { count: viewModel.overview.totalTabCount })}
              actionLabel={closeAllTabsSuggestion
                ? t('resourceMonitor.closeAllTabs')
                : undefined}
              onAction={closeAllTabsSuggestion
                ? () => props.onSuggestionAction(closeAllTabsSuggestion)
                : undefined}
            />
          </div>
        </div>

        {isEmbedded ? (
          <div>{listBody}</div>
        ) : (
          <>
            <ScrollArea className="max-h-[60vh]">
              {listBody}
            </ScrollArea>
            {props.onOpenFullSettings ? (
              <div className="border-t border-border/30 px-3 py-2">
                <button
                  type="button"
                  onClick={props.onOpenFullSettings}
                  className="flex w-full items-center justify-between gap-2 rounded-interactive px-2 py-1.5 text-body text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
                  data-testid="resource-monitor-view-details"
                >
                  <span>{t('resourceMonitor.viewDetails')}</span>
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
                </button>
              </div>
            ) : null}
          </>
        )}

        {overlayMounted ? (
          <div
            className={cn(
              'absolute inset-0 z-sticky flex items-center justify-center bg-background/60 transition-opacity duration-200 ease-out',
              overlayVisible ? 'opacity-100' : 'opacity-0',
            )}
            aria-busy={overlayVisible}
            aria-live="polite"
          >
            <div
              className={cn(
                'flex items-center gap-2 rounded-lg border border-border/40 bg-background/90 px-3 py-2 shadow-sm transition-[opacity,transform] duration-200 ease-out',
                overlayVisible ? 'scale-100 opacity-100' : 'scale-95 opacity-0',
              )}
            >
              <Loader2 className="h-4 w-4 animate-spin text-foreground" />
              <span className="text-body text-foreground">{t('resourceMonitor.refreshLoading')}</span>
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}
