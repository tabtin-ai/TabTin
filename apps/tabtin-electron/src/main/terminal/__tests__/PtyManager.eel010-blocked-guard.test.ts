/**
 * EEL-010 回归测试：PtyManager.executeCommand 显式 policy.route=blocked 兜底
 *
 * 验证 PtyManager.executeCommand() 在 policy.route === 'blocked' 时，
 * 通过显式兜底检查直接抛出 Error，而非仅依赖 getInteractiveTerminalPolicySupportError。
 * 与 Daemon 的 daemon-pty-manager.ts 保持对齐。
 *
 * 覆盖场景：
 * - policy.route='blocked' + denyReason → 抛出包含 denyReason 的错误
 * - policy.route='blocked' 无 denyReason → 抛出默认错误信息
 * - policy.route='blocked' 的错误信息格式与 Daemon 一致
 * - policy.route='regular' → 不被兜底拦截
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PtyManager } from '../PtyManager'
import type { PtyHostClient, PtyHostSession } from '../PtyHost'

const { getCLIServerInfoMock } = vi.hoisted(() => ({
  getCLIServerInfoMock: vi.fn(() => null),
}))

vi.mock('../../cli/cli-server', () => ({
  getCLIServerInfo: getCLIServerInfoMock,
}))

class MockHostSession implements PtyHostSession {
  pid = 9527

  private spawnedHandler?: (event: { pid: number }) => void
  private dataHandler?: (data: string) => void
  private exitHandler?: (event: { exitCode: number | null; signal?: number }) => void

  write = vi.fn()
  pauseOutput = vi.fn()
  resumeOutput = vi.fn()
  resize = vi.fn()
  kill = vi.fn()

  onSpawned = vi.fn((handler: (event: { pid: number }) => void) => {
    this.spawnedHandler = handler
    return { dispose: vi.fn() }
  })

  onData = vi.fn((handler: (data: string) => void) => {
    this.dataHandler = handler
    return { dispose: vi.fn() }
  })

  onExit = vi.fn((handler: (event: { exitCode: number | null; signal?: number }) => void) => {
    this.exitHandler = handler
    return { dispose: vi.fn() }
  })
}

class MockPtyHostClient implements PtyHostClient {
  spawn = vi.fn(() => new MockHostSession())
}

class MockProcessTerminator {
  terminateTree = vi.fn()
}

describe('EEL-010: PtyManager executeCommand blocked-route 兜底检查', () => {
  let hostClient: MockPtyHostClient
  let processTerminator: MockProcessTerminator
  let manager: PtyManager

  beforeEach(() => {
    getCLIServerInfoMock.mockReset()
    getCLIServerInfoMock.mockReturnValue(null)
    hostClient = new MockPtyHostClient()
    processTerminator = new MockProcessTerminator()
    manager = new PtyManager(hostClient, processTerminator as any)
  })

  afterEach(() => {
    manager.cleanup()
  })

  it('policy.route=blocked + denyReason → 抛出包含 denyReason 的错误', async () => {
    expect(manager.spawn('s1', { cwd: '/tmp' })).toBe(true)

    await expect(
      manager.executeCommand('s1', 'echo hello', {
        policy: {
          route: 'blocked',
          denyReason: 'Admin禁止此操作',
        },
      }),
    ).rejects.toThrow('Admin禁止此操作')
  })

  it('policy.route=blocked 无 denyReason → 抛出默认错误信息', async () => {
    expect(manager.spawn('s2', { cwd: '/tmp' })).toBe(true)

    await expect(
      manager.executeCommand('s2', 'echo hello', {
        policy: {
          route: 'blocked',
        },
      }),
    ).rejects.toThrow('execution not allowed by current sandbox policy')
  })

  it('错误信息格式与 Daemon 一致（包含 "Command blocked by security policy:" 前缀）', async () => {
    expect(manager.spawn('s3', { cwd: '/tmp' })).toBe(true)

    await expect(
      manager.executeCommand('s3', 'echo hello', {
        policy: {
          route: 'blocked',
          denyReason: 'test reason',
        },
      }),
    ).rejects.toThrow('Command blocked by security policy: test reason')
  })

  it('policy.route=regular → 不被兜底拦截（正常进入执行流程）', async () => {
    vi.useFakeTimers()
    try {
      expect(manager.spawn('s4', { cwd: '/tmp' })).toBe(true)

      const resultPromise = manager.executeCommand('s4', 'echo hello', {
        policy: { route: 'regular' },
        blockUntilMs: 5000,
      })

      const hostSession = hostClient.spawn.mock.results[0]?.value as MockHostSession
      const wrappedCommand = hostSession.write.mock.calls.at(-1)?.[0] as string

      expect(wrappedCommand).toBeDefined()
      expect(wrappedCommand).toContain('echo hello')

      const startMarker = wrappedCommand.match(/__TABTIN_CMD_START_[a-f0-9]+__/)?.[0]
      const endMarkerPrefix = wrappedCommand.match(/__TABTIN_CMD_END_[a-f0-9]+_/)?.[0]

      if (startMarker && endMarkerPrefix) {
        hostSession.onData.mock.calls[0]?.[0](`${startMarker}\nhello\n${endMarkerPrefix}0_/tmp__\n`)
      }

      const result = await resultPromise
      expect(result.exitCode).not.toBe(126)
      expect(result.sessionId).toBe('s4')
    } finally {
      vi.useRealTimers()
    }
  })

  it('policy 为 undefined → 不被兜底拦截', async () => {
    vi.useFakeTimers()
    try {
      expect(manager.spawn('s5', { cwd: '/tmp' })).toBe(true)

      const resultPromise = manager.executeCommand('s5', 'ls', {
        blockUntilMs: 5000,
      })

      const hostSession = hostClient.spawn.mock.results[0]?.value as MockHostSession
      const wrappedCommand = hostSession.write.mock.calls.at(-1)?.[0] as string

      expect(wrappedCommand).toContain('ls')

      const startMarker = wrappedCommand.match(/__TABTIN_CMD_START_[a-f0-9]+__/)?.[0]
      const endMarkerPrefix = wrappedCommand.match(/__TABTIN_CMD_END_[a-f0-9]+_/)?.[0]

      if (startMarker && endMarkerPrefix) {
        hostSession.onData.mock.calls[0]?.[0](`${startMarker}\nfile.txt\n${endMarkerPrefix}0_/tmp__\n`)
      }

      const result = await resultPromise
      expect(result.exitCode).not.toBe(126)
    } finally {
      vi.useRealTimers()
    }
  })
})
