/**
 * CreateFieldDialog - 创建字段弹窗
 *
 * 基于 useFieldConfigForm + FieldConfigFormBody 的精简版本。
 * 所有字段配置 UI 委托给 FieldConfigFormBody，本组件仅负责 Dialog 外壳与提交逻辑。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../dialog'
import { Button } from '../button'
import { ScrollArea } from '../scroll-area'
import { useTranslation } from 'react-i18next'
import { SelectChoicesEditor } from './select-choices-editor'
import {
  useFieldConfigForm,
  type FieldType,
  type FieldOptions,
} from '../../hooks/useFieldConfigForm'
import type { FieldDefaultValue } from '@tabtin/table-core'
import { FieldConfigFormBody } from '../field-config/FieldConfigFormBody'
import type { LinkTableOption, LinkForeignMeta } from '../field-config/LinkConfigSection'

export type { FieldOptions }

export interface CreateFieldData {
  name: string
  field_type: FieldType
  default_value?: FieldDefaultValue | null
  description?: string
  options?: FieldOptions
  width?: number
  validation_rules?: Record<string, unknown>
  visibility_roles?: string[]
}

export interface CreateFieldDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: CreateFieldData) => Promise<void> | void
  isLoading?: boolean
  tableFields?: Array<{ id: string; name: string; field_type: string }>
  availableTables?: Array<{ id: string; name: string }>
  onLoadForeignMeta?: (tableId: string, fieldId?: string) => Promise<LinkForeignMeta>
  tableId?: string
}

export const CreateFieldDialog: React.FC<CreateFieldDialogProps> = ({
  open,
  onOpenChange,
  onSubmit,
  isLoading = false,
  tableFields,
  availableTables,
  onLoadForeignMeta,
  tableId,
}) => {
  const { t } = useTranslation('field')
  const form = useFieldConfigForm()
  const fieldNameInputRef = useRef<HTMLInputElement>(null)
  const submitInFlightRef = useRef(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    submitInFlightRef.current = false
    setIsSubmitting(false)
    form.initForCreate('text')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const linkTables = useMemo<LinkTableOption[] | undefined>(
    () => availableTables?.map((t) => ({ id: t.id, name: t.name })),
    [availableTables],
  )

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) return
    if (submitInFlightRef.current || isLoading) return
    onOpenChange(false)
  }

  const handleSubmit = async () => {
    if (submitInFlightRef.current || isLoading) return
    const errs = form.validate({ existingFields: tableFields })
    if (Object.keys(errs).length > 0) return
    const payload = form.buildPayload()
    submitInFlightRef.current = true
    setIsSubmitting(true)
    try {
      await onSubmit(payload as CreateFieldData)
      submitInFlightRef.current = false
      onOpenChange(false)
    } catch (error) {
      console.error('Create field failed:', error)
    } finally {
      submitInFlightRef.current = false
      setIsSubmitting(false)
    }
  }

  const pending = isLoading || isSubmitting

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[min(42rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] max-h-[90vh] overflow-hidden grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('createFieldDialog.title.step2', { defaultValue: '配置字段' })}</DialogTitle>
          <DialogDescription>{t('createFieldDialog.description.step2', { label: '', defaultValue: '配置字段详情' })}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1">
          <div className="pr-1 py-4">
            <FieldConfigFormBody
              {...form}
              mode="create"
              currentTableId={tableId ?? ''}
              tableFields={tableFields}
              linkTables={linkTables}
              onLoadForeignMeta={onLoadForeignMeta}
              fieldNameInputRef={fieldNameInputRef}
              renderChoicesEditor={(choices, onChange) => (
                <SelectChoicesEditor
                  choices={choices}
                  onChange={onChange}
                />
              )}
            />
          </div>
        </ScrollArea>

        <DialogFooter className="border-t border-border pt-4 bg-background">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
            {t('common.cancel', { defaultValue: '取消' })}
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? t('createFieldDialog.creating', { defaultValue: '创建中...' }) : t('createFieldDialog.create', { defaultValue: '创建字段' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
