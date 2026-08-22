/**
 * MonitorStatusCard — Monitor 进程监管状态展示
 *
 * 展示 Monitor 的：
 * - 描述 + 状态（running/stopped/stream_ended/failed）
 * - 最近收到的事件行数
 * - 停止按钮（running 状态）
 *
 * 同时注册到 cardRenderers registry。
 */

import React from 'react'
import type { TFunction } from 'i18next'
import { Activity, StopCircle, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import {
  CARD_RADIUS,
  CARD_HEADER_PADDING,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  ICON_SIZE,
  ANIMATION,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import type { CardRendererProps } from '../registry/types'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

export interface MonitorCardData {
  monitor_id: string
  description: string
  command: string
  status: 'running' | 'stopped' | 'stream_ended' | 'failed'
  notify_on: string
  fail_reason?: string
  created_at?: string
  /** 上报链路中断（如认证失效后主进程已停止全部 Monitor），与 monitor:emitInterrupted 一致 */
  emit_interrupted?: boolean
}

interface MonitorStatusCardProps {
  data: MonitorCardData
  onStop?: (monitorId: string) => void
}

/** 将 MonitorExecutor / 网关返回的英文 fail_reason 转为当前语言；已有中文或非匹配文案则原样展示。 */
export function localizeMonitorFailReason(reason: string, t: TFunction<'monitor'>): string {
  const trimmed = reason.trim()
  if (!trimmed) return reason
  if (/[\u4e00-\u9fff]/.test(trimmed)) return trimmed

  if (trimmed.includes('Failed to spawn PTY session')) {
    return t('failReason.spawnPtyFailed')
  }
  if (trimmed.includes('Failed to write command to PTY session')) {
    return t('failReason.writePtyFailed')
  }
  if (trimmed.includes('Invalid regex pattern')) {
    return t('failReason.invalidRegex')
  }
  if (trimmed.includes('already running') && trimmed.includes('Monitor')) {
    return t('failReason.alreadyRunning')
  }
  if (trimmed.includes('Unknown monitor action')) {
    return t('failReason.unknownAction')
  }
  return trimmed
}

const STATUS_CONFIG = {
  running: {
    icon: Loader2,
    color: 'text-accent',
    bgColor: 'bg-accent/5',
    borderColor: 'border-accent/20',
    labelKey: 'status.running',
    animate: true,
  },
  stopped: {
    icon: StopCircle,
    color: 'text-muted-foreground/60',
    bgColor: 'bg-muted/10',
    borderColor: 'border-border/20',
    labelKey: 'status.stopped',
    animate: false,
  },
  stream_ended: {
    icon: CheckCircle2,
    color: 'text-success',
    bgColor: 'bg-success/5',
    borderColor: 'border-success/20',
    labelKey: 'status.streamEnded',
    animate: false,
  },
  failed: {
    icon: XCircle,
    color: 'text-destructive',
    bgColor: 'bg-destructive/5',
    borderColor: 'border-destructive/20',
    labelKey: 'status.failed',
    animate: false,
  },
} as const

export const MonitorStatusCard: React.FC<MonitorStatusCardProps> = ({ data, onStop }) => {
  const { t } = useTranslation('monitor')
  const config = STATUS_CONFIG[data.status] || STATUS_CONFIG.running
  const Icon = config.icon

  return (
    <div
      className={cn(
        CARD_RADIUS,
        'border',
        config.borderColor,
        config.bgColor,
        'overflow-hidden',
      )}
    >
      <div className={cn(CARD_HEADER_PADDING, 'flex items-center justify-between gap-2')}>
        <div className="flex items-center gap-2 min-w-0">
          <Activity className={cn(ICON_SIZE, 'shrink-0 text-muted-foreground/40')} />
          <div className="min-w-0">
            <div className={cn(TEXT.body, 'font-medium text-foreground truncate')}>
              {data.description}
            </div>
            <div className={cn(TEXT.meta, 'text-muted-foreground/60 truncate')}>
              {data.command.length > 60 ? data.command.slice(0, 60) + '…' : data.command}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className={cn('flex items-center gap-1', config.color)}>
            <Icon className={cn('h-3.5 w-3.5', config.animate && ANIMATION.spin)} />
            <span className={TEXT.meta}>
              {t(config.labelKey)}
            </span>
          </div>
          {data.status === 'running' && onStop && (
            <ChatIconTooltip content={t('stop')}>
              <button
                onClick={() => onStop(data.monitor_id)}
                className={cn(
                  'rounded p-1 text-muted-foreground/40 transition-colors',
                  'hover:text-destructive hover:bg-destructive/5',
                )}
                aria-label={t('stop')}
              >
                <StopCircle className="h-3.5 w-3.5" />
              </button>
            </ChatIconTooltip>
          )}
        </div>
      </div>

      {data.emit_interrupted && (
        <div className={cn(CARD_HEADER_PADDING, 'pt-0')}>
          <div className={cn(TEXT.meta, 'text-destructive/80')}>
            {t('emitInterrupted')}
          </div>
        </div>
      )}

      {data.fail_reason && (
        <div className={cn(CARD_HEADER_PADDING, 'pt-0')}>
          <div className={cn(TEXT.meta, 'text-destructive/80')}>
            {localizeMonitorFailReason(data.fail_reason, t)}
          </div>
        </div>
      )}
    </div>
  )
}

function MonitorErrorBanner({ message }: { message: string }) {
  const { t } = useTranslation('monitor')
  return (
    <div className={cn(CARD_RADIUS, 'border', BORDER.error, BG.error, 'overflow-hidden')}>
      <div className={cn(CARD_HEADER_PADDING, 'flex items-center gap-2')}>
        <XCircle className={cn(ICON_SIZE.status, 'shrink-0 text-destructive')} />
        <div className="min-w-0">
          <div className={cn(TEXT.body, 'font-medium text-destructive')}>
            {t('error', { defaultValue: 'Monitor 执行出错' })}
          </div>
          <div className={cn(TEXT.meta, 'text-destructive/80 break-words')}>
            {message}
          </div>
        </div>
      </div>
    </div>
  )
}

function MonitorLoadingPlaceholder() {
  const { t } = useTranslation('monitor')
  return (
    <div className={cn(CARD_RADIUS, 'border', BORDER.default, BG.card, 'overflow-hidden')}>
      <div className={cn(CARD_HEADER_PADDING, 'flex items-center gap-2')}>
        <Loader2 className={cn(ICON_SIZE.status, 'shrink-0 text-accent', ANIMATION.spin)} />
        <span className={cn(TEXT.body, TEXT_COLOR.muted)}>
          {t('loading', { defaultValue: 'Monitor 启动中…' })}
        </span>
      </div>
    </div>
  )
}

function isValidMonitorCardData(value: unknown): value is MonitorCardData {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return typeof obj.monitor_id === 'string' && typeof obj.status === 'string'
}

function MonitorCardAdapter({ data, error, phase }: CardRendererProps) {
  if (error) {
    return <MonitorErrorBanner message={error} />
  }
  if (phase === 'start') {
    return <MonitorLoadingPlaceholder />
  }
  if (!isValidMonitorCardData(data)) {
    return <MonitorErrorBanner message="Monitor 状态数据缺失或格式异常" />
  }
  return <MonitorStatusCard data={data} />
}

registerCardRenderer('monitor_status', MonitorCardAdapter)

export default MonitorStatusCard
