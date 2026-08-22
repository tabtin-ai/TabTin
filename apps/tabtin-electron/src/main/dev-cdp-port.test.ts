import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    default: {
      ...actual,
      execSync: execSyncMock,
    },
    execSync: execSyncMock,
  }
})

import {
  DEFAULT_DEV_CDP_PORT,
  isTcpPortListening,
  parseEnvCdpPort,
  resolveDevCdpPortWithMeta,
} from './dev-cdp-port'

describe('dev-cdp-port', () => {
  const originalTabtin = process.env.TABTIN_CDP_PORT
  const originalCdp = process.env.CDP_PORT

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.TABTIN_CDP_PORT
    delete process.env.CDP_PORT
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    if (originalTabtin === undefined) delete process.env.TABTIN_CDP_PORT
    else process.env.TABTIN_CDP_PORT = originalTabtin
    if (originalCdp === undefined) delete process.env.CDP_PORT
    else process.env.CDP_PORT = originalCdp
  })

  it('parseEnvCdpPort 读取 TABTIN_CDP_PORT / CDP_PORT', () => {
    process.env.TABTIN_CDP_PORT = '9333'
    expect(parseEnvCdpPort()).toBe(9333)
    delete process.env.TABTIN_CDP_PORT
    process.env.CDP_PORT = '9224'
    expect(parseEnvCdpPort()).toBe(9224)
  })

  it('isTcpPortListening 在 lsof 成功时返回 true', () => {
    execSyncMock.mockImplementation(() => '')
    expect(isTcpPortListening(9222)).toBe(true)
    expect(execSyncMock).toHaveBeenCalledWith('lsof -nP -iTCP:9222 -sTCP:LISTEN', { stdio: 'ignore' })
  })

  it('isTcpPortListening 在 lsof 抛错时返回 false', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('not found')
    })
    expect(isTcpPortListening(9333)).toBe(false)
  })

  it('9222 被占用时 fallback 到下一个空闲端口', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (String(cmd).includes('9222')) return ''
      throw new Error('free')
    })
    expect(resolveDevCdpPortWithMeta()).toEqual({
      port: 9333,
      requestedPort: DEFAULT_DEV_CDP_PORT,
      fallbackUsed: true,
    })
  })

  it('显式 TABTIN_CDP_PORT 优先于默认 9222', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('free')
    })
    process.env.TABTIN_CDP_PORT = '9227'
    expect(resolveDevCdpPortWithMeta()).toEqual({
      port: 9227,
      requestedPort: 9227,
      fallbackUsed: false,
    })
  })
})
