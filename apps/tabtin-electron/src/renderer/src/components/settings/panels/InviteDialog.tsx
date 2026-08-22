import React, { useState } from 'react'
import { Link2, Copy, Check, UserPlus, Smartphone } from 'lucide-react'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, toast } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { InvitationApiService } from '@services/invitationApi'
import type { AssignableRole } from '@tabtin/app-shell'
import { UI_ASSIGNABLE_ROLES } from '@tabtin/app-shell'
import { cn } from '@utils/cn'
import { SETTINGS_CONTROL, SETTINGS_HINT, SETTINGS_LABEL } from '../settingsUi'
import { isBillingErrorCode, showBillingErrorToast } from '@/lib/billingErrorHandler'
import { buildPublicInviteUrl } from '@/config/api'

interface InviteDialogProps {
  organizationId: string
  onClose: () => void
  onInvited?: () => void
}

type TabType = 'phone' | 'link' | 'userId'

export const InviteDialog: React.FC<InviteDialogProps> = ({ organizationId, onClose, onInvited }) => {
  const { t } = useTranslation(['settings', 'organization', 'common'])
  const [tab, setTab] = useState<TabType>('phone')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState<AssignableRole>(UI_ASSIGNABLE_ROLES[0])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [userId, setUserId] = useState('')
  const [generatedLink, setGeneratedLink] = useState('')
  const [copied, setCopied] = useState(false)

  const handleInvitationError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    const upperMsg = msg.toUpperCase()
    for (const code of ['SEAT_QUOTA_EXCEEDED', 'QUOTA_EXCEEDED', 'BILLING_BLOCKED']) {
      if (upperMsg.includes(code) && isBillingErrorCode(code)) {
        showBillingErrorToast(code)
        return
      }
    }
    setError(msg || t('invite.sendFailed'))
  }

  const handleUserIdInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!userId.trim()) {
      setError(t('members.errors.userIdRequired', { ns: 'organization' }))
      return
    }
    setIsLoading(true)
    setError('')
    try {
      await InvitationApiService.createDirectInvitation(organizationId, userId.trim(), role)
      toast({ title: t('invite.inviteSent') })
      onInvited?.()
      onClose()
    } catch (err) {
      handleInvitationError(err)
    } finally {
      setIsLoading(false)
    }
  }

  const handlePhoneInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!phone.trim()) {
      setError(t('invite.phoneRequired'))
      return
    }
    setIsLoading(true)
    setError('')
    try {
      await InvitationApiService.createPhoneInvitation(organizationId, phone.trim(), role)
      toast({ title: t('invite.inviteSent') })
      onInvited?.()
      onClose()
    } catch (err) {
      handleInvitationError(err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCreateLink = async () => {
    setIsLoading(true)
    setError('')
    try {
      const invitation = await InvitationApiService.createLinkInvitation(organizationId, role)
      setGeneratedLink(buildPublicInviteUrl(invitation.token))
      toast({ title: t('invite.linkCreated') })
      onInvited?.()
    } catch (err) {
      handleInvitationError(err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(generatedLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('invite.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex gap-1 mb-4 bg-muted rounded-lg p-1">
          <button
            onClick={() => setTab('phone')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-md text-body whitespace-nowrap transition-colors',
              tab === 'phone' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Smartphone className="h-3.5 w-3.5" />
            {t('invite.phoneTab')}
          </button>
          <button
            onClick={() => setTab('link')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-md text-body whitespace-nowrap transition-colors',
              tab === 'link' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Link2 className="h-3.5 w-3.5" />
            {t('invite.linkTab')}
          </button>
          <button
            onClick={() => setTab('userId')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-md text-body whitespace-nowrap transition-colors',
              tab === 'userId' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <UserPlus className="h-3.5 w-3.5" />
            {t('invite.userIdTab')}
          </button>
        </div>

        {error && (
          <div className="p-2 mb-3 bg-destructive/10 border border-destructive/20 rounded-lg">
            <p className="text-body text-destructive">{error}</p>
          </div>
        )}

        <div className="mb-4">
          <label className={cn(SETTINGS_LABEL, 'mb-1 block')}>{t('invite.role')}</label>
          {UI_ASSIGNABLE_ROLES.length === 1 ? (
            <div className="px-3 py-1.5 rounded-md text-body bg-muted">
              {t(`invite.${UI_ASSIGNABLE_ROLES[0]}`)}
              <span className="text-muted-foreground/60 ml-2">{t('invite.roleFixedHint')}</span>
            </div>
          ) : (
            <div className="flex gap-2">
              {UI_ASSIGNABLE_ROLES.map((r) => (
                <button
                  key={r}
                  onClick={() => setRole(r)}
                  className={cn(
                    'flex-1 px-3 py-1.5 rounded-md text-body transition-colors',
                    role === r
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background border border-input hover:bg-accent',
                  )}
                >
                  {t(`invite.${r}`)}
                </button>
              ))}
            </div>
          )}
        </div>

        {tab === 'phone' && (
          <form onSubmit={handlePhoneInvite} className="space-y-3">
            <div>
              <label className={cn(SETTINGS_LABEL, 'mb-1 block')}>{t('invite.phoneLabel')}</label>
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={t('invite.phonePlaceholder')}
                disabled={isLoading}
                className={cn('w-full', SETTINGS_CONTROL)}
              />
              <p className={cn(SETTINGS_HINT, 'mt-1')}>{t('invite.phoneHint')}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" type="button" size="form" onClick={onClose} className="flex-1">
                {t('invite.cancel')}
              </Button>
              <Button type="submit" size="form" disabled={isLoading} className="flex-1">
                {t('invite.sendInvite')}
              </Button>
            </div>
          </form>
        )}

        {tab === 'link' && (
          <div className="space-y-3">
            {!generatedLink ? (
              <div className="flex gap-2">
                <Button variant="outline" size="form" onClick={onClose} className="flex-1">
                  {t('invite.cancel')}
                </Button>
                <Button size="form" onClick={handleCreateLink} disabled={isLoading} className="flex-1">
                  {t('invite.generateLink')}
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
                  <code className="text-body flex-1 truncate">{generatedLink}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyLink}
                    className="shrink-0"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <Button variant="outline" size="form" onClick={onClose} className="w-full">
                  {t('invite.done')}
                </Button>
              </>
            )}
          </div>
        )}

        {tab === 'userId' && (
          <form onSubmit={handleUserIdInvite} className="space-y-3">
            <div>
              <label className={cn(SETTINGS_LABEL, 'mb-1 block')}>{t('invite.userIdLabel')}</label>
              <Input
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder={t('invite.userIdPlaceholder')}
                disabled={isLoading}
                className={cn('w-full font-mono', SETTINGS_CONTROL)}
              />
              <p className={cn(SETTINGS_HINT, 'mt-1')}>{t('invite.userIdHint')}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" type="button" size="form" onClick={onClose} className="flex-1">
                {t('invite.cancel')}
              </Button>
              <Button type="submit" size="form" disabled={isLoading} className="flex-1">
                {t('invite.sendInvite')}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
