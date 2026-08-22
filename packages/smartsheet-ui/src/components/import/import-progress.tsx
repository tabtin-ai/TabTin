/**
 * 导入进度组件（导入步骤3）
 *
 * 功能：
 * - 显示导入进度条
 * - 显示导入统计信息（成功/跳过/失败）
 * - 按错误类型分组展示结构化错误
 * - 向后兼容旧版 string[] 错误格式
 */

import React, { useState, useMemo } from 'react'
import { CheckCircle2, XCircle, AlertTriangle, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '../../utils/cn'
import { ScrollArea } from '../scroll-area'
import { t, getSmartsheetUiLocale } from "../../i18n"
import type { ImportErrorType, ClassifiedImportError, ImportErrorSummary } from '@tabtin/table-core'

export type ImportStatus = 'idle' | 'importing' | 'success' | 'error'

export interface ImportResult {
  created_count: number
  updated_count: number
  skipped_count?: number
  error_summary?: ImportErrorSummary
  errors: ClassifiedImportError[] | string[]
}

export interface ImportProgressProps {
  status: ImportStatus
  progress: number
  result?: ImportResult
  error?: string
  totalRows?: number
  processedRows?: number
}

/** 成功/失败态只要有结构化 result，就展示统计与错误明细 */
export function shouldShowImportResultDetails(
  status: ImportStatus,
  result?: ImportResult | null,
): boolean {
  return result != null && (status === 'success' || status === 'error')
}

/** 仅在无结构化 result 的硬失败（网络/500）时展示单句红框 */
export function shouldShowImportFatalErrorBox(
  status: ImportStatus,
  error?: string | null,
  result?: ImportResult | null,
): boolean {
  return status === 'error' && Boolean(error) && result == null
}

const ERROR_TYPE_LABELS: Record<ImportErrorType, { zh: string; en: string }> = {
  type_mismatch: { zh: '类型不匹配', en: 'Type mismatch' },
  null_violation: { zh: '非空约束', en: 'Null violation' },
  unique_violation: { zh: '唯一约束', en: 'Unique violation' },
  format_error: { zh: '格式错误', en: 'Format error' },
  column_mismatch: { zh: '列不匹配', en: 'Column mismatch' },
  validation_error: { zh: '验证失败', en: 'Validation error' },
  row_limit: { zh: '行数限制', en: 'Row limit' },
  field_limit: { zh: '字段限制', en: 'Field limit' },
  table_not_found: { zh: '表不存在', en: 'Table not found' },
  permission_denied: { zh: '权限不足', en: 'Permission denied' },
  unknown: { zh: '未知错误', en: 'Unknown' },
}

const ERROR_TYPE_COLORS: Record<ImportErrorType, string> = {
  type_mismatch: 'bg-warning/10 text-warning',
  null_violation: 'bg-destructive text-destructive dark:bg-destructive/30 dark:text-destructive',
  unique_violation: 'bg-type-agent/10 text-type-agent',
  format_error: 'bg-warning text-warning dark:bg-warning/30 dark:text-warning',
  column_mismatch: 'bg-info text-info dark:bg-info/30 dark:text-info',
  validation_error: 'bg-type-webhook/10 text-type-webhook',
  row_limit: 'bg-muted text-muted-foreground',
  field_limit: 'bg-muted text-muted-foreground',
  table_not_found: 'bg-destructive text-destructive dark:bg-destructive/30 dark:text-destructive',
  permission_denied: 'bg-destructive text-destructive dark:bg-destructive/30 dark:text-destructive',
  unknown: 'bg-muted text-muted-foreground',
}

function isClassifiedError(err: unknown): err is ClassifiedImportError {
  if (typeof err !== 'object' || err === null) return false
  const o = err as Record<string, unknown>
  return typeof o.type === 'string' && typeof o.message === 'string'
}

function getErrorTypeLabel(type: ImportErrorType): string {
  const locale = getSmartsheetUiLocale()
  const labels = ERROR_TYPE_LABELS[type] ?? ERROR_TYPE_LABELS.unknown
  return locale === 'zh-CN' ? labels.zh : labels.en
}

/**
 * 错误分组折叠面板
 */
const ERROR_GROUP_PAGE_SIZE = 20

const ErrorGroup: React.FC<{
  type: ImportErrorType
  errors: ClassifiedImportError[]
  defaultOpen?: boolean
}> = ({ type, errors, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen)
  const [showAll, setShowAll] = useState(false)

  const visibleErrors = showAll ? errors : errors.slice(0, ERROR_GROUP_PAGE_SIZE)
  const hasMore = errors.length > ERROR_GROUP_PAGE_SIZE

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center justify-between w-full px-3 py-2 text-body font-medium text-foreground bg-muted/40 hover:bg-muted/60 transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        <span className="flex items-center gap-2">
          {open
            ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
            : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
          {getErrorTypeLabel(type)}
        </span>
        <span className={cn(
          'inline-flex items-center px-1.5 py-0.5 rounded text-body font-medium',
          ERROR_TYPE_COLORS[type],
        )}>
          {errors.length}
        </span>
      </button>

      {open && (
        <div className="divide-y divide-border/40">
          {visibleErrors.map((err, idx) => (
            <div key={`${err.type}-${err.row ?? 'x'}-${idx}`} className="px-3 py-2 text-body text-muted-foreground">
              {err.row != null && (
                <span className="font-medium text-foreground mr-1">
                  {t('importProgress.errors.row', { row: err.row })}
                </span>
              )}
              {err.field_name && (
                <span className="text-foreground mr-1">
                  {t('importProgress.errors.field', { field: err.field_name })}
                </span>
              )}
              <span>{err.message}</span>
            </div>
          ))}
          {hasMore && !showAll && (
            <button
              type="button"
              className="w-full px-3 py-2 text-body text-primary hover:text-primary/80 hover:bg-muted/30 transition-colors text-center"
              onClick={() => setShowAll(true)}
            >
              {t('importProgress.errors.showAll', { count: errors.length })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export const ImportProgress: React.FC<ImportProgressProps> = ({
  status,
  progress,
  result,
  error,
  totalRows,
  processedRows,
}) => {
  const hasClassifiedErrors = useMemo(() => {
    if (!result?.errors?.length) return false
    return result.errors.some(isClassifiedError)
  }, [result])

  const groupedErrors = useMemo(() => {
    if (!result || !hasClassifiedErrors) return null
    const errors = result.errors.filter(isClassifiedError) as ClassifiedImportError[]
    if (!errors.length) return null
    const groups = new Map<ImportErrorType, ClassifiedImportError[]>()
    for (const err of errors) {
      const list = groups.get(err.type)
      if (list) list.push(err)
      else groups.set(err.type, [err])
    }
    return groups
  }, [result, hasClassifiedErrors])

  const unclassifiedErrors = useMemo(() => {
    if (!result?.errors?.length || !hasClassifiedErrors) return []
    return result.errors.filter(e => !isClassifiedError(e)) as string[]
  }, [result, hasClassifiedErrors])

  const getStatusIcon = () => {
    switch (status) {
      case 'importing':
        return <Loader2 className="w-12 h-12 text-primary animate-spin" />
      case 'success':
        return <CheckCircle2 className="w-12 h-12 text-success" />
      case 'error':
        return <XCircle className="w-12 h-12 text-destructive" />
      default:
        return null
    }
  }

  const getStatusText = () => {
    switch (status) {
      case 'importing':
        return t('importProgress.status.importing')
      case 'success':
        return t('importProgress.status.success')
      case 'error':
        return t('importProgress.status.error')
      default:
        return t('importProgress.status.idle')
    }
  }

  const getStatusDescription = () => {
    if (status === 'importing') {
      if (totalRows && processedRows !== undefined) {
        return t('importProgress.description.processed', { processed: processedRows, total: totalRows })
      }
      return t('importProgress.description.processing')
    }

    if (status === 'success' && result) {
      const total = result.created_count + result.updated_count
      const parts = []
      if (result.created_count > 0) {
        parts.push(t('importProgress.summary.created', { count: result.created_count }))
      }
      if (result.updated_count > 0) {
        parts.push(t('importProgress.summary.updated', { count: result.updated_count }))
      }
      const separator = t('importProgress.summary.separator')
      const details = parts.length > 0 ? t('importProgress.summary.detailsWrapper', { details: parts.join(separator) }) : ''
      return t('importProgress.summary.success', { total, details })
    }

    if (status === 'error') {
      if (result) {
        return t('importProgress.description.noRecordsWritten')
      }
      return error || t('importProgress.description.error')
    }

    return ''
  }

  const successCount = result ? result.created_count + result.updated_count : 0
  const skippedCount = result?.skipped_count ?? 0
  const failedCount = result ? result.errors.length : 0
  const showResultDetails = shouldShowImportResultDetails(status, result)
  const showFatalErrorBox = shouldShowImportFatalErrorBox(status, error, result)

  return (
    <div className="space-y-6">
      {/* 状态图标和文字 */}
      <div className="flex flex-col items-center justify-center py-8 space-y-4">
        {getStatusIcon()}

        <div className="text-center space-y-2">
          <h3 className="text-title font-semibold text-foreground">
            {getStatusText()}
          </h3>
          <p className="text-body text-muted-foreground max-w-md">
            {getStatusDescription()}
          </p>
        </div>
      </div>

      {/* 进度条 */}
      {(status === 'importing' || status === 'success') && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-body">
            <span className="text-muted-foreground">{t('importProgress.progress')}</span>
            <span className="font-medium text-foreground">
              {Math.round(progress)}%
            </span>
          </div>

          <div className="relative h-2 w-full overflow-hidden rounded-full bg-accent">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300 ease-in-out',
                status === 'success'
                  ? 'bg-success'
                  : 'bg-primary'
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* 统计摘要卡片：成功与失败态都展示，避免失败时只剩一句红字 */}
      {result && showResultDetails && (
        <div className="grid grid-cols-3 gap-4">
          <div className="flex flex-col items-center p-4 rounded-lg bg-success/10 border border-success/20">
            <p className="text-heading font-bold text-success">{successCount}</p>
            <p className="text-body text-success mt-1">{t('importProgress.stats.success')}</p>
          </div>

          <div className="flex flex-col items-center p-4 rounded-lg bg-warning/10 border border-warning/20">
            <p className="text-heading font-bold text-warning">{skippedCount}</p>
            <p className="text-body text-warning mt-1">{t('importProgress.stats.skipped')}</p>
          </div>

          <div className="flex flex-col items-center p-4 rounded-lg bg-destructive/10 border border-destructive/20">
            <p className="text-heading font-bold text-destructive">{failedCount}</p>
            <p className="text-body text-destructive mt-1">{t('importProgress.stats.failed')}</p>
          </div>
        </div>
      )}

      {/* 错误汇总条（基于 error_summary） */}
      {result && showResultDetails && result.error_summary && Object.keys(result.error_summary).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(Object.entries(result.error_summary) as [ImportErrorType, number][]).map(
            ([type, count]) => (
              <span
                key={type}
                className={cn(
                  'inline-flex items-center px-2 py-1 rounded-md text-body font-medium',
                  ERROR_TYPE_COLORS[type] ?? ERROR_TYPE_COLORS.unknown,
                )}
              >
                {getErrorTypeLabel(type)} ×{count}
              </span>
            ),
          )}
        </div>
      )}

      {/* 结构化错误分组展示 */}
      {result && showResultDetails && hasClassifiedErrors && groupedErrors && groupedErrors.size > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <h4 className="text-body font-semibold text-foreground">
              {t('importProgress.errors.title', { count: result.errors.length })}
            </h4>
          </div>

          <ScrollArea className="max-h-[280px]">
            <div className="space-y-2 pr-2">
              {Array.from(groupedErrors.entries()).map(([type, errors], idx) => (
                <ErrorGroup
                  key={type}
                  type={type}
                  errors={errors}
                  defaultOpen={idx === 0}
                />
              ))}
            </div>
          </ScrollArea>

          <p className="text-body text-muted-foreground text-center">
            {status === 'error'
              ? t('importProgress.errors.abortHint')
              : t('importProgress.errors.note')}
          </p>
        </div>
      )}

      {/* 未分类错误（混合列表中的字符串错误） */}
      {result && showResultDetails && unclassifiedErrors.length > 0 && (
        <ScrollArea className="max-h-[120px] rounded-lg border border-muted/30 bg-muted/10">
          <div className="space-y-1 p-3">
            {unclassifiedErrors.map((errMsg, index) => (
              <div key={`unclassified-${index}`} className="flex items-start gap-2 text-body">
                <span className="font-medium text-muted-foreground shrink-0 mt-0.5">•</span>
                <span className="text-muted-foreground">{String(errMsg)}</span>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      {/* 旧格式错误列表（向后兼容 string[]） */}
      {result && showResultDetails && !hasClassifiedErrors && result.errors.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <h4 className="text-body font-semibold text-foreground">
              {t('importProgress.errors.title', { count: result.errors.length })}
            </h4>
          </div>

          <ScrollArea className="max-h-[200px] rounded-lg border border-warning/20 bg-warning/10">
            <div className="space-y-2 p-3">
              {(result.errors as string[]).map((errMsg, index) => (
                <div key={index} className="flex items-start gap-2 text-body">
                  <span className="font-medium text-warning shrink-0 mt-0.5">•</span>
                  <span className="text-warning">{errMsg}</span>
                </div>
              ))}
            </div>
          </ScrollArea>

          <p className="text-body text-muted-foreground text-center">
            {status === 'error'
              ? t('importProgress.errors.abortHint')
              : t('importProgress.errors.note')}
          </p>
        </div>
      )}

      {/* 致命错误信息（无结构化 result 时，如网络/500） */}
      {showFatalErrorBox && (
        <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20">
          <div className="flex items-start gap-2">
            <XCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 space-y-1">
              <p className="text-body font-medium text-destructive">
                {t('importProgress.status.error')}
              </p>
              <p className="text-body text-destructive/80">
                {error}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
