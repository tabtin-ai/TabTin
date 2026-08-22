import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  login: vi.fn(),
  loginWithVerificationCode: vi.fn(),
  setAuthToken: vi.fn(),
  clearAuth: vi.fn(),
}))

const i18nState = vi.hoisted(() => ({
  language: 'zh-CN',
  translations: {
    'zh-CN': {
      'common:apiErrors.AUTH_INVALID': '用户名或密码错误',
      'auth:errors.loginFailed': '登录失败',
    },
    'en-US': {
      'common:apiErrors.AUTH_INVALID': 'Invalid username or password',
      'auth:errors.loginFailed': 'Sign in failed',
    },
  } as Record<string, Record<string, string>>,
}))

vi.mock('@/services/api', () => ({
  default: apiMocks,
}))

vi.mock('@/constants/upload', () => ({
  fetchUploadConfig: vi.fn(),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string; ns?: string }) => {
      const ns = options?.ns ?? 'auth'
      const translated = i18nState.translations[i18nState.language]?.[`${ns}:${key}`]
      if (translated) return translated
      if (typeof options?.defaultValue === 'string') {
        return options.defaultValue
      }
      return key
    },
  },
  getCurrentLanguage: () => 'zh-CN',
}))

function makeAuthInvalidError(): Error {
  const data = {
    success: false,
    code: 'AUTH_INVALID',
    message: 'Invalid username or password',
  }
  return Object.assign(new Error(data.message), {
    status: 401,
    data,
    response: { status: 401, data },
  })
}

describe('useAuthStore login errors', () => {
  beforeEach(() => {
    vi.resetModules()
    i18nState.language = 'zh-CN'
    apiMocks.login.mockReset()
    apiMocks.loginWithVerificationCode.mockReset()
    apiMocks.setAuthToken.mockReset()
    apiMocks.clearAuth.mockReset()
    localStorage.clear()
  })

  it('stores re-translatable auth error text for invalid credentials', async () => {
    const err = makeAuthInvalidError()
    apiMocks.login.mockRejectedValueOnce(err)

    const { useAuthStore } = await import('../../renderer/src/stores/useAuthStore')
    const { resolveStoredErrorMessage } = await import('../../renderer/src/utils/extract-api-error')

    await expect(useAuthStore.getState().login({
      username: 'bad-user',
      password: 'wrong-password',
      remember_me: false,
    })).rejects.toBe(err)

    const stored = useAuthStore.getState().error
    expect(resolveStoredErrorMessage(stored)).toBe('用户名或密码错误')

    i18nState.language = 'en-US'
    expect(resolveStoredErrorMessage(stored)).toBe('Invalid username or password')
  })
})
