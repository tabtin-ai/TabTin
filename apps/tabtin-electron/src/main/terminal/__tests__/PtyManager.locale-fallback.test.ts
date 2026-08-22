import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PtyManager, resolveDefaultLocaleEnv } from '../PtyManager'
import type { PtyHostClient, PtyHostSession } from '../PtyHost'

vi.mock('../../cli/cli-server', () => ({
  getCLIServerInfo: () => null,
}))

/**
 * ：打包版从 Finder/Dock 启动的 Electron 不继承 shell 环境，process.env.LANG 缺失，
 * PTY 子进程退回 C/POSIX locale，导致终端中文乱码。这里钉住 locale 兜底逻辑：
 * 仅当 env 完全没有 LANG/LC_ALL/LC_CTYPE 时才补一个从系统 locale 派生的 UTF-8 locale，
 * 已有任一 locale 变量则不覆盖。
 */
describe('resolveDefaultLocaleEnv（纯函数）', () => {
  it('env 无 locale + zh-CN → 补 zh_CN.UTF-8', () => {
    expect(resolveDefaultLocaleEnv({}, 'zh-CN')).toEqual({ LANG: 'zh_CN.UTF-8' })
  })

  it('env 无 locale + en-US → 补 en_US.UTF-8', () => {
    expect(resolveDefaultLocaleEnv({}, 'en-US')).toEqual({ LANG: 'en_US.UTF-8' })
  })

  it('繁中地区 zh-TW → zh_TW.UTF-8', () => {
    expect(resolveDefaultLocaleEnv({}, 'zh-TW')).toEqual({ LANG: 'zh_TW.UTF-8' })
  })

  it('无法解析的 locale（缺地区 / 空）→ 回退 en_US.UTF-8', () => {
    expect(resolveDefaultLocaleEnv({}, 'ja')).toEqual({ LANG: 'en_US.UTF-8' })
    expect(resolveDefaultLocaleEnv({}, '')).toEqual({ LANG: 'en_US.UTF-8' })
  })

  it('已有 LANG → 不覆盖', () => {
    expect(resolveDefaultLocaleEnv({ LANG: 'ja_JP.UTF-8' }, 'zh-CN')).toEqual({})
  })

  it('已有 LC_ALL 或 LC_CTYPE → 不覆盖', () => {
    expect(resolveDefaultLocaleEnv({ LC_ALL: 'C.UTF-8' }, 'zh-CN')).toEqual({})
    expect(resolveDefaultLocaleEnv({ LC_CTYPE: 'en_US.UTF-8' }, 'zh-CN')).toEqual({})
  })
})

class MockHostSession implements PtyHostSession {
  pid = 4321
  write = vi.fn()
  pauseOutput = vi.fn()
  resumeOutput = vi.fn()
  resize = vi.fn()
  kill = vi.fn()
  onSpawned = vi.fn(() => ({ dispose: vi.fn() }))
  onData = vi.fn(() => ({ dispose: vi.fn() }))
  onExit = vi.fn(() => ({ dispose: vi.fn() }))
}

class MockPtyHostClient implements PtyHostClient {
  lastEnv: Record<string, string> | undefined
  spawn = vi.fn((opts: { env?: Record<string, string> }) => {
    this.lastEnv = opts.env
    return new MockHostSession()
  })
}

describe('PtyManager.spawn locale 兜底接线', () => {
  const LOCALE_VARS = ['LANG', 'LC_ALL', 'LC_CTYPE'] as const
  const saved: Record<string, string | undefined> = {}
  let hostClient: MockPtyHostClient
  let manager: PtyManager

  beforeEach(() => {
    for (const key of LOCALE_VARS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    hostClient = new MockPtyHostClient()
    manager = new PtyManager(hostClient, { terminateTree: vi.fn() } as never)
  })

  afterEach(() => {
    manager.cleanup()
    for (const key of LOCALE_VARS) {
      if (saved[key] == null) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('process.env 无 locale（模拟打包）→ 子进程 env 补 UTF-8 LANG', () => {
    expect(manager.spawn('pkg-term', {})).toBe(true)
    const env = hostClient.lastEnv ?? {}
    // 测试上下文 app 不可用 → app.getLocale() 回退空串 → en_US.UTF-8
    expect(env.LANG).toBe('en_US.UTF-8')
  })

  it('process.env 已有 LANG（模拟 dev 继承 shell）→ 不覆盖', () => {
    process.env.LANG = 'zh_CN.UTF-8'
    expect(manager.spawn('dev-term', {})).toBe(true)
    const env = hostClient.lastEnv ?? {}
    expect(env.LANG).toBe('zh_CN.UTF-8')
  })
})
