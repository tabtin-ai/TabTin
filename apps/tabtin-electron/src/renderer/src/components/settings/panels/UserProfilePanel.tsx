import React, { useEffect, useRef, useState } from 'react'
import {
  Shield,
  Edit3,
  Check,
  LogOut,
  Lock,
  BadgeCheck,
  Copy,
  CheckCheck,
} from 'lucide-react'
import { Button, ConfirmDialog, Input, LoadingSpinner, Textarea, UserAvatar, toast } from '@components/ui'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@/stores/useAuthStore'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { UserProfileUpdateRequest } from '@/types/auth'
import apiService from '@/services/api'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'
import { SettingsSectionHeader } from '../SettingsSectionHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsRow, SettingsRowGroup } from '../SettingsRow'
import { ChangePasswordDialog } from './ChangePasswordDialog'
import { UserAvatarUploader } from './UserAvatarUploader'
import { SETTINGS_CONTROL, SETTINGS_CONTROL_SM, SETTINGS_HINT, SETTINGS_LABEL, SETTINGS_TEXTAREA, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE, SETTINGS_TEXT_MICRO } from '../settingsUi'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber } from '@/utils/i18n/format'

type AvatarDraft = {
  url: string
  fileId: string
}

const log = createLogger('UserProfilePanel')

function UserIdRow({ userId, t }: { userId: string; t: (key: string, opts?: Record<string, unknown>) => string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(userId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard not available */
    }
  }

  return (
    <SettingsRow
      label={t('labels.userId', { ns: 'profile' })}
      control={(
        <div className="flex min-w-0 items-center gap-2">
          <code className={cn(SETTINGS_TEXT_META_BASE, 'text-foreground/80', 'truncate rounded bg-background/80 px-1.5 py-0.5 font-mono select-all')}>
            {userId}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className={cn(SETTINGS_HINT, 'flex shrink-0 items-center gap-1 rounded-interactive px-1.5 py-0.5 transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]')}
            title={t('actions.copyId', { ns: 'profile' })}
          >
            {copied ? (
              <>
                <CheckCheck className="h-3 w-3 text-success" />
                <span className="text-success">{t('actions.copied', { ns: 'profile' })}</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                <span>{t('actions.copyId', { ns: 'profile' })}</span>
              </>
            )}
          </button>
        </div>
      )}
      controlClassName="min-w-0 sm:max-w-[28rem]"
    />
  )
}

function VerificationBadge({
  verified,
  t,
}: {
  verified: boolean
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  return verified ? (
    <span className={cn(SETTINGS_TEXT_MICRO, 'text-success/80', 'inline-flex items-center gap-1')}>
      <BadgeCheck className="h-3 w-3" />
      {t('verified', { ns: 'common' })}
    </span>
  ) : (
    <span className={cn(SETTINGS_HINT, 'inline-flex items-center gap-1')}>
      <Shield className="h-3 w-3" />
      {t('unverified', { ns: 'common' })}
    </span>
  )
}

interface UserProfilePanelProps {
  onRequestClose?: () => void
}

export const UserProfilePanel: React.FC<UserProfilePanelProps> = ({ onRequestClose }) => {
  const { t } = useTranslation(['profile', 'common'])
  const { user, updateProfile, logout, isLoading } = useAuthStore(
    useShallow((s) => ({ user: s.user, updateProfile: s.updateProfile, logout: s.logout, isLoading: s.isLoading }))
  )

  const [isEditing, setIsEditing] = useState(false)
  const [editData, setEditData] = useState({
    nickname: user?.nickname || '',
    bio: user?.bio || '',
  })
  const [editErrors, setEditErrors] = useState<Record<string, string>>({})
  const [isUpdating, setIsUpdating] = useState(false)
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
  const [showChangePassword, setShowChangePassword] = useState(false)
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft | null>(null)

  const [verificationStates, setVerificationStates] = useState({
    email: { sending: false, countdown: 0 },
    phone: { sending: false, countdown: 0 },
  })
  const emailTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const phoneTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (emailTimerRef.current) clearInterval(emailTimerRef.current)
      if (phoneTimerRef.current) clearInterval(phoneTimerRef.current)
    }
  }, [])

  const isProfileDirty = isEditing && (
    editData.nickname !== (user?.nickname || '') ||
    editData.bio !== (user?.bio || '') ||
    avatarDraft !== null
  )

  useEffect(() => {
    const unregister = useSettingsSpaceStore.getState().registerDirtyChecker(() => isProfileDirty)
    return unregister
  }, [isProfileDirty])

  if (!user) {
    return (
      <div className="h-full w-full flex items-center justify-center text-body text-muted-foreground">
        {t('notLoggedInProfile', { ns: 'common' })}
      </div>
    )
  }

  const validateEditForm = (): boolean => {
    const errors: Record<string, string> = {}

    if (editData.nickname.trim().length > 50) {
      errors.nickname = t('validation.nicknameLength', { ns: 'profile' })
    }

    if (editData.bio.trim() && editData.bio.length > 500) {
      errors.bio = t('validation.bioLength', { ns: 'profile' })
    }

    setEditErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSaveEdit = async () => {
    if (!validateEditForm()) return

    setIsUpdating(true)

    try {
      const updateData: UserProfileUpdateRequest = {}
      const currentNickname = user.nickname || ''
      const currentBio = user.bio || ''
      const normalizedNickname = editData.nickname.trim()

      if (normalizedNickname !== currentNickname) {
        updateData.nickname = normalizedNickname
      }
      if (editData.bio !== currentBio) {
        updateData.bio = editData.bio
      }
      if (avatarDraft) {
        updateData.avatar_file_id = avatarDraft.fileId
      }

      if (Object.keys(updateData).length > 0) {
        await updateProfile(updateData)
      }

      setAvatarDraft(null)
      setIsEditing(false)
      toast({ title: t('saved', { ns: 'profile' }) })
    } catch {
      toast({ variant: 'destructive', title: t('errors.updateFailed', { ns: 'profile' }) })
    } finally {
      setIsUpdating(false)
    }
  }

  const handleCancelEdit = () => {
    setEditData({
      nickname: user?.nickname || '',
      bio: user?.bio || '',
    })
    setAvatarDraft(null)
    setEditErrors({})
    setIsEditing(false)
  }

  const handleSendEmailVerification = async () => {
    if (verificationStates.email.countdown > 0) return

    setVerificationStates(prev => ({
      ...prev,
      email: { ...prev.email, sending: true }
    }))

    try {
      await apiService.sendEmailVerification()

      setVerificationStates(prev => ({
        ...prev,
        email: { sending: false, countdown: 60 }
      }))

      if (emailTimerRef.current) clearInterval(emailTimerRef.current)
      emailTimerRef.current = setInterval(() => {
        setVerificationStates(prev => {
          const newCountdown = prev.email.countdown - 1
          if (newCountdown <= 0) {
            if (emailTimerRef.current) clearInterval(emailTimerRef.current)
            emailTimerRef.current = null
            return {
              ...prev,
              email: { ...prev.email, countdown: 0 }
            }
          }
          return {
            ...prev,
            email: { ...prev.email, countdown: newCountdown }
          }
        })
      }, 1000)
    } catch (error) {
      console.error('Send email verification failed:', error)
      toast({ variant: 'destructive', title: t('errors.verificationFailed', { ns: 'profile' }) })
    } finally {
      setVerificationStates(prev => ({
        ...prev,
        email: { ...prev.email, sending: false }
      }))
    }
  }

  const handleSendPhoneVerification = async () => {
    if (verificationStates.phone.countdown > 0) return

    setVerificationStates(prev => ({
      ...prev,
      phone: { ...prev.phone, sending: true }
    }))

    try {
      await apiService.sendPhoneVerification()

      setVerificationStates(prev => ({
        ...prev,
        phone: { sending: false, countdown: 60 }
      }))

      if (phoneTimerRef.current) clearInterval(phoneTimerRef.current)
      phoneTimerRef.current = setInterval(() => {
        setVerificationStates(prev => {
          const newCountdown = prev.phone.countdown - 1
          if (newCountdown <= 0) {
            if (phoneTimerRef.current) clearInterval(phoneTimerRef.current)
            phoneTimerRef.current = null
            return {
              ...prev,
              phone: { ...prev.phone, countdown: 0 }
            }
          }
          return {
            ...prev,
            phone: { ...prev.phone, countdown: newCountdown }
          }
        })
      }, 1000)
    } catch (error) {
      console.error('Send phone verification failed:', error)
      toast({ variant: 'destructive', title: t('errors.verificationFailed', { ns: 'profile' }) })
    } finally {
      setVerificationStates(prev => ({
        ...prev,
        phone: { ...prev.phone, sending: false }
      }))
    }
  }

  const handleLogout = async () => {
    try {
      const completed = await runWithAgentContextSwitchGuard('logout', logout)
      if (completed) onRequestClose?.()
    } catch (error) {
      log.error('Logout failed', { error })
      toast({ variant: 'destructive', title: t('errors.logoutFailed', { ns: 'profile' }) })
    }
  }

  const maskEmail = (email: string) => {
    if (!email) return ''
    const [username, domain] = email.split('@')
    if (username.length <= 3) return email
    return `${username.slice(0, 2)}***@${domain}`
  }

  const maskPhone = (phone: string) => {
    if (!phone) return ''
    return `${phone.slice(0, 3)}****${phone.slice(-4)}`
  }

  return (
    <SettingsPanelLayout>
      <SettingsSectionHeader section="account" subtitle={t('description', { ns: 'profile' })} />

      {/* 头部：头像 + 基本信息 */}
      <div className="relative">
        <div className="flex items-start gap-4">
          {/* 头像区域：裁剪后先作为草稿预览，保存个人资料时再持久化。 */}
          <div className="relative shrink-0">
            {isEditing ? (
              <UserAvatarUploader
                compact
                currentAvatar={avatarDraft?.url ?? user.avatar ?? undefined}
                disabled={isUpdating}
                saving={isUpdating}
                onAvatarUploaded={setAvatarDraft}
              />
            ) : (
              <UserAvatar
                name={user.nickname || user.username || '?'}
                seed={user.id}
                avatarUrl={user.avatar}
                size={72}
              />
            )}
          </div>

          {/* 基本信息 */}
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <div>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <label className={cn(SETTINGS_LABEL, 'mb-1 block')} htmlFor="profile-nickname">
                      {t('labels.nickname', { ns: 'profile' })}
                    </label>
                    <Input
                      id="profile-nickname"
                      value={editData.nickname}
                      onChange={(e) => setEditData(prev => ({ ...prev, nickname: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          void handleSaveEdit()
                        }
                      }}
                      placeholder={t('placeholders.nickname', { ns: 'profile' })}
                      aria-invalid={Boolean(editErrors.nickname)}
                      aria-describedby={editErrors.nickname ? 'profile-nickname-error' : undefined}
                      className={cn(
                        'bg-background/80',
                        SETTINGS_CONTROL,
                        editErrors.nickname && 'border-destructive focus-visible:ring-destructive'
                      )}
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-2 pt-5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCancelEdit}
                      disabled={isUpdating}
                      className={SETTINGS_CONTROL_SM}
                    >
                      {t('cancel', { ns: 'common' })}
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSaveEdit}
                      disabled={isUpdating}
                      className={cn('gap-1.5', SETTINGS_CONTROL_SM)}
                    >
                      {isUpdating ? (
                        <LoadingSpinner size="sm" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      {t('save', { ns: 'common' })}
                    </Button>
                  </div>
                </div>
                {editErrors.nickname && (
                  <p id="profile-nickname-error" className="mt-1 text-body text-destructive">
                    {editErrors.nickname}
                  </p>
                )}
                <div className="mt-3">
                  <label className={cn(SETTINGS_LABEL, 'mb-1 block')} htmlFor="profile-bio">
                    {t('labels.bio', { ns: 'profile' })}
                  </label>
                  <Textarea
                    id="profile-bio"
                    value={editData.bio}
                    onChange={(e) => setEditData(prev => ({ ...prev, bio: e.target.value }))}
                    placeholder={t('placeholders.bio', { ns: 'profile' })}
                    rows={2}
                    aria-invalid={Boolean(editErrors.bio)}
                    aria-describedby={editErrors.bio ? 'profile-bio-error' : undefined}
                    className={cn(
                      'w-full resize-none bg-background/80 placeholder:text-muted-foreground/60',
                      SETTINGS_TEXTAREA,
                      editErrors.bio ? 'border-destructive' : 'border-input'
                    )}
                  />
                  <div className="mt-1 flex items-center justify-between">
                    {editErrors.bio && (
                      <p id="profile-bio-error" className="text-body text-destructive">{editErrors.bio}</p>
                    )}
                    <p className={cn(SETTINGS_TEXT_META, 'ml-auto')}>
                      {editData.bio.length}/500
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-start gap-3">
                  <h2 className="min-w-0 flex-1 truncate text-title font-semibold text-foreground">
                    {user.nickname || t('empty.nickname', { ns: 'profile' })}
                  </h2>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsEditing(true)}
                    className={cn('shrink-0', SETTINGS_CONTROL_SM)}
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    {t('actions.editProfile', { ns: 'profile' })}
                  </Button>
                </div>
                <p className="mt-2 line-clamp-2 text-body leading-relaxed text-muted-foreground/80">
                  {user.bio || t('empty.bio', { ns: 'profile' })}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <SettingsRowGroup>
            <UserIdRow userId={user.id} t={t} />
            {user.phone ? (
              <SettingsRow
                label={t('labels.phone', { ns: 'profile', defaultValue: '手机号' })}
                control={(
                  <div className="flex items-center gap-2">
                    <span className="text-body text-foreground">{maskPhone(user.phone)}</span>
                    <VerificationBadge verified={Boolean(user.is_verified_phone)} t={t} />
                    {!user.is_verified_phone ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleSendPhoneVerification}
                        disabled={verificationStates.phone.sending || verificationStates.phone.countdown > 0}
                        className={cn('shrink-0 text-muted-foreground/60', SETTINGS_CONTROL_SM)}
                      >
                        {verificationStates.phone.sending ? (
                          <LoadingSpinner size="sm" />
                        ) : verificationStates.phone.countdown > 0 ? (
                          `${verificationStates.phone.countdown}s`
                        ) : (
                          t('verify', { ns: 'common' })
                        )}
                      </Button>
                    ) : null}
                  </div>
                )}
              />
            ) : null}
            {user.email ? (
              <SettingsRow
                label={t('labels.email', { ns: 'profile', defaultValue: '邮箱' })}
                control={(
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-body text-foreground">{maskEmail(user.email)}</span>
                    <VerificationBadge verified={Boolean(user.is_verified_email)} t={t} />
                    {!user.is_verified_email ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleSendEmailVerification}
                        disabled={verificationStates.email.sending || verificationStates.email.countdown > 0}
                        className={cn('shrink-0 text-muted-foreground/60', SETTINGS_CONTROL_SM)}
                      >
                        {verificationStates.email.sending ? (
                          <LoadingSpinner size="sm" />
                        ) : verificationStates.email.countdown > 0 ? (
                          `${verificationStates.email.countdown}s`
                        ) : (
                          t('verify', { ns: 'common' })
                        )}
                      </Button>
                    ) : null}
                  </div>
                )}
                controlClassName="min-w-0"
              />
            ) : null}
            <SettingsRow
              label={t('labels.registeredAt', { ns: 'profile' })}
              control={<span className="text-body text-foreground">{formatDate(user.date_joined, { year: 'numeric', month: 'long', day: 'numeric' })}</span>}
            />
            <SettingsRow
              label={t('labels.loginCount', { ns: 'profile' })}
              control={<span className="text-body text-foreground">{t('stats.loginCount', { ns: 'profile', value: formatNumber(user.login_count) })}</span>}
            />
            {user.last_login ? (
              <SettingsRow
                label={t('labels.lastLogin', { ns: 'profile' })}
                control={<span className="text-body text-foreground">{formatDate(user.last_login, { year: 'numeric', month: 'long', day: 'numeric' })}</span>}
              />
            ) : null}
        </SettingsRowGroup>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowChangePassword(true)}
          >
            <Lock className="h-3.5 w-3.5" />
            {t('actions.changePassword', { ns: 'profile' })}
          </Button>
          <Button
            size="sm"
            onClick={() => setLogoutConfirmOpen(true)}
            disabled={isLoading}
          >
            {isLoading ? (
              <LoadingSpinner size="sm" />
            ) : (
              <LogOut className="h-3.5 w-3.5" />
            )}
            {t('actions.logout', { ns: 'profile' })}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={logoutConfirmOpen}
        onOpenChange={setLogoutConfirmOpen}
        title={t('actions.logoutConfirmTitle', { ns: 'profile' })}
        description={t('actions.logoutConfirmDesc', { ns: 'profile' })}
        confirmText={t('actions.logout', { ns: 'profile' })}
        cancelText={t('cancel', { ns: 'common' })}
        variant="destructive"
        onConfirm={handleLogout}
        isLoading={isLoading}
      />

      <ChangePasswordDialog
        open={showChangePassword}
        onOpenChange={setShowChangePassword}
        onPasswordChanged={onRequestClose}
        userEmail={user.email}
        userPhone={user.phone}
      />

    </SettingsPanelLayout>
  )
}
