import React, { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Eye, EyeOff, Lock, Mail, Smartphone } from 'lucide-react'
import {
  Button,
  Input,
  Form,
  FormField,
  FormLabel,
  FormMessage,
  LoadingSpinner,
} from '@tabtin/smartsheet-ui'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@stores/useAuthStore'
import { PasswordStrength } from '@/types/auth'
import apiService from '@/services/api'
import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core'
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common'
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en'
import { useTranslation } from 'react-i18next'
import { passwordHasSpecialChar } from '@tabtin/shared'
import { useRegisterForm, CN_MOBILE_PHONE_MAX_LENGTH } from '@tabtin/shared/auth-forms'
import { useCapsLockWarning } from '@tabtin/shared/use-caps-lock-warning'
import { AUTH_EMAIL_LOGIN_ENABLED } from '@/utils/featureFlags'
import { extractErrorMessage } from '@/utils/extract-api-error'
import { PasswordStrengthIndicator } from './PasswordStrengthIndicator'
import { PasswordRuleHints } from './PasswordRuleHints'
import { CapsLockHint } from './CapsLockHint'
import {
  formInputActionRowClassName,
  formInputGrowCellClassName,
  formOutlineCompanionClassName,
  formPrimaryFullWidthClassName,
} from '@/constants/formControlUi'

zxcvbnOptions.setOptions({
  graphs: zxcvbnCommonPackage.adjacencyGraphs,
  dictionary: {
    ...zxcvbnCommonPackage.dictionary,
    ...zxcvbnEnPackage.dictionary,
  },
})

const ZXCVBN_SCORE_MAP = [0, 20, 40, 70, 100] as const
const ZXCVBN_LEVEL_MAP = ['very_weak', 'weak', 'medium', 'strong', 'strong'] as const
const USER_AGREEMENT_URL = import.meta.env.VITE_USER_AGREEMENT_URL?.trim() ?? ''
const PRIVACY_POLICY_URL = import.meta.env.VITE_PRIVACY_POLICY_URL?.trim() ?? ''

function computePasswordStrength(password: string): PasswordStrength {
  const result = zxcvbn(password)
  const score = ZXCVBN_SCORE_MAP[result.score]
  const level = ZXCVBN_LEVEL_MAP[result.score]

  if (result.score >= 4) {
    return { score, level, suggestions: ['great'] }
  }

  const suggestions: string[] = []
  const hasUpper = /[A-Z]/.test(password)
  const hasLower = /[a-z]/.test(password)
  const hasDigit = /\d/.test(password)
  // ：与后端「非字母数字非空白」特殊字符口径对齐。
  const hasSpecial = passwordHasSpecialChar(password)

  if (result.score <= 1) {
    suggestions.push('tooSimple')
  }
  if (!hasUpper || !hasLower) suggestions.push('requireMixedCase')
  if (!hasDigit) suggestions.push('requireDigits')
  if (!hasSpecial) suggestions.push('requireSpecialChars')
  if (password.length < 10) suggestions.push('addLength')
  if (suggestions.length === 0) suggestions.push('moreCharTypes')

  return { score, level, suggestions }
}

interface RegisterFormProps {
  onSwitchToLogin: () => void
  onRegisterSuccess: () => void
}

export const RegisterForm: React.FC<RegisterFormProps> = ({
  onSwitchToLogin,
  onRegisterSuccess,
}) => {
  const { register, isLoading, error, setError } = useAuthStore(
    useShallow((s) => ({
      register: s.register,
      isLoading: s.isLoading,
      error: s.error,
      setError: s.setError,
    }))
  )
  const { t } = useTranslation('auth')

  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [termsAccepted, setTermsAccepted] = useState(true)
  const [passwordStrength, setPasswordStrength] = useState<PasswordStrength | null>(null)
  const passwordCapsLock = useCapsLockWarning()
  const confirmPasswordCapsLock = useCapsLockWarning()

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
    // 本地 zxcvbn 强度 <60 视为弱密码并拦截（与历史行为一致）。
    extraPasswordError: () =>
      passwordStrength && passwordStrength.score < 60
        ? t('registerForm.errors.passwordWeak')
        : null,
    onSuccess: onRegisterSuccess,
    emailLoginEnabled: AUTH_EMAIL_LOGIN_ENABLED,
  })

  useEffect(() => {
    if (form.password.length > 0) {
      setPasswordStrength(computePasswordStrength(form.password))
    } else {
      setPasswordStrength(null)
    }
  }, [form.password])

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="w-full max-w-md mx-auto"
    >
      <div className="text-center mb-8">
        <h1 className="text-heading font-semibold text-foreground mb-2">
          {t('registerForm.heading')}
        </h1>
        <p className="text-muted-foreground">
          {t(
            AUTH_EMAIL_LOGIN_ENABLED
              ? 'registerForm.subheadingEmailOrPhone'
              : 'registerForm.subheading',
          )}
        </p>
      </div>

      <Form onSubmit={form.submit}>
        {form.successMessage && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="p-3 bg-success/10 border border-success/20 rounded-lg mb-2"
          >
            <p className="text-body text-success">{form.successMessage}</p>
          </motion.div>
        )}
        {/* 手机号 / 邮箱 */}
        <FormField>
          <FormLabel htmlFor="phone">
            {t(AUTH_EMAIL_LOGIN_ENABLED ? 'registerForm.labels.emailOrPhone' : 'registerForm.labels.phone')}
          </FormLabel>
          <div className="relative">
            <Input
              id="phone"
              type={AUTH_EMAIL_LOGIN_ENABLED ? 'text' : 'tel'}
              value={form.phone}
              onChange={(e) => form.setField('phone', e.target.value)}
              placeholder={t(AUTH_EMAIL_LOGIN_ENABLED ? 'registerForm.placeholders.emailOrPhone' : 'registerForm.placeholders.phone')}
              className={`pl-10 ${form.fieldErrors.phone ? 'border-destructive' : ''}`}
              maxLength={AUTH_EMAIL_LOGIN_ENABLED ? undefined : CN_MOBILE_PHONE_MAX_LENGTH}
              inputMode={AUTH_EMAIL_LOGIN_ENABLED ? 'text' : 'numeric'}
              autoComplete={AUTH_EMAIL_LOGIN_ENABLED ? 'username' : 'tel'}
            />
            {AUTH_EMAIL_LOGIN_ENABLED ? (
              <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            ) : (
              <Smartphone className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            )}
          </div>
          {form.fieldErrors.phone && (
            <FormMessage>{form.fieldErrors.phone}</FormMessage>
          )}
        </FormField>

        {/* 密码 */}
        <FormField>
          <FormLabel htmlFor="password">{t('registerForm.labels.password')}</FormLabel>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={(e) => form.setField('password', e.target.value)}
              {...passwordCapsLock.inputHandlers}
              placeholder={t('registerForm.placeholders.password')}
              className={`pl-10 pr-10 ${form.fieldErrors.password ? 'border-destructive' : ''}`}
            />
            <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
            <CapsLockHint show={passwordCapsLock.capsLockOn} label={t('capsLock.hint')} />
          </div>
          <PasswordStrengthIndicator strength={passwordStrength} checking={false} />
          {form.fieldErrors.password && (
            <FormMessage>{form.fieldErrors.password}</FormMessage>
          )}
        </FormField>

        {/* 确认密码 */}
        <FormField>
          <FormLabel htmlFor="confirmPassword">{t('registerForm.labels.confirmPassword')}</FormLabel>
          <div className="relative">
            <Input
              id="confirmPassword"
              type={showConfirmPassword ? 'text' : 'password'}
              value={form.confirmPassword}
              onChange={(e) => form.setField('confirmPassword', e.target.value)}
              {...confirmPasswordCapsLock.inputHandlers}
              placeholder={t('registerForm.placeholders.confirmPassword')}
              className={`pl-10 pr-10 ${form.fieldErrors.confirmPassword ? 'border-destructive' : ''}`}
            />
            <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <button
              type="button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showConfirmPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
            <CapsLockHint show={confirmPasswordCapsLock.capsLockOn} label={t('capsLock.hint')} />
          </div>
          {form.fieldErrors.confirmPassword && (
            <FormMessage>{form.fieldErrors.confirmPassword}</FormMessage>
          )}
          <PasswordRuleHints password={form.password} className="mt-2" />
        </FormField>

        {/* 验证码 */}
        <FormField>
          <FormLabel htmlFor="verificationCode">{t('registerForm.labels.verificationCode')}</FormLabel>
          <div className={formInputActionRowClassName}>
            <div className={formInputGrowCellClassName}>
              <Input
                id="verificationCode"
                type="text"
                value={form.verificationCode}
                onChange={(e) => form.setField('verificationCode', e.target.value)}
                placeholder={t('registerForm.placeholders.verificationCode')}
                className={form.fieldErrors.verificationCode ? 'border-destructive' : ''}
                maxLength={6}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="form"
              onClick={form.sendCode}
              disabled={form.codeSending || form.countdown > 0}
              className={formOutlineCompanionClassName}
            >
              {form.codeSending ? (
                <LoadingSpinner size="sm" />
              ) : form.countdown > 0 ? (
                t('countdown', { ns: 'common', count: form.countdown })
              ) : (
                t('registerForm.actions.sendCode')
              )}
            </Button>
          </div>
          {form.fieldErrors.verificationCode && (
            <FormMessage>{form.fieldErrors.verificationCode}</FormMessage>
          )}
        </FormField>

        {/* 错误信息 */}
        {form.submitError && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg"
          >
            <p className="text-body text-destructive">{form.submitError}</p>
          </motion.div>
        )}

        {/* 协议确认 */}
        <div className="flex items-start gap-2 text-caption text-muted-foreground">
          <input
            type="checkbox"
            aria-label={t('registerForm.terms.ariaLabel')}
            checked={termsAccepted}
            onChange={(e) => setTermsAccepted(e.target.checked)}
            className="mt-0.5 rounded border-border text-primary focus:ring-primary"
          />
          <span className="leading-relaxed">
            {t('registerForm.terms.prefix')}
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                openExternalLink(USER_AGREEMENT_URL)
              }}
              className="text-primary hover:underline"
            >
              {t('registerForm.terms.userAgreement')}
            </button>
            {t('registerForm.terms.middle')}
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                openExternalLink(PRIVACY_POLICY_URL)
              }}
              className="text-primary hover:underline"
            >
              {t('registerForm.terms.privacyPolicy')}
            </button>
            {t('registerForm.terms.suffix')}
          </span>
        </div>

        {/* 注册按钮 */}
        <Button
          type="submit"
          size="form"
          className={formPrimaryFullWidthClassName}
          disabled={isLoading || !form.canSubmit || !termsAccepted}
        >
          {isLoading ? (
            <>
              <LoadingSpinner size="sm" className="mr-2" />
              {t('registerForm.actions.registering')}
            </>
          ) : (
            t('registerForm.actions.register')
          )}
        </Button>

        {/* 登录链接 */}
        <div className="text-center">
          <span className="text-body text-muted-foreground">
            {t('registerForm.noAccount')}{' '}
            <button
              type="button"
              onClick={() => {
                form.resetFeedback()
                onSwitchToLogin()
              }}
              className="text-primary hover:underline font-medium"
            >
              {t('registerForm.actions.loginNow')}
            </button>
          </span>
        </div>
      </Form>
    </motion.div>
  )
}
