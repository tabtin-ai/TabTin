import { beforeEach, describe, expect, it, vi } from 'vitest'

const i18nState = vi.hoisted(() => ({
  language: 'zh-CN',
  translations: {
    'zh-CN': {
      'common:apiErrors.AUTH_INVALID': '用户名或密码错误',
      'common:apiErrors.AUTH_VERIFICATION_CODE_INVALID': '验证码无效或已过期',
      'common:apiErrors.ACCOUNT_LOCKED': '账号已被锁定，请30分钟后重试',
      'auth:errors.loginFailed': '登录失败',
    },
    'en-US': {
      'common:apiErrors.AUTH_INVALID': 'Invalid username or password',
      'common:apiErrors.AUTH_VERIFICATION_CODE_INVALID': 'Verification code is invalid or expired',
      'common:apiErrors.ACCOUNT_LOCKED': 'Account is locked. Please try again in 30 minutes',
      'auth:errors.loginFailed': 'Sign in failed',
    },
  } as Record<string, Record<string, string>>,
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string; ns?: string }) => {
      const ns = options?.ns ?? 'translation'
      const translated = i18nState.translations[i18nState.language]?.[`${ns}:${key}`]
      if (translated) return translated
      if (typeof options?.defaultValue === 'string') return options.defaultValue
      return key
    },
  },
}))

import {
  extractErrorMessage,
  extractStorableErrorMessage,
  resolveStoredErrorMessage,
} from '../extract-api-error'

function makeServerError(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    data: {
      success: false,
      code,
      message,
    },
  })
}

describe('extractErrorMessage', () => {
  beforeEach(() => {
    i18nState.language = 'zh-CN'
  })

  it('translates structured auth errors before falling back to server message', () => {
    const err = makeServerError('AUTH_INVALID', 'Invalid username or password')

    expect(extractErrorMessage(err, 'errors.loginFailed', undefined, 'auth'))
      .toBe('用户名或密码错误')
  })

  it('keeps validation errors server-message-first for field-specific details', () => {
    const err = makeServerError('VALIDATION_ERROR', '验证码无效')

    expect(extractErrorMessage(err, 'errors.loginFailed', undefined, 'auth'))
      .toBe('验证码无效')
  })

  it('preserves the server lockout countdown instead of replacing it with a fixed translation', () => {
    const err = makeServerError('ACCOUNT_LOCKED', '账号已被锁定，请12分钟后重试')

    expect(extractErrorMessage(err, 'errors.loginFailed', undefined, 'auth'))
      .toBe('账号已被锁定，请12分钟后重试')

    const stored = extractStorableErrorMessage(err, 'errors.loginFailed', undefined, 'auth')
    expect(resolveStoredErrorMessage(stored)).toBe('账号已被锁定，请12分钟后重试')
  })

  it('stores structured auth errors as re-translatable messages', () => {
    const err = makeServerError('AUTH_INVALID', 'Invalid username or password')
    const stored = extractStorableErrorMessage(err, 'errors.loginFailed', undefined, 'auth')

    expect(resolveStoredErrorMessage(stored)).toBe('用户名或密码错误')

    i18nState.language = 'en-US'
    expect(resolveStoredErrorMessage(stored)).toBe('Invalid username or password')
  })

  it('normalizes legacy unauthorized login messages into re-translatable auth errors', () => {
    const err = makeServerError('UNAUTHORIZED', 'Invalid username or password')
    const stored = extractStorableErrorMessage(err, 'errors.loginFailed', undefined, 'auth')

    expect(resolveStoredErrorMessage(stored)).toBe('用户名或密码错误')

    i18nState.language = 'en-US'
    expect(resolveStoredErrorMessage(stored)).toBe('Invalid username or password')
  })

  it('normalizes legacy validation-code messages into re-translatable auth errors', () => {
    const err = makeServerError('VALIDATION_ERROR', 'Verification code is invalid or expired')
    const stored = extractStorableErrorMessage(err, 'errors.codeLoginFailed', undefined, 'auth')

    expect(resolveStoredErrorMessage(stored)).toBe('验证码无效或已过期')

    i18nState.language = 'en-US'
    expect(resolveStoredErrorMessage(stored)).toBe('Verification code is invalid or expired')
  })

  it('normalizes legacy locked-account messages into re-translatable auth errors', () => {
    const err = makeServerError('UNAUTHORIZED', '账号已被锁定，请30分钟后重试')
    const stored = extractStorableErrorMessage(err, 'errors.loginFailed', undefined, 'auth')

    expect(resolveStoredErrorMessage(stored)).toBe('账号已被锁定，请30分钟后重试')

    i18nState.language = 'en-US'
    expect(resolveStoredErrorMessage(stored)).toBe('Account is locked. Please try again in 30 minutes')
  })
})
