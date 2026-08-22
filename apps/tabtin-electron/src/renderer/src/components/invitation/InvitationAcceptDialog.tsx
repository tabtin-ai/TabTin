import React, { useEffect, useRef, useState } from 'react'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { InvitationApiService, type InvitationPreview } from '@/services/invitationApi'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'
import { Building2, LogIn, Shield, Users } from 'lucide-react'
import { InvitationNicknameField, validateInvitationNickname } from './InvitationNicknameField'
import { createLogger } from '@/utils/logger'
import { getInvitationErrorDetails } from './invitationError'

const log = createLogger('InvitationAcceptDialog')

interface Props {
  token: string
  onClose: () => void
}

function isAuthError(err: unknown): boolean {
  const { status, message } = getInvitationErrorDetails(err)
  return status === 401 || /unauthorized|未登录|请先登录/i.test(message)
}

export const InvitationAcceptDialog: React.FC<Props> = ({ token, onClose }) => {
  const { t } = useTranslation(['organization', 'common'])
  const [preview, setPreview] = useState<InvitationPreview | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isAccepting, setIsAccepting] = useState(false)
  const [error, setError] = useState('')
  const [needLogin, setNeedLogin] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [alreadyMember, setAlreadyMember] = useState(false)
  const [acceptedOrganizationId, setAcceptedOrganizationId] = useState<string | null>(null)
  const loadOrganizations = useOrganizationStore((s) => s.loadOrganizations)
  const selectOrganization = useOrganizationStore((s) => s.selectOrganization)
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const user = useAuthStore((state) => state.user)
  const updateProfile = useAuthStore((state) => state.updateProfile)
  const [nickname, setNickname] = useState(() => user?.nickname || '')
  const [nicknameError, setNicknameError] = useState('')
  const initializedUserIdRef = useRef(user?.id || null)

  useEffect(() => {
    const nextUserId = user?.id || null
    if (initializedUserIdRef.current === nextUserId) return
    initializedUserIdRef.current = nextUserId
    setNickname(user?.nickname || '')
    setNicknameError('')
  }, [user])

  useEffect(() => {
    let cancelled = false
    setPreview(null)
    setIsLoading(true)
    setError('')
    setNeedLogin(false)
    setAccepted(false)
    setAlreadyMember(false)
    setAcceptedOrganizationId(null)
    ;(async () => {
      try {
        const info = await InvitationApiService.getInvitationInfo(token)
        if (!cancelled) setPreview(info)
      } catch (err) {
        const { errorName, message } = getInvitationErrorDetails(err)
        log.error('Invitation preview load failed', {
          errorName,
        })
        if (!cancelled) setError(message || t('invitation.errors.notFound'))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    if (!isAuthenticated || !preview?.valid || !preview.organization_id) return

    let cancelled = false
    ;(async () => {
      try {
        await loadOrganizations()
        if (cancelled) return
        const organizations = useOrganizationStore.getState().organizations
        const target = organizations.find((w) => w.id === preview.organization_id)
        if (target) {
          setAlreadyMember(true)
          setAcceptedOrganizationId(target.id)
          setNeedLogin(false)
          setError('')
        }
      } catch (err) {
        log.warn('Failed to refresh organizations before invitation acceptance', {
          errorName: err instanceof Error ? err.name : 'UnknownError',
        })
      }
    })()

    return () => { cancelled = true }
  }, [isAuthenticated, loadOrganizations, preview?.organization_id, preview?.valid])

  const handleAccept = async () => {
    if (!isAuthenticated) {
      setNeedLogin(true)
      return
    }
    const normalizedNickname = nickname.trim()
    const validationError = validateInvitationNickname(normalizedNickname)
    if (validationError) {
      setNicknameError(t(`invitation.nickname.errors.${validationError}`))
      return
    }

    setIsAccepting(true)
    setError('')
    setNicknameError('')
    setNeedLogin(false)
    const nicknameChanged = normalizedNickname !== (user?.nickname || '').trim()
    let stage: 'profile' | 'invitation' = nicknameChanged ? 'profile' : 'invitation'
    log.info('Invitation acceptance started', { nicknameChanged })
    try {
      if (nicknameChanged) {
        await updateProfile({ nickname: normalizedNickname })
        stage = 'invitation'
      }

      const result = await InvitationApiService.acceptInvitation(token)
      log.info('Invitation acceptance succeeded', { organizationId: result.organization_id })
      setAccepted(true)
      setAcceptedOrganizationId(result.organization_id)
      await loadOrganizations()
    } catch (err) {
      const { errorCode, status, apiMessage, message } = getInvitationErrorDetails(err)
      log.error('Invitation acceptance failed', {
        stage,
        errorCode,
        status,
      })

      if (stage === 'profile') {
        setNicknameError(apiMessage || t('invitation.nickname.errors.updateFailed'))
        return
      }

      if (isAuthError(err)) {
        setNeedLogin(true)
        setError(t('invitation.accept.loginRequired'))
      } else if (errorCode === 'ALREADY_MEMBER' || errorCode === 'ALREADY_OWNER') {
        setAlreadyMember(true)
        setAcceptedOrganizationId(preview?.organization_id ?? null)
        await loadOrganizations()
      } else {
        if (errorCode === 'EMAIL_MISMATCH' || apiMessage.includes('邮箱')) {
          setError(apiMessage || t('invitation.errors.emailMismatch', { defaultValue: '此邀请发送到了其他邮箱，请用该邮箱对应的账号登录' }))
        } else {
          setError(message || t('invitation.errors.acceptFailed'))
        }
      }
    } finally {
      setIsAccepting(false)
    }
  }

  const handleGoToOrganization = async () => {
    let completed = true
    if (acceptedOrganizationId) {
      const organizations = useOrganizationStore.getState().organizations
      const target = organizations.find((w) => w.id === acceptedOrganizationId)
      if (target) {
        completed = await runWithAgentContextSwitchGuard('organization', () => selectOrganization(target))
      }
    }
    if (completed) onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-[400px] max-w-[400px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <DialogTitle className="text-subtitle font-semibold text-foreground">
              {t('invitation.accept.title')}
            </DialogTitle>
          </div>
        </DialogHeader>

        {isLoading && (
          <p className="text-body text-muted-foreground py-8 text-center">
            {t('loading', { ns: 'common' })}
          </p>
        )}

        {error && !preview && (
          <div className="py-8 text-center">
            <p className="text-body text-destructive mb-4">{error}</p>
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('close', { ns: 'common' })}
            </Button>
          </div>
        )}

        {preview && !preview.valid && (
          <div className="py-8 text-center">
            <p className="text-body text-muted-foreground mb-2">{t('invitation.accept.invalid')}</p>
            <p className="text-body text-muted-foreground/60">{t(`invitation.accept.status.${preview.status}`)}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={onClose}>
              {t('close', { ns: 'common' })}
            </Button>
          </div>
        )}

        {preview && preview.valid && !accepted && !alreadyMember && (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/20 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground/60" aria-hidden />
                <span className="text-body font-medium text-foreground">
                  {preview.organization_name}
                </span>
              </div>
              <div className="flex items-center gap-2 text-body text-muted-foreground">
                <Shield className="h-3 w-3" />
                <span>{t(`members.roles.${preview.role}`)}</span>
              </div>
              {preview.expires_at && (
                <p className="text-caption text-muted-foreground/60">
                  {t('members.expiresAt', { date: new Date(preview.expires_at).toLocaleString() })}
                </p>
              )}
            </div>

            <InvitationNicknameField
              inputId="invitation-accept-nickname"
              value={nickname}
              error={nicknameError}
              disabled={isAccepting}
              onChange={(value) => {
                setNickname(value)
                setNicknameError('')
              }}
            />

            {error && <p className="text-body text-destructive">{error}</p>}

            {needLogin && (
              <div className="flex items-center gap-2 rounded-lg bg-warning/10 border border-warning/20 px-3 py-2">
                <LogIn className="h-3.5 w-3.5 text-warning shrink-0" />
                <p className="text-body text-warning">
                  {t('invitation.accept.loginRequired')}
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose} disabled={isAccepting}>
                {t('members.actions.cancel')}
              </Button>
              <Button size="sm" onClick={handleAccept} disabled={isAccepting}>
                {isAccepting ? t('invitation.accept.accepting') : t('invitation.accept.confirm')}
              </Button>
            </div>
          </div>
        )}

        {(accepted || alreadyMember) && (
          <div className="py-6 text-center space-y-3">
            <p className="text-body text-foreground font-medium">
              {alreadyMember ? t('invitation.accept.alreadyMember') : t('invitation.accept.success')}
            </p>
            <p className="text-body text-muted-foreground">
              {alreadyMember
                ? t('invitation.accept.alreadyMemberDesc', { organization: preview?.organization_name })
                : t('invitation.accept.successDesc', { organization: preview?.organization_name })}
            </p>
            <Button size="sm" onClick={handleGoToOrganization}>
              {t('invitation.accept.goToOrganization')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
