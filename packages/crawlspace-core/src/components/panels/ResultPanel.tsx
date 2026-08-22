/**
 * ResultPanel - 通用结果面板组件
 *
 * 显示任务完成后的结果和自动关闭倒计时
 * 适用场景：定时刷新、批量任务、导入等需要展示结果的场景
 *
 * @module ResultPanel
 */

import React, { useState, useEffect } from 'react'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'

export interface ResultPanelProps {
  /** 任务状态 */
  status: 'completed' | 'failed' | 'cancelled'

  /** 已提取记录数 */
  recordCount?: number

  /** 提取的数据（可选，用于预览）*/
  extractedData?: any[]

  /** 错误信息 */
  error?: string | null

  /** 提交结果 */
  submitResult?: {
    success: boolean
    error?: string
    data?: {
      outcome?: {
        records_found?: number
        created?: number
        updated?: number
        deleted?: number
        skipped?: number
        unchanged?: number
        errors?: number
      }
    }
  } | null

  /** 关闭回调 */
  onClose: () => void

  /** 自动关闭倒计时（秒，0 表示不自动关闭）*/
  autoCloseDuration?: number

  /** 是否显示数据预览 */
  showDataPreview?: boolean

  /** 预览数据条数 */
  previewLimit?: number

  /** 自定义类名 */
  className?: string
}

/**
 * 通用结果面板组件
 */
export const ResultPanel: React.FC<ResultPanelProps> = ({
  status,
  recordCount = 0,
  extractedData = [],
  error,
  submitResult,
  onClose,
  autoCloseDuration = 5,
  showDataPreview = true,
  previewLimit = 3,
  className
}) => {
  const [countdown, setCountdown] = useState(autoCloseDuration)

  // 倒计时逻辑
  useEffect(() => {
    // 只有在提交成功后且设置了自动关闭时间时才启动倒计时
    if (!submitResult || !submitResult.success || autoCloseDuration <= 0) {
      return
    }

    if (countdown <= 0) {
      onClose()
      return
    }

    const timer = setTimeout(() => {
      setCountdown(prev => prev - 1)
    }, 1000)

    return () => clearTimeout(timer)
  }, [countdown, submitResult, onClose, autoCloseDuration])

  const outcome = submitResult?.data?.outcome

  return (
    <div className={cn('bg-background border-t border-border p-4', className)}>
      <div className="max-w-2xl mx-auto">
        {/* 标题 */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-title font-semibold">
            {status === 'completed'
              ? t('resultPanel.title.completed')
              : status === 'failed'
                ? t('resultPanel.title.failed')
                : t('resultPanel.title.cancelled')}
          </h3>

          {/* 手动关闭按钮 */}
          <button
            onClick={onClose}
            className="text-body text-muted-foreground hover:text-foreground underline"
          >
            {t('resultPanel.closeManual')}
          </button>
        </div>

        {/* 成功结果 */}
        {status === 'completed' && submitResult?.success && (
          <div className="space-y-3">
            {/* 成功提示 */}
            <div className="flex items-center space-x-2 text-success dark:text-success">
              <span className="text-heading" aria-hidden="true">✅</span>
              <span className="text-title font-semibold">{t('resultPanel.success.title')}</span>
            </div>

            {/* 统计信息 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-info dark:bg-info p-3 rounded-lg border border-info dark:border-info">
                <div className="text-body text-info dark:text-info mb-1">{t('resultPanel.stats.extracted')}</div>
                <div className="text-heading font-bold text-info dark:text-info">{recordCount}</div>
              </div>

              {outcome && (
                <>
                  <div className="bg-success dark:bg-success p-3 rounded-lg border border-success dark:border-success">
                    <div className="text-body text-success dark:text-success mb-1">{t('resultPanel.stats.created')}</div>
                    <div className="text-heading font-bold text-success dark:text-success">{outcome.created || 0}</div>
                  </div>

                  {(outcome.updated || 0) > 0 && (
                    <div className="bg-warning dark:bg-warning p-3 rounded-lg border border-warning dark:border-warning">
                      <div className="text-body text-warning dark:text-warning mb-1">{t('resultPanel.stats.updated')}</div>
                      <div className="text-heading font-bold text-warning dark:text-warning">{outcome.updated}</div>
                    </div>
                  )}

                  {(outcome.errors || 0) > 0 && (
                    <div className="bg-destructive dark:bg-destructive p-3 rounded-lg border border-destructive dark:border-destructive">
                      <div className="text-body text-destructive dark:text-destructive mb-1">{t('resultPanel.stats.errors')}</div>
                      <div className="text-heading font-bold text-destructive dark:text-destructive">{outcome.errors}</div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 自动关闭提示 */}
            {countdown > 0 && autoCloseDuration > 0 && (
              <div className="text-center text-body text-muted-foreground py-2">
                {t('resultPanel.autoClose', { count: countdown })}
              </div>
            )}
          </div>
        )}

        {/* 失败结果 */}
        {status === 'failed' && (
          <div className="space-y-3">
            {/* 失败提示 */}
            <div className="flex items-center space-x-2 text-destructive">
              <span className="text-heading" aria-hidden="true">❌</span>
              <span className="text-title font-semibold">{t('resultPanel.failed.title')}</span>
            </div>

            {/* 错误信息 */}
            {error && (
              <div className="bg-destructive/10 p-3 rounded-lg border border-destructive/20">
                <div className="text-body text-destructive mb-1">{t('resultPanel.failed.detailsTitle')}</div>
                <div className="text-body font-mono">{error}</div>
              </div>
            )}

            {/* 提交状态 */}
            {submitResult && (
              <div className="bg-muted/50 p-3 rounded-lg border border-border">
                <div className="text-body text-muted-foreground mb-1">{t('resultPanel.failed.submittedTitle')}</div>
                {submitResult.error && (
                  <div className="text-body text-muted-foreground mt-1">
                    {t('resultPanel.failed.submitError', { error: submitResult.error })}
                  </div>
                )}
              </div>
            )}

            {/* 自动关闭提示 */}
            {countdown > 0 && submitResult?.success && autoCloseDuration > 0 && (
              <div className="text-center text-body text-muted-foreground py-2">
                {t('resultPanel.autoClose', { count: countdown })}
              </div>
            )}
          </div>
        )}

        {/* 数据预览 */}
        {showDataPreview && status === 'completed' && recordCount > 0 && extractedData.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border">
            <details className="text-body">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground font-medium">
                {t('resultPanel.preview.title', { count: Math.min(previewLimit, recordCount) })}
              </summary>
              <div className="mt-2 space-y-2">
                {extractedData.slice(0, previewLimit).map((record, index) => (
                  <div
                    key={index}
                    className="bg-muted/50 p-2 rounded text-body font-mono overflow-auto max-h-32"
                  >
                    <pre>{JSON.stringify(record, null, 2)}</pre>
                  </div>
                ))}
                {recordCount > previewLimit && (
                  <div className="text-body text-muted-foreground text-center">
                    {t('resultPanel.preview.more', { count: recordCount - previewLimit })}
                  </div>
                )}
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}






