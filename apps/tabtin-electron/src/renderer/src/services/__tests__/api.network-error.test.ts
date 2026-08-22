import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiRequest = vi.fn()

describe('ApiService IPC 网络错误', () => {
  beforeEach(() => {
    vi.resetModules()
    apiRequest.mockReset()
    Object.defineProperty(window, 'electron', { value: {}, configurable: true })
    Object.defineProperty(window, 'tabtin', {
      value: { apiRequest },
      configurable: true,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    Reflect.deleteProperty(window, 'electron')
    Reflect.deleteProperty(window, 'tabtin')
  })

  it('所有 HTTP 请求统一上报客户端版本身份', async () => {
    vi.stubEnv('VITE_APP_VERSION', '0.7.0-beta.140')
    vi.stubEnv('VITE_GIT_COMMIT', 'abc1234')
    apiRequest.mockResolvedValue({ status: 200, data: { success: true, data: {} } })
    const { apiService } = await import('../api')

    await apiService.request({
      method: 'GET',
      url: '/health/',
      headers: { 'X-Client-Version': 'caller-must-not-override' },
    })

    expect(apiRequest.mock.calls[0][0].headers).toMatchObject({
      'X-Client-Type': 'electron',
      'X-Client-Version': '0.7.0-beta.140',
      'X-Client-Source-Sha': 'abc1234',
    })
  })

  it('保留主进程 envelope 透传的网络 code 与 reason', async () => {
    apiRequest.mockRejectedValue({
      code: 'ECONNREFUSED',
      message: 'Network error: connect refused',
      detail: { reason: 'connect refused' },
    })
    const { apiService } = await import('../api')

    await expect(apiService.request({ method: 'GET', url: '/health/' })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
      reason: 'connect refused',
      message: 'Network error: connect refused',
    })
  })

  it('即使后台写请求返回余额不足，也只将错误交给调用方，不派发全局计费提示', async () => {
    apiRequest.mockResolvedValue({
      status: 402,
      data: {
        success: false,
        code: 'ORGANIZATION_INSUFFICIENT_CREDITS',
        message: '组织钱包余额不足，请联系管理员充值',
      },
    })
    const listener = vi.fn()
    window.addEventListener('billing:api:error', listener)

    try {
      const { apiService, ApiError } = await import('../api')
      await expect(apiService.request({ method: 'POST', url: '/background-sync/' }))
        .rejects.toBeInstanceOf(ApiError)
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('billing:api:error', listener)
    }
  })
})
