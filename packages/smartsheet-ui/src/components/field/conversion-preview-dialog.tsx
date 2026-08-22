/**
 * ConversionPreviewDialog — 字段类型转换预览确认对话框
 *
 * 纯 UI 组件，展示转换预览结果（成功率、采样对比），
 * 让用户确认后再执行不可逆的类型转换。
 */

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../dialog'
import { Button } from '../button'
import { Checkbox } from '../checkbox'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'
import type {
  ConversionPreviewItem,
  FieldConversionPreviewResponse,
  FieldConversionResponse,
} from '@tabtin/table-core'

export type ConversionPreviewData = Pick<
  FieldConversionPreviewResponse,
  'can_convert' | 'field_name' | 'from_type' | 'to_type' | 'success_rate' | 'preview' | 'error'
>

export type ConversionResultStats = Pick<
  FieldConversionResponse,
  'affected_records' | 'converted_count' | 'cleared_count' | 'forced_null_count'
>

export type { ConversionPreviewItem }

export interface ConversionPreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  preview: ConversionPreviewData | null
  isLoading?: boolean
  isConverting?: boolean
  force?: boolean
  onForceChange?: (force: boolean) => void
  onConfirm: () => void
  onCancel: () => void
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export const ConversionPreviewDialog: React.FC<ConversionPreviewDialogProps> = ({
  open,
  onOpenChange,
  preview,
  isLoading = false,
  isConverting = false,
  force = false,
  onForceChange,
  onConfirm,
  onCancel,
}) => {
  const handleCancel = () => {
    onCancel()
    onOpenChange(false)
  }

  const successRateKnown = preview?.success_rate != null
  const successRate = preview?.success_rate ?? 1
  const hasLossRisk = successRateKnown && successRate < 1
  const canConvert = preview?.can_convert !== false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('editFieldDialog.conversionPreview.title')}</DialogTitle>
          <DialogDescription>
            {preview?.field_name && preview.from_type && preview.to_type
              ? t('editFieldDialog.conversionPreview.description', {
                  fieldName: preview.field_name,
                  fromType: preview.from_type,
                  toType: preview.to_type,
                })
              : t('editFieldDialog.conversionPreview.title')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <div className="flex items-center gap-3 text-body text-muted-foreground">
                <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
                {t('editFieldDialog.conversionPreview.loadingPreview')}
              </div>
            </div>
          )}

          {!isLoading && preview && !canConvert && (
            <div className="rounded-md border border-destructive/60 bg-destructive/10 px-4 py-3 text-body text-destructive">
              {preview.error || t('editFieldDialog.conversionPreview.cannotConvert')}
            </div>
          )}

          {!isLoading && preview && canConvert && (
            <>
              {/* Success rate */}
              <div className="flex items-center justify-between rounded-md border px-4 py-3">
                <span className="text-body font-medium">
                  {t('editFieldDialog.conversionPreview.successRate')}
                </span>
                {successRateKnown ? (
                  <span
                    className={cn(
                      'text-body font-semibold tabular-nums',
                      successRate >= 1
                        ? 'text-success dark:text-success'
                        : successRate >= 0.8
                          ? 'text-warning dark:text-warning'
                          : 'text-destructive',
                    )}
                  >
                    {(successRate * 100).toFixed(1)}%
                  </span>
                ) : (
                  <span className="text-body text-muted-foreground">—</span>
                )}
              </div>

              {/* Loss warning */}
              {hasLossRisk && (
                <div className="rounded-md border border-warning/60 bg-warning px-4 py-3 text-body text-warning dark:bg-warning/30 dark:text-warning">
                  {t('editFieldDialog.conversionPreview.lossWarning')}
                </div>
              )}

              {/* Force conversion toggle */}
              {hasLossRisk && onForceChange && (
                <label className="flex items-center gap-2 text-body cursor-pointer">
                  <Checkbox
                    checked={force}
                    onCheckedChange={(checked) => onForceChange(checked === true)}
                  />
                  <span>
                    {t('editFieldDialog.conversionPreview.forceLabel', {
                      defaultValue: '强制转换（不兼容的值将被置为空）',
                    })}
                  </span>
                </label>
              )}

              {/* Preview unavailable warning */}
              {!successRateKnown && (!preview.preview || preview.preview.length === 0) && (
                <div className="rounded-md border border-warning/60 bg-warning px-4 py-3 text-body text-warning dark:bg-warning/30 dark:text-warning">
                  {t('editFieldDialog.conversionPreview.previewUnavailable', {
                    defaultValue: '无法获取转换预览，是否仍要继续？此操作不可撤销。',
                  })}
                </div>
              )}

              {/* Sample preview table */}
              {preview.preview && preview.preview.length > 0 && (
                <div className="space-y-2">
                  <span className="text-body font-medium text-muted-foreground">
                    {t('editFieldDialog.conversionPreview.samplePreview')}
                  </span>
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-body">
                      <thead>
                        <tr className="border-b bg-muted/50">
                          <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                            {t('editFieldDialog.conversionPreview.original')}
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                            {t('editFieldDialog.conversionPreview.converted')}
                          </th>
                          <th className="w-12 px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {preview.preview.slice(0, 8).map((item, idx) => (
                          <tr key={idx} className="border-b last:border-0">
                            <td className="px-3 py-1.5 font-mono text-body truncate max-w-[180px]">
                              {formatCellValue(item.original)}
                            </td>
                            <td
                              className={cn(
                                'px-3 py-1.5 font-mono text-body truncate max-w-[180px]',
                                !item.success && 'text-destructive',
                              )}
                            >
                              {formatCellValue(item.converted)}
                            </td>
                            <td className="px-3 py-1.5 text-center">
                              {item.success ? (
                                <span className="text-success dark:text-success">✓</span>
                              ) : (
                                <span className="text-destructive">✗</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancel}
            disabled={isConverting}
          >
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            variant={hasLossRisk ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={isLoading || !canConvert || isConverting}
          >
            {isConverting
              ? t('editFieldDialog.saving')
              : t('editFieldDialog.conversionPreview.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
