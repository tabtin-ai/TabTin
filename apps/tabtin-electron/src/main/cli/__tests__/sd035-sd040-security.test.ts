/**
 * 回归测试：SD-035, SD-036, SD-037, SD-038, SD-040
 *
 * SD-035: djangoRequest 绝对超时保护（非仅 socket 空闲超时）
 * SD-036: performRequest 中 res.on('error') 处理
 * SD-037: 并发刷新 token 避免重复消耗已轮转的 refresh token
 * SD-038: server.json 写入后 chmodSync 强制权限
 * SD-040: api-proxy.ts makeRequest 绝对超时保护
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { EventEmitter } from 'node:events'

// ─── SD-035: djangoRequest 绝对超时保护 ──────────────────────

describe('SD-035: djangoRequest 绝对超时', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('源码中 performRequest 包含绝对超时 setTimeout', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../routes/shared/error-handler.ts'),
      'utf-8',
    )

    expect(source).toContain('ABSOLUTE_TIMEOUT_MULTIPLIER')
    expect(source).toContain('absoluteTimer')
    expect(source).toContain('absoluteTimeout')
    const absoluteTimeoutPattern = /setTimeout\(\s*\(\)\s*=>\s*\{[^}]*req\.destroy\(\)/s
    expect(absoluteTimeoutPattern.test(source)).toBe(true)
  })

  it('绝对超时值为 socket timeout 的倍数', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../routes/shared/error-handler.ts'),
      'utf-8',
    )

    const multiplierMatch = source.match(/ABSOLUTE_TIMEOUT_MULTIPLIER\s*=\s*(\d+)/)
    expect(multiplierMatch).not.toBeNull()
    const multiplier = Number(multiplierMatch![1])
    expect(multiplier).toBeGreaterThanOrEqual(2)
  })
})

// ─── SD-036: performRequest res.on('error') ──────────────────

describe('SD-036: performRequest 响应流错误处理', () => {
  it('源码中响应回调包含 res.on error 处理', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../routes/shared/error-handler.ts'),
      'utf-8',
    )

    const resOnErrorPattern = /res\.on\(\s*['"]error['"]/
    expect(resOnErrorPattern.test(source)).toBe(true)
  })

  it('res.on error settle 包含 UNAVAILABLE 错误码', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../routes/shared/error-handler.ts'),
      'utf-8',
    )

    const resErrorLines = source.split('\n')
    let inResOnError = false
    let foundBackendError = false
    for (const line of resErrorLines) {
      if (/res\.on\(\s*['"]error['"]/.test(line)) {
        inResOnError = true
      }
      if (inResOnError && line.includes('UNAVAILABLE')) {
        foundBackendError = true
        break
      }
      if (inResOnError && /res\.on\(/.test(line) && !/error/.test(line)) {
        break
      }
    }
    expect(foundBackendError).toBe(true)
  })
})

// ─── SD-037: 并发刷新 token 竞争保护 ────────────────────────

describe('SD-037: 并发 refresh token 竞争保护', () => {
  it('源码包含 token 变更检测逻辑（避免重复刷新）', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../routes/shared/error-handler.ts'),
      'utf-8',
    )

    expect(source).toContain('originalToken')
    expect(source).toContain('latestToken')
    expect(source).toContain('latestToken !== originalToken')
  })

  it('refreshAccessTokenShared 包含结果缓存 TTL', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../routes/shared/error-handler.ts'),
      'utf-8',
    )

    expect(source).toContain('lastRefreshedToken')
    expect(source).toContain('lastRefreshedAt')
    expect(source).toContain('REFRESH_RESULT_TTL_MS')

    const ttlMatch = source.match(/REFRESH_RESULT_TTL_MS\s*=\s*(\d[\d_]*)/)
    expect(ttlMatch).not.toBeNull()
    const ttlMs = Number(ttlMatch![1].replace(/_/g, ''))
    expect(ttlMs).toBeGreaterThanOrEqual(5_000)
    expect(ttlMs).toBeLessThanOrEqual(30_000)
  })

  it('401 重试前先检查 token 是否已被其他请求刷新', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../routes/shared/error-handler.ts'),
      'utf-8',
    )

    const tokenCheckBeforeRefresh = /getAccessToken\(\)[\s\S]*?latestToken\s*!==\s*originalToken[\s\S]*?refreshAccessTokenShared\(\)/
    expect(tokenCheckBeforeRefresh.test(source)).toBe(true)
  })
})

// ─── SD-038: server.json chmodSync 强制权限 ──────────────────

describe('SD-038: discovery file 权限由 cli-server-core 统一收紧', () => {
  it('writeDiscoveryFile 内部会在非 Windows 上执行 chmodSync(filePath, 0o600)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../../../../packages/cli-server-core/src/server.ts'),
      'utf-8',
    )

    expect(source).toContain('writeDiscoveryFile')
    const chmodPattern = /chmodSync\(\s*filePath\s*,\s*0o600\s*\)/
    expect(chmodPattern.test(source)).toBe(true)
  })

  it('Electron CLI 仍会分别写入 server.json 与 dev-server.json', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../cli-server.ts'),
      'utf-8',
    )

    expect(source).toContain("writeDiscoveryFileDetailed('server.json'")
    expect(source).toContain("writeDiscoveryFileDetailed('dev-server.json'")
  })

  it('chmodSync 仅在非 Windows 平台执行', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../../../../packages/cli-server-core/src/server.ts'),
      'utf-8',
    )

    const lines = source.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (/chmodSync\(\s*filePath/.test(lines[i])) {
        const contextBefore = lines.slice(Math.max(0, i - 3), i).join('\n')
        expect(contextBefore).toContain("process.platform !== 'win32'")
      }
    }
  })
})

// ─── SD-040: api-proxy.ts makeRequest 绝对超时 ──────────────

describe('SD-040: api-proxy makeRequest 绝对超时', () => {
  it('makeRequest 包含绝对超时 setTimeout 保护', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../api-proxy.ts'),
      'utf-8',
    )

    expect(source).toContain('ABSOLUTE_TIMEOUT_MULTIPLIER')
    expect(source).toContain('absoluteTimeout')
    expect(source).toContain('absoluteTimer')
    const absoluteTimeoutPattern = /setTimeout\(\s*\(\)\s*=>\s*\{[^}]*req\.destroy\(\)/s
    expect(absoluteTimeoutPattern.test(source)).toBe(true)
  })

  it('makeRequest 包含 res.on error 处理', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../api-proxy.ts'),
      'utf-8',
    )

    const resOnErrorPattern = /res\.on\(\s*['"]error['"]/
    expect(resOnErrorPattern.test(source)).toBe(true)
  })

  it('settle 函数防止多次 resolve/reject', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../api-proxy.ts'),
      'utf-8',
    )

    expect(source).toContain('if (settled) return')
    expect(source).toContain('settled = true')
  })
})
