import { useState } from 'react'
import { useCountdown } from '../use-countdown.js'
import type { ForgotPasswordRequest, ResetPasswordRequest } from '../auth-types.js'
import {
  passwordHasWhitespace,
  passwordContainsCjk,
  sanitizeNewPasswordInput,
  passwordMeetsCharClassRule,
  PASSWORD_MIN_LENGTH,
} from '../password-strength.js'
import {
  isValidCnPhone,
  isValidSmsCode,
  sanitizeCnMobilePhoneInput,
  sanitizeAuthIdentifierInput,
  normalizeAuthIdentifier,
  isValidAuthIdentifier,
  type AuthTranslate,
} from './rules.js'

type CodeSendResult = { message?: string } | null | undefined | void
type ForgotField = 'username' | 'verificationCode' | 'newPassword' | 'confirmPassword'

/**
 * 重置密码的默认基线校验（必填 + 无空白 + 长度≥8 + 至少三类字符）。
 * electron 可注入更严格规则（如 zxcvbn）；未注入时也必须挡住 1/2 类密码，避免只靠后端。
 */
function defaultResetPasswordError(password: string, t: AuthTranslate): string | null {
  if (!password.trim()) return t('forgotForm.errors.newPasswordRequired')
  if (passwordContainsCjk(password)) return t('forgotForm.errors.newPasswordNoCjk')
  if (passwordHasWhitespace(password)) return t('forgotForm.errors.newPasswordNoWhitespace')
  if (password.length < PASSWORD_MIN_LENGTH) return t('forgotForm.errors.newPasswordTooShort')
  if (!passwordMeetsCharClassRule(password)) return t('forgotForm.errors.newPasswordNotComplex')
  return null
}

export interface UseForgotPasswordFormDeps {
  forgotPassword: (req: ForgotPasswordRequest) => Promise<CodeSendResult>
  resetPassword: (req: ResetPasswordRequest) => Promise<unknown>
  translate: AuthTranslate
  extractError: (err: unknown, fallbackKey: string) => string
  /** 重置密码校验注入（默认 defaultResetPasswordError）；electron 传 getResetPasswordLocalError */
  getResetPasswordError?: (password: string, translate: AuthTranslate) => string | null
  /** 重置成功回调（切回登录 / 关闭弹窗 / toast） */
  onResetSuccess: () => void
  /** 邮箱登录入口开关，默认 false（各端必须传入 env 解析结果） */
  emailLoginEnabled?: boolean
}

export interface UseForgotPasswordFormResult {
  step: 'request' | 'reset'
  username: string
  verificationCode: string
  newPassword: string
  confirmPassword: string
  isLoading: boolean
  countdown: number
  fieldErrors: Record<string, string>
  firstFieldError: string | null
  generalError: string | null
  successMessage: string | null
  canRequest: boolean
  canReset: boolean
  setField: (field: ForgotField, value: string) => void
  submitRequest: (e: React.FormEvent) => Promise<void>
  resend: () => Promise<void>
  submitReset: (e: React.FormEvent) => Promise<void>
}

/** 两步忘记密码逻辑（请求验证码 → 重置）。自管 loading/error，不依赖 store。 */
export function useForgotPasswordForm(
  deps: UseForgotPasswordFormDeps,
): UseForgotPasswordFormResult {
  const {
    forgotPassword,
    resetPassword,
    translate: t,
    extractError,
    getResetPasswordError = defaultResetPasswordError,
    onResetSuccess,
  } = deps

  const emailLoginEnabled = deps.emailLoginEnabled ?? false

  const [step, setStep] = useState<'request' | 'reset'>('request')
  const [username, setUsername] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const { countdown, start: startCountdown } = useCountdown(60)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const setField = (field: ForgotField, value: string) => {
    if (field === 'newPassword' || field === 'confirmPassword') {
      const { value: next, notice } = sanitizeNewPasswordInput(value)
      if (field === 'newPassword') setNewPassword(next)
      else setConfirmPassword(next)
      if (notice === 'cjk') {
        setFieldErrors((prev) => ({
          ...prev,
          [field]: t('forgotForm.errors.newPasswordNoCjk'),
        }))
        if (generalError) setGeneralError(null)
        return
      }
      if (notice === 'whitespace') {
        setFieldErrors((prev) => ({
          ...prev,
          [field]: t('forgotForm.errors.newPasswordNoWhitespace'),
        }))
        if (generalError) setGeneralError(null)
        return
      }
      if (fieldErrors[field]) {
        setFieldErrors((prev) => ({ ...prev, [field]: '' }))
      }
      if (generalError) setGeneralError(null)
      return
    }

    const next = field === 'username' ? sanitizeAuthIdentifierInput(value, emailLoginEnabled) : value
    if (field === 'username') setUsername(next)
    else setVerificationCode(next)
    if (fieldErrors[field]) {
      setFieldErrors((prev) => ({ ...prev, [field]: '' }))
    }
    if (generalError) setGeneralError(null)
  }

  const validateRequest = (): boolean => {
    const errors: Record<string, string> = {}
    if (!username.trim()) {
      errors.username = t(
        emailLoginEnabled
          ? 'forgotForm.errors.usernameRequiredEmailOrPhone'
          : 'forgotForm.errors.usernameRequired',
      )
    } else if (!isValidAuthIdentifier(username, emailLoginEnabled)) {
      errors.username = t(
        emailLoginEnabled && username.includes('@')
          ? 'forgotForm.errors.emailInvalid'
          : 'forgotForm.errors.usernameInvalid',
      )
    }
    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const validateReset = (): boolean => {
    const errors: Record<string, string> = {}
    const passwordError = getResetPasswordError(newPassword, t)
    if (passwordError) errors.newPassword = passwordError
    if (!confirmPassword.trim()) {
      errors.confirmPassword = t('forgotForm.errors.confirmPasswordRequired')
    } else if (newPassword !== confirmPassword) {
      errors.confirmPassword = t('forgotForm.errors.confirmPasswordMismatch')
    }
    if (!verificationCode.trim()) {
      errors.verificationCode = t('forgotForm.errors.codeRequired')
    } else if (!isValidSmsCode(verificationCode)) {
      errors.verificationCode = t('forgotForm.errors.codeInvalid')
    }
    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const submitRequest = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!validateRequest()) return
    setIsLoading(true)
    setGeneralError(null)
    try {
      const resp = await forgotPassword({ username: normalizeAuthIdentifier(username) })
      startCountdown()
      setStep('reset')
      // 延迟设置成功消息，确保在新 step 中渲染
      setTimeout(() => {
        setSuccessMessage(
          resp?.message ||
            t(
              emailLoginEnabled
                ? 'forgotForm.success.codeSentEmailOrPhone'
                : 'forgotForm.success.codeSent',
            ),
        )
      }, 100)
    } catch (err) {
      setGeneralError(extractError(err, 'forgotForm.errors.sendCodeFailed'))
      setSuccessMessage(null)
    } finally {
      setIsLoading(false)
    }
  }

  const resend = async (): Promise<void> => {
    if (countdown > 0) return
    setIsLoading(true)
    try {
      await forgotPassword({ username: normalizeAuthIdentifier(username) })
      startCountdown()
    } catch (err) {
      setGeneralError(extractError(err, 'forgotForm.errors.resendFailed'))
    } finally {
      setIsLoading(false)
    }
  }

  const submitReset = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!validateReset()) return
    setIsLoading(true)
    setGeneralError(null)
    try {
      await resetPassword({
        username: normalizeAuthIdentifier(username),
        verification_code: verificationCode.trim(),
        new_password: newPassword,
      })
      onResetSuccess()
    } catch (err) {
      setGeneralError(extractError(err, 'forgotForm.errors.resetFailed'))
    } finally {
      setIsLoading(false)
    }
  }

  const canRequest = username.trim().length > 0
  const canReset =
    newPassword.trim().length > 0 &&
    confirmPassword.trim().length > 0 &&
    verificationCode.trim().length > 0

  const firstFieldError = Object.values(fieldErrors).find((msg) => msg) ?? null

  return {
    step,
    username,
    verificationCode,
    newPassword,
    confirmPassword,
    isLoading,
    countdown,
    fieldErrors,
    firstFieldError,
    generalError,
    successMessage,
    canRequest,
    canReset,
    setField,
    submitRequest,
    resend,
    submitReset,
  }
}
