/**
 * 共享的 Webhook 创建/编辑弹窗。
 * 供 OrganizationExtensionsPanel 使用，后续也可供其他面板复用。
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
import type {
  WebhookSubscription,
  CreateWebhookPayload,
  UpdateWebhookPayload,
} from '@/services/extensionApi'

export interface WebhookDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  existing: WebhookSubscription | null
  allEventTypes: Array<{ event_type: string; description: string }>
  organizationId: string
  onSaved: () => void
}

export const WebhookDialog: React.FC<WebhookDialogProps> = ({
  open,
  onOpenChange,
  existing,
  allEventTypes,
  organizationId,
  onSaved,
}) => {
  const { t } = useTranslation(['settings', 'common'])
  const addWebhook = useExtensionStore((s) => s.addWebhook)
  const editWebhook = useExtensionStore((s) => s.editWebhook)
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [maxRetries, setMaxRetries] = useState(3)
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const isEditing = !!existing

  useEffect(() => {
    if (open) {
      setUrl(existing?.url ?? '')
      setSecret('')
      setMaxRetries(existing?.max_retries ?? 3)
      setSelectedEvents(new Set(existing?.event_types ?? []))
      setFormError('')
      setSaving(false)
    }
  }, [open, existing])

  const toggleEvent = (evt: string) => {
    setSelectedEvents((prev) => {
      const next = new Set(prev)
      if (next.has(evt)) next.delete(evt)
      else next.add(evt)
      return next
    })
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimUrl = url.trim()
    if (!trimUrl) { setFormError(t('extensions.urlRequired', { ns: 'settings' })); return }
    try {
      const parsed = new URL(trimUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        setFormError(t('extensions.urlMustBeHttp', { ns: 'settings' })); return
      }
    } catch { setFormError(t('extensions.urlInvalid', { ns: 'settings' })); return }

    setSaving(true)
    setFormError('')
    try {
      const eventTypes = Array.from(selectedEvents)
      if (isEditing) {
        const payload: UpdateWebhookPayload = {
          url: trimUrl,
          event_types: eventTypes,
          max_retries: maxRetries,
        }
        if (secret.trim()) payload.secret = secret.trim()
        await editWebhook(organizationId, existing!.id, payload)
      } else {
        const payload: CreateWebhookPayload = {
          url: trimUrl,
          event_types: eventTypes,
          max_retries: maxRetries,
        }
        if (secret.trim()) payload.secret = secret.trim()
        await addWebhook(organizationId, payload)
      }
      onOpenChange(false)
      onSaved()
      toast({ title: t('extensions.webhookSaveSuccess', { ns: 'settings', defaultValue: 'Webhook saved' }) })
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('extensions.saveWebhookFailed', { ns: 'settings' }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="text-body font-medium">
          {isEditing
            ? t('extensions.editWebhook', { ns: 'settings' })
            : t('extensions.addWebhook', { ns: 'settings' })
          }
        </DialogTitle>
        <DialogDescription className="text-caption text-muted-foreground/60">
          {t('extensions.webhookDialogDesc', { ns: 'settings' })}
        </DialogDescription>
        <form onSubmit={handleSave} className="space-y-3 mt-2">
          <div className="space-y-1">
            <label className="text-caption text-muted-foreground" htmlFor="webhook-url">
              {t('extensions.urlLabel', { ns: 'settings' })} <span className="text-destructive/80">*</span>
            </label>
            <Input
              id="webhook-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/webhook"
              className="h-8 text-body"
            />
          </div>

          <div className="space-y-1">
            <label className="text-caption text-muted-foreground" htmlFor="webhook-secret">
              {t('extensions.secretLabel', { ns: 'settings' })} {isEditing && <span className="text-caption text-muted-foreground/60">({t('extensions.secretKeepHint', { ns: 'settings' })})</span>}
            </label>
            <Input
              id="webhook-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={t('extensions.secretPlaceholder', { ns: 'settings' })}
              className="h-8 text-body"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="webhook-max-retries" className="text-caption text-muted-foreground">{t('extensions.maxRetries', { ns: 'settings' })}</label>
            <Input
              id="webhook-max-retries"
              type="number"
              min={0}
              max={10}
              value={maxRetries}
              onChange={(e) => setMaxRetries(Math.max(0, Math.min(10, Math.round(Number(e.target.value) || 0))))}
              className="h-8 text-body w-20"
            />
          </div>

          {allEventTypes.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-caption text-muted-foreground">
                {t('extensions.eventTypes', { ns: 'settings' })}
                <span className="text-caption text-muted-foreground/60 ml-1">
                  ({selectedEvents.size === 0
                    ? t('extensions.allEvents', { ns: 'settings' })
                    : t('extensions.selectedCount', { ns: 'settings', count: selectedEvents.size })})
                </span>
              </label>
              <div className="max-h-40 overflow-y-auto rounded-md border border-border/40 p-2 space-y-1">
                {allEventTypes.map((evt) => (
                  <label key={evt.event_type} className="flex items-start gap-2 cursor-pointer py-0.5">
                    <input
                      type="checkbox"
                      checked={selectedEvents.has(evt.event_type)}
                      onChange={() => toggleEvent(evt.event_type)}
                      className="mt-0.5 rounded border-input"
                    />
                    <div className="min-w-0">
                      <span className="text-caption font-mono">{evt.event_type}</span>
                      {evt.description && (
                        <p className="text-caption text-muted-foreground/60">{evt.description}</p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {formError && <p className="text-caption text-destructive">{formError}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={saving || !url.trim()}>
              {saving ? t('common:saving') : t('common:save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
