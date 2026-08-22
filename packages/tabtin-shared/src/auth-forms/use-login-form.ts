import { useState } from 'react'
import { useCountdown } from '../use-countdown.js'
import type {
  LoginRequest,
  VerificationCodeLoginRequest,
  SendVerificationCodeRequest,
} from '../auth-types.js'
import {
  authFeedbackKey,
  authFeedbackMessage,
  isValidCnPhone,
  isValidSmsCode,
  resolveAuthFormFeedbacks,
  sanitizeCnMobilePhoneInput,
  sanitizeSmsCodeInput,
  sanitizeAuthIdentifierInput,
  normalizeAuthIdentifier,
  isValidAuthIdentifier,
  type AuthFormFeedback,
  type AuthTranslate,
} from './rules.js'

/** UI 层登录方式：密码 / 验证码（注意与 auth-types 的 LoginMethod 命名不同，这里是 UI 语义） */
export type LoginUiMethod = 'password' | 'verification'

type CodeSendResult = { message?: string } | null | undefined | void
const GENERIC_SEND_CODE_FAILURES = new Set(['Failed to send code', '发送验证码失败'])

export interface UseLoginFormDeps {
  login: (req: LoginRequest) => Promise<unknown>
  loginWithVerificationCode: (req: VerificationCodeLoginRequest) => Promise<unknown>
  sendVerificationCode: (req: SendVerificationCodeRequest) => Promise<CodeSendResult>
  /** store 暴露的服务端错误（提交失败等） */
  error: string | null
  /** 清空 / 设置 store 错误（web 端可传 (e)=>setState({error:e})） */
  setError: (value: string | null) => void
  /** 已绑定到 auth namespace 的 i18n 翻译函数 */
  translate: AuthTranslate
  /** 提取服务端错误信息的工具（各端 extract-api-error） */
  extractError: (err: unknown, fallbackKey: string) => string
  /** 初始登录方式，默认 'password'（侧边栏可传 'verification'） */
  initialMethod?: LoginUiMethod
  /** 默认是否记住登录，默认 true */
  defaultRememberMe?: boolean
  /** 登录成功回调（web 端用于导航等；electron 由 store 驱动可不传） */
  onSuccess?: () => void
  /** 邮箱登录入口开关，默认 false（各端必须传入 env 解析结果） */
  emailLoginEnabled?: boolean
}

export interface UseLoginFormResult {
  method: LoginUiMethod
  isVerification: boolean
  username: string
  password: string
  verificationCode: string
  rememberMe: boolean
  codeSending: boolean
  countdown: number
  /** 逐字段错误（全屏版按字段渲染） */
  fieldErrors: Record<string, string>
  /** 首个字段错误（窄版单行展示用） */
  firstFieldError: string | null
  /** store 服务端错误 */
  submitError: string | null
  successMessage: string | null
  canSubmit: boolean
  setRememberMe: (value: boolean) => void
  setField: (field: 'username' | 'password' | 'verificationCode', value: string) => void
  switchMethod: (next: LoginUiMethod) => void
  resetFeedback: () => void
  sendCode: () => Promise<void>
  submit: (e: React.FormEvent) => Promise<void>
}

/**
 * 登录表单逻辑（状态 + 校验 + canSubmit + 发码/提交编排）。
 * UI 与样式留给各端组件；differences（默认登录方式、是否记住我 UI）通过 options/返回值适配。
 */
export function useLoginForm(deps: UseLoginFormDeps): UseLoginFormResult {
  const {
    login,
    loginWithVerificationCode,
    sendVerificationCode,
    error,
    setError,
    translate: t,
    extractError,
    initialMethod = 'password',
    defaultRememberMe = true,
    onSuccess,
  } = deps

  const emailLoginEnabled = deps.emailLoginEnabled ?? false

  const [method, setMethod] = useState<LoginUiMethod>(initialMethod)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [verificationChallengeKey, setVerificationChallengeKey] = useState<string | null>(null)
  const [rememberMe, setRememberMe] = useState(defaultRememberMe)
  const [codeSending, setCodeSending] = useState(false)
  const { countdown, start: startCountdown } = useCountdown(60)
  const [fieldFeedbacks, setFieldFeedbacks] = useState<Record<string, AuthFormFeedback>>({})
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const isVerification = method === 'verification'
  const fieldErrors = resolveAuthFormFeedbacks(fieldFeedbacks, t)

  const resetFeedback = () => {
    setFieldFeedbacks({})
    setSuccessMessage(null)
    setError(null)
  }

  const setField = (field: 'username' | 'password' | 'verificationCode', value: string) => {
    let next = value
    if (field === 'username') {
      next = sanitizeAuthIdentifierInput(value, emailLoginEnabled)
    } else if (field === 'verificationCode') {
      next = sanitizeSmsCodeInput(value)
    }
    if (field === 'username') {
      setUsername(next)
      if (next !== username) setVerificationChallengeKey(null)
    } else if (field === 'password') setPassword(next)
    else setVerificationCode(next)
    if (fieldFeedbacks[field]) {
      setFieldFeedbacks((prev) => {
        const { [field]: _removed, ...rest } = prev
        return rest
      })
    }
    setError(null)
  }

  const switchMethod = (next: LoginUiMethod) => {
    if (next === method) return
    resetFeedback()
    setMethod(next)
    setUsername((prev) => sanitizeAuthIdentifierInput(prev, emailLoginEnabled))
  }

  const validate = (): boolean => {
    const errors: Record<string, AuthFormFeedback> = {}
    const trimmedUsername = username.trim()
    if (!trimmedUsername) {
      errors.username = isVerification
        ? authFeedbackKey(
            emailLoginEnabled
              ? 'loginForm.errors.usernameBeforeCodeEmailOrPhone'
              : 'loginForm.errors.usernameBeforeCode',
          )
        : authFeedbackKey(
            emailLoginEnabled
              ? 'loginForm.errors.usernameRequiredEmailOrPhone'
              : 'loginForm.errors.usernameRequired',
          )
    } else if (!isValidAuthIdentifier(trimmedUsername, emailLoginEnabled)) {
      errors.username = authFeedbackKey(
        emailLoginEnabled && trimmedUsername.includes('@')
          ? 'loginForm.errors.emailInvalid'
          : 'loginForm.errors.phoneInvalid',
      )
    }
    if (method === 'password' && !password.trim()) {
      errors.password = authFeedbackKey('loginForm.errors.passwordRequired')
    }
    if (isVerification) {
      if (!verificationCode.trim()) {
        errors.verificationCode = authFeedbackKey('loginForm.errors.codeRequired')
      } else if (!isValidSmsCode(verificationCode)) {
        errors.verificationCode = authFeedbackKey('loginForm.errors.codeInvalid')
      }
    }
    setFieldFeedbacks(errors)
    return Object.keys(errors).length === 0
  }

  const sendCode = async (): Promise<void> => {
    const trimmedUsername = username.trim()
    if (!trimmedUsername) {
      setFieldFeedbacks({
        username: authFeedbackKey(
          emailLoginEnabled
            ? 'loginForm.errors.usernameBeforeCodeEmailOrPhone'
            : 'loginForm.errors.usernameBeforeCode',
        ),
      })
      return
    }
    if (!isValidAuthIdentifier(trimmedUsername, emailLoginEnabled)) {
      setFieldFeedbacks({
        username: authFeedbackKey(
          emailLoginEnabled && trimmedUsername.includes('@')
            ? 'loginForm.errors.emailInvalid'
            : 'loginForm.errors.phoneInvalid',
        ),
      })
      return
    }
    setCodeSending(true)
    const challengeKey = crypto.randomUUID()
    try {
      const resp = await sendVerificationCode({
        username: normalizeAuthIdentifier(trimmedUsername),
        code_type: 'login',
        challenge_key: challengeKey,
      })
      setVerificationChallengeKey(challengeKey)
      startCountdown()
      setSuccessMessage(
        resp?.message ||
          t(
            emailLoginEnabled
              ? 'loginForm.success.codeSentEmailOrPhone'
              : 'loginForm.success.codeSent',
          ),
      )
      setFieldFeedbacks({})
    } catch (err) {
      const message = extractError(err, 'loginForm.errors.sendCodeFailed')
      setFieldFeedbacks({
        verificationCode: GENERIC_SEND_CODE_FAILURES.has(message)
          ? authFeedbackKey('loginForm.errors.sendCodeFailed')
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
      if (method === 'password') {
        await login({
          username: normalizeAuthIdentifier(username),
          password,
          remember_me: rememberMe,
        })
      } else {
        if (!verificationChallengeKey) {
          setFieldFeedbacks({
            verificationCode: authFeedbackKey('loginForm.errors.sendCodeFailed'),
          })
          return
        }
        await loginWithVerificationCode({
          username: normalizeAuthIdentifier(username),
          verification_code: verificationCode.trim(),
          remember_me: rememberMe,
          challenge_key: verificationChallengeKey,
        })
      }
      onSuccess?.()
    } catch {
      // 错误已由 store 处理（error 注入回显）
    }
  }

  const canSubmit =
    username.trim().length > 0 &&
    (method === 'password' ? password.trim().length > 0 : verificationCode.trim().length > 0)

  const firstFieldError = Object.values(fieldErrors).find((msg) => msg) ?? null

  return {
    method,
    isVerification,
    username,
    password,
    verificationCode,
    rememberMe,
    codeSending,
    countdown,
    fieldErrors,
    firstFieldError,
    submitError: error,
    successMessage,
    canSubmit,
    setRememberMe,
    setField,
    switchMethod,
    resetFeedback,
    sendCode,
    submit,
  }
}
