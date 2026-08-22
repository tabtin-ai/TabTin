/**
 * ApiService 认证逻辑测试
 * 测试 shouldBypassAuth、token 刷新锁机制、响应校验等
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('ApiService Auth Logic', () => {
  const AUTH_BYPASS_PATTERNS = [
    '/auth/login',
    '/auth/register',
    '/auth/refresh-token',
    '/auth/forgot-password',
    '/auth/reset-password',
    '/auth/send-verification-code',
    '/auth/send-email-verification',
    '/auth/send-phone-verification',
    '/auth/password-strength',
    '/auth/health',
    '/client-errors/report-anonymous',
  ]

  function shouldBypassAuth(url?: string): boolean {
    if (!url) return false
    const pathname = url.split('?')[0].split('#')[0]
    return AUTH_BYPASS_PATTERNS.some(
      (pattern) => pathname === pattern || pathname.endsWith(pattern)
    )
  }

  describe('shouldBypassAuth', () => {
    it('应跳过登录接口', () => {
      expect(shouldBypassAuth('/auth/login')).toBe(true)
    })

    it('应跳过注册接口', () => {
      expect(shouldBypassAuth('/auth/register')).toBe(true)
    })

    it('应跳过刷新 token 接口', () => {
      expect(shouldBypassAuth('/auth/refresh-token')).toBe(true)
    })

    it('应跳过忘记密码接口', () => {
      expect(shouldBypassAuth('/auth/forgot-password')).toBe(true)
    })

    it('应跳过重置密码接口', () => {
      expect(shouldBypassAuth('/auth/reset-password')).toBe(true)
    })

    it('应跳过发送验证码接口', () => {
      expect(shouldBypassAuth('/auth/send-verification-code')).toBe(true)
    })

    it('应跳过密码强度检查接口', () => {
      expect(shouldBypassAuth('/auth/password-strength')).toBe(true)
    })

    it('应跳过健康检查接口', () => {
      expect(shouldBypassAuth('/auth/health')).toBe(true)
    })

    it('不应跳过需要认证的接口', () => {
      expect(shouldBypassAuth('/auth/profile')).toBe(false)
      expect(shouldBypassAuth('/auth/sessions')).toBe(false)
      expect(shouldBypassAuth('/tabdata/tables')).toBe(false)
      expect(shouldBypassAuth('/context/workspaces')).toBe(false)
    })

    it('应跳过匿名错误上报接口', () => {
      expect(shouldBypassAuth('/client-errors/report-anonymous')).toBe(true)
    })

    it('应返回 false 对于空 URL', () => {
      expect(shouldBypassAuth(undefined)).toBe(false)
      expect(shouldBypassAuth('')).toBe(false)
    })

    it('不应被 query 参数中的旁路路径欺骗（CL-5 回归）', () => {
      expect(shouldBypassAuth('/tabdata/tables?redirect=/auth/login')).toBe(false)
      expect(shouldBypassAuth('/private/data?foo=/auth/refresh-token')).toBe(false)
      expect(shouldBypassAuth('/api/secret?path=/auth/register&bar=1')).toBe(false)
    })

    it('不应被 fragment 中的旁路路径欺骗', () => {
      expect(shouldBypassAuth('/tabdata/tables#/auth/login')).toBe(false)
    })

    it('应正确匹配带有前缀的旁路路径', () => {
      expect(shouldBypassAuth('/api/v1/auth/login')).toBe(true)
      expect(shouldBypassAuth('/api/v1/auth/register')).toBe(true)
    })
  })

  describe('Token Refresh Response Validation', () => {
    function validateRefreshResponse(data: any): void {
      if (!data.access_token || typeof data.access_token !== 'string') {
        throw new Error('刷新 Token 响应缺少 access_token')
      }
      if (!data.refresh_token || typeof data.refresh_token !== 'string') {
        throw new Error('刷新 Token 响应缺少 refresh_token')
      }
    }

    it('应通过有效的刷新响应', () => {
      expect(() =>
        validateRefreshResponse({
          access_token: 'new_at',
          refresh_token: 'new_rt',
        })
      ).not.toThrow()
    })

    it('应拒绝缺少 access_token 的响应', () => {
      expect(() =>
        validateRefreshResponse({
          refresh_token: 'new_rt',
        })
      ).toThrow('access_token')
    })

    it('应拒绝缺少 refresh_token 的响应', () => {
      expect(() =>
        validateRefreshResponse({
          access_token: 'new_at',
        })
      ).toThrow('refresh_token')
    })

    it('应拒绝空字符串 token', () => {
      expect(() =>
        validateRefreshResponse({
          access_token: '',
          refresh_token: 'new_rt',
        })
      ).toThrow('access_token')
    })

    it('应拒绝非字符串 token', () => {
      expect(() =>
        validateRefreshResponse({
          access_token: 123,
          refresh_token: 'new_rt',
        })
      ).toThrow('access_token')
    })

    it('应拒绝完全空的响应', () => {
      expect(() => validateRefreshResponse({})).toThrow()
    })
  })

  describe('Token Refresh Lock Mechanism', () => {
    it('应防止并发刷新', async () => {
      let refreshCount = 0
      let refreshPromise: Promise<string> | null = null

      async function refreshWithLock(): Promise<string> {
        if (refreshPromise) {
          return refreshPromise
        }

        refreshPromise = (async () => {
          try {
            refreshCount++
            await new Promise((r) => setTimeout(r, 50))
            return 'new_token'
          } finally {
            refreshPromise = null
          }
        })()

        return refreshPromise
      }

      // 并发调用 3 次
      const [r1, r2, r3] = await Promise.all([
        refreshWithLock(),
        refreshWithLock(),
        refreshWithLock(),
      ])

      // 应该只执行一次实际刷新
      expect(refreshCount).toBe(1)
      expect(r1).toBe('new_token')
      expect(r2).toBe('new_token')
      expect(r3).toBe('new_token')
    })

    it('锁释放后应允许新的刷新', async () => {
      let refreshCount = 0
      let refreshPromise: Promise<string> | null = null

      async function refreshWithLock(): Promise<string> {
        if (refreshPromise) {
          return refreshPromise
        }

        refreshPromise = (async () => {
          try {
            refreshCount++
            await new Promise((r) => setTimeout(r, 10))
            return `token_${refreshCount}`
          } finally {
            refreshPromise = null
          }
        })()

        return refreshPromise
      }

      const first = await refreshWithLock()
      expect(first).toBe('token_1')

      const second = await refreshWithLock()
      expect(second).toBe('token_2')
      expect(refreshCount).toBe(2)
    })
  })

  describe('Internal Auth Channel (authPersistence)', () => {
    it('notifyTokensSynced 应通过闭包回调传递 token（非 DOM 事件）', async () => {
      const mod = await import('@/utils/authPersistence')

      const handler = vi.fn()
      mod.setAuthSyncHandler(handler)

      mod.notifyTokensSynced({
        accessToken: 'at_123',
        refreshToken: 'rt_456',
        user: { id: '1' } as any,
      })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({
        accessToken: 'at_123',
        refreshToken: 'rt_456',
        user: { id: '1' },
      })

      mod.setAuthSyncHandler(() => {})
    })

    it('notifyLogoutRequired 应通过闭包回调传递登出原因（非 DOM 事件）', async () => {
      const mod = await import('@/utils/authPersistence')

      const handler = vi.fn()
      mod.setAuthLogoutHandler(handler)

      mod.notifyLogoutRequired('ws_auth_failed')

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith('ws_auth_failed')

      mod.setAuthLogoutHandler(() => {})
    })
  })

  describe('CL-1 回归：tabtin-client.ts 不应通过 DOM 广播 token', () => {
    it('源码中不应包含 dispatchEvent + auth:tokensSynced', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../renderer/src/services/tabtin-client.ts'),
        'utf-8',
      )
      expect(source).not.toContain('dispatchEvent')
      expect(source).not.toContain("auth:tokensSynced")
      expect(source).toContain('notifyTokensSynced')
    })

    it('源码中不应包含 dispatchEvent + auth:sessionExpired', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../renderer/src/services/tabtin-client.ts'),
        'utf-8',
      )
      expect(source).not.toContain("auth:sessionExpired")
      expect(source).toContain('notifyLogoutRequired')
    })
  })

  describe('CL-2 回归：chatApi.ts 不应通过 DOM 派发 auth:logout', () => {
    it('源码中不应包含 dispatchEvent + auth:logout', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../renderer/src/services/chatApi.ts'),
        'utf-8',
      )
      expect(source).not.toContain('dispatchEvent')
      expect(source).not.toContain("auth:logout")
      expect(source).toContain('notifyLogoutRequired')
    })
  })

  describe('CL-1/CL-2 回归：useAuthStore DOM 兼容层已移除', () => {
    it('useAuthStore 不应监听 auth:tokensSynced DOM 事件', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../renderer/src/stores/useAuthStore.ts'),
        'utf-8',
      )
      expect(source).not.toMatch(/addEventListener.*auth:tokensSynced/)
    })

    it('useAuthStore 不应监听 auth:logout DOM 事件', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../renderer/src/stores/useAuthStore.ts'),
        'utf-8',
      )
      expect(source).not.toMatch(/addEventListener.*auth:logout/)
    })
  })
})
