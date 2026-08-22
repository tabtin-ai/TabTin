import React, { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import type { OrganizationMember } from '@tabtin/app-shell'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  StatusNotice,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { SETTINGS_CONTROL_SM, SETTINGS_HINT } from '../settingsUi'

interface OrganizationOwnershipTransferDialogProps {
  open: boolean
  organizationName: string
  currentOwnerId: string
  members: OrganizationMember[]
  isLoading: boolean
  isLoadingMembers?: boolean
  error: string
  onOpenChange: (open: boolean) => void
  onConfirm: (newOwnerUserId: string) => void
}

const getMemberName = (member: OrganizationMember): string =>
  member.user?.nickname || member.user?.username || member.user?.email || member.user?.phone || member.user_id

const getMemberSecondary = (member: OrganizationMember): string => {
  const primary = getMemberName(member)
  const secondary = member.user?.email || member.user?.phone
  return secondary && secondary !== primary ? secondary : ''
}

const getUserFacingError = (error: string, organizationLimitMessage: string): string => {
  const normalized = error.trim()
  const apiError = normalized.match(/^([A-Z][A-Z0-9_]*):\s*(.+)$/s)
  if (apiError?.[1] === 'ORGANIZATION_LIMIT_EXCEEDED' && organizationLimitMessage) {
    return organizationLimitMessage
  }
  return apiError?.[2]?.trim() || normalized
}

export const OrganizationOwnershipTransferDialog: React.FC<OrganizationOwnershipTransferDialogProps> = ({
  open,
  organizationName,
  currentOwnerId,
  members,
  isLoading,
  isLoadingMembers = false,
  error,
  onOpenChange,
  onConfirm,
}) => {
  const { t } = useTranslation(['organization', 'settings'])
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const candidates = members.filter((member) => member.user_id !== currentOwnerId && member.role !== 'owner')
  const selectedMember = candidates.find((member) => member.user_id === selectedUserId)
  const selectedMemberName = selectedMember ? getMemberName(selectedMember) : ''
  const organizationLimitMessage = selectedMemberName
    ? t('settings.danger.transferOrganizationLimitExceeded', {
        name: selectedMemberName,
        defaultValue: '{{name}} 的组织数量已达上限',
      })
    : ''
  const errorDescription = getUserFacingError(error, organizationLimitMessage)

  useEffect(() => {
    if (open) setSelectedUserId(null)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('settings.danger.transferTitle')}</DialogTitle>
        </DialogHeader>

        <p className={SETTINGS_HINT}>
          {t('settings.danger.transferDialogDesc', {
            name: organizationName,
            defaultValue: '选择接任「{{name}}」的现有成员。转让后，你将成为普通成员。',
          })}
        </p>

        {isLoadingMembers ? (
          <div className="flex items-center justify-center gap-2 py-6 text-body text-muted-foreground/60">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t('settings.danger.transferLoadingMembers', { defaultValue: '正在加载成员…' })}
          </div>
        ) : candidates.length === 0 ? (
          <div className="rounded-interactive bg-muted/20 px-3 py-4 text-center text-body text-muted-foreground/60">
            {t('settings.danger.transferNoCandidates', { defaultValue: '暂无可转让成员，请先邀请成员加入组织。' })}
          </div>
        ) : (
          <div role="radiogroup" className="max-h-64 space-y-1 overflow-y-auto">
            {candidates.map((member) => {
              const selected = selectedUserId === member.user_id
              const name = getMemberName(member)
              const secondary = getMemberSecondary(member)
              return (
                <button
                  key={member.user_id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={[name, secondary].filter(Boolean).join(' ')}
                  onClick={() => setSelectedUserId(member.user_id)}
                  disabled={isLoading}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-interactive px-3 py-2 text-left transition-colors',
                    selected
                      ? 'bg-foreground/[0.06] dark:bg-foreground/[0.08]'
                      : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
                    isLoading && 'cursor-not-allowed opacity-40',
                  )}
                >
                  <span className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                    selected ? 'border-accent bg-accent text-accent-foreground' : 'border-border',
                  )}>
                    {selected ? <Check className="h-3 w-3" aria-hidden /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-foreground">{name}</span>
                    {secondary ? (
                      <span className={cn(SETTINGS_HINT, 'block truncate')}>{secondary}</span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {errorDescription ? <StatusNotice tone="danger" size="sm" description={errorDescription} /> : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
            className={SETTINGS_CONTROL_SM}
          >
            {t('settings.actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={!selectedUserId || isLoading || isLoadingMembers}
            onClick={() => {
              if (selectedUserId) onConfirm(selectedUserId)
            }}
            className={SETTINGS_CONTROL_SM}
          >
            {isLoading
              ? t('settings.danger.transferring', { defaultValue: '转让中…' })
              : t('settings:organization.confirmTransfer', { defaultValue: '确认转让' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
