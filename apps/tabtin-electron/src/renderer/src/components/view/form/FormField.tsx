import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  FieldValueEditor,
  type FieldValueEditorField,
  type FieldValueEditorProps,
} from '@tabtin/smartsheet-ui'
import { isAttachmentFieldType, type FormFieldMeta } from '@tabtin/table-ui'
import type { Field } from '@tabtin/table-core'
import { FieldTypeIcon } from '@/components/field/FieldTypeIcon'
import { useUpload } from '@/hooks/useUpload'

export interface FormFieldProps {
  field: FormFieldMeta
  fieldDef?: Field
  value: unknown
  onChange: (fieldId: string, value: unknown) => void
  error?: string
  disabled?: boolean
  organizationMembers?: FieldValueEditorProps['organizationMembers']
  getFieldExtra?: (key: string) => unknown
  onLinkEdit?: (fieldId: string, fieldName: string, currentValue: unknown) => void
}

export function mergeToEditorField(
  meta: FormFieldMeta,
  def?: Field,
): FieldValueEditorField {
  const defOptions = def?.options as Record<string, unknown> | undefined

  if (
    !defOptions &&
    (meta.field_type === 'select' || meta.field_type === 'multi_select' || meta.field_type === 'link')
  ) {
    console.warn(
      `[FormField] fieldDef missing for ${meta.field_type} field "${meta.name}" (${meta.id}), options may be incomplete`,
    )
  }

  return {
    id: meta.id,
    name: meta.name,
    field_type: meta.field_type,
    description: meta.description || undefined,
    options: defOptions
      ? { ...meta.config, ...defOptions }
      : (meta.config ?? {}),
    config: meta.config,
  }
}

export const FormField: React.FC<FormFieldProps> = ({
  field,
  fieldDef,
  value,
  onChange,
  error,
  disabled = false,
  organizationMembers,
  getFieldExtra,
  onLinkEdit,
}) => {
  const handleChange = React.useCallback(
    (nextValue: unknown) => {
      onChange(field.id, nextValue)
    },
    [field.id, onChange],
  )

  const editorField = React.useMemo(
    () => mergeToEditorField(field, fieldDef),
    [field, fieldDef],
  )

  const isAttachment = isAttachmentFieldType(field.field_type)

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <FieldTypeIcon type={field.field_type} className="size-4 shrink-0" />
        <span className="text-body font-medium">{field.name}</span>
      </div>

      <FieldValueEditor
        field={editorField}
        value={value}
        onChange={handleChange}
        disabled={disabled || field.default_value?.mode === 'last_modified_time'}
        error={error}
        mode="create"
        organizationMembers={organizationMembers}
        getFieldExtra={getFieldExtra}
        onLinkEdit={onLinkEdit}
        renderAttachment={isAttachment ? (props) => <FormAttachmentUploader {...props} /> : undefined}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared field-value validation (used by FormBody/FormPreviewer)
// ---------------------------------------------------------------------------

export function validateFieldValue(
  fieldType: string,
  value: unknown,
): string | null {
  if (value === null || value === undefined || value === '') return null

  const strVal = typeof value === 'string' ? value : String(value)

  switch (fieldType) {
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(strVal))
        return 'invalidEmail'
      break
    case 'url':
      try { new URL(strVal) } catch { return 'invalidUrl' }
      break
    case 'phone':
      if (!/^[\d\s\-+().]+$/.test(strVal))
        return 'invalidPhone'
      break
    case 'number':
    case 'percent':
    case 'currency':
      if (typeof value === 'string' && value !== '' && isNaN(Number(value)))
        return 'invalidNumber'
      break
  }
  return null
}

// ---------------------------------------------------------------------------
// FormAttachmentUploader — platform-specific upload via useUpload + OSS
// ---------------------------------------------------------------------------

const FormAttachmentUploader: React.FC<{
  field: FieldValueEditorField
  value: unknown
  onChange: (value: unknown) => void
  disabled?: boolean
}> = ({ field, value, onChange, disabled }) => {
  const { t } = useTranslation('view')
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = React.useState<string | null>(null)
  const items: Array<{ file_id: string; name: string; size: number; url: string }> =
    Array.isArray(value) ? value : []

  const { upload, isUploading, progress, cancel, reset } = useUpload({
    module: 'tabdata',
    folder: 'form-attachments',
    trackInQueue: false,
  })

  const handleFileSelect = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      setUploadError(null)
      const newItems = [...items]
      const failedFiles: string[] = []

      for (const file of Array.from(files)) {
        try {
          const result = await upload(file, file.name)
          newItems.push({
            file_id: result.fileId,
            name: result.fileName,
            size: result.fileSize ?? file.size,
            url: result.accessUrl,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('abort')) break
          failedFiles.push(`${file.name}: ${msg}`)
        }
      }

      if (failedFiles.length > 0) {
        setUploadError(failedFiles.join('; '))
      }

      if (newItems.length !== items.length) onChange(newItems)
      reset()
      if (inputRef.current) inputRef.current.value = ''
    },
    [items, upload, onChange, reset],
  )

  const handleRemove = React.useCallback(
    (fileId: string) => {
      onChange(items.filter((i) => i.file_id !== fileId))
    },
    [items, onChange],
  )

  const uploadLabel = t('form.uploadAttachment', '上传附件')

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-body font-medium shadow-sm transition-colors hover:bg-accent disabled:opacity-50"
          disabled={disabled || isUploading}
          onClick={() => inputRef.current?.click()}
        >
          {isUploading ? `${Math.round(progress * 100)}%` : uploadLabel}
        </button>
        {isUploading && (
          <button
            type="button"
            className="text-body text-muted-foreground hover:text-foreground"
            onClick={cancel}
          >
            {t('form.cancelUpload', '取消')}
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      {uploadError && (
        <p className="text-caption text-destructive">{uploadError}</p>
      )}

      {items.length > 0 && (
        <div className="space-y-1.5">
          {items.map((item) => (
            <div
              key={item.file_id}
              className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-1.5 text-body"
            >
              <span className="truncate">{item.name}</span>
              {!disabled && (
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => handleRemove(item.file_id)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
