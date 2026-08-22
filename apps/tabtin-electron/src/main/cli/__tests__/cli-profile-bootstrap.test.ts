/**
 * cli-profile-bootstrap: placeholder profile 初始化契约
 *
 * 钉住"Go CLI fail-fast 闸门防卡死"机制（首次启动 / 删 config.json 后），
 * 验证 `ensureCliProfileBootstrap()` 的四种返回路径符合契约。
 *
 * 背景：Go CLI 在 `~/.tabtin/config.json` 看不到 profile.token 时会触发
 * fail-fast，所有 RequiresAuth 命令立即报 UNAUTHORIZED——即使 Electron
 * TokenManager 已持有真 JWT。本模块在 CLI Server 启动时写一个 placeholder
 * profile（token 是字面字符串，不是真 JWT）让闸门放行。
 *
 * 详见 cli-profile-bootstrap.ts 顶部注释和
 * support/about/2026-05-27-electron-cli-profile-bootstrap.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mocks = vi.hoisted(() => ({
  tmpHome: '',
  accessToken: null as string | null,
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '1.0.0-test'),
    getAppPath: vi.fn(() => '/tmp/app'),
    isPackaged: false,
  },
}))

vi.mock('@tabtin/shared/storage-paths', () => ({
  getHomeTabtinPath: (...segments: string[]) => join(mocks.tmpHome, '.tabtin', ...segments),
}))

vi.mock('../../config/api', () => ({
  API_BASE_URL: 'http://127.0.0.1:6060/api',
}))

vi.mock('../../auth', () => ({
  TokenManager: {
    getAccessToken: vi.fn(async () => mocks.accessToken),
  },
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import { ensureCliProfileBootstrap } from '../cli-profile-bootstrap'

describe('ensureCliProfileBootstrap · 契约', () => {
  beforeEach(() => {
    mocks.tmpHome = mkdtempSync(join(tmpdir(), 'tabtin-bootstrap-test-'))
    mocks.accessToken = null
  })

  afterEach(() => {
    rmSync(mocks.tmpHome, { recursive: true, force: true })
  })

  it('config.json 不存在 + 已登录 → 写入 placeholder profile，返回 created', async () => {
    mocks.accessToken = 'fake-real-jwt-in-keychain'

    const result = await ensureCliProfileBootstrap()
    expect(result).toBe('created')

    const configPath = join(mocks.tmpHome, '.tabtin', 'config.json')
    expect(existsSync(configPath)).toBe(true)

    const content = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(content.version).toBe(2)
    expect(content.currentProfile).toBe('default')
    expect(content.profiles.default.baseURL).toBe('http://127.0.0.1:6060/api')
    expect(content.profiles.default.token).toBe('managed-by-electron')
    expect(content.profiles.default.label).toBe('TabTin App')
  })

  it('placeholder token 是字面占位符，不是真 JWT（SD-039 §4.5：不让真 token 落盘）', async () => {
    mocks.accessToken = 'real-jwt-must-not-leak-to-disk'

    await ensureCliProfileBootstrap()

    const configPath = join(mocks.tmpHome, '.tabtin', 'config.json')
    const content = readFileSync(configPath, 'utf-8')

    expect(content).not.toContain('real-jwt-must-not-leak-to-disk')
    expect(content).toContain('"token": "managed-by-electron"')
  })

  it('config.json 已存在 → 不覆盖，返回 exists（保护用户手动配置）', async () => {
    mocks.accessToken = 'fake-real-jwt'
    const configDir = join(mocks.tmpHome, '.tabtin')
    const configPath = join(configDir, 'config.json')

    rmSync(configDir, { recursive: true, force: true })
    mkdirIfMissing(configDir)

    const userConfig = {
      version: 2,
      currentProfile: 'production',
      profiles: {
        production: {
          baseURL: 'https://www.example.com/api',
          token: 'user_configured_real_token_xyz',
          label: 'My Prod',
        },
      },
      defaults: { format: 'yaml' },
    }
    writeFileSync(configPath, JSON.stringify(userConfig, null, 2), { encoding: 'utf-8' })

    const result = await ensureCliProfileBootstrap()
    expect(result).toBe('exists')

    const after = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(after.currentProfile).toBe('production')
    expect(after.profiles.production.token).toBe('user_configured_real_token_xyz')
    expect(after.profiles.production.baseURL).toBe('https://www.example.com/api')
    expect(after.defaults.format).toBe('yaml')
  })

  it('未登录（TokenManager 无 access token）→ 不写，返回 skipped_no_login', async () => {
    mocks.accessToken = null

    const result = await ensureCliProfileBootstrap()
    expect(result).toBe('skipped_no_login')

    const configPath = join(mocks.tmpHome, '.tabtin', 'config.json')
    expect(existsSync(configPath)).toBe(false)
  })

  it('写入文件 mode 必须是 0o600（防止其它用户读取 placeholder 元信息）', async () => {
    if (process.platform === 'win32') return // Windows 没有 POSIX 权限

    mocks.accessToken = 'fake-jwt'

    await ensureCliProfileBootstrap()

    const configPath = join(mocks.tmpHome, '.tabtin', 'config.json')
    const stat = statSync(configPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })
})

function mkdirIfMissing(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  const { mkdirSync } = require('node:fs') as typeof import('node:fs')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}
