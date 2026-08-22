import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn, Popover, PopoverContent, PopoverTrigger } from '@tabtin/smartsheet-ui'
import { Wifi, WifiOff } from 'lucide-react'
import {
  TOPBAR_CHROME_ACTION,
  TOPBAR_CHROME_ICON_SIZE,
  TOPBAR_CHROME_ICON_STROKE,
} from '@components/layout/sidebarUi'
import { useWsConnectionStatus } from '@/hooks/useWsConnectionStatus'
import { useRuntimeVersionInfo } from '@/hooks/useRuntimeVersionInfo'
import { RUNTIME_VERSION_DETAILS_ENABLED } from '@/utils/featureFlags'

const toneDotClass = {
  neutral: 'bg-muted-foreground/40',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
} as const

const toneTextClass = {
  neutral: 'text-muted-foreground/60',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
} as const

export type NetworkConnectionIndicatorPlacement = 'sidebar' | 'topbar'

export interface NetworkConnectionIndicatorProps {
  placement?: NetworkConnectionIndicatorPlacement
  className?: string
  'data-testid'?: string
}

export const NetworkConnectionIndicator: React.FC<NetworkConnectionIndicatorProps> = ({
  placement = 'topbar',
  className,
  'data-testid': dataTestId,
}) => {
  const { t } = useTranslation('common')
  const {
    isAuthenticated,
    indicatorState,
    serviceLines,
    tone,
    pulse,
    connectedLabel,
    sessionKicked,
  } = useWsConnectionStatus()
  const [open, setOpen] = React.useState(false)
  const hoverTimerRef = React.useRef<number | null>(null)
  const versionInfo = useRuntimeVersionInfo(open && isAuthenticated && RUNTIME_VERSION_DETAILS_ENABLED)

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

  const isTopBar = placement === 'topbar'
  const hasIssue = indicatorState?.kind !== 'connected' || tone !== 'success'
  const message =
    indicatorState?.kind === 'connected'
      ? connectedLabel
      : indicatorState?.kind === 'actionable' || indicatorState?.kind === 'informational'
        ? indicatorState.message
        : connectedLabel
  const actionLabel =
    indicatorState?.kind === 'actionable' ? indicatorState.actionLabel : undefined
  const onAction =
    indicatorState?.kind === 'actionable' ? indicatorState.onAction : undefined
  const actionDisabled =
    indicatorState?.kind === 'actionable' ? indicatorState.actionDisabled : false
  const shouldAutoOpen = !sessionKicked
    && (indicatorState?.kind === 'actionable' || tone === 'destructive')
  const indicatorTitle = t('ws.indicatorTitle', '连接状态')
  const ariaLabel = hasIssue ? `${indicatorTitle} · ${message}` : `${indicatorTitle} · ${connectedLabel}`
  const Icon = hasIssue ? WifiOff : Wifi

  React.useEffect(() => {
    if (shouldAutoOpen) setOpen(true)
    else if (!hasIssue) setOpen(false)
  }, [hasIssue, shouldAutoOpen])

  if (!isAuthenticated) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          data-testid={dataTestId ?? (isTopBar ? 'shell-top-bar-network-indicator' : undefined)}
          className={cn(
            'relative',
            isTopBar
              ? cn(TOPBAR_CHROME_ACTION, 'no-drag text-muted-foreground/60 hover:text-foreground')
              : 'h-7 w-7 flex items-center justify-center rounded-md transition-colors text-muted-foreground/60 hover:text-foreground hover:bg-muted/30',
            hasIssue && toneTextClass[tone],
            open && (hasIssue ? toneTextClass[tone] : 'bg-foreground/[0.06] text-foreground'),
            className,
          )}
          title={ariaLabel}
          aria-label={ariaLabel}
        >
          <Icon
            size={isTopBar ? TOPBAR_CHROME_ICON_SIZE : 14}
            strokeWidth={isTopBar ? TOPBAR_CHROME_ICON_STROKE : 2}
            className="shrink-0"
            aria-hidden
          />
          <span
            className={cn(
              'absolute bottom-0.5 right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background',
              toneDotClass[tone],
              pulse && 'animate-pulse',
            )}
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side={isTopBar ? 'bottom' : 'right'}
        sideOffset={isTopBar ? 8 : 4}
        className="w-[320px] rounded-xl p-3"
        onMouseEnter={handlePopoverMouseEnter}
        onMouseLeave={handlePopoverMouseLeave}
      >
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <span
              className={cn(
                'mt-1 inline-block h-2 w-2 shrink-0 rounded-full',
                toneDotClass[tone],
                pulse && 'animate-pulse',
              )}
              aria-hidden
            />
            <div className="min-w-0 flex-1 space-y-2">
              <p className={cn('text-body leading-snug', toneTextClass[tone])}>{message}</p>
              {actionLabel && onAction ? (
                <button
                  type="button"
                  onClick={onAction}
                  disabled={actionDisabled}
                  className="text-body text-current/80 underline underline-offset-2 transition-colors hover:text-current disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {actionLabel}
                </button>
              ) : null}
            </div>
          </div>
          <div className="border-t border-border/40 pt-2">
            <div className="mb-1.5 text-caption text-muted-foreground/60">
              {t('ws.serviceBreakdownTitle', '连接明细')}
            </div>
            <ul className="space-y-1.5">
              {serviceLines.map((line) => (
                <li key={line.id} className="flex items-start gap-2">
                  <span
                    className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', toneDotClass[line.tone])}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-caption text-foreground/80">{line.label}</div>
                    <div className={cn('text-caption leading-snug', toneTextClass[line.tone])}>{line.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          {RUNTIME_VERSION_DETAILS_ENABLED ? (
            <div className="border-t border-border/40 pt-2">
              <div className="mb-1.5 text-caption text-muted-foreground/60">
                {t('ws.versionDetailsTitle', '版本信息')}
              </div>
              <dl className="space-y-1.5 text-caption">
                <VersionLine
                  label={t('ws.clientVersion', '客户端')}
                  version={versionInfo.clientVersion}
                  sourceSha={versionInfo.clientSourceSha}
                />
                <VersionLine
                  label={t('ws.serverVersion', '服务端')}
                  version={
                    versionInfo.serverLoading && !versionInfo.serverVersion ? '…' : versionInfo.serverVersion
                  }
                  sourceSha={versionInfo.serverSourceSha}
                />
                <div className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-2">
                  <dt className="text-muted-foreground/60">{t('ws.serverAddress', '服务端地址')}</dt>
                  <dd
                    className="min-w-0 break-all font-mono text-foreground/80"
                    title={versionInfo.serverAddress}
                  >
                    {versionInfo.serverAddress || '—'}
                  </dd>
                </div>
              </dl>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function VersionLine({
  label,
  version,
  sourceSha,
}: {
  label: string
  version: string
  sourceSha: string
}) {
  const shortSha = sourceSha ? sourceSha.slice(0, 8) : '—'

  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-2">
      <dt className="text-muted-foreground/60">{label}</dt>
      <dd className="min-w-0 font-mono text-foreground/80" title={sourceSha || undefined}>
        <span>{version || '—'}</span>
        <span className="ml-2 text-muted-foreground/60">{shortSha}</span>
      </dd>
    </div>
  )
}
