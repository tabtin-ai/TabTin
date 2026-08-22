import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  useLoginForm,
  useRegisterForm,
  useForgotPasswordForm,
} from '../../../../../packages/tabtin-shared/src/auth-forms/index'

function submitEvent(): React.FormEvent {
  return { preventDefault: vi.fn() } as unknown as React.FormEvent
}

function createTranslate(lang: 'zh-CN' | 'en-US') {
  const translations = {
    'zh-CN': {
      'loginForm.errors.usernameRequired': '请输入手机号',
      'loginForm.errors.usernameRequiredEmailOrPhone': '请输入邮箱或手机号',
      'loginForm.errors.usernameBeforeCode': '请先输入手机号',
      'loginForm.errors.usernameBeforeCodeEmailOrPhone': '请先输入邮箱或手机号',
      'loginForm.errors.phoneInvalid': '请输入有效的手机号',
      'loginForm.errors.emailInvalid': '请输入有效的邮箱地址',
      'registerForm.errors.phoneRequired': '请输入手机号',
      'registerForm.errors.phoneRequiredEmailOrPhone': '请输入邮箱或手机号',
      'registerForm.errors.phoneInvalid': '请输入有效的手机号',
      'registerForm.errors.emailInvalid': '请输入有效的邮箱地址',
      'forgotForm.errors.usernameRequired': '请输入手机号',
      'forgotForm.errors.usernameRequiredEmailOrPhone': '请输入邮箱或手机号',
      'forgotForm.errors.usernameInvalid': '请输入有效的手机号',
      'forgotForm.errors.emailInvalid': '请输入有效的邮箱地址',
    },
    'en-US': {
      'loginForm.errors.usernameRequired': 'Please enter phone',
      'loginForm.errors.usernameRequiredEmailOrPhone': 'Please enter email or phone',
      'loginForm.errors.usernameBeforeCode': 'Please enter phone first',
      'loginForm.errors.usernameBeforeCodeEmailOrPhone': 'Please enter email or phone first',
      'loginForm.errors.phoneInvalid': 'Please enter a valid phone',
      'loginForm.errors.emailInvalid': 'Please enter a valid email',
      'registerForm.errors.phoneRequired': 'Please enter phone',
      'registerForm.errors.phoneRequiredEmailOrPhone': 'Please enter email or phone',
      'registerForm.errors.phoneInvalid': 'Please enter a valid phone',
      'registerForm.errors.emailInvalid': 'Please enter a valid email',
      'forgotForm.errors.usernameRequired': 'Please enter phone',
      'forgotForm.errors.usernameRequiredEmailOrPhone': 'Please enter email or phone',
      'forgotForm.errors.usernameInvalid': 'Please enter a valid phone',
      'forgotForm.errors.emailInvalid': 'Please enter a valid email',
    },
  } as const
  return (key: string): string => {
    return (translations[lang] as Record<string, string>)[key] ?? key
  }
}

describe('auth form email identifier', () => {
  it('login sendCode accepts email when enabled', async () => {
    const sendVerificationCode = vi.fn().mockResolvedValue({ message: 'ok' })
    const t = createTranslate('zh-CN')
    const { result } = renderHook(() =>
      useLoginForm({
        login: vi.fn(),
        loginWithVerificationCode: vi.fn(),
        sendVerificationCode,
        error: null,
        setError: vi.fn(),
        translate: t,
        extractError: () => 'err',
        initialMethod: 'verification',
        emailLoginEnabled: true,
      }),
    )
    act(() => result.current.setField('username', 'User@Example.com'))
    await act(async () => result.current.sendCode())
    expect(sendVerificationCode).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'user@example.com', code_type: 'login' }),
    )
  })

  it('login username keeps in-progress email letters when enabled', () => {
    const { result } = renderHook(() =>
      useLoginForm({
        login: vi.fn(),
        loginWithVerificationCode: vi.fn(),
        sendVerificationCode: vi.fn(),
        error: null,
        setError: vi.fn(),
        translate: createTranslate('zh-CN'),
        extractError: () => 'err',
        emailLoginEnabled: true,
      }),
    )
    act(() => result.current.setField('username', 'u'))
    expect(result.current.username).toBe('u')
    act(() => result.current.setField('username', 'user'))
    expect(result.current.username).toBe('user')
  })

  it('login sendCode rejects email when disabled', async () => {
    const sendVerificationCode = vi.fn()
    const t = createTranslate('zh-CN')
    const { result } = renderHook(() =>
      useLoginForm({
        login: vi.fn(),
        loginWithVerificationCode: vi.fn(),
        sendVerificationCode,
        error: null,
        setError: vi.fn(),
        translate: t,
        extractError: () => 'err',
        initialMethod: 'verification',
        emailLoginEnabled: false,
      }),
    )
    act(() => result.current.setField('username', 'user@example.com'))
    await act(async () => result.current.sendCode())
    expect(sendVerificationCode).not.toHaveBeenCalled()
  })

  it('login sendCode rejects email when not passed (default false)', async () => {
    const sendVerificationCode = vi.fn()
    const t = createTranslate('zh-CN')
    const { result } = renderHook(() =>
      useLoginForm({
        login: vi.fn(),
        loginWithVerificationCode: vi.fn(),
        sendVerificationCode,
        error: null,
        setError: vi.fn(),
        translate: t,
        extractError: () => 'err',
        initialMethod: 'verification',
      }),
    )
    act(() => result.current.setField('username', 'user@example.com'))
    await act(async () => result.current.sendCode())
    expect(sendVerificationCode).not.toHaveBeenCalled()
  })

  it('register submit splits email vs phone', async () => {
    const register = vi.fn().mockResolvedValue({})
    const t = createTranslate('zh-CN')
    const { result } = renderHook(() =>
      useRegisterForm({
        register,
        sendVerificationCode: vi.fn().mockResolvedValue({ message: 'ok' }),
        error: null,
        setError: vi.fn(),
        translate: t,
        extractError: () => 'err',
        emailLoginEnabled: true,
      }),
    )
    act(() => {
      result.current.setField('phone', 'User@Example.com')
      result.current.setField('password', 'Abcdef1!')
      result.current.setField('confirmPassword', 'Abcdef1!')
      result.current.setField('verificationCode', '123456')
    })
    await act(async () => result.current.submit(submitEvent()))
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'user@example.com',
        verification_code: '123456',
      }),
    )
    expect(register.mock.calls[0][0].phone).toBeUndefined()
  })

  it('register submit uses phone field for phone numbers', async () => {
    const register = vi.fn().mockResolvedValue({})
    const t = createTranslate('zh-CN')
    const { result } = renderHook(() =>
      useRegisterForm({
        register,
        sendVerificationCode: vi.fn().mockResolvedValue({ message: 'ok' }),
        error: null,
        setError: vi.fn(),
        translate: t,
        extractError: () => 'err',
        emailLoginEnabled: true,
      }),
    )
    act(() => {
      result.current.setField('phone', '13800138000')
      result.current.setField('password', 'Abcdef1!')
      result.current.setField('confirmPassword', 'Abcdef1!')
      result.current.setField('verificationCode', '123456')
    })
    await act(async () => result.current.submit(submitEvent()))
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: '13800138000',
        verification_code: '123456',
      }),
    )
    expect(register.mock.calls[0][0].email).toBeUndefined()
  })

  it('forgot password sends lowercase email when enabled', async () => {
    const forgotPassword = vi.fn().mockResolvedValue({ message: 'ok' })
    const t = createTranslate('zh-CN')
    const { result } = renderHook(() =>
      useForgotPasswordForm({
        forgotPassword,
        resetPassword: vi.fn(),
        translate: t,
        extractError: () => 'err',
        onResetSuccess: vi.fn(),
        emailLoginEnabled: true,
      }),
    )
    act(() => result.current.setField('username', 'User@Example.com'))
    await act(async () => result.current.submitRequest(submitEvent()))
    expect(forgotPassword).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'user@example.com' }),
    )
  })

  it('login password submit normalizes email', async () => {
    const login = vi.fn().mockResolvedValue({})
    const t = createTranslate('zh-CN')
    const { result } = renderHook(() =>
      useLoginForm({
        login,
        loginWithVerificationCode: vi.fn(),
        sendVerificationCode: vi.fn(),
        error: null,
        setError: vi.fn(),
        translate: t,
        extractError: () => 'err',
        initialMethod: 'password',
        emailLoginEnabled: true,
      }),
    )
    act(() => {
      result.current.setField('username', 'User@Example.com')
      result.current.setField('password', 'Abcdef1!')
    })
    await act(async () => result.current.submit(submitEvent()))
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'user@example.com' }),
    )
  })
})