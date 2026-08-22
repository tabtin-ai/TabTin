/**
 * AiServiceFormDialog —— AI 服务密钥的创建/编辑通用 Dialog。
 *
 * 抽出自原 ServiceKeysSection，让新 vault 详情面板和 toolbar 都能用。
 */

import React, { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  toast,
} from '@components/ui'
import { cn } from '@utils/cn'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/services/apiClient'
import { credentialKeys } from '@/hooks/queries/credentials'
import { SERVICE_PRESETS, getFieldMeta, type ServicePreset } from '../credentials/constants'
import type { CredentialItem } from '../credentials/types'
import { SETTINGS_CONTROL, SETTINGS_LABEL, SETTINGS_TEXT_MICRO } from '../../settingsUi'

interface AiServiceFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item?: CredentialItem | null
  /** 创建时预选的预设 + 预填值（来自 .env 粘贴） */
  initialPreset?: string
  initialServiceName?: string
  initialDisplayName?: string
  initialFieldValues?: Record<string, string>
}

export const AiServiceFormDialog: React.FC<AiServiceFormDialogProps> = ({
  open,
  onOpenChange,
  item,
  initialPreset,
  initialServiceName,
  initialDisplayName,
  initialFieldValues,
}) => {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const mode: 'create' | 'edit' = item ? 'edit' : 'create'

  const [selectedPreset, setSelectedPreset] = useState('openai')
  const [customServiceName, setCustomServiceName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [editFieldValues, setEditFieldValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  // 重置表单
  useEffect(() => {
    if (!open) return
    if (item) {
      setSelectedPreset(item.service_name)
      setDisplayName(item.display_name)
      setEditFieldValues({})
    } else {
      setSelectedPreset(initialPreset ?? 'openai')
      setCustomServiceName(initialServiceName ?? '')
      setDisplayName(initialDisplayName ?? '')
      setFieldValues(initialFieldValues ?? {})
    }
  }, [open, item, initialPreset, initialServiceName, initialDisplayName, initialFieldValues])

  const presetOptions = useMemo<readonly ServicePreset[]>(
    () => [
      ...SERVICE_PRESETS,
      { value: 'custom', label: t('credentialVault.serviceKeys.custom'), keyFields: ['api_key'] },
    ],
    [t],
  )

  const activePresetKeyFields = useMemo<readonly string[]>(() => {
    if (selectedPreset === 'custom') return ['api_key']
    const preset = SERVICE_PRESETS.find((p) => p.value === selectedPreset)
    return preset?.keyFields ?? ['api_key']
  }, [selectedPreset])

  const handleCreate = async () => {
    const serviceName = selectedPreset === 'custom' ? customServiceName.trim() : selectedPreset
    const missingField = activePresetKeyFields.find((f) => !(fieldValues[f] || '').trim())
    if (!serviceName || missingField) {
      toast({ title: t('credentialVault.serviceKeys.fillRequired'), variant: 'destructive' })
      return
    }
    setSubmitting(true)
    try {
      const preset = SERVICE_PRESETS.find((p) => p.value === selectedPreset)
      const credentialData: Record<string, string> = {}
      for (const field of activePresetKeyFields) {
        credentialData[field] = (fieldValues[field] || '').trim()
      }
      await apiClient.post('/credential-vault/create', {
        category: 'api_key',
        service_name: serviceName,
        display_name: displayName.trim() || preset?.label || serviceName,
        credential_data: credentialData,
      })
      void queryClient.invalidateQueries({ queryKey: credentialKeys.all })
      onOpenChange(false)
      toast({ title: t('credentialVault.serviceKeys.saved') })
    } catch (error: any) {
      toast({ title: t('credentialVault.serviceKeys.saveFailed'), description: error.message, variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  const handleUpdate = async () => {
    if (!item) return
    setSubmitting(true)
    try {
      const updatePayload: Record<string, any> = {}
      if (displayName.trim() !== item.display_name) {
        updatePayload.display_name = displayName.trim()
      }
      const partial: Record<string, string> = {}
      for (const [field, value] of Object.entries(editFieldValues)) {
        if (value.trim()) partial[field] = value.trim()
      }
      if (Object.keys(partial).length > 0) updatePayload.credential_data = partial

      if (Object.keys(updatePayload).length === 0) {
        onOpenChange(false)
        return
      }

      await apiClient.put(`/credential-vault/${item.id}`, updatePayload)
      void queryClient.invalidateQueries({ queryKey: credentialKeys.all })
      try {
        await (window as unknown as {
          tabtin?: {
            agentEngine?: {
              invalidateSkillCredentialCache?: (filter?: { spaceId?: string; skillKey?: string }) => Promise<unknown>
            }
          }
        }).tabtin?.agentEngine?.invalidateSkillCredentialCache?.()
      } catch {
        /* TTL 兜底 */
      }
      onOpenChange(false)
      toast({ title: t('credentialVault.serviceKeys.updated') })
    } catch (error: any) {
      toast({ title: t('credentialVault.serviceKeys.updateFailed'), description: error.message, variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create'
              ? t('credentialVault.serviceKeys.createTitle')
              : t('credentialVault.serviceKeys.editTitle')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? t('credentialVault.serviceKeys.createDescription')
              : t('credentialVault.serviceKeys.editDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {mode === 'create' && (
            <>
              <div className="space-y-1">
                <label className={SETTINGS_LABEL}>{t('credentialVault.serviceKeys.serviceType')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {presetOptions.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => {
                        setSelectedPreset(preset.value)
                        setFieldValues({})
                      }}
                      className={cn(
                        'rounded-md border px-2.5 py-1 transition-colors', SETTINGS_TEXT_MICRO,
                        selectedPreset === preset.value
                          ? 'border-accent/30 bg-accent/10 text-accent'
                          : 'border-border/60 text-muted-foreground hover:border-accent/30',
                      )}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
              {selectedPreset === 'custom' && (
                <div className="space-y-1">
                  <label className={SETTINGS_LABEL}>{t('credentialVault.serviceKeys.serviceName')}</label>
                  <Input
                    value={customServiceName}
                    onChange={(e) => setCustomServiceName(e.target.value)}
                    placeholder={t('credentialVault.serviceKeys.serviceNamePlaceholder')}
                    className={SETTINGS_CONTROL}
                  />
                </div>
              )}
            </>
          )}
          <div className="space-y-1">
            <label className={SETTINGS_LABEL}>{t('credentialVault.serviceKeys.displayName')}</label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t('credentialVault.serviceKeys.displayNamePlaceholder')}
              className={SETTINGS_CONTROL}
            />
          </div>

          {mode === 'create'
            ? activePresetKeyFields.map((fieldName) => {
                const meta = getFieldMeta(fieldName)
                return (
                  <div key={fieldName} className="space-y-1">
                    <label className={SETTINGS_LABEL}>{t(meta.labelKey)}</label>
                    <Input
                      value={fieldValues[fieldName] || ''}
                      onChange={(e) => setFieldValues((prev) => ({ ...prev, [fieldName]: e.target.value }))}
                      placeholder={t(meta.placeholderKey)}
                      className={cn(SETTINGS_CONTROL, 'font-mono')}
                      type={meta.isSecret ? 'password' : 'text'}
                      autoComplete="off"
                      spellCheck={false}
                      data-1p-ignore="true"
                      data-lpignore="true"
                    />
                  </div>
                )
              })
            : Object.keys(item?.masked_data ?? {}).map((fieldName) => {
                const meta = getFieldMeta(fieldName)
                const maskedHint = item?.masked_data?.[fieldName]
                return (
                  <div key={fieldName} className="space-y-1">
                    <label className={SETTINGS_LABEL}>{t(meta.labelKey)}</label>
                    <Input
                      value={editFieldValues[fieldName] || ''}
                      onChange={(e) =>
                        setEditFieldValues((prev) => ({ ...prev, [fieldName]: e.target.value }))
                      }
                      placeholder={maskedHint || t(meta.placeholderKey)}
                      className={cn(SETTINGS_CONTROL, 'font-mono')}
                      type={meta.isSecret ? 'password' : 'text'}
                      autoComplete="off"
                      spellCheck={false}
                      data-1p-ignore="true"
                      data-lpignore="true"
                    />
                  </div>
                )
              })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('credentialVault.serviceKeys.cancel')}
          </Button>
          <Button onClick={mode === 'create' ? handleCreate : handleUpdate} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {mode === 'create' ? t('credentialVault.serviceKeys.save') : t('credentialVault.serviceKeys.update')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
