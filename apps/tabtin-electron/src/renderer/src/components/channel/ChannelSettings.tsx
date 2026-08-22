import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Radio } from 'lucide-react'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, ScrollArea } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useChannelStore } from '@/stores/useChannelStore'
import { ChannelAccountCard } from './ChannelAccountCard'
import { AddChannelDialog } from './AddChannelDialog'
import { ChannelPolicyPanel } from './ChannelPolicyPanel'
import { SpaceSettingsSectionHeader } from '@components/space-settings/SpaceSettingsSectionHeader'

interface ChannelSettingsProps {
  spaceId: string
  organizationId: string
  canManage?: boolean
}

export const ChannelSettings: React.FC<ChannelSettingsProps> = ({ spaceId, organizationId, canManage = true }) => {
  const { t } = useTranslation('channel')
  const { t: tSpace } = useTranslation('space')
  const {
    accounts,
    loading,
    fetchAccounts,
    fetchRuntimeStatuses,
    createAccount,
    updateAccount,
    deleteAccount,
    getStatusForAccount,
  } = useChannelStore(useShallow((s) => ({
    accounts: s.accounts,
    loading: s.loading,
    fetchAccounts: s.fetchAccounts,
    fetchRuntimeStatuses: s.fetchRuntimeStatuses,
    createAccount: s.createAccount,
    updateAccount: s.updateAccount,
    deleteAccount: s.deleteAccount,
    getStatusForAccount: s.getStatusForAccount,
  })))
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editAccount, setEditAccount] = useState<typeof accounts[0] | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)

  const visibleAccounts = useMemo(() => (
    accounts.filter((account) => {
      const config = account.config as Record<string, unknown> | undefined
      const linkedSpaceId = (config?.default_space_id ?? config?.default_project_id) as string | undefined
      return linkedSpaceId === spaceId
    })
  ), [accounts, spaceId])
  const hiddenAccountCount = useMemo(() => (
    accounts.filter((account) => {
      const config = account.config as Record<string, unknown> | undefined
      const linkedSpaceId = (config?.default_space_id ?? config?.default_project_id) as string | undefined
      return !!linkedSpaceId && linkedSpaceId !== spaceId
    }).length
  ), [accounts, spaceId])

  useEffect(() => {
    if (organizationId) {
      fetchAccounts(organizationId)
      fetchRuntimeStatuses(organizationId)
    }
  }, [organizationId, fetchAccounts, fetchRuntimeStatuses])

  const handleToggleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      await updateAccount(id, { enabled })
    },
    [updateAccount],
  )

  const handleRequestDelete = useCallback(
    (id: string) => {
      const acct = visibleAccounts.find((a) => a.id === id)
      setDeleteTarget({ id, name: acct?.name || acct?.channel || id })
    },
    [visibleAccounts],
  )

  const handleConfirmDelete = useCallback(
    async () => {
      if (!deleteTarget) return
      await deleteAccount(deleteTarget.id, organizationId)
      setDeleteTarget(null)
    },
    [deleteTarget, deleteAccount, organizationId],
  )

  const handleEdit = useCallback(
    (id: string) => {
      const acct = visibleAccounts.find((a) => a.id === id)
      if (acct) {
        setEditAccount(acct)
        setDialogOpen(true)
      }
    },
    [visibleAccounts],
  )

  const handleEditSubmit = useCallback(
    async (channel: string, config: Record<string, string>) => {
      const name = config.name
      delete config.name
      if (editAccount) {
        await updateAccount(editAccount.id, { name: name || undefined, config })
        fetchRuntimeStatuses(organizationId)
      } else {
        await createAccount({
          channel,
          organization_id: organizationId,
          name: name || undefined,
          config,
        })
        fetchRuntimeStatuses(organizationId)
      }
    },
    [editAccount, updateAccount, createAccount, organizationId, fetchRuntimeStatuses],
  )

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
      <div className="space-y-5">
        {/* 渠道列表 */}
        <div>
          <SpaceSettingsSectionHeader
            marginBottomClassName="mb-2"
            title={tSpace('tabs.channels')}
            description={t('scopeHint')}
            actions={canManage ? (
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className="flex items-center gap-1 text-caption text-muted-foreground/60 hover:text-foreground transition-colors"
              >
                <Plus className="h-3 w-3" />
                {t('add')}
              </button>
            ) : undefined}
          />
          {hiddenAccountCount > 0 && (
            <p className="mb-2 text-caption text-muted-foreground/60">
              {t('channelsBoundElsewhere', { count: hiddenAccountCount })}
            </p>
          )}

          {visibleAccounts.length === 0 ? (
            <div className="py-6 text-center">
              <Radio className="mx-auto h-5 w-5 text-muted-foreground/30" />
              <p className="mt-2 text-body text-muted-foreground/60">
                {t('noChannelsYet')}
              </p>
              <p className="mt-0.5 text-caption text-muted-foreground/40">
                {t('noChannelsHint')}
              </p>
              {canManage && (
                <button
                  type="button"
                  onClick={() => setDialogOpen(true)}
                  className="mt-3 text-body text-accent hover:text-accent/80 transition-colors"
                >
                  {t('addFirstChannel')}
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              {visibleAccounts.map((account) => (
                <ChannelAccountCard
                  key={account.id}
                  account={account}
                  runtimeStatus={getStatusForAccount(account.channel, account.account_id)}
                  onToggleEnabled={handleToggleEnabled}
                  onDelete={handleRequestDelete}
                  onEdit={handleEdit}
                  loading={loading}
                  canManage={canManage}
                />
              ))}
            </div>
          )}
        </div>

        {visibleAccounts.map((account) => (
          <ChannelPolicyPanel
            key={`policy-${account.id}`}
            organizationId={organizationId}
            channel={account.channel}
            accountId={account.account_id}
            label={account.name || t(`channelMeta.${account.channel}`, { defaultValue: account.channel })}
            canManage={canManage}
          />
        ))}
      </div>
      </ScrollArea>

      <AddChannelDialog
        open={dialogOpen}
        onOpenChange={(open) => { if (!open) setEditAccount(null); setDialogOpen(open) }}
        onSubmit={handleEditSubmit}
        editAccount={editAccount}
        fixedSpaceId={spaceId}
        occupiedChannelIds={accounts.map((account) => account.channel)}
      />

      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('confirmDeleteTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-body text-muted-foreground">
            {t('confirmDeleteMessage', { name: deleteTarget?.name })}
          </p>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('cancel')}</Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>{t('confirmDelete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
