import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Eye, EyeOff, Lock, Mail, Smartphone } from 'lucide-react'
import { Button, Input, Form, FormField, FormLabel, FormMessage, LoadingSpinner } from '@tabtin/smartsheet-ui'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@stores/useAuthStore'
import apiService from '@/services/api'
import { useTranslation } from 'react-i18next'
import { extractErrorMessage, resolveStoredErrorMessage } from '@/utils/extract-api-error'
import {
  useLoginForm,
  CN_MOBILE_PHONE_MAX_LENGTH,
  SMS_CODE_MAX_LENGTH,
} from '@tabtin/shared/auth-forms'
import { useCapsLockWarning } from '@tabtin/shared/use-caps-lock-warning'
import { AUTH_EMAIL_LOGIN_ENABLED } from '@/utils/featureFlags'
import { CapsLockHint } from './CapsLockHint'
import {
  formInputActionRowClassName,
  formInputGrowCellRelativeClassName,
  formMethodSegmentClassName,
  formOutlineCompanionClassName,
  formPrimaryFullWidthClassName,
} from '@/constants/formControlUi'

interface LoginFormProps {
  onSwitchToRegister: () => void
  onSwitchToForgotPassword: () => void
}

export const LoginForm: React.FC<LoginFormProps> = ({
  onSwitchToRegister,
  onSwitchToForgotPassword,
}) => {
  const { login, loginWithVerificationCode, isLoading, error, setError } = useAuthStore(
    useShallow((s) => ({
      login: s.login,
      loginWithVerificationCode: s.loginWithVerificationCode,
      isLoading: s.isLoading,
      error: s.error,
      setError: s.setError,
    }))
  )
  const { t } = useTranslation('auth')
  const [showPassword, setShowPassword] = useState(false)
  const displayError = resolveStoredErrorMessage(error)
  const { capsLockOn, inputHandlers } = useCapsLockWarning()

  const form = useLoginForm({
    login,
    loginWithVerificationCode,
    sendVerificationCode: apiService.sendVerificationCode.bind(apiService),
    error: displayError,
    setError,
    translate: t,
    extractError: (err, key) => extractErrorMessage(err, key, undefined, 'auth'),
    initialMethod: 'password',
    emailLoginEnabled: AUTH_EMAIL_LOGIN_ENABLED,
  })

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="w-full max-w-md mx-auto"
    >
      <div className="text-center mb-8">
        <h1 className="text-heading font-semibold text-foreground mb-2">
          {t('loginForm.heading')}
        </h1>
        <p className="text-muted-foreground">
          {t('loginForm.subheading')}
        </p>
      </div>

      {/* 登录方式切换 */}
      <div className="flex rounded-lg bg-muted p-1 mb-6 gap-1">
        <button
          type="button"
          onClick={() => form.switchMethod('password')}
          className={formMethodSegmentClassName(form.method === 'password')}
        >
          {t('loginForm.method.password')}
        </button>
        <button
          type="button"
          onClick={() => form.switchMethod('verification')}
          className={formMethodSegmentClassName(form.method === 'verification')}
        >
          {t('loginForm.method.code')}
        </button>
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
        {/* 手机号 / 邮箱输入（密码 / 验证码登录共用） */}
        <FormField>
          <FormLabel htmlFor="username">
            {t(AUTH_EMAIL_LOGIN_ENABLED ? 'loginForm.labels.emailOrPhone' : 'loginForm.labels.username')}
          </FormLabel>
          <div className="relative">
            <Input
              id="username"
              type={AUTH_EMAIL_LOGIN_ENABLED ? 'text' : 'tel'}
              inputMode={AUTH_EMAIL_LOGIN_ENABLED ? 'text' : 'numeric'}
              autoComplete={AUTH_EMAIL_LOGIN_ENABLED ? 'username' : 'tel'}
              maxLength={AUTH_EMAIL_LOGIN_ENABLED ? undefined : CN_MOBILE_PHONE_MAX_LENGTH}
              value={form.username}
              onChange={(e) => form.setField('username', e.target.value)}
              placeholder={t(AUTH_EMAIL_LOGIN_ENABLED ? 'loginForm.placeholders.emailOrPhone' : 'loginForm.placeholders.username')}
              className={`pl-10 ${form.fieldErrors.username ? 'border-destructive' : ''}`}
            />
            {AUTH_EMAIL_LOGIN_ENABLED ? (
              <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            ) : (
              <Smartphone className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            )}
          </div>
          {form.fieldErrors.username && (
            <FormMessage>{form.fieldErrors.username}</FormMessage>
          )}
        </FormField>

        {/* 密码登录 */}
        {form.method === 'password' && (
          <FormField>
            <FormLabel htmlFor="password">{t('loginForm.labels.password')}</FormLabel>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={(e) => form.setField('password', e.target.value)}
                {...inputHandlers}
                placeholder={t('loginForm.placeholders.password')}
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
              <CapsLockHint show={capsLockOn} label={t('capsLock.hint')} />
            </div>
            {form.fieldErrors.password && (
              <FormMessage>{form.fieldErrors.password}</FormMessage>
            )}
          </FormField>
        )}

        {/* 验证码登录 */}
        {form.method === 'verification' && (
          <div className="space-y-4">
            <FormField>
              <FormLabel htmlFor="verificationCode">{t('loginForm.labels.verificationCode')}</FormLabel>
              <div className={formInputActionRowClassName}>
                <div className={formInputGrowCellRelativeClassName}>
                  <Input
                    id="verificationCode"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={form.verificationCode}
                    onChange={(e) => form.setField('verificationCode', e.target.value)}
                    placeholder={t('loginForm.placeholders.verificationCode')}
                    className={`pl-10 ${form.fieldErrors.verificationCode ? 'border-destructive' : ''}`}
                    maxLength={SMS_CODE_MAX_LENGTH}
                  />
                  <Smartphone className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
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
                    t('loginForm.actions.sendCode')
                  )}
                </Button>
              </div>
              {form.fieldErrors.verificationCode && (
                <FormMessage>{form.fieldErrors.verificationCode}</FormMessage>
              )}
            </FormField>
            <p className="text-caption text-muted-foreground">
              {t(
                AUTH_EMAIL_LOGIN_ENABLED
                  ? 'loginForm.hints.autoRegisterOnCodeLoginEmailOrPhone'
                  : 'loginForm.hints.autoRegisterOnCodeLogin',
              )}
            </p>
          </div>
        )}

        {/* 记住我和忘记密码 */}
        <div className="flex items-center justify-between">
          <label className="flex items-center space-x-2 cursor-pointer group">
            <input
              type="checkbox"
              checked={form.rememberMe}
              onChange={(e) => form.setRememberMe(e.target.checked)}
              className="rounded border-border text-primary focus:ring-primary"
            />
            <span className="text-body text-muted-foreground">
              {t('loginForm.remember.label')}
              <span className="text-body text-muted-foreground ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {t('loginForm.remember.hint')}
              </span>
            </span>
          </label>

          {form.method === 'password' && (
            <button
              type="button"
              onClick={() => {
                form.resetFeedback()
                onSwitchToForgotPassword()
              }}
              className="text-body text-primary hover:underline"
            >
              {t('loginForm.actions.forgotPassword')}
            </button>
          )}
        </div>

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

        {/* 登录按钮 */}
        <Button
          type="submit"
          size="form"
          className={formPrimaryFullWidthClassName}
          disabled={isLoading || !form.canSubmit}
        >
          {isLoading ? (
            <>
              <LoadingSpinner size="sm" className="mr-2" />
              {t('loginForm.actions.loggingIn')}
            </>
          ) : (
            t('loginForm.actions.login')
          )}
        </Button>

        {/* 注册链接 */}
        <div className="text-center">
          <span className="text-body text-muted-foreground">
            {t('loginForm.noAccount')}{' '}
            <button
              type="button"
              onClick={() => {
                form.resetFeedback()
                onSwitchToRegister()
              }}
              className="text-primary hover:underline font-medium"
            >
              {t('loginForm.actions.registerNow')}
            </button>
          </span>
        </div>
      </Form>
    </motion.div>
  )
}
