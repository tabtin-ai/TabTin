import React, { useState } from 'react'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { InvitationApiService, type PendingInvitation } from '@/services/invitationApi'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'
import { Building2, Shield, Users, Clock, User } from 'lucide-react'
import { InvitationNicknameField, validateInvitationNickname } from './InvitationNicknameField'
import { createLogger } from '@/utils/logger'
import { getInvitationErrorDetails } from './invitationError'

const log = createLogger('InvitationResponseDialog')

interface Props {
  invitation: PendingInvitation
  onClose: () => void
  onResponded: () => void
}

export const InvitationResponseDialog: React.FC<Props> = ({ invitation, onClose, onResponded }) => {
  const { t } = useTranslation(['workspace', 'organization', 'common'])
  const [isAccepting, setIsAccepting] = useState(false)
  const [isRejecting, setIsRejecting] = useState(false)
  const [error, setError] = useState('')
  const [accepted, setAccepted] = useState(false)
  const user = useAuthStore((state) => state.user)
  const updateProfile = useAuthStore((state) => state.updateProfile)
  const [nickname, setNickname] = useState(() => user?.nickname || '')
  const [nicknameError, setNicknameError] = useState('')
  const selectOrganization = useOrganizationStore((s) => s.selectOrganization)

  const handleRespond = async (accept: boolean) => {
    const normalizedNickname = nickname.trim()
    if (accept) {
      const validationError = validateInvitationNickname(normalizedNickname)
      if (validationError) {
        setNicknameError(t(`organization:invitation.nickname.errors.${validationError}`))
        return
      }
    }

    if (accept) {
      setIsAccepting(true)
    } else {
      setIsRejecting(true)
    }
    setError('')
    setNicknameError('')

    const nicknameChanged = accept && normalizedNickname !== (user?.nickname || '').trim()
    let stage: 'profile' | 'invitation' = nicknameChanged ? 'profile' : 'invitation'
    log.info('Invitation response started', {
      invitationId: invitation.id,
      organizationId: invitation.organization_id,
      action: accept ? 'accept' : 'reject',
      nicknameChanged,
    })

    try {
      if (nicknameChanged) {
        await updateProfile({ nickname: normalizedNickname })
        stage = 'invitation'
      }

      await InvitationApiService.respondToInvitation(invitation.id, accept)
      log.info('Invitation response succeeded', {
        invitationId: invitation.id,
        organizationId: invitation.organization_id,
        action: accept ? 'accept' : 'reject',
      })

      if (accept) {
        setAccepted(true)
        await useOrganizationStore.getState().loadOrganizations()
      } else {
        onResponded()
      }
    } catch (err) {
      const { errorCode, status, apiMessage, message } = getInvitationErrorDetails(err)
      log.error('Invitation response failed', {
        invitationId: invitation.id,
        organizationId: invitation.organization_id,
        action: accept ? 'accept' : 'reject',
        stage,
        errorCode,
        status,
      })

      if (stage === 'profile') {
        setNicknameError(apiMessage || t('organization:invitation.nickname.errors.updateFailed'))
        return
      }

      if (message.includes('INVITATION_INVALID') || message.includes('INVITATION_NOT_FOUND') || message.includes('INVITATION_EXPIRED')) {
        onResponded()
        return
      }
      if (errorCode === 'SEAT_CHECK_FAILED' || status === 503) {
        setError(t('organization:invitation.errors.seatCheckFailed', { defaultValue: '组织席位服务暂时不可用，请稍后重试' }))
      } else if (errorCode === 'EMAIL_MISMATCH') {
        setError(apiMessage || t('organization:invitation.errors.emailMismatch', { defaultValue: '此邀请发送到了其他邮箱，请用该邮箱对应的账号登录' }))
      } else {
        setError(message || t('organization:invitation.errors.respondFailed'))
      }
    } finally {
      setIsAccepting(false)
      setIsRejecting(false)
    }
  }

  const handleGoToWorkspace = async () => {
    let completed = true
    const organizations = useOrganizationStore.getState().organizations
    const target = organizations.find(w => w.id === invitation.organization_id)
    if (target) {
      completed = await runWithAgentContextSwitchGuard('organization', () => selectOrganization(target))
    }
    if (completed) onResponded()
  }

  const isBusy = isAccepting || isRejecting

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-[400px] max-w-[400px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <div>
              <DialogTitle className="text-subtitle font-semibold text-foreground">
                {t('invitationResponse.title')}
              </DialogTitle>
              <DialogDescription className="text-caption text-muted-foreground/60">
                {t('invitationResponse.description')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {!accepted && (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/20 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground/60" aria-hidden />
                <span className="text-body font-medium text-foreground">
                  {invitation.organization_name}
                </span>
              </div>
              {invitation.invited_by_name && (
                <div className="flex items-center gap-2 text-body text-muted-foreground">
                  <User className="h-3 w-3" />
                  <span>{t('invitationResponse.invitedBy', { name: invitation.invited_by_name })}</span>
                </div>
              )}
              <div className="flex items-center gap-2 text-body text-muted-foreground">
                <Shield className="h-3 w-3" />
                <span>{t('invitationResponse.role')}: {t(`members.roles.${invitation.role}`)}</span>
              </div>
              <div className="flex items-center gap-2 text-caption text-muted-foreground/60">
                <Clock className="h-3 w-3" />
                <span>
                  {t('invitationResponse.expiresAt')}: {new Date(invitation.expires_at).toLocaleString()}
                </span>
              </div>
            </div>

            <InvitationNicknameField
              inputId="invitation-response-nickname"
              value={nickname}
              error={nicknameError}
              disabled={isBusy}
              onChange={(value) => {
                setNickname(value)
                setNicknameError('')
              }}
            />

            {error && <p className="text-body text-destructive">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleRespond(false)}
                disabled={isBusy}
              >
                {isRejecting ? t('invitationResponse.rejecting') : t('invitationResponse.reject')}
              </Button>
              <Button
                size="sm"
                onClick={() => handleRespond(true)}
                disabled={isBusy}
              >
                {isAccepting ? t('invitationResponse.accepting') : t('invitationResponse.accept')}
              </Button>
            </div>
          </div>
        )}

        {accepted && (
          <div className="py-6 text-center space-y-3">
            <p className="text-body text-foreground font-medium">
              {t('invitationResponse.accepted', { name: invitation.organization_name })}
            </p>
            <Button size="sm" onClick={handleGoToWorkspace}>
              {t('organization:invitation.accept.goToOrganization')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
