/**
 * ProgressPanel - 通用进度面板组件
 *
 * 显示任务执行进度、状态和统计信息
 * 适用场景：定时刷新、批量任务、导入等需要展示进度的场景
 *
 * @module ProgressPanel
 */

import React from 'react'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'

export interface ProgressPanelProps {
  /** 任务状态 */
  status: 'pending' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

  /** 进度百分比（0-100）*/
  progress?: number

  /** 当前步骤描述 */
  currentStep?: string

  /** 开始时间戳（毫秒）*/
  startedAt?: number | null

  /** 完成时间戳（毫秒）*/
  completedAt?: number | null

  /** 已提取记录数 */
  recordCount?: number

  /** 翻页统计 */
  paginationStats?: {
    successPages?: number
    requestedPages?: number
  }

  /** 错误信息 */
  error?: string | null

  /** 是否正在提交结果 */
  isSubmitting?: boolean

  /** 提交结果 */
  submitResult?: {
    success: boolean
    error?: string
    data?: {
      outcome?: {
        created?: number
        updated?: number
      }
    }
  } | null

  /** 自定义类名 */
  className?: string
}

/**
 * 状态颜色类名映射
 */
const STATUS_COLOR_MAP = {
  pending: 'text-muted-foreground',
  queued: 'text-info',
  running: 'text-warning',
  paused: 'text-warning',
  completed: 'text-success',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
}

/**
 * 状态图标映射
 */
const STATUS_ICON_MAP = {
  pending: '⏸️',
  queued: '⏳',
  running: '⚡',
  paused: '⏸️',
  completed: '✅',
  failed: '❌',
  cancelled: '🚫',
}

/**
 * 计算执行时间（秒）
 */
function calculateExecutionTime(
  startedAt?: number | null,
  completedAt?: number | null
): number {
  if (!startedAt) return 0
  const endTime = completedAt || Date.now()
  const durationMs = endTime - startedAt
  const durationSec = durationMs / 1000
  return Math.max(0, Math.round(durationSec * 100) / 100)
}

/**
 * 格式化执行时间
 */
function formatExecutionTime(seconds: number): string {
  if (seconds < 60) {
    return t('duration.seconds', { value: seconds.toFixed(1) })
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  if (remainingSeconds === 0) {
    return t('duration.minutes', { value: minutes })
  }
  return t('duration.minutesSeconds', { minutes, seconds: remainingSeconds })
}

/**
 * 通用进度面板组件
 */
export const ProgressPanel: React.FC<ProgressPanelProps> = ({
  status,
  progress = 0,
  currentStep,
  startedAt,
  completedAt,
  recordCount = 0,
  paginationStats,
  error,
  isSubmitting = false,
  submitResult,
  className
}) => {
  const executionTime = calculateExecutionTime(startedAt, completedAt)
  const statusText = t(`progressPanel.status.${status}`)
  const statusColorClass = STATUS_COLOR_MAP[status] || 'text-muted-foreground'
  const statusIcon = STATUS_ICON_MAP[status] || '●'

  const successPages = paginationStats?.successPages || 0
  const requestedPages = paginationStats?.requestedPages || 0

  return (
    <div className={cn('bg-background border-b border-border p-4', className)}>
      <div className="flex items-center justify-between mb-3">
        {/* 左侧：状态 */}
        <div className="flex items-center space-x-2">
          <span className="text-heading" aria-hidden="true">{statusIcon}</span>
          <span className={cn('text-title font-semibold', statusColorClass)}>
            {statusText}
          </span>
        </div>

        {/* 右侧：执行时间 */}
        {executionTime > 0 && (
          <div className="text-body text-muted-foreground">
            {t('progressPanel.executionTime', { time: formatExecutionTime(executionTime) })}
          </div>
        )}
      </div>

      {/* 进度条 */}
      {(status === 'running' || status === 'queued') && (
        <div className="mb-3">
          <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
            <div
              className="bg-primary h-full transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="mt-1 text-body text-muted-foreground text-center">
            {currentStep
              ? t('progressPanel.progressWithStep', { progress, step: currentStep })
              : t('progressPanel.progress', { progress })}
          </div>
        </div>
      )}

      {/* 统计信息 */}
      <div className="grid grid-cols-2 gap-2 text-body">
        {/* 记录数 — CC-023: recordCount 为 0 时也显示，用 0 作为初始值 */}
        <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
          <span className="text-muted-foreground">{t('progressPanel.stats.extracted')}</span>
          <span className="font-semibold">{t('common.records', { count: recordCount })}</span>
        </div>

        {/* 页数 */}
        {successPages > 0 && (
          <div className="flex items-center justify-between p-2 bg-muted/50 rounded">
            <span className="text-muted-foreground">{t('progressPanel.stats.pages')}</span>
            <span className="font-semibold">
              {requestedPages > 0 && requestedPages !== successPages
                ? t('progressPanel.pages.successWithTotal', { count: successPages, total: requestedPages })
                : t('progressPanel.pages.success', { count: successPages })}
            </span>
          </div>
        )}
      </div>

      {/* 提交状态 */}
      {isSubmitting && (
        <div className="mt-3 flex items-center space-x-2 text-body text-primary">
          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span>{t('progressPanel.submitting')}</span>
        </div>
      )}

      {/* 提交结果 */}
      {submitResult && !isSubmitting && (
        <div className={cn(
          'mt-3 p-2 rounded text-body',
          submitResult.success
            ? 'bg-success text-success border border-success dark:bg-success dark:text-success dark:border-success'
            : 'bg-destructive/10 text-destructive border border-destructive/20'
        )}>
          {submitResult.success ? (
            <div className="flex items-center space-x-2">
              <span aria-hidden="true">✅</span>
              <span>
                {t('progressPanel.submit.success')}
                {submitResult.data?.outcome && (
                  <span className="ml-1">
                    {t('progressPanel.submit.outcome', {
                      created: submitResult.data.outcome.created || 0,
                      updated: submitResult.data.outcome.updated || 0
                    })}
                  </span>
                )}
              </span>
            </div>
          ) : (
            <div className="flex items-center space-x-2">
              <span aria-hidden="true">❌</span>
              <span>{t('progressPanel.submit.failed', { error: submitResult.error || t('common.unknownError') })}</span>
            </div>
          )}
        </div>
      )}

      {/* 错误信息 */}
      {error && (
        <div className="mt-3 p-2 rounded text-body bg-destructive/10 text-destructive border border-destructive/20">
          <div className="flex items-start space-x-2">
            <span className="flex-shrink-0" aria-hidden="true">❌</span>
            <div className="flex-1">
              <div className="font-semibold mb-1">{t('progressPanel.error.title')}</div>
              <div className="text-body">{error}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}





