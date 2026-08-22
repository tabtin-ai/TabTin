import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Mail, Smartphone, Lock, ArrowLeft, Eye, EyeOff } from 'lucide-react'
import { PasswordRuleHints } from './PasswordRuleHints'
import { Button, Input, Form, FormField, FormLabel, FormMessage, LoadingSpinner } from '@tabtin/smartsheet-ui'
import apiService from '@/services/api'
import { useTranslation } from 'react-i18next'
import { extractErrorMessage } from '@/utils/extract-api-error'
import { useForgotPasswordForm, CN_MOBILE_PHONE_MAX_LENGTH } from '@tabtin/shared/auth-forms'
import { useCapsLockWarning } from '@tabtin/shared/use-caps-lock-warning'
import { AUTH_EMAIL_LOGIN_ENABLED } from '@/utils/featureFlags'
import { getResetPasswordLocalError } from './passwordValidation'
import { CapsLockHint } from './CapsLockHint'
import {
  formGhostFullWidthClassName,
  formInputActionRowClassName,
  formInputGrowCellClassName,
  formOutlineCompanionClassName,
  formPrimaryFullWidthClassName,
} from '@/constants/formControlUi'

interface ForgotPasswordFormProps {
  onSwitchToLogin: () => void
  onResetSuccess: () => void
}

export const ForgotPasswordForm: React.FC<ForgotPasswordFormProps> = ({
  onSwitchToLogin,
  onResetSuccess,
}) => {
  const { t } = useTranslation('auth')
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const newPasswordCapsLock = useCapsLockWarning()
  const confirmPasswordCapsLock = useCapsLockWarning()

  const form = useForgotPasswordForm({
    forgotPassword: apiService.forgotPassword.bind(apiService),
    resetPassword: apiService.resetPassword.bind(apiService),
    translate: t,
    extractError: (err, key) => extractErrorMessage(err, key, undefined, 'auth'),
    getResetPasswordError: getResetPasswordLocalError,
    onResetSuccess,
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
          {form.step === 'request' ? t('forgotForm.heading.request') : t('forgotForm.heading.reset')}
        </h1>
        <p className="text-muted-foreground">
          {form.step === 'request'
            ? t(
                AUTH_EMAIL_LOGIN_ENABLED
                  ? 'forgotForm.subheading.requestEmailOrPhone'
                  : 'forgotForm.subheading.request',
              )
            : t('forgotForm.subheading.reset')
          }
        </p>
      </div>

      {form.step === 'request' ? (
        <Form onSubmit={form.submitRequest}>
          {form.successMessage && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="p-3 bg-success/10 border border-success/20 rounded-lg"
            >
              <p className="text-body text-success">{form.successMessage}</p>
            </motion.div>
          )}
          {/* 手机号 / 邮箱输入 */}
          <FormField>
            <FormLabel htmlFor="username">
              {t(AUTH_EMAIL_LOGIN_ENABLED ? 'forgotForm.labels.emailOrPhone' : 'forgotForm.labels.username')}
            </FormLabel>
            <div className="relative">
              <Input
                id="username"
                type={AUTH_EMAIL_LOGIN_ENABLED ? 'text' : 'tel'}
                value={form.username}
                onChange={(e) => form.setField('username', e.target.value)}
                placeholder={t(AUTH_EMAIL_LOGIN_ENABLED ? 'forgotForm.placeholders.emailOrPhone' : 'forgotForm.placeholders.username')}
                className={`pl-10 ${form.fieldErrors.username ? 'border-destructive' : ''}`}
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
            {form.fieldErrors.username && (
              <FormMessage>{form.fieldErrors.username}</FormMessage>
            )}
          </FormField>

          {/* 错误信息 */}
          {form.generalError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg"
            >
              <p className="text-body text-destructive">{form.generalError}</p>
            </motion.div>
          )}

          {/* 发送验证码按钮 */}
          <Button
            type="submit"
            size="form"
            className={formPrimaryFullWidthClassName}
            disabled={form.isLoading || !form.canRequest}
          >
          {form.isLoading ? (
            <>
              <LoadingSpinner size="sm" className="mr-2" />
              {t('forgotForm.actions.sending')}
            </>
          ) : (
            t('forgotForm.actions.sendCode')
          )}
        </Button>

          {/* 返回登录 */}
          <Button
            type="button"
            variant="ghost"
            size="form"
            onClick={onSwitchToLogin}
            className={formGhostFullWidthClassName}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('forgotForm.actions.backToLogin')}
          </Button>
        </Form>
      ) : (
        <Form onSubmit={form.submitReset}>
          {form.successMessage && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="p-3 bg-success/10 border border-success/20 rounded-lg"
            >
              <p className="text-body text-success">{form.successMessage}</p>
            </motion.div>
          )}

          {/* 新密码输入 */}
          <FormField>
            <FormLabel htmlFor="newPassword">{t('forgotForm.labels.newPassword')}</FormLabel>
            <div className="relative">
              <Input
                id="newPassword"
                type={showNewPassword ? 'text' : 'password'}
                value={form.newPassword}
                onChange={(e) => form.setField('newPassword', e.target.value)}
                {...newPasswordCapsLock.inputHandlers}
                placeholder={t('forgotForm.placeholders.newPassword')}
                className={`pl-10 pr-10 ${form.fieldErrors.newPassword ? 'border-destructive' : ''}`}
              />
              <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <button
                type="button"
                onClick={() => setShowNewPassword(!showNewPassword)}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
              <CapsLockHint show={newPasswordCapsLock.capsLockOn} label={t('capsLock.hint')} />
            </div>
            {form.fieldErrors.newPassword && (
              <FormMessage>{form.fieldErrors.newPassword}</FormMessage>
            )}
          </FormField>

          {/* 确认新密码 */}
          <FormField>
            <FormLabel htmlFor="confirmPassword">{t('forgotForm.labels.confirmPassword')}</FormLabel>
            <div className="relative">
              <Input
                id="confirmPassword"
                type={showConfirmPassword ? 'text' : 'password'}
                value={form.confirmPassword}
                onChange={(e) => form.setField('confirmPassword', e.target.value)}
                {...confirmPasswordCapsLock.inputHandlers}
                placeholder={t('forgotForm.placeholders.confirmPassword')}
                className={`pl-10 pr-10 ${form.fieldErrors.confirmPassword ? 'border-destructive' : ''}`}
              />
              <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
              <CapsLockHint show={confirmPasswordCapsLock.capsLockOn} label={t('capsLock.hint')} />
            </div>
            {form.fieldErrors.confirmPassword && (
              <FormMessage>{form.fieldErrors.confirmPassword}</FormMessage>
            )}
            <PasswordRuleHints password={form.newPassword} className="mt-2" />
          </FormField>

          {/* 验证码输入 */}
          <FormField>
            <FormLabel htmlFor="verificationCode">{t('forgotForm.labels.verificationCode')}</FormLabel>
            <div className={formInputActionRowClassName}>
              <div className={formInputGrowCellClassName}>
                <Input
                  id="verificationCode"
                  type="text"
                  value={form.verificationCode}
                  onChange={(e) => form.setField('verificationCode', e.target.value)}
                  placeholder={t('forgotForm.placeholders.verificationCode')}
                  className={form.fieldErrors.verificationCode ? 'border-destructive' : ''}
                  maxLength={6}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="form"
                onClick={form.resend}
                disabled={form.isLoading || form.countdown > 0}
                className={formOutlineCompanionClassName}
              >
                {form.countdown > 0 ? t('countdown', { ns: 'common', count: form.countdown }) : t('forgotForm.actions.resend')}
              </Button>
            </div>
            {form.fieldErrors.verificationCode && (
              <FormMessage>{form.fieldErrors.verificationCode}</FormMessage>
            )}
          </FormField>

          {/* 错误信息 */}
          {form.generalError && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg"
            >
              <p className="text-body text-destructive">{form.generalError}</p>
            </motion.div>
          )}

          {/* 重置密码按钮 */}
          <Button
            type="submit"
            size="form"
            className={formPrimaryFullWidthClassName}
            disabled={form.isLoading || !form.canReset}
          >
          {form.isLoading ? (
            <>
              <LoadingSpinner size="sm" className="mr-2" />
              {t('forgotForm.actions.resetting')}
            </>
          ) : (
            t('forgotForm.actions.reset')
          )}
        </Button>

          {/* 返回登录 */}
          <Button
            type="button"
            variant="ghost"
            size="form"
            onClick={onSwitchToLogin}
            className={formGhostFullWidthClassName}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t('forgotForm.actions.backToLogin')}
          </Button>
        </Form>
      )}
    </motion.div>
  )
}
