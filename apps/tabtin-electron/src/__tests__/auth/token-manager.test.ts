/**
 * TokenManager (main process) 单元测试
 * 测试 JWT 解码、bundle 序列化/反序列化、过期检查等纯逻辑
 */
import { describe, it, expect } from 'vitest'

// 由于 TokenManager 依赖 keytar 和 ipcMain（Node 原生模块），
// 这里测试其纯函数逻辑（提取为独立函数方便测试）

/** 模拟 JWT payload 解码（与 auth.ts 中的 decodeJwtPayload 相同） */
function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = payload.length % 4
    if (pad) {
      payload += '='.repeat(4 - pad)
    }
    const json = Buffer.from(payload, 'base64').toString('utf-8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** 模拟 sanitizeBundle（与 auth.ts 中的逻辑相同） */
function sanitizeBundle(bundle: any): {
  accessToken: string | null
  refreshToken: string | null
  userInfo: any | null
  expiresAt: number | null
} {
  if (!bundle || typeof bundle !== 'object') {
    return { accessToken: null, refreshToken: null, userInfo: null, expiresAt: null }
  }
  return {
    accessToken: bundle.accessToken ?? null,
    refreshToken: bundle.refreshToken ?? null,
    userInfo: bundle.userInfo ?? null,
    expiresAt: typeof bundle.expiresAt === 'number' ? bundle.expiresAt : null,
  }
}

/** 检查 token 是否即将过期 */
function isTokenExpiringSoon(token: string, bufferMinutes = 5): boolean {
  if (!token) return true
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  if (typeof exp !== 'number') return false
  const now = Math.floor(Date.now() / 1000)
  const bufferSeconds = Math.max(0, Math.floor(bufferMinutes * 60))
  return exp - now <= bufferSeconds
}

// ---------- 辅助：创建 JWT ----------
function makeJwt(payload: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.fake_signature`
}

describe('decodeJwtPayload', () => {
  it('应正确解码有效的 JWT payload', () => {
    const payload = { sub: '123', exp: 9999999999, name: 'Test' }
    const token = makeJwt(payload)
    const decoded = decodeJwtPayload(token)
    expect(decoded).toEqual(payload)
  })

  it('应返回 null 对于无效 token（缺少 parts）', () => {
    expect(decodeJwtPayload('invalid')).toBeNull()
    expect(decodeJwtPayload('')).toBeNull()
  })

  it('应返回 null 对于不合法的 base64', () => {
    expect(decodeJwtPayload('a.!!!invalid!!!.b')).toBeNull()
  })

  it('应正确处理 base64url 编码（含 - 和 _）', () => {
    const payload = { data: 'test+value/special' }
    const token = makeJwt(payload)
    const decoded = decodeJwtPayload(token)
    expect(decoded).toEqual(payload)
  })
})

describe('sanitizeBundle', () => {
  it('应返回空 bundle 对于 null/undefined', () => {
    expect(sanitizeBundle(null)).toEqual({
      accessToken: null,
      refreshToken: null,
      userInfo: null,
      expiresAt: null,
    })
    expect(sanitizeBundle(undefined)).toEqual({
      accessToken: null,
      refreshToken: null,
      userInfo: null,
      expiresAt: null,
    })
  })

  it('应返回空 bundle 对于非对象类型', () => {
    expect(sanitizeBundle('string')).toEqual({
      accessToken: null,
      refreshToken: null,
      userInfo: null,
      expiresAt: null,
    })
    expect(sanitizeBundle(42)).toEqual({
      accessToken: null,
      refreshToken: null,
      userInfo: null,
      expiresAt: null,
    })
  })

  it('应正确序列化有效的 bundle', () => {
    const bundle = {
      accessToken: 'at123',
      refreshToken: 'rt456',
      userInfo: { id: '1', name: 'Test' },
      expiresAt: 1700000000000,
    }
    expect(sanitizeBundle(bundle)).toEqual(bundle)
  })

  it('应将缺失字段填充为 null', () => {
    expect(sanitizeBundle({})).toEqual({
      accessToken: null,
      refreshToken: null,
      userInfo: null,
      expiresAt: null,
    })
  })

  it('应忽略非数字的 expiresAt', () => {
    expect(sanitizeBundle({ expiresAt: 'invalid' })).toEqual({
      accessToken: null,
      refreshToken: null,
      userInfo: null,
      expiresAt: null,
    })
  })
})

describe('isTokenExpiringSoon', () => {
  it('应返回 true 对于空 token', () => {
    expect(isTokenExpiringSoon('')).toBe(true)
  })

  it('应返回 false 对于未过期的 token', () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600 // 1小时后
    const token = makeJwt({ exp: futureExp })
    expect(isTokenExpiringSoon(token, 5)).toBe(false)
  })

  it('应返回 true 对于即将过期的 token（在缓冲区内）', () => {
    const soonExp = Math.floor(Date.now() / 1000) + 120 // 2分钟后
    const token = makeJwt({ exp: soonExp })
    expect(isTokenExpiringSoon(token, 5)).toBe(true)
  })

  it('应返回 true 对于已过期的 token', () => {
    const pastExp = Math.floor(Date.now() / 1000) - 3600 // 1小时前
    const token = makeJwt({ exp: pastExp })
    expect(isTokenExpiringSoon(token, 5)).toBe(true)
  })

  it('应返回 false 对于没有 exp 字段的 token', () => {
    const token = makeJwt({ sub: '123' }) // 无 exp
    expect(isTokenExpiringSoon(token, 5)).toBe(false)
  })

  it('应支持自定义缓冲区分钟数', () => {
    const exp = Math.floor(Date.now() / 1000) + 600 // 10分钟后
    const token = makeJwt({ exp })
    expect(isTokenExpiringSoon(token, 5)).toBe(false) // 5分钟缓冲→不算即将过期
    expect(isTokenExpiringSoon(token, 15)).toBe(true) // 15分钟缓冲→算即将过期
  })
})
