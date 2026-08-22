import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  callback: null as (() => void) | null,
  user: { id: 'user-1' } as Record<string, unknown> | null,
}))
const resetRegistration = vi.hoisted(() => vi.fn())

vi.mock('../../auth.js', () => ({
  TokenManager: {
    getCachedUserInfo: () => auth.user,
    onAuthChanged: (callback: () => void) => {
      auth.callback = callback
      return () => undefined
    },
  },
}))

vi.mock('./DeviceIdentityCoordinator.js', () => ({
  DeviceIdentityCoordinator: class {
    resetRegistration = resetRegistration
  },
}))

vi.mock('./electronDeviceRegistrationAdapter.js', () => ({
  electronDeviceRegistrationAdapter: {},
}))

describe('currentDeviceIdentity auth lifecycle', () => {
  beforeEach(async () => {
    vi.resetModules()
    resetRegistration.mockReset()
    auth.callback = null
    auth.user = { id: 'user-1' }
    await import('./currentDeviceIdentity.js')
  })

  it('同一用户 token 刷新不清除 registration', () => {
    auth.user = { id: 'user-1' }
    auth.callback?.()

    expect(resetRegistration).not.toHaveBeenCalled()
  })

  it('登出时清除 registration', () => {
    auth.user = null
    auth.callback?.()

    expect(resetRegistration).toHaveBeenCalledOnce()
  })

  it('切换用户时清除 registration', () => {
    auth.user = { user_id: 'user-2' }
    auth.callback?.()

    expect(resetRegistration).toHaveBeenCalledOnce()
  })
})
