/**
 * SidebarAuthInline — 侧边栏 inline 登录 / 注册组件
 *
 * 设计意图：
 * 桌面应用未登录态下侧边栏本就空着，与其点按钮再弹一个 Dialog 遮住主区域
 * 的产品介绍，不如直接在侧边栏里完成 auth 流程。这样：
 *   1. 零多余点击 — 看到表单立刻就能填
 *   2. 主区域的 hero + Demo 始终可见，转化路径不被打断
 *   3. 符合 TabTin "看得见的工作" 哲学：登录这件事也"看得见"，不藏在模态里
 *
 * 与全屏 LoginForm/RegisterForm 的区别：
 *   - 视觉为 ~200px 内容宽度优化（输入框无 Label，placeholder 表达字段）
 *   - 字段简化（注册仅需手机号 / 密码 / 确认密码 / 验证码 4 个，username/nickname 注册后可补）
 *   - 业务逻辑直接复用 useAuthStore 的 login / loginWithVerificationCode / register 方法
 *   - 登录支持密码 / 验证码两种方式（与全屏一致）
 */

import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Eye, EyeOff, Languages, Lock, KeyRound, Mail, Smartphone, Sun } from 'lucide-react'
import {
  Button,
  Input,
  LoadingSpinner,
  toast,
} from '@tabtin/smartsheet-ui'
import { useShallow } from 'zustand/react/shallow'
import { selectNeedsInviteCode, useAuthStore } from '@stores/useAuthStore'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'
import { useI18nStore } from '@stores/useI18nStore'
import { useUIStore } from '@stores/useUIStore'
import { useTranslation } from 'react-i18next'
import { LANGUAGE_NATIVE_LABELS, type LanguagePreference } from '@/i18n/language'
import { sanitizeNewPasswordInput } from '@tabtin/shared'
import { useCountdown } from '@tabtin/shared/use-countdown'
import {
  useLoginForm,
  useRegisterForm,
  SMS_CODE_MAX_LENGTH,
  sanitizeAuthIdentifierInput,
  normalizeAuthIdentifier,
  isValidAuthIdentifier,
} from '@tabtin/shared/auth-forms'
import { useCapsLockWarning } from '@tabtin/shared/use-caps-lock-warning'
import { AUTH_EMAIL_LOGIN_ENABLED } from '@/utils/featureFlags'
import apiService from '@services/api'
import { extractErrorMessage, resolveStoredErrorMessage } from '@utils/extract-api-error'
import { cn } from '@utils/cn'
import { getResetPasswordLocalError } from './passwordValidation'
import { CN_MOBILE_PHONE_MAX_LENGTH } from './phoneInput'
import { CapsLockHint } from './CapsLockHint'
import { PasswordRuleHints } from './PasswordRuleHints'
import { TABTIN_APP_ICON_URL } from '@/constants/appIcon'
import { InviteCodeContactStrip } from './InviteCodeAcquireCard'
import { resolveInitialAuthEntryMode } from './authEntryMode'

type Mode = 'login' | 'register' | 'forgot'
const USER_AGREEMENT_URL = import.meta.env.VITE_USER_AGREEMENT_URL?.trim() ?? ''
const PRIVACY_POLICY_URL = import.meta.env.VITE_PRIVACY_POLICY_URL?.trim() ?? ''

export const SidebarAuthInline: React.FC = () => {
  const { t } = useTranslation('auth')
  const [mode, setMode] = useState<Mode>(() =>
    resolveInitialAuthEntryMode(typeof window === 'undefined' ? undefined : window.localStorage),
  )
  const setError = useAuthStore(s => s.setError)
  const needsInviteCode = useAuthStore(selectNeedsInviteCode)

  const switchMode = (nextMode: Mode) => {
    setError(null)
    setMode(nextMode)
  }

  return (
    // 外层填满侧边栏剩余空间 + 允许滚动；内层 min-h-full + justify-center 让内容垂直居中，
    // 当注册表单较高时自然推上去并保留滚动能力。
    <div className="relative flex-1 overflow-y-auto select-none [&_input]:select-text [&_textarea]:select-text">
      <div className="min-h-full flex flex-col justify-center px-3 py-8 pb-20">
        {/* 品牌 */}
        <div className="flex flex-col items-center gap-2.5 mb-7 shrink-0">
          <img
            src={TABTIN_APP_ICON_URL}
            alt=""
            aria-hidden="true"
            className="h-12 w-12 rounded-xl"
          />
          <div className="text-center space-y-1">
            <div className="text-subtitle font-semibold text-foreground leading-tight">
              TabTin
            </div>
            <div
              className={cn(
                'leading-snug',
                mode === 'login' || needsInviteCode
                  ? 'text-caption text-muted-foreground/60'
                  : 'text-body text-muted-foreground',
              )}
            >
              {needsInviteCode
                ? t('sidebar.tagline.invite', { defaultValue: 'Complete invite verification' })
                : mode === 'login'
                  ? t('sidebar.tagline.login', { defaultValue: 'Visible AI work' })
                  : mode === 'register'
                  ? t('sidebar.tagline.register', { defaultValue: 'Create your account' })
                  : t('sidebar.tagline.forgot', { defaultValue: 'Reset your password' })}
            </div>
          </div>
        </div>

        {/* 表单（带柔和切换动画） */}
        <AnimatePresence mode="wait">
          {needsInviteCode ? (
            <InviteCodePanel key="invite" onBackToLogin={() => setMode('login')} />
          ) : mode === 'login' ? (
            <LoginPanel
              key="login"
              onSwitchRegister={() => switchMode('register')}
              onForgot={() => switchMode('forgot')}
            />
          ) : mode === 'register' ? (
            <RegisterPanel key="register" onSwitchLogin={() => switchMode('login')} />
          ) : (
            <ForgotPanel key="forgot" onBackToLogin={() => switchMode('login')} />
          )}
        </AnimatePresence>
      </div>
      <GuestLanguageSwitch />
    </div>
  )
}

const GuestLanguageSwitch: React.FC = () => {
  const { t } = useTranslation('auth')
  const preference = useI18nStore(s => s.preference)
  const resolvedLanguage = useI18nStore(s => s.resolvedLanguage)
  const setPreference = useI18nStore(s => s.setPreference)
  const theme = useUIStore(s => s.theme)
  const setTheme = useUIStore(s => s.setTheme)
  const languageOptions: LanguagePreference[] = ['zh-CN', 'en-US']
  const themeOptions = [
    {
      value: 'light' as const,
      label: t('sidebar.theme.light', { defaultValue: 'Light' }),
    },
    {
      value: 'dark' as const,
      label: t('sidebar.theme.dark', { defaultValue: 'Dark' }),
    },
    {
      value: 'system' as const,
      label: t('sidebar.theme.system', { defaultValue: 'Auto' }),
    },
  ]

  return (
    <div className="absolute bottom-4 left-4 flex flex-col items-start gap-2">
      <div
        role="group"
        className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-muted/30 p-0.5"
        aria-label={t('sidebar.languageSwitch', { defaultValue: 'Switch language' })}
      >
        <Languages className="ml-2 h-3.5 w-3.5 text-muted-foreground/60" />
        {languageOptions.map((language) => {
          const active = preference === language || (preference === 'system' && resolvedLanguage === language)
          return (
            <button
              key={language}
              type="button"
              onClick={() => setPreference(language)}
              aria-pressed={active}
              className={cn(
                'rounded-full px-2 py-1 text-caption font-medium transition-all',
                // 选中态与登录方式分段（SegmentTab）统一：中性白底 pill + 轻阴影，不用主色淡底。
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {language === 'system'
                ? t('sidebar.language.system', { defaultValue: 'Auto' })
                : LANGUAGE_NATIVE_LABELS[language]}
            </button>
          )
        })}
      </div>

      <div
        role="group"
        className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-muted/30 p-0.5"
        aria-label={t('sidebar.themeSwitch', { defaultValue: 'Switch appearance' })}
      >
        <Sun className="ml-2 h-3.5 w-3.5 text-muted-foreground/60" />
        {themeOptions.map(({ value, label }) => {
          const active = theme === value
          return (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              aria-pressed={active}
              className={cn(
                'rounded-full px-2 py-1 text-caption font-medium transition-all',
                // 选中态与登录方式分段（SegmentTab）统一：中性白底 pill + 轻阴影，不用主色淡底。
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Login ───────────────────────────────────────────────────────────────────

const InviteCodePanel: React.FC<{ onBackToLogin: () => void }> = ({ onBackToLogin }) => {
  const { t } = useTranslation('auth')
  const { redeemInviteCode, logout, isLoading } = useAuthStore(
    useShallow(s => ({
      redeemInviteCode: s.redeemInviteCode,
      logout: s.logout,
      isLoading: s.isLoading,
    })),
  )
  const [inviteCode, setInviteCode] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedCode = inviteCode.trim()
    if (!trimmedCode) {
      setLocalError(t('invite.errors.required'))
      return
    }
    setLocalError(null)
    try {
      await redeemInviteCode(trimmedCode)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : t('invite.errors.verifyFailed'))
    }
  }

  return (
    <motion.form
      onSubmit={handleSubmit}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.15 }}
      className="space-y-3"
    >
      <InviteCodeContactStrip />

      <p className="text-caption text-muted-foreground/60">{t('invite.haveCode')}</p>

      <FieldWithIcon icon={<KeyRound className="h-3.5 w-3.5" />}>
        <Input
          type="text"
          value={inviteCode}
          onChange={e => {
            setInviteCode(e.target.value.toUpperCase())
            if (localError) setLocalError(null)
          }}
          placeholder={t('invite.placeholder.short')}
          className="pl-9 text-body"
          autoComplete="one-time-code"
          disabled={isLoading}
        />
      </FieldWithIcon>

      {localError && <InlineError message={localError} />}

      <Button
        type="submit"
        size="form"
        disabled={isLoading || inviteCode.trim().length === 0}
        className="w-full"
      >
        {isLoading ? <LoadingSpinner size="sm" /> : t('invite.actions.continue')}
      </Button>

      <button
        type="button"
        onClick={() => {
          void runWithAgentContextSwitchGuard('logout', async () => {
            await logout('manual')
            onBackToLogin()
          })
        }}
        disabled={isLoading}
        className="block w-full text-center text-caption text-muted-foreground hover:text-foreground transition-colors py-0.5 disabled:opacity-50"
      >
        {t('invite.actions.backToLogin')}
      </button>
    </motion.form>
  )
}

const LoginPanel: React.FC<{
  onSwitchRegister: () => void
  onForgot: () => void
}> = ({ onSwitchRegister, onForgot }) => {
  const { login, loginWithVerificationCode, isLoading, error, setError } = useAuthStore(
    useShallow(s => ({
      login: s.login,
      loginWithVerificationCode: s.loginWithVerificationCode,
      isLoading: s.isLoading,
      error: s.error,
      setError: s.setError,
    })),
  )
  const { t } = useTranslation('auth')
  const displayError = resolveStoredErrorMessage(error)
  const passwordCapsLock = useCapsLockWarning()
  const [showPassword, setShowPassword] = useState(false)

  const form = useLoginForm({
    login,
    loginWithVerificationCode,
    sendVerificationCode: apiService.sendVerificationCode.bind(apiService),
    error: displayError,
    setError,
    translate: t,
    extractError: (err, key) => extractErrorMessage(err, key, undefined, 'auth'),
    initialMethod: 'verification',
    emailLoginEnabled: AUTH_EMAIL_LOGIN_ENABLED,
  })

  // 侧栏窄版单行展示：字段错误优先，其次服务端错误。
  const errMsg = form.firstFieldError ?? form.submitError

  return (
    <motion.form
      onSubmit={form.submit}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.15 }}
      className="space-y-3"
    >
      {/* 登录方式切换 */}
      <div className="flex rounded-lg border border-border/60 bg-muted/30 p-1 gap-1">
        <SegmentTab
          active={form.method === 'password'}
          onClick={() => form.switchMethod('password')}
        >
          {t('loginForm.method.password', { defaultValue: 'Password' })}
        </SegmentTab>
        <SegmentTab
          active={form.method === 'verification'}
          onClick={() => form.switchMethod('verification')}
        >
          {t('loginForm.method.code', { defaultValue: 'Verification code' })}
        </SegmentTab>
      </div>

      <FieldWithIcon icon={AUTH_EMAIL_LOGIN_ENABLED ? <Mail className="h-3.5 w-3.5" /> : <Smartphone className="h-3.5 w-3.5" />}>
        <Input
          type={AUTH_EMAIL_LOGIN_ENABLED ? 'text' : 'tel'}
          inputMode={AUTH_EMAIL_LOGIN_ENABLED ? 'text' : 'numeric'}
          maxLength={AUTH_EMAIL_LOGIN_ENABLED ? undefined : CN_MOBILE_PHONE_MAX_LENGTH}
          value={form.username}
          onChange={e => form.setField('username', e.target.value)}
          placeholder={t(
            AUTH_EMAIL_LOGIN_ENABLED ? 'loginForm.placeholders.emailOrPhone' : 'loginForm.placeholders.username',
            { defaultValue: AUTH_EMAIL_LOGIN_ENABLED ? 'Email or phone' : 'Phone' },
          )}
          className="pl-9 text-body"
          autoComplete={AUTH_EMAIL_LOGIN_ENABLED ? 'username' : 'tel'}
        />
      </FieldWithIcon>

      {form.method === 'password' ? (
        <div className="relative">
          <FieldWithIcon icon={<Lock className="h-3.5 w-3.5" />}>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={e => form.setField('password', e.target.value)}
              {...passwordCapsLock.inputHandlers}
              placeholder={t('loginForm.placeholders.password', {
                defaultValue: 'Password',
              })}
              className="pl-9 pr-9 text-body"
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              aria-label={
                showPassword
                  ? t('loginForm.actions.hidePassword', { defaultValue: 'Hide password' })
                  : t('loginForm.actions.showPassword', { defaultValue: 'Show password' })
              }
            >
              {showPassword ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </button>
          </FieldWithIcon>
          <CapsLockHint
            show={passwordCapsLock.capsLockOn}
            label={t('capsLock.hint', { defaultValue: 'Caps Lock is on' })}
          />
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-stretch gap-1.5">
            <FieldWithIcon
              icon={<KeyRound className="h-3.5 w-3.5" />}
              className="flex-1 min-w-0"
            >
              <Input
                type="text"
                value={form.verificationCode}
                onChange={e => form.setField('verificationCode', e.target.value)}
                placeholder={t('loginForm.placeholders.verificationCode', {
                  defaultValue: 'Verification code',
                })}
                maxLength={SMS_CODE_MAX_LENGTH}
                className="pl-9 text-body"
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </FieldWithIcon>
            <Button
              type="button"
              variant="outline"
              size="form"
              onClick={form.sendCode}
              disabled={form.codeSending || form.countdown > 0}
              className="shrink-0 px-2.5 text-caption font-medium"
            >
              {form.codeSending ? (
                <LoadingSpinner size="sm" />
              ) : form.countdown > 0 ? (
                `${form.countdown}s`
              ) : (
                t('loginForm.actions.sendCode', { defaultValue: 'Send code' })
              )}
            </Button>
          </div>
          <p className="text-caption text-muted-foreground/80 leading-relaxed">
            {t(
              AUTH_EMAIL_LOGIN_ENABLED
                ? 'loginForm.hints.autoRegisterOnCodeLoginEmailOrPhone'
                : 'loginForm.hints.autoRegisterOnCodeLogin',
              {
                defaultValue: AUTH_EMAIL_LOGIN_ENABLED
                  ? 'If you do not have an account yet, code sign-in will create one.'
                  : 'If this phone number is not registered, code sign-in will create an account and sign you in.',
              },
            )}
          </p>
        </div>
      )}

      {form.successMessage && !errMsg && (
        <p className="text-caption text-success">{form.successMessage}</p>
      )}
      {errMsg && <InlineError message={errMsg} />}

      <Button
        type="submit"
        size="form"
        disabled={isLoading || !form.canSubmit}
        className="w-full"
      >
        {isLoading ? (
          <LoadingSpinner size="sm" />
        ) : (
          t('loginForm.actions.login', { defaultValue: 'Sign in' })
        )}
      </Button>

      {form.method === 'password' && (
        <button
          type="button"
          onClick={onForgot}
          className="block w-full text-center text-caption text-muted-foreground hover:text-foreground transition-colors py-0.5"
        >
          {t('loginForm.actions.forgotPassword', { defaultValue: 'Forgot password?' })}
        </button>
      )}

      <button
        type="button"
        onClick={onSwitchRegister}
        className="group mx-auto flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-caption text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground"
      >
        <span>{t('loginForm.noAccount', { defaultValue: 'No account yet?' })}</span>
        <span className="font-medium text-accent transition-colors group-hover:text-accent">
          {t('loginForm.actions.registerNow', { defaultValue: 'Create one' })}
        </span>
      </button>
    </motion.form>
  )
}

// ── Register ────────────────────────────────────────────────────────────────

const RegisterPanel: React.FC<{ onSwitchLogin: () => void }> = ({
  onSwitchLogin,
}) => {
  const { register, isLoading, error, setError } = useAuthStore(
    useShallow(s => ({
      register: s.register,
      isLoading: s.isLoading,
      error: s.error,
      setError: s.setError,
    })),
  )
  const { t } = useTranslation('auth')
  const passwordCapsLock = useCapsLockWarning()
  const confirmPasswordCapsLock = useCapsLockWarning()
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [termsAccepted, setTermsAccepted] = useState(true)

  const openExternalLink = (url: string) => {
    if (!url) return
    void window.tabtin?.openExternal?.(url)
  }

  const form = useRegisterForm({
    register,
    sendVerificationCode: apiService.sendVerificationCode.bind(apiService),
    error,
    setError,
    translate: t,
    extractError: (err, key) => extractErrorMessage(err, key, undefined, 'auth'),
    emailLoginEnabled: AUTH_EMAIL_LOGIN_ENABLED,
  })

  // 侧栏窄版单行展示：字段错误优先，其次服务端错误。
  const errMsg = form.firstFieldError ?? form.submitError

  return (
    <motion.form
      onSubmit={form.submit}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.15 }}
      className="space-y-3"
    >
      <FieldWithIcon icon={AUTH_EMAIL_LOGIN_ENABLED ? <Mail className="h-3.5 w-3.5" /> : <Smartphone className="h-3.5 w-3.5" />}>
        <Input
          type={AUTH_EMAIL_LOGIN_ENABLED ? 'text' : 'tel'}
          value={form.phone}
          onChange={e => form.setField('phone', e.target.value)}
          placeholder={t(
            AUTH_EMAIL_LOGIN_ENABLED ? 'registerForm.placeholders.emailOrPhone' : 'registerForm.placeholders.phone',
            { defaultValue: AUTH_EMAIL_LOGIN_ENABLED ? 'Email or phone' : 'Phone' },
          )}
          maxLength={AUTH_EMAIL_LOGIN_ENABLED ? undefined : CN_MOBILE_PHONE_MAX_LENGTH}
          className="pl-9 text-body"
          inputMode={AUTH_EMAIL_LOGIN_ENABLED ? 'text' : 'numeric'}
          autoComplete={AUTH_EMAIL_LOGIN_ENABLED ? 'username' : 'tel'}
        />
      </FieldWithIcon>

      <div className="relative">
        <FieldWithIcon icon={<Lock className="h-3.5 w-3.5" />}>
          <Input
            type={showPassword ? 'text' : 'password'}
            value={form.password}
            onChange={e => form.setField('password', e.target.value)}
            {...passwordCapsLock.inputHandlers}
            placeholder={t('registerForm.placeholders.password', {
              defaultValue: 'Set a password',
            })}
            className="pl-9 pr-9 text-body"
            autoComplete="new-password"
          />
          <button
            type="button"
            onClick={() => setShowPassword(v => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={
              showPassword
                ? t('registerForm.actions.hidePassword', { defaultValue: 'Hide password' })
                : t('registerForm.actions.showPassword', { defaultValue: 'Show password' })
            }
          >
            {showPassword ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </button>
        </FieldWithIcon>
        <CapsLockHint
          show={passwordCapsLock.capsLockOn}
          label={t('capsLock.hint', { defaultValue: 'Caps Lock is on' })}
        />
      </div>

      <div className="relative">
        <FieldWithIcon icon={<Lock className="h-3.5 w-3.5" />}>
          <Input
            type={showConfirmPassword ? 'text' : 'password'}
            value={form.confirmPassword}
            onChange={e => form.setField('confirmPassword', e.target.value)}
            {...confirmPasswordCapsLock.inputHandlers}
            placeholder={t('registerForm.placeholders.confirmPassword', {
              defaultValue: 'Re-enter password',
            })}
            className="pl-9 pr-9 text-body"
            autoComplete="new-password"
          />
          <button
            type="button"
            onClick={() => setShowConfirmPassword(v => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={
              showConfirmPassword
                ? t('registerForm.actions.hideConfirmPassword', {
                    defaultValue: 'Hide confirm password',
                  })
                : t('registerForm.actions.showConfirmPassword', {
                    defaultValue: 'Show confirm password',
                  })
            }
          >
            {showConfirmPassword ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </button>
        </FieldWithIcon>
        <CapsLockHint
          show={confirmPasswordCapsLock.capsLockOn}
          label={t('capsLock.hint', { defaultValue: 'Caps Lock is on' })}
        />
      </div>

      <PasswordRuleHints password={form.password} className="px-0.5" />

      <div className="flex items-stretch gap-1.5">
        <FieldWithIcon
          icon={<KeyRound className="h-3.5 w-3.5" />}
          className="flex-1 min-w-0"
        >
          <Input
            type="text"
            value={form.verificationCode}
            onChange={e => form.setField('verificationCode', e.target.value)}
            placeholder={t('registerForm.placeholders.verificationCode', {
              defaultValue: 'Verification code',
            })}
            maxLength={6}
            className="pl-9 text-body"
            inputMode="numeric"
            autoComplete="one-time-code"
          />
        </FieldWithIcon>
        <Button
          type="button"
          variant="outline"
          size="form"
          onClick={form.sendCode}
          disabled={form.codeSending || form.countdown > 0}
          className="shrink-0 px-2.5 text-caption font-medium"
        >
          {form.codeSending ? (
            <LoadingSpinner size="sm" />
          ) : form.countdown > 0 ? (
            `${form.countdown}s`
          ) : (
            t('registerForm.actions.sendCode', { defaultValue: 'Send code' })
          )}
        </Button>
      </div>

      {form.successMessage && !errMsg && (
        <p className="text-caption text-success">{form.successMessage}</p>
      )}
      {errMsg && <InlineError message={errMsg} />}

      <div className="flex items-start gap-2 px-0.5 text-caption text-muted-foreground">
        <input
          type="checkbox"
          aria-label={t('registerForm.terms.ariaLabel', {
            defaultValue: 'Read and agree to the User Agreement and Privacy Policy',
          })}
          checked={termsAccepted}
          onChange={e => setTermsAccepted(e.target.checked)}
          className="mt-0.5 shrink-0 rounded border-border text-primary focus:ring-primary"
        />
        <span className="min-w-0 leading-relaxed">
          {t('registerForm.terms.prefix', { defaultValue: 'I have read and agree to the ' })}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              openExternalLink(USER_AGREEMENT_URL)
            }}
            className="text-accent hover:underline"
          >
            {t('registerForm.terms.userAgreement', { defaultValue: 'User Agreement' })}
          </button>
          {t('registerForm.terms.middle', { defaultValue: ' and ' })}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              openExternalLink(PRIVACY_POLICY_URL)
            }}
            className="text-accent hover:underline"
          >
            {t('registerForm.terms.privacyPolicy', { defaultValue: 'Privacy Policy' })}
          </button>
          {t('registerForm.terms.suffix', { defaultValue: '' })}
        </span>
      </div>

      <Button
        type="submit"
        size="form"
        disabled={isLoading || !form.canSubmit || !termsAccepted}
        className="w-full"
      >
        {isLoading ? (
          <LoadingSpinner size="sm" />
        ) : (
          t('registerForm.actions.register', { defaultValue: 'Create account and sign in' })
        )}
      </Button>

      <button
        type="button"
        onClick={onSwitchLogin}
        className="group mx-auto flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-caption text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground"
      >
        <span>{t('registerForm.noAccount', { defaultValue: 'Already have an account?' })}</span>
        <span className="font-medium text-accent transition-colors group-hover:text-accent">
          {t('registerForm.actions.loginNow', { defaultValue: 'Sign in' })}
        </span>
      </button>
    </motion.form>
  )
}

// ── Forgot Password ──────────────────────────────────────────────────────────
// 侧栏内联忘记密码：布局与注册面板一致（单页四字段 + 缝隙内 Caps Lock），
// 后端仍走 apiService.forgotPassword / resetPassword。

const ForgotPanel: React.FC<{ onBackToLogin: () => void }> = ({
  onBackToLogin,
}) => {
  const { t } = useTranslation('auth')
  const [username, setUsername] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [codeSending, setCodeSending] = useState(false)
  const { countdown, start } = useCountdown(60)
  const [localError, setLocalError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const newPasswordCapsLock = useCapsLockWarning()
  const confirmPasswordCapsLock = useCapsLockWarning()

  const update = (
    setter: React.Dispatch<React.SetStateAction<string>>,
    value: string,
  ) => {
    setter(value)
    if (localError) setLocalError(null)
  }

  const updateUsername = (value: string) => {
    setUsername(sanitizeAuthIdentifierInput(value, AUTH_EMAIL_LOGIN_ENABLED))
    if (localError) setLocalError(null)
  }

  /** 新密码 / 确认密码：与改密 / 全屏忘记密码同口径（剔空格 + 拒汉字）。 */
  const updateNewPasswordField = (
    setter: React.Dispatch<React.SetStateAction<string>>,
    raw: string,
  ) => {
    const { value, notice } = sanitizeNewPasswordInput(raw)
    setter(value)
    if (notice === 'cjk') {
      setLocalError(
        t('forgotForm.errors.newPasswordNoCjk', {
          defaultValue: 'Password cannot contain CJK characters; do not paste other content',
        }),
      )
      return
    }
    if (notice === 'whitespace') {
      setLocalError(
        t('forgotForm.errors.newPasswordNoWhitespace', {
          defaultValue: 'Password cannot contain spaces; spaces have been removed',
        }),
      )
      return
    }
    if (localError) setLocalError(null)
  }

  const validateResetIdentifier = (): string | null => {
    const id = username.trim()
    if (!id) {
      setLocalError(
        t(
          AUTH_EMAIL_LOGIN_ENABLED
            ? 'forgotForm.errors.usernameRequiredEmailOrPhone'
            : 'forgotForm.errors.usernameRequired',
          {
            defaultValue: AUTH_EMAIL_LOGIN_ENABLED
              ? 'Please enter email or phone number'
              : 'Please enter phone number',
          },
        ),
      )
      return null
    }
    if (!isValidAuthIdentifier(id, AUTH_EMAIL_LOGIN_ENABLED)) {
      setLocalError(
        t(
          AUTH_EMAIL_LOGIN_ENABLED && id.includes('@')
            ? 'forgotForm.errors.emailInvalid'
            : 'forgotForm.errors.usernameInvalid',
          { defaultValue: 'Please enter a valid phone number' },
        ),
      )
      return null
    }
    return normalizeAuthIdentifier(id)
  }

  const sendCode = async (): Promise<boolean> => {
    const id = validateResetIdentifier()
    if (!id) return false

    setCodeSending(true)
    try {
      await apiService.forgotPassword({ username: id })
      start()
      setSuccessMsg(
        t(
          AUTH_EMAIL_LOGIN_ENABLED
            ? 'forgotForm.success.codeSentEmailOrPhone'
            : 'forgotForm.success.codeSent',
          { defaultValue: AUTH_EMAIL_LOGIN_ENABLED ? 'Code sent to your email or phone' : 'Code sent' },
        ),
      )
      setLocalError(null)
      return true
    } catch (err) {
      setLocalError(
        extractErrorMessage(
          err,
          'forgotForm.errors.sendCodeFailed',
          undefined,
          'auth',
        ),
      )
      setSuccessMsg(null)
      return false
    } finally {
      setCodeSending(false)
    }
  }

  const handleResend = async () => {
    if (countdown > 0) return
    await sendCode()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError(null)

    const passwordError = getResetPasswordLocalError(newPassword, t)
    if (passwordError) {
      return setLocalError(passwordError)
    }
    if (newPassword !== confirm) {
      return setLocalError(
        t('forgotForm.errors.confirmPasswordMismatch', {
          defaultValue: 'Passwords do not match',
        }),
      )
    }
    const id = validateResetIdentifier()
    if (!id) return
    if (!code.trim()) {
      return setLocalError(
        t('forgotForm.errors.codeRequired', {
          defaultValue: 'Please enter verification code',
        }),
      )
    }
    if (!/^\d{6}$/.test(code.trim())) {
      return setLocalError(
        t('forgotForm.errors.codeInvalid', {
          defaultValue: 'Code should be 6 digits',
        }),
      )
    }

    setIsLoading(true)
    try {
      await apiService.resetPassword({
        username: id,
        verification_code: code.trim(),
        new_password: newPassword,
      })
      toast({
        title: t('forgotForm.success.resetSuccess', {
          defaultValue: 'Password reset successful. Please sign in with the new password',
        }),
      })
      onBackToLogin()
    } catch (err) {
      setLocalError(
        extractErrorMessage(
          err,
          'forgotForm.errors.resetFailed',
          undefined,
          'auth',
        ),
      )
    } finally {
      setIsLoading(false)
    }
  }

  const errMsg = localError
  const busy = isLoading || codeSending
  const canSubmit =
    username.trim().length > 0 &&
    newPassword.trim().length > 0 &&
    confirm.trim().length > 0 &&
    code.trim().length > 0

  return (
    <motion.form
      onSubmit={handleSubmit}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.15 }}
      className="space-y-3"
    >
      <FieldWithIcon icon={AUTH_EMAIL_LOGIN_ENABLED ? <Mail className="h-3.5 w-3.5" /> : <Smartphone className="h-3.5 w-3.5" />}>
        <Input
          type={AUTH_EMAIL_LOGIN_ENABLED ? 'text' : 'tel'}
          value={username}
          onChange={e => updateUsername(e.target.value)}
          placeholder={t(
            AUTH_EMAIL_LOGIN_ENABLED ? 'forgotForm.placeholders.emailOrPhone' : 'forgotForm.placeholders.username',
            { defaultValue: AUTH_EMAIL_LOGIN_ENABLED ? 'Email or phone' : 'Phone' },
          )}
          maxLength={AUTH_EMAIL_LOGIN_ENABLED ? undefined : CN_MOBILE_PHONE_MAX_LENGTH}
          inputMode={AUTH_EMAIL_LOGIN_ENABLED ? 'text' : 'numeric'}
          className="pl-9 text-body"
          autoComplete={AUTH_EMAIL_LOGIN_ENABLED ? 'username' : 'tel'}
        />
      </FieldWithIcon>

      <div className="relative">
        <FieldWithIcon icon={<Lock className="h-3.5 w-3.5" />}>
          <Input
            type={showNewPassword ? 'text' : 'password'}
            value={newPassword}
            onChange={e => updateNewPasswordField(setNewPassword, e.target.value)}
            {...newPasswordCapsLock.inputHandlers}
            placeholder={t('forgotForm.placeholders.newPassword', {
              defaultValue: 'Set a new password',
            })}
            className="pl-9 pr-9 text-body"
            autoComplete="new-password"
          />
          <button
            type="button"
            onClick={() => setShowNewPassword(v => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={
              showNewPassword
                ? t('forgotForm.actions.hideNewPassword')
                : t('forgotForm.actions.showNewPassword')
            }
          >
            {showNewPassword ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </button>
        </FieldWithIcon>
        <CapsLockHint
          show={newPasswordCapsLock.capsLockOn}
          label={t('capsLock.hint', { defaultValue: 'Caps Lock is on' })}
        />
      </div>

      <div className="relative">
        <FieldWithIcon icon={<Lock className="h-3.5 w-3.5" />}>
          <Input
            type={showConfirmPassword ? 'text' : 'password'}
            value={confirm}
            onChange={e => updateNewPasswordField(setConfirm, e.target.value)}
            {...confirmPasswordCapsLock.inputHandlers}
            placeholder={t('sidebar.forgot.placeholders.confirmPassword', {
              defaultValue: 'Confirm new password',
            })}
            className="pl-9 pr-9 text-body"
            autoComplete="new-password"
          />
          <button
            type="button"
            onClick={() => setShowConfirmPassword(v => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={
              showConfirmPassword
                ? t('forgotForm.actions.hideConfirmPassword')
                : t('forgotForm.actions.showConfirmPassword')
            }
          >
            {showConfirmPassword ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </button>
        </FieldWithIcon>
        <CapsLockHint
          show={confirmPasswordCapsLock.capsLockOn}
          label={t('capsLock.hint', { defaultValue: 'Caps Lock is on' })}
        />
      </div>

      <PasswordRuleHints password={newPassword} className="px-0.5" />

      <div className="flex items-stretch gap-1.5">
        <FieldWithIcon
          icon={<KeyRound className="h-3.5 w-3.5" />}
          className="flex-1 min-w-0"
        >
          <Input
            type="text"
            value={code}
            onChange={e => update(setCode, e.target.value)}
            placeholder={t('sidebar.forgot.placeholders.verificationCode', {
              defaultValue: '6-digit code',
            })}
            maxLength={6}
            className="pl-9 text-body"
            inputMode="numeric"
            autoComplete="one-time-code"
          />
        </FieldWithIcon>
        <Button
          type="button"
          variant="outline"
          size="form"
          onClick={() => void handleResend()}
          disabled={codeSending || countdown > 0}
          className="shrink-0 px-2.5 text-caption font-medium"
        >
          {codeSending ? (
            <LoadingSpinner size="sm" />
          ) : countdown > 0 ? (
            `${countdown}s`
          ) : (
            t('forgotForm.actions.sendCode', { defaultValue: 'Send code' })
          )}
        </Button>
      </div>

      {successMsg && !errMsg && (
        <p className="text-caption text-success">{successMsg}</p>
      )}
      {errMsg && <InlineError message={errMsg} />}

      <Button type="submit" size="form" disabled={busy || !canSubmit} className="w-full">
        {busy ? (
          <LoadingSpinner size="sm" />
        ) : (
          t('forgotForm.actions.reset', { defaultValue: 'Reset password' })
        )}
      </Button>

      <button
        type="button"
        onClick={onBackToLogin}
        className="block w-full text-center text-caption text-muted-foreground hover:text-foreground transition-colors py-1"
      >
        {t('forgotForm.actions.backToLogin', { defaultValue: 'Back to sign in' })}
      </button>
    </motion.form>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

const SegmentTab: React.FC<{
  active: boolean
  onClick: () => void
  children: React.ReactNode
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={cn(
      'flex-1 px-3 py-1.5 rounded-md text-caption font-medium transition-all',
      // 分段控件选中态用中性高亮（背景色 pill + 轻阴影），不用品牌主色——
      // 与全屏 LoginForm 的 formMethodSegmentClassName 一致。
      active
        ? 'bg-background text-foreground shadow-sm'
        : 'text-muted-foreground/80 hover:bg-background/60 hover:text-foreground',
    )}
  >
    {children}
  </button>
)

const FieldWithIcon: React.FC<{
  icon: React.ReactNode
  className?: string
  children: React.ReactNode
}> = ({ icon, className, children }) => (
  <div className={cn('relative', className)}>
    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
      {icon}
    </span>
    {children}
  </div>
)

const InlineError: React.FC<{ message: string }> = ({ message }) => (
  <p className="text-caption text-destructive leading-snug">{message}</p>
)
