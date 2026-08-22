import React from 'react'
import { FileJson, Check, AlertCircle } from 'lucide-react'
import { cn } from '../../utils/cn'
import { InfoBanner } from '../ui/InfoBanner'
import {
  StepPanelLayout,
  FontSize,
  FontWeight,
  ButtonStyles,
  BorderRadius,
  BorderColors,
} from '../../constants/design-tokens'
import { t } from "../../i18n"

export interface SchemaField {
  name: string
  type: string
  description?: string
  selector?: string
}

export interface SchemaConfirmPanelProps {
  /** 提取的 Schema 字段列表 */
  fields: SchemaField[]
  /** 确认回调 */
  onConfirm: () => void
  /** 取消/重试回调 */
  onCancel?: () => void
  /** 是否加载中 */
  loading?: boolean
  /** 错误信息 */
  error?: string
  /** 标题 */
  title?: string
  /** 描述 */
  description?: string
  /** 自定义类名 */
  className?: string
}

/**
 * 通用 Schema 确认面板
 *
 * 展示自动提取的 Schema 结构供用户确认。
 */
export const SchemaConfirmPanel: React.FC<SchemaConfirmPanelProps> = ({
  fields,
  onConfirm,
  onCancel,
  loading = false,
  error,
  title = t('schemaConfirm.title'),
  description = t('schemaConfirm.description'),
  className,
}) => {
  return (
    <div className={cn(StepPanelLayout.container, className)}>
      {error && (
        <InfoBanner
          type="error"
          title={t('schemaConfirm.errorTitle')}
          description={error}
          className="mb-4"
        />
      )}

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className={cn(FontSize.subtitle, FontWeight.semibold)}>{title}</h3>
            <p className={cn(FontSize.body, 'text-muted-foreground')}>{description}</p>
          </div>
          <div className="text-body text-muted-foreground bg-muted px-3 py-1 rounded-full">
            {t('schemaConfirm.fieldCount', { count: fields.length })}
          </div>
        </div>

        {/* 字段列表 */}
        <div className="border border-border rounded-lg overflow-hidden bg-card">
          <div className="grid grid-cols-12 gap-4 p-3 bg-muted/50 border-b border-border text-body font-medium text-muted-foreground">
            <div className="col-span-3">{t('schemaConfirm.columns.name')}</div>
            <div className="col-span-2">{t('schemaConfirm.columns.type')}</div>
            <div className="col-span-7">{t('schemaConfirm.columns.description')}</div>
          </div>
          <div className="max-h-[300px] overflow-y-auto divide-y divide-border/50">
            {fields.map((field, index) => (
              <div key={index} className="grid grid-cols-12 gap-4 p-3 text-body hover:bg-muted/50 transition-colors">
                <div className="col-span-3 font-medium text-foreground truncate" title={field.name}>
                  {field.name}
                </div>
                <div className="col-span-2 text-muted-foreground">
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-body bg-brand-50 text-brand-700">
                    {field.type}
                  </span>
                </div>
                <div className="col-span-7 text-muted-foreground truncate" title={`${field.description || ''} ${field.selector || ''}`}>
                  {field.description || field.selector || '-'}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
          {onCancel && (
            <button
              onClick={onCancel}
              className={cn(
                'h-10 px-4 rounded-md',
                'inline-flex items-center justify-center',
                'text-body font-medium',
                ButtonStyles.ghost
              )}
            >
              {t('common.cancel')}
            </button>
          )}

          <button
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'h-10 px-6 rounded-md',
              'inline-flex items-center justify-center',
              'text-body font-semibold text-white',
              'bg-brand-600 hover:bg-brand-700 transition-colors',
              'shadow-sm',
              loading && 'opacity-70 cursor-not-allowed'
            )}
          >
            {loading ? t('common.processing') : (
              <>
                <Check className="w-4 h-4 mr-2" />
                {t('schemaConfirm.confirm')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
