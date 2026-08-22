import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STEALTH_ARGS } from '@tabtin/anti-detect'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(() => '/tmp/tabtin-user-data'),
  appendSwitch: vi.fn(),
  installGlobalWindowRecoveryHooks: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  app: {
    getPath: mocks.getPath,
    commandLine: {
      appendSwitch: mocks.appendSwitch,
    },
  },
}))

vi.mock('./main-window', () => ({
  installGlobalWindowRecoveryHooks: mocks.installGlobalWindowRecoveryHooks,
}))

vi.mock('./dev-cdp-port', () => ({
  resolveDevCdpPortWithMeta: vi.fn(() => ({
    port: 9222,
    requestedPort: 9222,
    fallbackUsed: false,
  })),
}))

import { configureMainProcess } from './main-process-config'
import { resolveDevCdpPortWithMeta } from './dev-cdp-port'

describe('main-process-config', () => {
  const originalSecurityWarnings = process.env.ELECTRON_DISABLE_SECURITY_WARNINGS

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.ELECTRON_DISABLE_SECURITY_WARNINGS
  })

  afterEach(() => {
    if (originalSecurityWarnings === undefined) {
      delete process.env.ELECTRON_DISABLE_SECURITY_WARNINGS
    } else {
      process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = originalSecurityWarnings
    }
  })

  it('会配置主进程命令行开关并安装窗口恢复钩子', () => {
    configureMainProcess({
      isDev: true,
      log: mocks.log,
      cdpPort: 9333,
    })

    expect(mocks.appendSwitch).toHaveBeenCalledWith('log-file', '/tmp/tabtin-user-data/chromium.log')
    expect(mocks.appendSwitch).toHaveBeenCalledWith('remote-debugging-port', '9333')
    expect(mocks.appendSwitch).toHaveBeenCalledWith('remote-debugging-address', '127.0.0.1')
    expect(mocks.installGlobalWindowRecoveryHooks).toHaveBeenCalledWith(mocks.log)
    expect(mocks.log.info).toHaveBeenCalledWith('CDP 调试端口已启用: 127.0.0.1:9333')
    expect(process.env.ELECTRON_DISABLE_SECURITY_WARNINGS).toBe('true')
  })

  it('非开发环境下不会开启安全警告屏蔽且不启用 CDP 调试', () => {
    configureMainProcess({
      isDev: false,
      log: mocks.log,
    })

    expect(process.env.ELECTRON_DISABLE_SECURITY_WARNINGS).toBeUndefined()
    expect(mocks.appendSwitch).not.toHaveBeenCalledWith('remote-debugging-port', expect.any(String))
    expect(mocks.appendSwitch).not.toHaveBeenCalledWith('remote-debugging-address', expect.any(String))
  })

  it('应用共享 stealth flags（过滤 Electron 不适用的 flag）', () => {
    configureMainProcess({
      isDev: false,
      log: mocks.log,
    })

    const calls = mocks.appendSwitch.mock.calls.map(
      ([key, val]: [string, string?]) => val ? `--${key}=${val}` : `--${key}`,
    )

    // 核心 stealth flag 应被设置
    expect(calls).toContain('--disable-blink-features=AutomationControlled')
    expect(calls).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp')
    expect(calls).toContain('--force-color-profile=srgb')
    expect(calls).toContain('--autoplay-policy=user-gesture-required')

    // --test-type 应被排除（Electron 不适用）
    expect(calls).not.toContain('--test-type')

    // enable-features 应合并基础 + stealth
    const enableFeaturesCall = mocks.appendSwitch.mock.calls.find(
      ([key]: [string]) => key === 'enable-features',
    )
    expect(enableFeaturesCall).toBeDefined()
    const featureStr: string = enableFeaturesCall![1]
    expect(featureStr).toContain('VaapiVideoDecoder')
    expect(featureStr).toContain('TrustTokens')
  })

  it('stealth args 中的 --test-type 不会被应用', () => {
    expect(STEALTH_ARGS).toContain('--test-type')

    configureMainProcess({
      isDev: false,
      log: mocks.log,
    })

    const switchNames = mocks.appendSwitch.mock.calls.map(([key]: [string]) => key)
    expect(switchNames).not.toContain('test-type')
  })

  it('dev 下 9222 被占用时会 warn 并使用 fallback 端口', () => {
    vi.mocked(resolveDevCdpPortWithMeta).mockReturnValue({
      port: 9333,
      requestedPort: 9222,
      fallbackUsed: true,
    })

    configureMainProcess({
      isDev: true,
      log: mocks.log,
    })

    expect(mocks.appendSwitch).toHaveBeenCalledWith('remote-debugging-port', '9333')
    expect(mocks.log.warn).toHaveBeenCalledWith(expect.stringContaining('9333'))
  })
})
