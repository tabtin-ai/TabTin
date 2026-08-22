/**
 * AiServiceVaultDetail —— AI 服务 vault 的右侧详情面板。
 */

import React, { useState } from 'react'
import { CheckCircle2, CircleSlash, Eye, KeyRound, Loader2, Pencil, Trash2 } from 'lucide-react'
import { Button, ConfirmDialog, toast } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/services/apiClient'
import { credentialKeys, type CredentialItem } from '@/hooks/queries/credentials'
import { formatDate } from '@/utils/i18n/format'
import { VaultDetail, VaultDetailField, VaultDetailFieldGroup } from '../vault'
import { AiServiceFormDialog } from './AiServiceFormDialog'
import { RevealCredentialDialog } from '../credentials/RevealCredentialDialog'
import { getFieldMeta, SERVICE_PRESETS } from '../credentials/constants'
import type { AiServiceVaultRow } from './useAiServiceVaultRows'

interface AiServiceVaultDetailProps {
  row: AiServiceVaultRow | null
  onAfterDelete: () => void
}

export const AiServiceVaultDetail: React.FC<AiServiceVaultDetailProps> = ({ row, onAfterDelete }) => {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [editTarget, setEditTarget] = useState<CredentialItem | null>(null)
  const [revealOpen, setRevealOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const raw = row?.raw
  const presetMeta = raw ? SERVICE_PRESETS.find((p) => p.value === raw.service_name) : null
  const kindLabel = raw
    ? `${presetMeta?.label ?? raw.service_name} · ${t('credentialVault.detail.aiKind', { defaultValue: 'API Key' })}`
    : undefined

  const handleToggleActive = async () => {
    if (!raw) return
    setBusy(true)
    try {
      await apiClient.put(`/credential-vault/${raw.id}`, { is_active: !raw.is_active })
      void queryClient.invalidateQueries({ queryKey: credentialKeys.all })
    } catch {
      toast({ title: t('credentialVault.serviceKeys.operationFailed'), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!raw) return
    setBusy(true)
    try {
      await apiClient.delete(`/credential-vault/${raw.id}`)
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
      toast({ title: t('credentialVault.serviceKeys.deleted') })
      onAfterDelete()
    } catch (e: any) {
      toast({ title: t('credentialVault.serviceKeys.deleteFailed'), description: e?.message, variant: 'destructive' })
    } finally {
      setBusy(false)
      setConfirmDelete(false)
    }
  }

  const formatTime = (iso?: string | null) => {
    if (!iso) return '—'
    try {
      return formatDate(iso, { year: 'numeric', month: 'long', day: 'numeric' })
    } catch {
      return iso
    }
  }

  return (
    <VaultDetail row={row} kindLabel={kindLabel}>
      {raw && (
        <>
          <VaultDetailFieldGroup>
            <VaultDetailField
              label={t('credentialVault.detail.service', { defaultValue: '服务' })}
              value={presetMeta?.label || raw.service_name}
            />
            {Object.entries(raw.masked_data || {}).map(([field, masked]) => {
              const meta = getFieldMeta(field)
              return (
                <VaultDetailField
                  key={field}
                  label={t(meta.labelKey)}
                  value={masked || '••••••••'}
                  valueClassName="font-mono"
                  action={
                    meta.isSecret ? (
                      <button
                        type="button"
                        onClick={() => setRevealOpen(true)}
                        className="text-muted-foreground/60 hover:text-foreground transition-colors"
                        aria-label={t('credentialVault.serviceKeys.revealTitle')}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                    ) : null
                  }
                />
              )
            })}
            <VaultDetailField
              label={t('credentialVault.detail.status', { defaultValue: '状态' })}
              value={
                <span className="inline-flex items-center gap-1.5">
                  {raw.is_active ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                      <span>{t('credentialVault.serviceKeys.active', { defaultValue: '已启用' })}</span>
                    </>
                  ) : (
                    <>
                      <CircleSlash className="h-3.5 w-3.5 text-muted-foreground/60" />
                      <span>{t('credentialVault.serviceKeys.disabled', { defaultValue: '已禁用' })}</span>
                    </>
                  )}
                </span>
              }
            />
            {raw.created_at && (
              <VaultDetailField
                label={t('credentialVault.detail.createdAt', { defaultValue: '创建时间' })}
                value={formatTime(raw.created_at)}
              />
            )}
          </VaultDetailFieldGroup>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setEditTarget(raw)} disabled={busy}>
              <Pencil className="h-3.5 w-3.5" />
              {t('credentialVault.detail.edit', { defaultValue: '编辑' })}
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={handleToggleActive} disabled={busy}>
              {raw.is_active ? <CircleSlash className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {raw.is_active
                ? t('credentialVault.detail.disable', { defaultValue: '禁用' })
                : t('credentialVault.detail.enable', { defaultValue: '启用' })}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-destructive hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {t('credentialVault.detail.delete', { defaultValue: '删除' })}
            </Button>
          </div>
        </>
      )}

      <AiServiceFormDialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)} item={editTarget ?? undefined} />
      <RevealCredentialDialog
        open={revealOpen}
        onOpenChange={setRevealOpen}
        itemId={raw?.id ?? null}
        itemLabel={raw?.display_name || raw?.service_name || ''}
        apiPath="/credential-vault"
        titleKey="credentialVault.serviceKeys.revealTitle"
        descriptionKey="credentialVault.serviceKeys.revealDescription"
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('credentialVault.serviceKeys.deleteTitle')}
        description={
          raw
            ? t('credentialVault.serviceKeys.deleteDescription', {
                name: raw.display_name || raw.service_name,
              })
            : ''
        }
        confirmText={t('credentialVault.serviceKeys.deleteTitle')}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </VaultDetail>
  )
}
