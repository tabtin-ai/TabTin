/**
 * AppVaultDetail —— 应用凭据 vault 的右侧详情面板。
 */

import React, { useState } from 'react'
import { Eye, Loader2, Pencil, Smartphone, Trash2 } from 'lucide-react'
import { Button, ConfirmDialog, toast } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/services/apiClient'
import { credentialKeys, type AppCredentialItem } from '@/hooks/queries/credentials'
import { VaultDetail, VaultDetailField, VaultDetailFieldGroup } from '../vault'
import { AppCredentialFormDialog } from './AppCredentialFormDialog'
import { RevealCredentialDialog } from '../credentials/RevealCredentialDialog'
import type { AppVaultRow } from './useAppVaultRows'

interface AppVaultDetailProps {
  row: AppVaultRow | null
  onAfterDelete: () => void
}

export const AppVaultDetail: React.FC<AppVaultDetailProps> = ({ row, onAfterDelete }) => {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [editTarget, setEditTarget] = useState<AppCredentialItem | null>(null)
  const [revealOpen, setRevealOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const raw = row?.raw

  const handleDelete = async () => {
    if (!raw) return
    setBusy(true)
    try {
      await apiClient.delete(`/credential-vault/${raw.id}`)
      void queryClient.invalidateQueries({ queryKey: credentialKeys.appCredentials() })
      toast({ title: t('credentialVault.appCredentials.deleted') })
      onAfterDelete()
    } catch (e: any) {
      toast({ title: t('credentialVault.appCredentials.deleteFailed'), description: e?.message, variant: 'destructive' })
    } finally {
      setBusy(false)
      setConfirmDelete(false)
    }
  }

  return (
    <VaultDetail row={row} kindLabel={t('credentialVault.detail.appKind', { defaultValue: '应用账号' })}>
      {raw && (
        <>
          <VaultDetailFieldGroup>
            <VaultDetailField label={t('credentialVault.appCredentials.appName')} value={raw.app_name || raw.app_package} />
            <VaultDetailField label={t('credentialVault.appCredentials.appPackage')} value={raw.app_package} valueClassName="font-mono" />
            <VaultDetailField label={t('credentialVault.appCredentials.username')} value={raw.username || '—'} />
            <VaultDetailField
              label={t('credentialVault.appCredentials.password')}
              value={raw.masked_password || '••••••••'}
              valueClassName="font-mono"
              action={
                <button
                  type="button"
                  onClick={() => setRevealOpen(true)}
                  className="text-muted-foreground/60 hover:text-foreground transition-colors"
                  aria-label={t('credentialVault.appCredentials.revealTitle')}
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              }
            />
          </VaultDetailFieldGroup>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setEditTarget(raw)} disabled={busy}>
              <Pencil className="h-3.5 w-3.5" />
              {t('credentialVault.detail.edit', { defaultValue: '编辑' })}
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

      <AppCredentialFormDialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)} item={editTarget ?? undefined} />
      <RevealCredentialDialog
        open={revealOpen}
        onOpenChange={setRevealOpen}
        itemId={raw?.id ?? null}
        itemLabel={raw?.display_name || raw?.app_name || raw?.app_package || ''}
        apiPath="/credential-vault"
        titleKey="credentialVault.appCredentials.revealTitle"
        descriptionKey="credentialVault.appCredentials.revealDescription"
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('credentialVault.appCredentials.deleteTitle')}
        description={
          raw
            ? t('credentialVault.appCredentials.deleteDescription', {
                name: raw.display_name || raw.app_name || raw.app_package,
              })
            : ''
        }
        confirmText={t('credentialVault.appCredentials.deleteTitle')}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </VaultDetail>
  )
}
