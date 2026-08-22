import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { EyeOff, GripVertical, Paperclip, ExternalLink } from 'lucide-react'
import {
  cn,
  Input,
  Switch,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@tabtin/smartsheet-ui'
import type { FormFieldMeta } from '@tabtin/table-ui'
import { FieldTypeIcon } from '@/components/field/FieldTypeIcon'

export interface FormFieldEditorProps {
  field: FormFieldMeta
  onHide?: (fieldId: string) => void
  isActive?: boolean
}

const CellEditorPreview: React.FC<{ field: FormFieldMeta; t: TFunction }> = ({ field, t }) => {
  switch (field.field_type) {
    case 'long_text':
      return <Textarea disabled placeholder={field.name} className="resize-none" rows={3} />
    case 'checkbox':
      return (
        <div className="flex items-center gap-2">
          <Switch disabled />
        </div>
      )
    case 'rating':
      return (
        <div className="flex items-center gap-1">
          {Array.from({ length: (field.config?.max as number) ?? 5 }).map((_, i) => (
            <span key={i} className="text-subtitle text-muted-foreground/40">★</span>
          ))}
        </div>
      )
    case 'attachment':
      return (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-3 text-muted-foreground/60">
          <Paperclip className="size-4 shrink-0" />
          <span className="text-caption">
            {t('form.attachmentPlaceholder', '点击或拖拽上传附件')}
          </span>
        </div>
      )
    case 'link':
      return (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-muted-foreground/60">
          <ExternalLink className="size-4 shrink-0" />
          <span className="text-caption">{t('form.linkPlaceholder', '关联记录')}</span>
        </div>
      )
    default:
      return <Input disabled placeholder={field.name} />
  }
}

export const FormFieldEditor: React.FC<FormFieldEditorProps> = ({
  field,
  onHide,
  isActive,
}) => {
  const { t } = useTranslation('view')
  const isProtected = field.protected === true

  const handleHide = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onHide?.(field.id)
    },
    [field.id, onHide],
  )

  return (
    <div
      className={cn(
        'relative w-full rounded-lg border border-border bg-background px-8 py-5',
        isActive && 'ring-2 ring-primary/30',
      )}
    >
      {/* 字段图标 + 名称 | 隐藏按钮 */}
      <div className="mb-2 flex w-full items-center justify-between">
        <div className="flex items-center overflow-hidden">
          <div className="flex h-6 shrink-0 items-center">
            <FieldTypeIcon type={field.field_type} className="size-4 shrink-0" />
          </div>
          <h3 className="mx-1 truncate text-body font-medium">{field.name}</h3>
        </div>

        <div className="flex shrink-0 items-center">
          <div
            className="flex items-center"
            onClick={(e) => e.stopPropagation()}
          >
            {isProtected ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex items-center">
                      <EyeOff className="size-6 cursor-not-allowed rounded p-1 opacity-50" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {t('form.protectedFieldTip')}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center rounded hover:bg-accent"
                        onClick={handleHide}
                        aria-label={t('form.removeFromFormTip')}
                      >
                        <EyeOff className="size-6 p-1 text-muted-foreground hover:text-foreground" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {t('form.removeFromFormTip')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 字段描述 */}
      {field.description && (
        <div className="mb-2 whitespace-pre-line text-caption text-muted-foreground">
          {field.description}
        </div>
      )}

      {/* CellEditor 只读预览 */}
      <div className="pointer-events-none">
        <CellEditorPreview field={field} t={t} />
      </div>

      {/* 拖拽手柄（仅视觉提示，不挂 listeners） */}
      <GripVertical
        className={cn(
          'absolute left-1 top-6 size-4 text-muted-foreground/60',
          'opacity-0 transition-opacity group-hover:opacity-100',
        )}
      />
    </div>
  )
}
