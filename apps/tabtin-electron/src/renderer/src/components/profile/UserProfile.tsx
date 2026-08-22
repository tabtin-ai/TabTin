import React, { useEffect, useRef, useState } from 'react'
import {
  User,
  Mail,
  Smartphone,
  Calendar,
  Shield,
  Edit3,
  Check,
  X,
  Camera,
  LogOut,
  Settings,
  HardDrive,
  ChevronRight
} from 'lucide-react'
import {
  Button,
  Input,
  LoadingSpinner,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  VisuallyHidden,
} from '@components/ui'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@/stores/useAuthStore'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'
import { UserProfileUpdateRequest } from '@/types/auth'
import apiService from '@/services/api'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useTranslation } from 'react-i18next'
import { formatDate, formatNumber } from '@/utils/i18n/format'
import { createLogger } from '@/utils/logger'

interface UserProfileProps {
  isOpen: boolean
  onClose: () => void
}

const log = createLogger('UserProfile')

export const UserProfile: React.FC<UserProfileProps> = ({ isOpen, onClose }) => {
  const { user, updateProfile, logout, isLoading } = useAuthStore(useShallow(state => ({
    user: state.user,
    updateProfile: state.updateProfile,
    logout: state.logout,
    isLoading: state.isLoading,
  })))
  const { t } = useTranslation(['profile', 'common', 'settings'])

  // 编辑状态
  const [isEditing, setIsEditing] = useState(false)
  const [editData, setEditData] = useState({
    nickname: user?.nickname || '',
    username: user?.username || '',
    bio: user?.bio || '',
    avatar: user?.avatar || '',
  })
  const [editErrors, setEditErrors] = useState<Record<string, string>>({})
  const [isUpdating, setIsUpdating] = useState(false)

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

  if (!user) return null

  // 验证编辑表单
  const validateEditForm = (): boolean => {
    const errors: Record<string, string> = {}

    if (editData.username.trim()) {
      if (editData.username.length < 3 || editData.username.length > 20) {
        errors.username = t('validation.usernameLength', { ns: 'profile' })
      } else if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(editData.username)) {
        errors.username = t('validation.usernameFormat', { ns: 'profile' })
      }
    }

    if (editData.nickname.trim() && editData.nickname.length > 50) {
      errors.nickname = t('validation.nicknameLength', { ns: 'profile' })
    }

    if (editData.bio.trim() && editData.bio.length > 500) {
      errors.bio = t('validation.bioLength', { ns: 'profile' })
    }

    setEditErrors(errors)
    return Object.keys(errors).length === 0
  }

  // 保存编辑
  const handleSaveEdit = async () => {
    if (!validateEditForm()) return

    setIsUpdating(true)

    try {
      const updateData: UserProfileUpdateRequest = {}

      if (editData.nickname !== user.nickname) {
        updateData.nickname = editData.nickname || undefined
      }
      if (editData.username !== user.username) {
        updateData.username = editData.username || undefined
      }
      if (editData.bio !== user.bio) {
        updateData.bio = editData.bio || undefined
      }
      if (editData.avatar !== user.avatar) {
        updateData.avatar = editData.avatar || undefined
      }

      if (Object.keys(updateData).length > 0) {
        await updateProfile(updateData)
      }

      setIsEditing(false)
    } catch {
      // 错误已在store中处理
    } finally {
      setIsUpdating(false)
    }
  }

  // 取消编辑
  const handleCancelEdit = () => {
    setEditData({
      nickname: user?.nickname || '',
      username: user?.username || '',
      bio: user?.bio || '',
      avatar: user?.avatar || '',
    })
    setEditErrors({})
    setIsEditing(false)
  }

  // 发送邮箱验证码
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
    } finally {
      setVerificationStates(prev => ({
        ...prev,
        email: { ...prev.email, sending: false }
      }))
    }
  }

  // 发送手机验证码
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
    } finally {
      setVerificationStates(prev => ({
        ...prev,
        phone: { ...prev.phone, sending: false }
      }))
    }
  }

  // 处理登出
  const handleLogout = async () => {
    try {
      const completed = await runWithAgentContextSwitchGuard('logout', logout)
      if (completed) onClose()
    } catch (error) {
      log.error('Logout failed', { error })
    }
  }

  // 脱敏显示
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
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>{t('title', { ns: 'profile' })}</span>
            <div className="flex items-center gap-2">
              {!isEditing ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsEditing(true)}
                >
                  <Edit3 className="h-4 w-4 mr-2" />
                  {t('edit', { ns: 'common' })}
                </Button>
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancelEdit}
                    disabled={isUpdating}
                  >
                    <X className="h-4 w-4 mr-2" />
                    {t('cancel', { ns: 'common' })}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSaveEdit}
                    disabled={isUpdating}
                  >
                    {isUpdating ? (
                      <LoadingSpinner size="sm" className="mr-2" />
                    ) : (
                      <Check className="h-4 w-4 mr-2" />
                    )}
                    {t('save', { ns: 'common' })}
                  </Button>
                </div>
              )}
            </div>
          </DialogTitle>
          <VisuallyHidden>
            <DialogDescription>
              {t('description', { ns: 'profile' })}
            </DialogDescription>
          </VisuallyHidden>
        </DialogHeader>

        <div className="space-y-6">
          {/* 头像和基本信息 */}
          <div className="flex items-start gap-6">
            <div className="relative">
              <div className="w-20 h-20 rounded-full bg-gradient-to-br from-primary/20 to-primary/40 flex items-center justify-center">
                {user.avatar ? (
                  <img
                    src={user.avatar}
                    alt={t('alt.avatar', { ns: 'profile' })}
                    className="w-full h-full rounded-full object-cover"
                  />
                ) : (
                  <User className="h-8 w-8 text-primary" />
                )}
              </div>
              {isEditing && (
                <Button
                  variant="outline"
                  size="sm"
                  className="absolute -bottom-2 -right-2 rounded-full h-8 w-8 p-0"
                >
                  <Camera className="h-4 w-4" />
                </Button>
              )}
            </div>

            <div className="flex-1 space-y-3">
              {/* 昵称 */}
              <div>
                <label className="text-body font-medium text-muted-foreground">
                  {t('labels.nickname', { ns: 'profile' })}
                </label>
                {isEditing ? (
                  <div className="mt-1">
                    <Input
                      value={editData.nickname}
                      onChange={(e) => setEditData(prev => ({ ...prev, nickname: e.target.value }))}
                      placeholder={t('placeholders.nickname', { ns: 'profile' })}
                      className={editErrors.nickname ? 'border-destructive' : ''}
                    />
                    {editErrors.nickname && (
                      <p className="text-body text-destructive mt-1">{editErrors.nickname}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-foreground font-medium">
                    {user.nickname || t('empty.nickname', { ns: 'profile' })}
                  </p>
                )}
              </div>

              {/* 用户名 */}
              <div>
                <label className="text-body font-medium text-muted-foreground">
                  {t('labels.username', { ns: 'profile' })}
                </label>
                {isEditing ? (
                  <div className="mt-1">
                    <Input
                      value={editData.username}
                      onChange={(e) => setEditData(prev => ({ ...prev, username: e.target.value }))}
                      placeholder={t('placeholders.username', { ns: 'profile' })}
                      className={editErrors.username ? 'border-destructive' : ''}
                    />
                    {editErrors.username && (
                      <p className="text-body text-destructive mt-1">{editErrors.username}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-foreground">
                    {user.username ? `@${user.username}` : t('empty.username', { ns: 'profile' })}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* 个人简介 */}
          <div>
            <label className="text-body font-medium text-muted-foreground">
              {t('labels.bio', { ns: 'profile' })}
            </label>
            {isEditing ? (
              <div className="mt-1">
                <textarea
                  value={editData.bio}
                  onChange={(e) => setEditData(prev => ({ ...prev, bio: e.target.value }))}
                  placeholder={t('placeholders.bio', { ns: 'profile' })}
                  rows={3}
                  className={`w-full px-3 py-2 border rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 ${
                    editErrors.bio ? 'border-destructive' : 'border-input'
                  }`}
                />
                <div className="flex justify-between items-center mt-1">
                  {editErrors.bio && (
                    <p className="text-body text-destructive">{editErrors.bio}</p>
                  )}
                  <p className="text-body text-muted-foreground ml-auto">
                    {editData.bio.length}/500
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-foreground mt-1">
                {user.bio || t('empty.bio', { ns: 'profile' })}
              </p>
            )}
          </div>

          {/* 联系方式 */}
          <div className="space-y-4">
            <h3 className="text-title font-semibold">{t('labels.contact', { ns: 'profile' })}</h3>

            {/* 邮箱 */}
            {user.email && (
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div className="flex items-center gap-3">
                  <Mail className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">{maskEmail(user.email)}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {user.is_verified_email ? (
                        <div className="flex items-center gap-1 text-success">
                          <Check className="h-3 w-3" />
                          <span className="text-body">{t('verified', { ns: 'common' })}</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 text-warning">
                          <Shield className="h-3 w-3" />
                          <span className="text-body">{t('unverified', { ns: 'common' })}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {!user.is_verified_email && (
                  <Button
                    variant="outline"
                    size="form"
                    className="shrink-0"
                    onClick={handleSendEmailVerification}
                    disabled={verificationStates.email.sending || verificationStates.email.countdown > 0}
                  >
                    {verificationStates.email.sending ? (
                      <LoadingSpinner size="sm" />
                    ) : verificationStates.email.countdown > 0 ? (
                      t('countdown', { ns: 'common', count: verificationStates.email.countdown })
                    ) : (
                      t('verify', { ns: 'common' })
                    )}
                  </Button>
                )}
              </div>
            )}

            {/* 手机号 */}
            {user.phone && (
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div className="flex items-center gap-3">
                  <Smartphone className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">{maskPhone(user.phone)}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {user.is_verified_phone ? (
                        <div className="flex items-center gap-1 text-success">
                          <Check className="h-3 w-3" />
                          <span className="text-body">{t('verified', { ns: 'common' })}</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 text-warning">
                          <Shield className="h-3 w-3" />
                          <span className="text-body">{t('unverified', { ns: 'common' })}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {!user.is_verified_phone && (
                  <Button
                    variant="outline"
                    size="form"
                    className="shrink-0"
                    onClick={handleSendPhoneVerification}
                    disabled={verificationStates.phone.sending || verificationStates.phone.countdown > 0}
                  >
                    {verificationStates.phone.sending ? (
                      <LoadingSpinner size="sm" />
                    ) : verificationStates.phone.countdown > 0 ? (
                      t('countdown', { ns: 'common', count: verificationStates.phone.countdown })
                    ) : (
                      t('verify', { ns: 'common' })
                    )}
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* 账户信息 */}
          <div className="space-y-4">
            <h3 className="text-title font-semibold">{t('labels.accountInfo', { ns: 'profile' })}</h3>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-center gap-3 p-4 border rounded-lg">
                <Calendar className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-body text-muted-foreground">{t('labels.registeredAt', { ns: 'profile' })}</p>
                  <p className="font-medium">{formatDate(user.date_joined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                </div>
              </div>

              <div className="flex items-center gap-3 p-4 border rounded-lg">
                <User className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-body text-muted-foreground">{t('labels.loginCount', { ns: 'profile' })}</p>
                  <p className="font-medium">{t('stats.loginCount', { ns: 'profile', value: formatNumber(user.login_count) })}</p>
                </div>
              </div>
            </div>

            {user.last_login && (
              <div className="flex items-center gap-3 p-4 border rounded-lg">
                <Shield className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-body text-muted-foreground">{t('labels.lastLogin', { ns: 'profile' })}</p>
                  <p className="font-medium">{formatDate(user.last_login, { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                </div>
              </div>
            )}
          </div>

          {/* W3.1：本地存储统一入口 — D-11 单一入口（个人资料 → 存储管理）。
              点击后关掉本 Dialog 并打开 settings 的 storageManager section，
              满足"三步可达"业务目标。 */}
          <button
            type="button"
            onClick={() => {
              useSettingsSpaceStore.getState().openSettings('storageManager')
              onClose()
            }}
            className="group flex w-full items-center justify-between gap-3 rounded-md border border-border/40 bg-muted/20 px-3 py-2.5 hover:bg-muted/40 transition-colors"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <HardDrive className="h-4 w-4 text-muted-foreground/60 shrink-0" />
              <div className="min-w-0 text-left">
                <p className="text-body text-foreground">
                  {t('actions.openStorageManager', { ns: 'profile', defaultValue: '存储管理' })}
                </p>
                <p className="text-caption text-muted-foreground/60 truncate">
                  {t('actions.openStorageManagerHint', { ns: 'profile', defaultValue: '看见 TabTin 在你电脑上存了什么，按需要清理或导出' })}
                </p>
              </div>
            </div>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 group-hover:text-foreground shrink-0" />
          </button>

          {/* 操作按钮 */}
          <div className="flex justify-between pt-4 border-t">
            <Button variant="outline" className="flex items-center gap-2">
              <Settings className="h-4 w-4" />
              {t('actions.accountSettings', { ns: 'profile' })}
            </Button>

            <Button
              variant="destructive"
              onClick={handleLogout}
              disabled={isLoading}
              className="flex items-center gap-2"
            >
              {isLoading ? (
                <LoadingSpinner size="sm" />
              ) : (
                <LogOut className="h-4 w-4" />
              )}
              {t('actions.logout', { ns: 'profile' })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
