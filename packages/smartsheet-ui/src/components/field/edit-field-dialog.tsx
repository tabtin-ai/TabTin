/**
 * EditFieldDialog - 编辑字段侧边栏 (Sheet Panel)
 *
 * 基于 useFieldConfigForm + FieldConfigFormBody 的精简版本。
 * 所有字段配置 UI 委托给 FieldConfigFormBody，本组件仅负责 Sheet 外壳与提交逻辑。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../sheet'
import { Button } from '../button'
import { ScrollArea } from '../scroll-area'
import { useTranslation } from 'react-i18next'
import { SelectChoicesEditor } from './select-choices-editor'
import {
  useFieldConfigForm,
  type FieldType,
  type FieldLike,
  type FieldOptions,
} from '../../hooks/useFieldConfigForm'
import type { FieldDefaultValue } from '@tabtin/table-core'
import { FieldConfigFormBody } from '../field-config/FieldConfigFormBody'

export type { FieldOptions }

export interface EditFieldData {
  name: string
  description?: string
  default_value?: FieldDefaultValue | null
  options?: FieldOptions
  width?: number
  validation_rules?: Record<string, unknown>
  visibility_roles?: string[]
  field_type?: string
}

export interface EditFieldDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  field: {
    id: string
    name: string
    field_type: string
    is_primary: boolean
    default_value?: FieldDefaultValue | null
    description?: string
    options?: FieldOptions
    width?: number
    validation_rules?: Record<string, unknown>
    visibility_roles?: string[]
  } | null
  onSubmit: (data: EditFieldData) => void | false | Promise<void | false>
  isSubmitting?: boolean
  tableFields?: Array<{ id: string; name: string; field_type: string }>
  onCheckConversion?: (targetType: string) => Promise<{ can_convert: boolean; error?: string } | null>
  tableId?: string
}

export const EditFieldDialog: React.FC<EditFieldDialogProps> = ({
  open,
  onOpenChange,
  field,
  onSubmit,
  isSubmitting = false,
  tableFields,
  onCheckConversion,
  tableId,
}) => {
  const { t } = useTranslation('field')
  const form = useFieldConfigForm()
  const { handleFieldTypeChange } = form
  const [conversionError, setConversionError] = useState<string | null>(null)
  const conversionCheckVersionRef = useRef(0)

  useEffect(() => {
    conversionCheckVersionRef.current += 1
    setConversionError(null)
    if (!open || !field) return
    form.initFromField({
      name: field.name,
      description: field.description,
      field_type: field.field_type,
      default_value: field.default_value,
      options: field.options,
      width: field.width,
      validation_rules: field.validation_rules,
      visibility_roles: field.visibility_roles,
    })
  }, [open, field]) // eslint-disable-line react-hooks/exhaustive-deps

  const fieldAsLike = useMemo<FieldLike | null>(() => {
    if (!field) return null
    return {
      name: field.name,
      description: field.description,
      field_type: field.field_type,
      default_value: field.default_value,
      options: field.options,
      width: field.width,
      validation_rules: field.validation_rules,
      visibility_roles: field.visibility_roles,
    }
  }, [field])

  const handleTypeChangeWithCheck = useCallback(
    (newType: FieldType) => {
      const checkVersion = conversionCheckVersionRef.current + 1
      conversionCheckVersionRef.current = checkVersion
      handleFieldTypeChange(newType, fieldAsLike)
      setConversionError(null)
      if (onCheckConversion && field && newType !== field.field_type) {
        void onCheckConversion(newType).then((result) => {
          if (conversionCheckVersionRef.current !== checkVersion) return
          if (result && !result.can_convert) {
            setConversionError(result.error || t('editFieldDialog.conversionPreview.cannotConvert', { defaultValue: '不支持此类型转换' }))
          }
        })
      }
    },
    [field, onCheckConversion, handleFieldTypeChange, t, fieldAsLike],
  )

  const formWithOverrides = useMemo(
    () => ({ ...form, handleFieldTypeChange: handleTypeChangeWithCheck }),
    [form, handleTypeChangeWithCheck],
  )

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const errs = form.validate({
      existingFields: tableFields,
      excludeFieldId: field?.id,
    })
    if (Object.keys(errs).length > 0) return
    if (conversionError) return

    const payload = form.buildPayload(fieldAsLike)
    try {
      const result = await onSubmit(payload as EditFieldData)
      if (result !== false) {
        onOpenChange(false)
      }
    } catch (error) {
      console.error('Edit field failed:', error)
    }
  }

  if (!field) return null

  const afterTypeSelector = conversionError
    ? <p className="text-body text-destructive">{conversionError}</p>
    : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[420px] flex-col p-0 sm:max-w-[420px]">
        <SheetHeader className="shrink-0 border-b border-border/40 px-4 py-3">
          <SheetTitle className="text-body">{t('editFieldDialog.title', { defaultValue: '编辑字段' })}</SheetTitle>
          <SheetDescription className="text-body">
            {field.is_primary
              ? t('editFieldDialog.description.primary', { defaultValue: '主字段可调整名称和描述' })
              : t('editFieldDialog.description.default', { defaultValue: '修改字段属性' })}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ScrollArea className="flex-1">
            <div className="px-4 py-4">
              <FieldConfigFormBody
                {...formWithOverrides}
                mode="edit"
                currentTableId={tableId ?? ''}
                editingFieldId={field.id}
                isPrimary={field.is_primary}
                originalFieldType={field.field_type as FieldType}
                tableFields={tableFields}
                afterTypeSelector={afterTypeSelector}
                renderChoicesEditor={(choices, onChange) => (
                  <SelectChoicesEditor
                    choices={choices}
                    onChange={onChange}
                  />
                )}
              />
            </div>
          </ScrollArea>

          <SheetFooter className="shrink-0 border-t border-border/40 px-4 py-3 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {t('common.cancel', { defaultValue: '取消' })}
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? t('editFieldDialog.saving', { defaultValue: '保存中...' }) : t('common.save', { defaultValue: '保存' })}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
