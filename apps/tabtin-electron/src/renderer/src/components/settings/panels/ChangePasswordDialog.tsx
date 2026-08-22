import React, { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Button,
  Input,
  LoadingSpinner,
  toast,
} from '@components/ui'
import { Lock, Eye, EyeOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import apiService from '@/services/api'
import { useAuthStore } from '@/stores/useAuthStore'
import { useCountdown } from '@tabtin/shared/use-countdown'
import { useCapsLockWarning } from '@tabtin/shared/use-caps-lock-warning'
import {
  passwordHasWhitespace,
  passwordContainsCjk,
  sanitizeNewPasswordInput,
  passwordMeetsCharClassRule,
  PASSWORD_MIN_LENGTH,
} from '@tabtin/shared'
import { extractErrorMessage } from '@/utils/extract-api-error'
import type { CurrentUserPasswordResetRequest, PasswordChangeRequest } from '@/types/auth'
import { cn } from '@utils/cn'
import { SETTINGS_CONTROL, SETTINGS_TEXT_META } from '../settingsUi'
import { CapsLockHint } from '../../auth/CapsLockHint'
import { PasswordRuleHints } from '../../auth/PasswordRuleHints'

interface ChangePasswordDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPasswordChanged?: () => void
  /** 当前账号邮箱（验证码重置时发码用） */
  userEmail?: string
  /** 当前账号手机号（无邮箱时用手机号发码） */
  userPhone?: string
}

type Mode = 'change' | 'reset'

function isMaskedIdentifier(id: string): boolean {
  return id.includes('*')
}

function maskIdentifier(id: string): string {
  if (!id) return ''
  if (id.includes('@')) {
    const [name, domain] = id.split('@')
    return name.length <= 2 ? id : `${name.slice(0, 2)}***@${domain}`
  }
  return id.length <= 7 ? id : `${id.slice(0, 3)}****${id.slice(-4)}`
}

/**
 * 已登录用户的「修改密码」对话框。
 *
 * 一个弹窗覆盖两种情况：
 *  - change 模式（默认）：原密码 + 新密码 → POST /auth/change-password
 *  - reset 模式（忘记原密码）：后端给当前账号邮箱/手机发验证码 → 验证码 + 新密码 → POST /auth/reset-current-password
 *
 * 后端在两条路径成功后都会失效所有会话，故成功后引导用户重新登录。
 */
export const ChangePasswordDialog: React.FC<ChangePasswordDialogProps> = ({
  open,
  onOpenChange,
  onPasswordChanged,
  userEmail,
  userPhone,
}) => {
  const { t } = useTranslation(['profile', 'common'])
  const { logout } = useAuthStore(useShallow((s) => ({ logout: s.logout })))
  const displayIdentifier = (userEmail || userPhone || '').trim()

  const [mode, setMode] = useState<Mode>('change')
  const [oldPassword, setOldPassword] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showOld, setShowOld] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resetIdentifier, setResetIdentifier] = useState('')
  const { countdown, start: startCountdown } = useCountdown(60)
  const oldPasswordCapsLock = useCapsLockWarning()
  const newPasswordCapsLock = useCapsLockWarning()
  const confirmPasswordCapsLock = useCapsLockWarning()

  useEffect(() => {
    if (!open) return
    setResetIdentifier(isMaskedIdentifier(displayIdentifier) ? '' : displayIdentifier)
  }, [open, displayIdentifier])

  const dismissCapsLockHints = () => {
    oldPasswordCapsLock.resetCapsLockWarning()
    newPasswordCapsLock.resetCapsLockWarning()
    confirmPasswordCapsLock.resetCapsLockWarning()
  }

  // 父级直接把 open 置 false 时也要收口，避免框外关 Caps Lock 后再打开仍提示。
  useEffect(() => {
    if (open) return
    dismissCapsLockHints()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随 open 收口
  }, [open])

  const resetState = () => {
    setMode('change')
    setOldPassword('')
    setVerificationCode('')
    setNewPassword('')
    setConfirmPassword('')
    setShowOld(false)
    setShowNew(false)
    setShowConfirm(false)
    setError(null)
    setIsLoading(false)
    setResetIdentifier('')
    dismissCapsLockHints()
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) resetState()
    onOpenChange(next)
  }

  /** 单字段策略错误（不含两次一致性）；粘贴/输入后立刻展示在界面，不写回密码框。 */
  const getPasswordPolicyError = (password: string): string | null => {
    if (!password) return null
    // 与后端 SSOT validate_user_password 对齐：禁 CJK / 禁空白 / ≥8 / 四类至少 3 类。
    if (passwordContainsCjk(password)) return t('changePassword.errors.newNoCjk')
    if (passwordHasWhitespace(password)) return t('changePassword.errors.newNoWhitespace')
    if (password.length < PASSWORD_MIN_LENGTH) return t('changePassword.errors.newTooShort')
    if (!passwordMeetsCharClassRule(password)) return t('changePassword.errors.newNotComplex')
    return null
  }

  const validateNewPassword = (): string | null => {
    const policyErr = getPasswordPolicyError(newPassword)
    if (policyErr) return policyErr
    if (!newPassword) return t('changePassword.errors.newTooShort')
    if (newPassword !== confirmPassword) return t('changePassword.errors.mismatch')
    return null
  }

  const handleNewPasswordChange = (raw: string) => {
    const { value: next, notice } = sanitizeNewPasswordInput(raw)
    setNewPassword(next)
    if (notice === 'cjk') {
      setError(t('changePassword.errors.newNoCjk'))
      return
    }
    if (notice === 'whitespace') {
      setError(t('changePassword.errors.newNoWhitespace'))
      return
    }
    // 已满 8 位仍不够复杂立刻提示；短输入不刷「太短」。
    if (next.length >= PASSWORD_MIN_LENGTH && !passwordMeetsCharClassRule(next)) {
      setError(t('changePassword.errors.newNotComplex'))
      return
    }
    if (
      confirmPassword &&
      next.length >= PASSWORD_MIN_LENGTH &&
      next !== confirmPassword
    ) {
      setError(t('changePassword.errors.mismatch'))
      return
    }
    setError(null)
  }

  const handleConfirmPasswordChange = (raw: string) => {
    const { value: next, notice } = sanitizeNewPasswordInput(raw)
    setConfirmPassword(next)
    if (notice === 'cjk') {
      setError(t('changePassword.errors.newNoCjk'))
      return
    }
    if (notice === 'whitespace') {
      setError(t('changePassword.errors.newNoWhitespace'))
      return
    }
    if (newPassword && next && newPassword !== next) {
      setError(t('changePassword.errors.mismatch'))
      return
    }
    const policyErr =
      newPassword.length >= PASSWORD_MIN_LENGTH ? getPasswordPolicyError(newPassword) : null
    if (policyErr) {
      setError(policyErr)
      return
    }
    setError(null)
  }

  const handleSendCode = async () => {
    if (countdown > 0) return
    setIsLoading(true)
    setError(null)
    try {
      await apiService.sendCurrentPasswordResetCode()
      startCountdown()
      toast({ title: t('changePassword.codeSent') })
    } catch (err) {
      setError(extractErrorMessage(err, 'changePassword.errors.sendCodeFailed', undefined, 'profile'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const pwdErr = validateNewPassword()
    if (pwdErr) {
      setError(pwdErr)
      return
    }
    if (mode === 'change' && !oldPassword.trim()) {
      setError(t('changePassword.errors.oldRequired'))
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      if (mode === 'reset') {
        if (!/^\d{6}$/.test(verificationCode.trim())) {
          setError(t('changePassword.errors.codeInvalid'))
          return
        }
      }

      if (mode === 'change') {
        await apiService.changePassword({
          old_password: oldPassword,
          new_password: newPassword,
        } as PasswordChangeRequest)
      } else {
        await apiService.resetCurrentPassword({
          verification_code: verificationCode.trim(),
          new_password: newPassword,
        } as CurrentUserPasswordResetRequest)
      }
      toast({ title: t('changePassword.success'), description: t('changePassword.successRelogin') })
      handleOpenChange(false)
      // 后端改密成功会失效所有会话，引导重新登录
      await logout('password_changed')
      onPasswordChanged?.()
    } catch (err) {
      setError(extractErrorMessage(err, 'changePassword.errors.failed', undefined, 'profile'))
    } finally {
      setIsLoading(false)
    }
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
    setOldPassword('')
    setVerificationCode('')
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('changePassword.title')}</DialogTitle>
          <DialogDescription>
            {mode === 'change'
              ? t('changePassword.descChange')
              : (resetIdentifier || displayIdentifier)
                ? t('changePassword.descReset', { identifier: maskIdentifier(resetIdentifier || displayIdentifier) })
                : t('changePassword.descResetNoContact')}
          </DialogDescription>
        </DialogHeader>

        {/* space-y-4：与改密弹窗原版字段间距一致；Caps Lock 叠在缝隙内不额外撑高 */}
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          {mode === 'change' ? (
            <div>
              <label className="text-body text-foreground mb-1.5 block">
                {t('changePassword.labels.oldPassword')}
              </label>
              <div className="relative" onMouseLeave={() => setShowOld(false)}>
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type={showOld ? 'text' : 'password'}
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                  {...oldPasswordCapsLock.inputHandlers}
                  placeholder={t('changePassword.placeholders.oldPassword')}
                  className={cn(SETTINGS_CONTROL, 'pl-10 pr-10')}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowOld((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showOld ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                <CapsLockHint show={oldPasswordCapsLock.capsLockOn} label={t('changePassword.capsLockHint')} />
              </div>
            </div>
          ) : null}

          <div>
            <label className="text-body text-foreground mb-1.5 block">
              {t('changePassword.labels.newPassword')}
            </label>
            <div className="relative" onMouseLeave={() => setShowNew(false)}>
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type={showNew ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => handleNewPasswordChange(e.target.value)}
                {...newPasswordCapsLock.inputHandlers}
                placeholder={t('changePassword.placeholders.newPassword')}
                className={cn(SETTINGS_CONTROL, 'pl-10 pr-10')}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowNew((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
              <CapsLockHint show={newPasswordCapsLock.capsLockOn} label={t('changePassword.capsLockHint')} />
            </div>
          </div>

          <div>
            <label className="text-body text-foreground mb-1.5 block">
              {t('changePassword.labels.confirmPassword')}
            </label>
            <div className="relative" onMouseLeave={() => setShowConfirm(false)}>
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type={showConfirm ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => handleConfirmPasswordChange(e.target.value)}
                {...confirmPasswordCapsLock.inputHandlers}
                placeholder={t('changePassword.placeholders.confirmPassword')}
                className={cn(SETTINGS_CONTROL, 'pl-10 pr-10')}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowConfirm((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
              <CapsLockHint show={confirmPasswordCapsLock.capsLockOn} label={t('changePassword.capsLockHint')} />
            </div>
            <PasswordRuleHints password={newPassword} className="mt-2" />
          </div>

          {mode === 'reset' ? (
            <div>
              <label className="text-body text-foreground mb-1.5 block">
                {t('changePassword.labels.verificationCode')}
              </label>
              <div className="flex items-stretch gap-2">
                <Input
                  type="text"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value)}
                  placeholder={t('changePassword.placeholders.verificationCode')}
                  maxLength={6}
                  className={cn('flex-1', SETTINGS_CONTROL)}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSendCode}
                  disabled={isLoading || countdown > 0}
                  className="shrink-0"
                >
                  {countdown > 0
                    ? t('countdown', { ns: 'common', count: countdown })
                    : t('changePassword.actions.sendCode')}
                </Button>
              </div>
            </div>
          ) : null}

          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
              <p className="text-body text-destructive">{error}</p>
            </div>
          )}

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
            {t('changePassword.actions.submit')}
          </Button>

          <div className="mt-3 text-center">
            {mode === 'change' ? (
              <button
                type="button"
                onClick={() => switchMode('reset')}
                className={cn(SETTINGS_TEXT_META, 'hover:text-foreground transition-colors')}
              >
                {t('changePassword.actions.forgotOld')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => switchMode('change')}
                className={cn(SETTINGS_TEXT_META, 'hover:text-foreground transition-colors')}
              >
                {t('changePassword.actions.useOldPassword')}
              </button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
