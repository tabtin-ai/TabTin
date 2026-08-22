/**
 * 共享的 Extension 连接配置弹窗。
 * 供 OrganizationExtensionsPanel / AgentExtensionsPanel 共同使用。
 */
import React, { useEffect, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  toast,
} from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useExtensionStore } from '@stores/useExtensionStore'
import type { ExtensionManifest, ExtensionConnection } from '@/services/extensionApi'

// ── JSON Schema types ───────────────────────────────────────────────

interface SchemaProperty {
  type?: string
  title?: string
  description?: string
  default?: unknown
  enum?: string[]
  'x-field-type'?: string
}

interface ConfigSchema {
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

// ── Schema → dynamic form ───────────────────────────────────────────

const ConfigSchemaForm: React.FC<{
  schema: ConfigSchema
  values: Record<string, unknown>
  maskedValues?: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
}> = ({ schema, values, maskedValues, onChange }) => {
  const { t } = useTranslation('settings')
  const props = schema.properties ?? {}
  const required = new Set(schema.required ?? [])

  if (Object.keys(props).length === 0) {
    return <p className="text-caption text-muted-foreground/60 py-1">{t('extensions.noConfigRequired')}</p>
  }

  return (
    <div className="space-y-3">
      {Object.entries(props).map(([key, prop]) => {
        const fieldType = prop['x-field-type'] ?? 'string'
        const isPassword = fieldType === 'password'
        const maskedVal = maskedValues?.[key]
        const hasExistingValue = maskedVal != null && maskedVal !== ''

        if (prop.type === 'boolean') {
          return (
            <label key={key} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={values[key] !== undefined ? !!values[key] : (hasExistingValue ? !!maskedVal : false)}
                onChange={(e) => onChange({ ...values, [key]: e.target.checked })}
                className="rounded border-input"
              />
              <span className="text-caption">{prop.title ?? key}</span>
              {required.has(key) && <span className="text-destructive/80 text-caption">*</span>}
            </label>
          )
        }

        if (prop.enum && prop.enum.length > 0) {
          const selectId = `config-field-${key}`
          return (
            <div key={key} className="space-y-1">
              <label htmlFor={selectId} className="text-caption text-muted-foreground">
                {prop.title ?? key}
                {required.has(key) && <span className="text-destructive/80 ml-0.5">*</span>}
              </label>
              <select
                id={selectId}
                value={String(values[key] ?? prop.default ?? '')}
                onChange={(e) => onChange({ ...values, [key]: e.target.value })}
                className="w-full h-8 rounded-md border border-input bg-background px-2 text-body"
              >
                <option value="">--</option>
                {prop.enum.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              {prop.description && <p className="text-caption text-muted-foreground/60">{prop.description}</p>}
            </div>
          )
        }

        const placeholder = hasExistingValue
          ? String(maskedVal)
          : (prop.default != null ? String(prop.default) : undefined)

        const inputId = `config-field-${key}`
        return (
          <div key={key} className="space-y-1">
            <label htmlFor={inputId} className="text-caption text-muted-foreground">
              {prop.title ?? key}
              {required.has(key) && <span className="text-destructive/80 ml-0.5">*</span>}
              {hasExistingValue && (
                <span className="text-caption text-success ml-1.5">{t('extensions.configured')}</span>
              )}
            </label>
            <Input
              id={inputId}
              type={isPassword ? 'password' : fieldType === 'url' ? 'url' : 'text'}
              value={String(values[key] ?? '')}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
              placeholder={placeholder}
              className="h-8 text-body"
            />
            {prop.description && <p className="text-caption text-muted-foreground/60">{prop.description}</p>}
          </div>
        )
      })}
    </div>
  )
}

// ── Dialog ───────────────────────────────────────────────────────────

export interface ConnectionConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  extension: ExtensionManifest | null
  existingConnection: ExtensionConnection | null
  organizationId: string
  spaceId?: string
  onSaved: () => void
}

export const ConnectionConfigDialog: React.FC<ConnectionConfigDialogProps> = ({
  open,
  onOpenChange,
  extension,
  existingConnection,
  organizationId,
  spaceId,
  onSaved,
}) => {
  const { t } = useTranslation(['settings', 'common'])
  const addConnection = useExtensionStore((s) => s.addConnection)
  const editConnection = useExtensionStore((s) => s.editConnection)
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    if (open) {
      setConfigValues({})
      setFormError('')
      setSaving(false)
    }
  }, [open])

  const schema = (extension?.config_schema ?? {}) as ConfigSchema
  const isEditing = !!existingConnection

  const maskedValues = isEditing ? (existingConnection?.config_masked ?? {}) : undefined

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!extension) return

    const required = new Set(schema.required ?? [])
    const props = schema.properties ?? {}

    if (!isEditing) {
      for (const key of required) {
        const val = configValues[key]
        if (val === undefined || val === null || val === '') {
          setFormError(t('extensions.fieldRequired', { ns: 'settings', defaultValue: '{{field}} is required', field: props[key]?.title ?? key }))
          return
        }
      }
    }

    const configToSend: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(configValues)) {
      if (val !== undefined && val !== null && val !== '') {
        configToSend[key] = val
      }
    }

    if (isEditing && Object.keys(configToSend).length === 0) {
      onOpenChange(false)
      return
    }

    setSaving(true)
    setFormError('')
    try {
      if (isEditing) {
        await editConnection(organizationId, existingConnection!.id, { config: configToSend })
      } else {
        await addConnection(organizationId, {
          extension_id: extension.id,
          name: extension.name,
          config: configToSend,
          ...(spaceId ? { space_id: spaceId } : {}),
        })
      }
      onOpenChange(false)
      onSaved()
      toast({ title: t('extensions.configSaveSuccess', { ns: 'settings', defaultValue: 'Configuration saved' }) })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('extensions.saveFailed', { ns: 'settings' }))
    } finally {
      setSaving(false)
    }
  }

  if (!extension) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="text-body font-medium flex items-center gap-2">
          <span className="text-subtitle">{extension.icon || '🧩'}</span>
          {isEditing
            ? t('extensions.editConfig', { ns: 'settings', defaultValue: 'Configure {{name}}', name: extension.name })
            : t('extensions.installConfig', { ns: 'settings', defaultValue: 'Install {{name}}', name: extension.name })
          }
        </DialogTitle>
        <DialogDescription className="text-caption text-muted-foreground/60">
          {isEditing
            ? t('extensions.editConfigDesc', { ns: 'settings', defaultValue: 'Update the credentials for this extension. Leave fields empty to keep current values.' })
            : t('extensions.installConfigDesc', { ns: 'settings', defaultValue: 'Provide the credentials to connect this extension.' })
          }
        </DialogDescription>
        <form onSubmit={handleSave} className="space-y-4 mt-2">
          <ConfigSchemaForm
            schema={schema}
            values={configValues}
            maskedValues={maskedValues}
            onChange={setConfigValues}
          />
          {formError && <p className="text-caption text-destructive">{formError}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('common:cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving
                ? t('common:saving', { defaultValue: 'Saving...' })
                : isEditing
                  ? t('common:save', { defaultValue: 'Save' })
                  : t('extensions.install', { ns: 'settings', defaultValue: 'Install' })
              }
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
