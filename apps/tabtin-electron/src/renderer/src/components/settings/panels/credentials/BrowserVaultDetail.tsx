/**
 * BrowserVaultDetail —— 浏览器 vault 的右侧详情面板。
 *
 * 用通用 VaultDetail 外壳 + 浏览器特有的字段表 + 警告卡 + 行动按钮。
 */

import React, { useState } from 'react'
import {
  AlertTriangle,
  Eye,
  Loader2,
  Pencil,
  Trash2,
} from 'lucide-react'
import { Button, ConfirmDialog, toast } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/services/apiClient'
import { credentialKeys, type WebsiteCredentialItem } from '@/hooks/queries/credentials'
import { formatDate } from '@/utils/i18n/format'
import { VaultDetail, VaultDetailField, VaultDetailFieldGroup } from '../vault'
import { PasswordFormDialog } from './PasswordFormDialog'
import { RevealCredentialDialog } from './RevealCredentialDialog'
import type { BrowserVaultRow } from './useBrowserVaultRows'
import { SETTINGS_TEXT_META } from '../../settingsUi'
import { cn } from '@utils/cn'

interface BrowserVaultDetailProps {
  row: BrowserVaultRow | null
  partition: string | null
  onAfterDelete: () => void
}

export const BrowserVaultDetail: React.FC<BrowserVaultDetailProps> = ({
  row,
  partition,
  onAfterDelete,
}) => {
  const { t } = useTranslation('settings')
  const raw = row?.raw
  const kindLabel = raw
    ? raw.kind === 'cookie'
      ? t('credentialVault.detail.cookieKind', { defaultValue: '浏览器 Cookie' })
      : t('credentialVault.detail.passwordKind', { defaultValue: '网站密码' })
    : undefined

  return (
    <VaultDetail row={row} kindLabel={kindLabel}>
      {row && (
        <BrowserVaultDetailBody row={row} partition={partition} onAfterDelete={onAfterDelete} />
      )}
    </VaultDetail>
  )
}

/**
 * BrowserVaultDetailBody —— 详情正文（字段表 + 警告 + 行动按钮 + 内部弹窗）。
 *
 * 不含 VaultDetail 外壳（大 favicon + 标题），因此既能嵌进右侧详情面板，
 * 也能直接塞进弹窗（单列网址列表点「编辑」时复用同一套动作）。
 */
export const BrowserVaultDetailBody: React.FC<{
  row: BrowserVaultRow
  partition: string | null
  onAfterDelete: () => void
}> = ({ row, partition, onAfterDelete }) => {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [editTarget, setEditTarget] = useState<WebsiteCredentialItem | null>(null)
  const [revealTarget, setRevealTarget] = useState<WebsiteCredentialItem | null>(null)
  const [confirmClearCookie, setConfirmClearCookie] = useState(false)
  const [confirmDeletePassword, setConfirmDeletePassword] = useState(false)
  const [busy, setBusy] = useState(false)

  const raw = row.raw

  const handleClearCookie = async () => {
    if (!partition || raw.kind !== 'cookie') return
    setBusy(true)
    try {
      const res = await window.tabtin.credentialVault.clearPartitionCookies({
        partition,
        domain: raw.displayHost,
      })
      if (res.success) {
        toast({ title: t('credentialVault.browserCookies.clearSuccess', { count: res.removed }) })
        onAfterDelete()
      }
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : String(e), variant: 'destructive' })
    } finally {
      setBusy(false)
      setConfirmClearCookie(false)
    }
  }

  const handleDeletePassword = async () => {
    if (raw.kind !== 'password') return
    setBusy(true)
    try {
      await apiClient.delete(`/credential-vault/${raw.item.id}`)
      void queryClient.invalidateQueries({ queryKey: credentialKeys.websiteCredentials() })
      toast({ title: t('credentialVault.websitePasswords.deleted') })
      onAfterDelete()
    } catch (e) {
      toast({ title: t('credentialVault.websitePasswords.deleteFailed'), description: e instanceof Error ? e.message : String(e), variant: 'destructive' })
    } finally {
      setBusy(false)
      setConfirmDeletePassword(false)
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
    <>
      <VaultDetailFieldGroup>
            {raw.kind === 'cookie' ? (
              <>
                <VaultDetailField label={t('credentialVault.detail.domain', { defaultValue: '域名' })} value={raw.displayHost} />
                <VaultDetailField
                  label={t('credentialVault.detail.cookieCount', { defaultValue: 'Cookie 数量' })}
                  value={String(raw.cookieCount)}
                />
                {raw.hasExpired && (
                  <VaultDetailField
                    label={t('credentialVault.detail.expiredCount', { defaultValue: '已过期' })}
                    value={String(raw.expiredCount)}
                    valueClassName="text-warning"
                  />
                )}
              </>
            ) : (
              <>
                <VaultDetailField label={t('credentialVault.detail.username', { defaultValue: '用户名' })} value={raw.username || '—'} />
                <VaultDetailField
                  label={t('credentialVault.detail.password', { defaultValue: '密码' })}
                  value={raw.item.masked_password || '••••••••'}
                  action={
                    <button
                      type="button"
                      onClick={() => setRevealTarget(raw.item)}
                      className="text-muted-foreground/60 hover:text-foreground transition-colors"
                      aria-label={t('credentialVault.websitePasswords.revealTitle')}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                  }
                  valueClassName="font-mono"
                />
                <VaultDetailField label={t('credentialVault.detail.site', { defaultValue: '网站' })} value={raw.item.url} />
                {raw.item.updated_at ? (
                  <VaultDetailField
                    label={t('credentialVault.detail.modifiedAt', { defaultValue: '修改时间' })}
                    value={formatTime(raw.item.updated_at)}
                  />
                ) : raw.item.created_at ? (
                  <VaultDetailField
                    label={t('credentialVault.detail.createdAt', { defaultValue: '创建时间' })}
                    value={formatTime(raw.item.created_at)}
                  />
                ) : null}
              </>
            )}
          </VaultDetailFieldGroup>

          {raw.kind === 'cookie' && raw.hasExpired && (
            <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warning mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="text-body font-medium text-foreground">
                    {t('credentialVault.detail.warnExpiredTitle', { defaultValue: '部分 Cookie 已过期' })}
                  </div>
                  <p className={cn(SETTINGS_TEXT_META, 'mt-0.5')}>
                    {t('credentialVault.detail.warnExpiredDesc', {
                      count: raw.expiredCount,
                      defaultValue: '{{count}} 个 Cookie 已过期；建议重新同步以恢复登录态。',
                    })}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-2">
            {raw.kind === 'password' ? (
              <>
                <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setEditTarget(raw.item)} disabled={busy}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t('credentialVault.detail.edit', { defaultValue: '编辑' })}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 text-destructive hover:text-destructive"
                  onClick={() => setConfirmDeletePassword(true)}
                  disabled={busy}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  {t('credentialVault.detail.deletePassword', { defaultValue: '删除密码' })}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-destructive hover:text-destructive"
                onClick={() => setConfirmClearCookie(true)}
                disabled={busy}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {t('credentialVault.detail.clearCookies', { defaultValue: '清除该网站 Cookie' })}
              </Button>
            )}
      </div>

      <PasswordFormDialog
        open={!!editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
        item={editTarget ?? undefined}
      />
      <RevealCredentialDialog
        open={!!revealTarget}
        onOpenChange={(o) => !o && setRevealTarget(null)}
        itemId={revealTarget?.id ?? null}
        itemLabel={revealTarget?.display_name || revealTarget?.url || ''}
        apiPath="/credential-vault/website"
        titleKey="credentialVault.websitePasswords.revealTitle"
        descriptionKey="credentialVault.websitePasswords.revealDescription"
      />

      <ConfirmDialog
        open={confirmClearCookie}
        onOpenChange={setConfirmClearCookie}
        title={t('credentialVault.browserCookies.clearConfirmTitle')}
        description={
          raw.kind === 'cookie'
            ? t('credentialVault.browserCookies.clearDomainDescription', { domain: raw.displayHost })
            : ''
        }
        confirmText={t('credentialVault.browserCookies.clearAll')}
        variant="destructive"
        onConfirm={handleClearCookie}
      />
      <ConfirmDialog
        open={confirmDeletePassword}
        onOpenChange={setConfirmDeletePassword}
        title={t('credentialVault.websitePasswords.deleteTitle')}
        description={
          raw.kind === 'password'
            ? t('credentialVault.websitePasswords.deleteDescription', { name: raw.item.display_name || raw.item.url })
            : ''
        }
        confirmText={t('credentialVault.websitePasswords.deleteTitle')}
        variant="destructive"
        onConfirm={handleDeletePassword}
      />
    </>
  )
}
