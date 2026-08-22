import { useState } from 'react'
import { useCountdown } from '../use-countdown.js'
import type { RegisterRequest, SendVerificationCodeRequest } from '../auth-types.js'
import {
  passwordHasWhitespace,
  passwordContainsCjk,
  sanitizeNewPasswordInput,
  passwordMeetsCharClassRule,
  PASSWORD_MIN_LENGTH,
} from '../password-strength.js'
import {
  authFeedbackKey,
  authFeedbackMessage,
  isValidCnPhone,
  isValidSmsCode,
  normalizeRegisterErrorKey,
  resolveAuthFormFeedbacks,
  sanitizeCnMobilePhoneInput,
  sanitizeAuthIdentifierInput,
  normalizeAuthIdentifier,
  isValidAuthIdentifier,
  splitRegisterContact,
  type AuthFormFeedback,
  type AuthTranslate,
} from './rules.js'

type CodeSendResult = { message?: string } | null | undefined | void
type RegisterField = 'phone' | 'password' | 'confirmPassword' | 'verificationCode'
const GENERIC_SEND_CODE_FAILURES = new Set(['Failed to send code', '发送验证码失败'])

export interface UseRegisterFormDeps {
  register: (req: RegisterRequest) => Promise<unknown>
  sendVerificationCode: (req: SendVerificationCodeRequest) => Promise<CodeSendResult>
  error: string | null
  setError: (value: string | null) => void
  translate: AuthTranslate
  extractError: (err: unknown, fallbackKey: string) => string
  /**
   * 额外密码校验（如密码强度阈值）。返回错误文案则拦截，返回 null 则放行。
   * electron 全屏版用本地 zxcvbn 强度判定 score<60，web/侧边栏可不传。
   */
  extraPasswordError?: (password: string) => string | null
  /** 注册成功后回调（全屏版用于切换路由 / 关闭弹窗；侧边栏可不传，由 store 驱动） */
  onSuccess?: () => void
  /** 邮箱登录入口开关，默认 false（各端必须传入 env 解析结果） */
  emailLoginEnabled?: boolean
}

export interface UseRegisterFormResult {
  phone: string
  password: string
  confirmPassword: string
  verificationCode: string
  codeSending: boolean
  countdown: number
  fieldErrors: Record<string, string>
  firstFieldError: string | null
  submitError: string | null
  successMessage: string | null
  canSubmit: boolean
  setField: (field: RegisterField, value: string) => void
  resetFeedback: () => void
  sendCode: () => Promise<void>
  submit: (e: React.FormEvent) => Promise<void>
}

/** 注册表单逻辑（状态 + 校验 + canSubmit + 发码/提交编排）。UI / 密码强度展示留给组件。 */
export function useRegisterForm(deps: UseRegisterFormDeps): UseRegisterFormResult {
  const {
    register,
    sendVerificationCode,
    error,
    setError,
    translate: t,
    extractError,
    extraPasswordError,
    onSuccess,
  } = deps

  const emailLoginEnabled = deps.emailLoginEnabled ?? false

  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [codeSending, setCodeSending] = useState(false)
  const { countdown, start: startCountdown } = useCountdown(60)
  const [fieldFeedbacks, setFieldFeedbacks] = useState<Record<string, AuthFormFeedback>>({})
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const fieldErrors = resolveAuthFormFeedbacks(fieldFeedbacks, t)

  const resetFeedback = () => {
    setFieldFeedbacks({})
    setSuccessMessage(null)
    setError(null)
  }

  const setField = (field: RegisterField, value: string) => {
    if (field === 'password' || field === 'confirmPassword') {
      const { value: next, notice } = sanitizeNewPasswordInput(value)
      if (field === 'password') setPassword(next)
      else setConfirmPassword(next)
      if (notice === 'cjk') {
        setFieldFeedbacks((prev) => ({
          ...prev,
          [field]: authFeedbackKey('registerForm.errors.passwordNoCjk'),
        }))
        setError(null)
        return
      }
      if (notice === 'whitespace') {
        setFieldFeedbacks((prev) => ({
          ...prev,
          [field]: authFeedbackKey('registerForm.errors.passwordNoWhitespace'),
        }))
        setError(null)
        return
      }
      if (fieldFeedbacks[field]) {
        setFieldFeedbacks((prev) => {
          const { [field]: _removed, ...rest } = prev
          return rest
        })
      }
      setError(null)
      return
    }

    const next = field === 'phone' ? sanitizeAuthIdentifierInput(value, emailLoginEnabled) : value
    if (field === 'phone') setPhone(next)
    else setVerificationCode(next)
    if (fieldFeedbacks[field]) {
      setFieldFeedbacks((prev) => {
        const { [field]: _removed, ...rest } = prev
        return rest
      })
    }
    setError(null)
  }

  const validate = (): boolean => {
    const errors: Record<string, AuthFormFeedback> = {}

    const trimmedPhone = phone.trim()
    if (!trimmedPhone) {
      errors.phone = authFeedbackKey(
        emailLoginEnabled
          ? 'registerForm.errors.phoneRequiredEmailOrPhone'
          : 'registerForm.errors.phoneRequired',
      )
    } else if (!isValidAuthIdentifier(trimmedPhone, emailLoginEnabled)) {
      errors.phone = authFeedbackKey(
        emailLoginEnabled && trimmedPhone.includes('@')
          ? 'registerForm.errors.emailInvalid'
          : 'registerForm.errors.phoneInvalid',
      )
    }

    if (!password.trim()) {
      errors.password = authFeedbackKey('registerForm.errors.passwordRequired')
    } else if (passwordContainsCjk(password)) {
      errors.password = authFeedbackKey('registerForm.errors.passwordNoCjk')
    } else if (passwordHasWhitespace(password)) {
      errors.password = authFeedbackKey('registerForm.errors.passwordNoWhitespace')
    } else if (password.length < PASSWORD_MIN_LENGTH) {
      errors.password = authFeedbackKey('registerForm.errors.passwordTooShort')
    } else if (!passwordMeetsCharClassRule(password)) {
      errors.password = authFeedbackKey('registerForm.errors.passwordNotComplex')
    } else {
      const extra = extraPasswordError?.(password)
      if (extra) errors.password = authFeedbackMessage(extra)
    }

    if (!confirmPassword.trim()) {
      errors.confirmPassword = authFeedbackKey('registerForm.errors.confirmPasswordRequired')
    } else if (password !== confirmPassword) {
      errors.confirmPassword = authFeedbackKey('registerForm.errors.confirmPasswordMismatch')
    }

    if (!verificationCode.trim()) {
      errors.verificationCode = authFeedbackKey('registerForm.errors.codeRequired')
    } else if (!isValidSmsCode(verificationCode)) {
      errors.verificationCode = authFeedbackKey('registerForm.errors.codeInvalid')
    }

    setFieldFeedbacks(errors)
    return Object.keys(errors).length === 0
  }

  const sendCode = async (): Promise<void> => {
    const trimmedPhone = phone.trim()
    if (!trimmedPhone) {
      setFieldFeedbacks({
        phone: authFeedbackKey(
          emailLoginEnabled
            ? 'registerForm.errors.phoneRequiredEmailOrPhone'
            : 'registerForm.errors.phoneRequired',
        ),
      })
      return
    }
    if (!isValidAuthIdentifier(trimmedPhone, emailLoginEnabled)) {
      setFieldFeedbacks({
        phone: authFeedbackKey(
          emailLoginEnabled && trimmedPhone.includes('@')
            ? 'registerForm.errors.emailInvalid'
            : 'registerForm.errors.phoneInvalid',
        ),
      })
      return
    }
    setCodeSending(true)
    try {
      const resp = await sendVerificationCode({
        username: normalizeAuthIdentifier(trimmedPhone),
        code_type: 'register',
      })
      startCountdown()
      setSuccessMessage(
        resp?.message ||
          t(
            emailLoginEnabled
              ? 'registerForm.success.codeSentEmailOrPhone'
              : 'registerForm.success.codeSent',
          ),
      )
      setFieldFeedbacks({})
    } catch (err) {
      const message = extractError(err, 'registerForm.errors.sendCodeFailed')
      const normalizedKey = normalizeRegisterErrorKey(message)
      setFieldFeedbacks({
        verificationCode: normalizedKey
          ? authFeedbackKey(normalizedKey)
          : GENERIC_SEND_CODE_FAILURES.has(message)
            ? authFeedbackKey('registerForm.errors.sendCodeFailed')
            : authFeedbackMessage(message),
      })
      setSuccessMessage(null)
    } finally {
      setCodeSending(false)
    }
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setSuccessMessage(null)
    if (!validate()) return
    try {
      await register({
        ...splitRegisterContact(phone),
        password,
        verification_code: verificationCode.trim(),
      })
      onSuccess?.()
    } catch {
      // 错误已由 store 处理
    }
  }

  const canSubmit =
    phone.trim().length > 0 &&
    password.trim().length > 0 &&
    confirmPassword.trim().length > 0 &&
    verificationCode.trim().length > 0

  const firstFieldError = Object.values(fieldErrors).find((msg) => msg) ?? null

  return {
    phone,
    password,
    confirmPassword,
    verificationCode,
    codeSending,
    countdown,
    fieldErrors,
    firstFieldError,
    submitError: error,
    successMessage,
    canSubmit,
    setField,
    resetFeedback,
    sendCode,
    submit,
  }
}
