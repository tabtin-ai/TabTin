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
import { useAuthStore } from '@/stores/auth-store'
import { authApi } from '@/services/auth-api'
import { extractErrorMessage } from '@/utils/extract-api-error'
import { PasswordStrengthIndicator } from './PasswordStrengthIndicator'
import type { PasswordStrength } from '@/types/auth'
import { useTranslation } from 'react-i18next'
import { useRegisterForm, CN_MOBILE_PHONE_MAX_LENGTH, parseEmailLoginEnabled } from '@tabtin/shared/auth-forms'
import { useCapsLockWarning } from '@tabtin/shared/use-caps-lock-warning'
import { CapsLockHint } from './CapsLockHint'

const AUTH_EMAIL_LOGIN_ENABLED = parseEmailLoginEnabled(
  import.meta.env.VITE_AUTH_EMAIL_LOGIN_ENABLED,
)

interface RegisterFormProps {
  onSwitchToLogin: () => void
  onRegisterSuccess: () => void
}

export const RegisterForm: React.FC<RegisterFormProps> = ({
  onSwitchToLogin,
  onRegisterSuccess,
}) => {
  const { register, isLoading, error } = useAuthStore()
  const { t } = useTranslation('auth')

  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [passwordStrength, setPasswordStrength] = useState<PasswordStrength | null>(null)
  const [checkingPassword, setCheckingPassword] = useState(false)
  const passwordCapsLock = useCapsLockWarning()
  const confirmPasswordCapsLock = useCapsLockWarning()

  const form = useRegisterForm({
    register,
    sendVerificationCode: authApi.sendVerificationCode,
    error,
    setError: (value) => useAuthStore.setState({ error: value }),
    translate: t,
    extractError: (err, key) => extractErrorMessage(err, key, undefined, 'auth'),
    onSuccess: onRegisterSuccess,
    emailLoginEnabled: AUTH_EMAIL_LOGIN_ENABLED,
  })

  useEffect(() => {
    const checkPassword = async () => {
      if (form.password.length >= 6) {
        setCheckingPassword(true)
        try {
          const strength = await authApi.checkPasswordStrength(form.password)
          setPasswordStrength(strength)
        } catch {
          // ignore
        } finally {
          setCheckingPassword(false)
        }
      } else {
        setPasswordStrength(null)
      }
    }
    const debounceTimer = setTimeout(checkPassword, 500)
    return () => clearTimeout(debounceTimer)
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
          {form.fieldErrors.phone && <FormMessage>{form.fieldErrors.phone}</FormMessage>}
        </FormField>

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
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
            <CapsLockHint show={passwordCapsLock.capsLockOn} label={t('capsLock.hint')} />
          </div>
          <PasswordStrengthIndicator strength={passwordStrength} checking={checkingPassword} />
          {form.fieldErrors.password && <FormMessage>{form.fieldErrors.password}</FormMessage>}
        </FormField>

        <FormField>
          <FormLabel htmlFor="confirmPassword">
            {t('registerForm.labels.confirmPassword')}
          </FormLabel>
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
        </FormField>

        <FormField>
          <FormLabel htmlFor="verificationCode">
            {t('registerForm.labels.verificationCode')}
          </FormLabel>
          <div className="flex gap-2">
            <Input
              id="verificationCode"
              type="text"
              value={form.verificationCode}
              onChange={(e) => form.setField('verificationCode', e.target.value)}
              placeholder={t('registerForm.placeholders.verificationCode')}
              className={`flex-1 ${form.fieldErrors.verificationCode ? 'border-destructive' : ''}`}
              maxLength={6}
            />
            <Button
              type="button"
              variant="outline"
              size="form"
              onClick={form.sendCode}
              disabled={form.codeSending || form.countdown > 0}
              className="whitespace-nowrap"
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

        {form.submitError && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg"
          >
            <p className="text-body text-destructive">{form.submitError}</p>
          </motion.div>
        )}

        <Button type="submit" className="w-full" disabled={isLoading || !form.canSubmit}>
          {isLoading ? (
            <>
              <LoadingSpinner size="sm" className="mr-2" />
              {t('registerForm.actions.registering')}
            </>
          ) : (
            t('registerForm.actions.register')
          )}
        </Button>

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
