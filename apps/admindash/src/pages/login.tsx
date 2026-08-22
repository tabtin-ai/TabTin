import { authApi } from '@/api/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useAuthStore } from '@/stores/auth-store'
import type { LoginRequest, RegisterRequest, ResetPasswordRequest } from '@/types/auth'
import { ArrowLeft, Eye, EyeOff, KeyRound, Loader2, Lock, Mail, Smartphone, UserPlus } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  parseEmailLoginEnabled,
  isValidAuthIdentifier,
  normalizeAuthIdentifier,
  splitRegisterContact,
} from '@tabtin/shared/auth-forms'

type AuthMode = 'login' | 'register' | 'forgot'
type LoginMethod = 'password' | 'verification'

const EMAIL_LOGIN_ENABLED = parseEmailLoginEnabled(
  import.meta.env.VITE_AUTH_EMAIL_LOGIN_ENABLED,
)

function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  return fallback
}

function passwordHasWhitespace(value: string): boolean {
  return /\s/.test(value)
}

function stripPasswordWhitespace(value: string): string {
  return value.replace(/\s/g, '')
}

/** ：与后端 / Electron 共享「非字母数字非空白」特殊字符口径。 */
function passwordHasSpecialChar(value: string): boolean {
  return /[^\p{L}\p{N}\s]/u.test(value)
}

/** ：禁止中日韩汉字（避免粘贴报错文案当密码）。 */
function passwordContainsCjk(value: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(value)
}

function countPasswordCharClasses(value: string): number {
  const hasUpper = /[A-Z]/.test(value)
  const hasLower = /[a-z]/.test(value)
  const hasDigit = /[0-9]/.test(value)
  const hasSpecial = passwordHasSpecialChar(value)
  return [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length
}

function validateNewPassword(value: string, label = '密码'): string | null {
  if (!value) return `请输入${label}`
  if (passwordContainsCjk(value)) return `${label}不能包含中日韩文字，请勿粘贴其他内容`
  if (passwordHasWhitespace(value)) return `${label}不能包含空格、Tab 或换行`
  if (value.length < 8) return `${label}至少 8 位`
  if (value.length > 128) return `${label}不能超过 128 位`
  if (countPasswordCharClasses(value) < 3) {
    return `${label}必须包含大写字母、小写字母、数字、特殊字符中的至少 3 种`
  }
  return null
}

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    login,
    loginWithVerificationCode,
    register,
    isAuthenticated,
    isLoading,
    error,
    clearError,
  } = useAuthStore()

  const [mode, setMode] = useState<AuthMode>('login')
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('password')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [registerName, setRegisterName] = useState('')
  const [registerUsername, setRegisterUsername] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [resetPassword, setResetPassword] = useState('')
  const [resetConfirmPassword, setResetConfirmPassword] = useState('')
  const [forgotStep, setForgotStep] = useState<'request' | 'reset'>('request')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [showResetPassword, setShowResetPassword] = useState(false)
  const [codeSending, setCodeSending] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [formError, setFormError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  useEffect(() => {
    if (isAuthenticated) {
      const state = location.state as { from?: { pathname?: string } } | null
      const from = state?.from?.pathname || '/'
      navigate(from, { replace: true })
    }
  }, [isAuthenticated, navigate, location])

  useEffect(() => {
    if (countdown <= 0) return
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [countdown])

  const modeTitle = useMemo(() => {
    if (mode === 'register') return '创建 AdminDash 账号'
    if (mode === 'forgot') return forgotStep === 'request' ? '找回密码' : '重置密码'
    return '欢迎回来'
  }, [forgotStep, mode])

  const modeDescription = useMemo(() => {
    if (mode === 'register') {
      return EMAIL_LOGIN_ENABLED ? '使用邮箱或手机号完成验证后创建账号' : '使用手机号完成验证后创建账号'
    }
    if (mode === 'forgot') {
      return EMAIL_LOGIN_ENABLED ? '通过邮箱或手机号验证码重设登录密码' : '通过手机号验证码重设登录密码'
    }
    return '使用密码或验证码登录管理后台'
  }, [mode])

  const setNextMode = (nextMode: AuthMode) => {
    setMode(nextMode)
    setFormError(null)
    setSuccessMessage(null)
    clearError()
    setInviteCode('')
    if (nextMode !== 'forgot') setForgotStep('request')
  }

  const validateIdentifier = (value = identifier): string | null => {
    const trimmed = value.trim()
    if (!trimmed) return '请输入账号或手机号'
    return null
  }

  const validateContactForCode = (value = identifier): string | null => {
    const trimmed = value.trim()
    if (!trimmed) return EMAIL_LOGIN_ENABLED ? '请输入邮箱或手机号' : '请输入手机号'
    if (!isValidAuthIdentifier(trimmed, EMAIL_LOGIN_ENABLED)) {
      return trimmed.includes('@') ? '请输入有效的邮箱地址' : '请输入有效的手机号'
    }
    return null
  }

  const sendCode = async (codeType: 'login' | 'register' | 'reset_password') => {
    const contactError = validateContactForCode()
    if (contactError) {
      setFormError(contactError)
      return
    }
    setCodeSending(true)
    setFormError(null)
    setSuccessMessage(null)
    try {
      await authApi.sendVerificationCode({
        username: normalizeAuthIdentifier(identifier),
        code_type: codeType,
        invite_code: inviteCode.trim() || undefined,
      })
      setCountdown(60)
      setSuccessMessage('验证码已发送，请查收')
      if (codeType === 'reset_password') setForgotStep('reset')
    } catch (err: unknown) {
      setFormError(resolveErrorMessage(err, '验证码发送失败'))
    } finally {
      setCodeSending(false)
    }
  }

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault()
    setFormError(null)
    setSuccessMessage(null)
    const idError = validateIdentifier()
    if (idError) {
      setFormError(idError)
      return
    }
    try {
      if (loginMethod === 'password') {
        if (!password) {
          setFormError('请输入密码')
          return
        }
        const payload: LoginRequest = {
          username: normalizeAuthIdentifier(identifier),
          password,
          remember_me: rememberMe,
        }
        await login(payload)
      } else {
        if (!/^\d{6}$/.test(verificationCode.trim())) {
          setFormError('请输入 6 位验证码')
          return
        }
        await loginWithVerificationCode({
          username: normalizeAuthIdentifier(identifier),
          verification_code: verificationCode.trim(),
          invite_code: inviteCode.trim() || undefined,
          remember_me: rememberMe,
        })
      }
    } catch {
      // store already exposes the error
    }
  }

  const handleRegister = async (event: React.FormEvent) => {
    event.preventDefault()
    setFormError(null)
    setSuccessMessage(null)
    const contactError = validateContactForCode()
    if (contactError) {
      setFormError(contactError)
      return
    }
    const passwordError = validateNewPassword(password)
    if (passwordError) {
      setFormError(passwordError)
      return
    }
    if (password !== confirmPassword) {
      setFormError('两次输入的密码不一致')
      return
    }
    if (!/^\d{6}$/.test(verificationCode.trim())) {
      setFormError('请输入 6 位验证码')
      return
    }
    const payload: RegisterRequest = {
      password,
      verification_code: verificationCode.trim(),
      nickname: registerName.trim() || undefined,
      username: registerUsername.trim() || undefined,
      ...splitRegisterContact(identifier),
      invite_code: inviteCode.trim() || undefined,
    }
    try {
      await register(payload)
    } catch {
      // store already exposes the error
    }
  }

  const handleResetPassword = async (event: React.FormEvent) => {
    event.preventDefault()
    setFormError(null)
    setSuccessMessage(null)
    const passwordError = validateNewPassword(resetPassword, '新密码')
    if (passwordError) {
      setFormError(passwordError)
      return
    }
    if (resetPassword !== resetConfirmPassword) {
      setFormError('两次输入的新密码不一致')
      return
    }
    if (!/^\d{6}$/.test(verificationCode.trim())) {
      setFormError('请输入 6 位验证码')
      return
    }
    try {
      const payload: ResetPasswordRequest = {
        username: normalizeAuthIdentifier(identifier),
        verification_code: verificationCode.trim(),
        new_password: resetPassword,
      }
      await authApi.resetPassword(payload)
      setSuccessMessage('密码已重置，请使用新密码登录')
      setMode('login')
      setLoginMethod('password')
      setPassword('')
      setVerificationCode('')
      setResetPassword('')
      setResetConfirmPassword('')
      setForgotStep('request')
    } catch (err: unknown) {
      setFormError(resolveErrorMessage(err, '密码重置失败'))
    }
  }

  const message = formError || error

  // 必填项未填齐时禁用各主按钮（置灰），口径与客户端 / web 端 auth 表单一致。
  // 提交流程仍保留各 handle* 内的格式 / 长度 / 两次密码一致校验作为兜底。
  const canLogin =
    identifier.trim().length > 0 &&
    (loginMethod === 'password'
      ? password.trim().length > 0
      : verificationCode.trim().length > 0)
  const canRegister =
    identifier.trim().length > 0 &&
    password.trim().length > 0 &&
    confirmPassword.trim().length > 0 &&
    verificationCode.trim().length > 0
  const canForgotRequest = identifier.trim().length > 0
  const canForgotReset =
    resetPassword.trim().length > 0 &&
    resetConfirmPassword.trim().length > 0 &&
    verificationCode.trim().length > 0

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/20 px-4 py-8">
      <div className="flex w-full max-w-xl flex-col items-center gap-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-title font-bold text-primary-foreground shadow-sm">
          T
        </div>
        <Card className="w-full rounded-2xl border-border/50 shadow-sm">
          <CardHeader className="space-y-3 px-8 pt-10 text-center">
            <CardTitle className="text-display font-bold tracking-tight">{modeTitle}</CardTitle>
            <CardDescription className="text-subtitle">{modeDescription}</CardDescription>
          </CardHeader>
          <CardContent className="px-8 pb-8 pt-6">
            {mode === 'login' ? (
              <form onSubmit={handleLogin} className="space-y-6">
                <div className="grid grid-cols-2 rounded-lg bg-muted p-1 text-subtitle">
                  <button
                    type="button"
                    onClick={() => setLoginMethod('password')}
                    className={`rounded-md px-3 py-3 font-semibold transition-colors ${
                      loginMethod === 'password'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground'
                    }`}
                  >
                    密码登录
                  </button>
                  <button
                    type="button"
                    onClick={() => setLoginMethod('verification')}
                    className={`rounded-md px-3 py-3 font-semibold transition-colors ${
                      loginMethod === 'verification'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground'
                    }`}
                  >
                    验证码登录
                  </button>
                </div>

                <IdentifierInput
                  label={loginMethod === 'password' ? '用户名 / 手机号' : EMAIL_LOGIN_ENABLED ? '邮箱或手机号' : '手机号'}
                  value={identifier}
                  onChange={setIdentifier}
                  placeholder={loginMethod === 'password' ? '请输入用户名或手机号' : EMAIL_LOGIN_ENABLED ? '请输入邮箱或手机号' : '请输入手机号'}
                  disabled={isLoading || codeSending}
                />

                {loginMethod === 'password' ? (
                  <PasswordInput
                    label="密码"
                    value={password}
                    onChange={setPassword}
                    show={showPassword}
                    onToggleShow={() => setShowPassword((value) => !value)}
                    placeholder="请输入密码"
                    disabled={isLoading}
                  />
                ) : (
                  <div className="space-y-4">
                    <CodeInput
                      value={verificationCode}
                      onChange={setVerificationCode}
                      disabled={isLoading || codeSending}
                      countdown={countdown}
                      sending={codeSending}
                      onSend={() => void sendCode('login')}
                    />
                  </div>
                )}

                <div className="flex items-center justify-between text-subtitle">
                  <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(event) => setRememberMe(event.target.checked)}
                      className="h-4 w-4 accent-primary"
                    />
                    记住我
                  </label>
                  {loginMethod === 'password' ? (
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => setNextMode('forgot')}
                    >
                      忘记密码？
                    </button>
                  ) : null}
                </div>

                <AuthMessages success={successMessage} error={message} />
                <Button
                  type="submit"
                  size="lg"
                  className="h-12 w-full text-subtitle"
                  disabled={isLoading || !canLogin}
                >
                  {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  登录
                </Button>

                <div className="text-center text-subtitle text-muted-foreground">
                  还没有账户？
                  <button
                    type="button"
                    className="ml-2 font-semibold text-primary hover:underline"
                    onClick={() => setNextMode('register')}
                  >
                    立即注册
                  </button>
                </div>
              </form>
            ) : null}

            {mode === 'register' ? (
              <form onSubmit={handleRegister} className="space-y-4">
                <IdentifierInput
                  label={EMAIL_LOGIN_ENABLED ? '邮箱或手机号' : '手机号'}
                  value={identifier}
                  onChange={setIdentifier}
                  placeholder={EMAIL_LOGIN_ENABLED ? '请输入邮箱或手机号' : '请输入手机号'}
                  disabled={isLoading || codeSending}
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    value={registerName}
                    onChange={(event) => setRegisterName(event.target.value)}
                    placeholder="昵称（可选）"
                    aria-label="昵称（可选）"
                    className="h-12 border-transparent bg-muted/50 shadow-none"
                    disabled={isLoading}
                  />
                  <Input
                    value={registerUsername}
                    onChange={(event) => setRegisterUsername(event.target.value)}
                    placeholder="用户名（可选）"
                    aria-label="用户名（可选）"
                    className="h-12 border-transparent bg-muted/50 shadow-none"
                    disabled={isLoading}
                  />
                </div>
                <PasswordInput
                  label="密码"
                  value={password}
                  onChange={(value) => setPassword(stripPasswordWhitespace(value))}
                  show={showPassword}
                  onToggleShow={() => setShowPassword((value) => !value)}
                  placeholder="设置密码"
                  disabled={isLoading}
                />
                <PasswordInput
                  label="确认密码"
                  value={confirmPassword}
                  onChange={(value) => setConfirmPassword(stripPasswordWhitespace(value))}
                  show={showConfirmPassword}
                  onToggleShow={() => setShowConfirmPassword((value) => !value)}
                  placeholder="再次输入密码"
                  disabled={isLoading}
                />
                <InviteCodeInput
                  label="邀请码（可选）"
                  value={inviteCode}
                  onChange={setInviteCode}
                  disabled={isLoading || codeSending}
                />
                <CodeInput
                  value={verificationCode}
                  onChange={setVerificationCode}
                  disabled={isLoading || codeSending}
                  countdown={countdown}
                  sending={codeSending}
                  onSend={() => void sendCode('register')}
                />
                <AuthMessages success={successMessage} error={message} />
                <Button
                  type="submit"
                  size="lg"
                  className="h-12 w-full text-subtitle"
                  disabled={isLoading || !canRegister}
                >
                  {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  <UserPlus className="mr-2 h-4 w-4" />
                  创建并登录
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => setNextMode('login')}
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  返回登录
                </Button>
              </form>
            ) : null}

            {mode === 'forgot' ? (
              <form
                onSubmit={
                  forgotStep === 'request'
                    ? (event) => {
                        event.preventDefault()
                        void sendCode('reset_password')
                      }
                    : handleResetPassword
                }
                className="space-y-4"
              >
                <IdentifierInput
                  label={EMAIL_LOGIN_ENABLED ? '邮箱或手机号' : '手机号'}
                  value={identifier}
                  onChange={setIdentifier}
                  placeholder={EMAIL_LOGIN_ENABLED ? '请输入邮箱或手机号' : '请输入手机号'}
                  disabled={isLoading || codeSending || forgotStep === 'reset'}
                />
                {forgotStep === 'request' ? (
                  <Button
                    type="submit"
                    size="lg"
                    className="h-12 w-full text-subtitle"
                    disabled={codeSending || !canForgotRequest}
                  >
                    {codeSending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    发送重置验证码
                  </Button>
                ) : (
                  <>
                    <PasswordInput
                      label="新密码"
                      value={resetPassword}
                      onChange={(value) => setResetPassword(stripPasswordWhitespace(value))}
                      show={showResetPassword}
                      onToggleShow={() => setShowResetPassword((value) => !value)}
                      placeholder="请输入新密码"
                      disabled={isLoading}
                    />
                    <PasswordInput
                      label="确认新密码"
                      value={resetConfirmPassword}
                      onChange={(value) => setResetConfirmPassword(stripPasswordWhitespace(value))}
                      show={showConfirmPassword}
                      onToggleShow={() => setShowConfirmPassword((value) => !value)}
                      placeholder="再次输入新密码"
                      disabled={isLoading}
                    />
                    <CodeInput
                      value={verificationCode}
                      onChange={setVerificationCode}
                      disabled={isLoading || codeSending}
                      countdown={countdown}
                      sending={codeSending}
                      onSend={() => void sendCode('reset_password')}
                    />
                    <Button
                      type="submit"
                      size="lg"
                      className="h-12 w-full text-subtitle"
                      disabled={isLoading || !canForgotReset}
                    >
                      {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      重置密码
                    </Button>
                  </>
                )}
                <AuthMessages success={successMessage} error={message} />
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => setNextMode('login')}
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  返回登录
                </Button>
              </form>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function IdentifierInput({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label?: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
}) {
  const inputId = useId()
  return (
    <div className="space-y-2">
      {label ? (
        <label htmlFor={inputId} className="text-subtitle font-semibold text-foreground">
          {label}
        </label>
      ) : null}
      <div className="relative">
        {EMAIL_LOGIN_ENABLED ? (
          <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        ) : (
          <Smartphone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        )}
        <Input
          id={inputId}
          type="text"
          placeholder={placeholder}
          className="h-12 border-transparent bg-muted/50 pl-10 shadow-none"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          autoComplete="username"
        />
      </div>
    </div>
  )
}

function InviteCodeInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const inputId = useId()
  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="text-subtitle font-semibold text-foreground">
        {label}
      </label>
      <div className="relative">
        <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={inputId}
          type="text"
          placeholder="有邀请码可填写"
          className="h-12 border-transparent bg-muted/50 pl-10 shadow-none"
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          disabled={disabled}
          autoComplete="one-time-code"
        />
      </div>
    </div>
  )
}

function PasswordInput({
  label,
  value,
  onChange,
  show,
  onToggleShow,
  placeholder,
  disabled,
}: {
  label?: string
  value: string
  onChange: (value: string) => void
  show: boolean
  onToggleShow: () => void
  placeholder: string
  disabled?: boolean
}) {
  const inputId = useId()
  return (
    <div className="space-y-2">
      {label ? (
        <label htmlFor={inputId} className="text-subtitle font-semibold text-foreground">
          {label}
        </label>
      ) : null}
      <div className="relative">
        <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={inputId}
          type={show ? 'text' : 'password'}
          placeholder={placeholder}
          className="h-12 border-transparent bg-muted/50 pl-10 pr-10 shadow-none"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          autoComplete="current-password"
        />
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={show ? '隐藏密码' : '显示密码'}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

function CodeInput({
  value,
  onChange,
  disabled,
  countdown,
  sending,
  onSend,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  countdown: number
  sending: boolean
  onSend: () => void
}) {
  const inputId = useId()
  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="text-subtitle font-semibold text-foreground">
        验证码
      </label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={inputId}
            type="text"
            inputMode="numeric"
            placeholder="请输入 6 位验证码"
            className="h-12 border-transparent bg-muted/50 pl-10 shadow-none"
            value={value}
            onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
            disabled={disabled}
            maxLength={6}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-12 w-32"
          disabled={disabled || sending || countdown > 0}
          onClick={onSend}
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : countdown > 0 ? (
            `${countdown}s`
          ) : (
            '发送验证码'
          )}
        </Button>
      </div>
    </div>
  )
}

function AuthMessages({ success, error }: { success: string | null; error: string | null }) {
  return (
    <>
      {success ? (
        <div className="rounded-md border border-success/20 bg-success/10 p-3 text-body text-success">
          {success}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-body text-destructive">
          {error}
        </div>
      ) : null}
    </>
  )
}
