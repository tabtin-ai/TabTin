/**
 * P0-F1 regression tests:
 * 1. killOnTimeout is always passed to commandRunner.execute()
 * 2. needsRestart triggers automatic session restart (pre-flight + reactive)
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

  triggerData(data: string): void {
    this.dataHandler?.(data)
  }

  triggerSpawned(pid: number): void {
    this.pid = pid
    this.spawnedHandler?.({ pid })
  }

  triggerExit(exitCode: number | null, signal?: number): void {
    this.exitHandler?.({ exitCode, signal })
  }
}

class MockPtyHostClient implements PtyHostClient {
  private readonly sessions: MockHostSession[] = []

  spawn = vi.fn(() => {
    const session = new MockHostSession()
    this.sessions.push(session)
    return session
  })

  getLastSession(): MockHostSession {
    const session = this.sessions.at(-1)
    if (!session) throw new Error('No host session created')
    return session
  }

  getSessionCount(): number {
    return this.sessions.length
  }
}

class MockProcessTerminator {
  terminateTree = vi.fn()
}

describe('P0-F1: killOnTimeout + needsRestart', () => {
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

  describe('killOnTimeout 传递', () => {
    it('executeCommand 向 commandRunner.execute 传递 killOnTimeout: true', async () => {
      vi.useFakeTimers()
      try {
        expect(manager.spawn('session-kill', { cwd: '/tmp' })).toBe(true)

        const resultPromise = manager.executeCommand('session-kill', 'yes', {
          blockUntilMs: 1000,
        })

        const hostSession = hostClient.getLastSession()

        // Advance past the timeout
        vi.advanceTimersByTime(1001)

        const result = await resultPromise
        expect(result.backgrounded).toBe(false)
        expect(result.timedOut).toBe(true)

        // killOnTimeout: true → should have sent Ctrl+C (\x03) to the PTY
        const ctrlCWrites = hostSession.write.mock.calls.filter(
          (call: any[]) => call[0] === '\x03',
        )
        expect(ctrlCWrites).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('needsRestart 消费 — 预检重启', () => {
    it('executeCommand 检测到 needsRestart 后自动重启 session shell', async () => {
      expect(manager.spawn('session-restart', { cwd: '/tmp' })).toBe(true)

      // Simulate needsRestart being set (as PtyCommandRunner would do)
      const session = manager.getSession('session-restart')
      expect(session).toBeTruthy()
      session!.needsRestart = true

      const initialSpawnCount = hostClient.getSessionCount()

      // Execute a new command — should trigger pre-flight restart
      const resultPromise = manager.executeCommand('session-restart', 'echo hello', {
        blockUntilMs: 5000,
      })

      // Restart should have spawned a new PTY process
      expect(hostClient.getSessionCount()).toBe(initialSpawnCount + 1)

      // needsRestart should be cleared
      const restartedSession = manager.getSession('session-restart')
      expect(restartedSession).toBeTruthy()
      expect(restartedSession!.needsRestart).toBeFalsy()
      expect(restartedSession!.isRunning).toBe(true)

      // Complete the command so the promise resolves
      const newHostSession = hostClient.getLastSession()
      const wrappedCommand = newHostSession.write.mock.calls.at(-1)?.[0] as string
      const startMarker = wrappedCommand.match(/__TABTIN_CMD_START_[a-f0-9]+__/)?.[0]
      const endMarkerPrefix = wrappedCommand.match(/__TABTIN_CMD_END_[a-f0-9]+_/)?.[0]

      if (startMarker && endMarkerPrefix) {
        newHostSession.triggerData(`${startMarker}\nhello\n${endMarkerPrefix}0_/tmp__\n`)
      }

      const result = await resultPromise
      expect(result.sessionId).toBe('session-restart')
    })

    it('重启保留 spaceId 和 session 可用性', async () => {
      const sessionId = manager.spawnAgentSession('space-restart-test', {
        cwd: '/tmp',
        threadId: 'thread-restart',
      })
      expect(sessionId).toBeTruthy()

      const session = manager.getSession(sessionId!)
      expect(session).toBeTruthy()
      session!.needsRestart = true

      // Execute triggers restart
      const resultPromise = manager.executeCommand(sessionId!, 'echo ok', {
        blockUntilMs: 5000,
      })

      const restartedSession = manager.getSession(sessionId!)
      expect(restartedSession).toBeTruthy()
      expect(restartedSession!.spaceId).toBe('space-restart-test')
      expect(restartedSession!.isRunning).toBe(true)

      // Complete the command
      const newHostSession = hostClient.getLastSession()
      const wrappedCommand = newHostSession.write.mock.calls.at(-1)?.[0] as string
      const startMarker = wrappedCommand.match(/__TABTIN_CMD_START_[a-f0-9]+__/)?.[0]
      const endMarkerPrefix = wrappedCommand.match(/__TABTIN_CMD_END_[a-f0-9]+_/)?.[0]

      if (startMarker && endMarkerPrefix) {
        newHostSession.triggerData(`${startMarker}\nok\n${endMarkerPrefix}0_/tmp__\n`)
      }

      const result = await resultPromise
      expect(result.output).toContain('ok')
    })
  })

  describe('needsRestart 消费 — 反应式重启', () => {
    it('session-restarted 事件在重启时触发', () => {
      expect(manager.spawn('session-reactive', { cwd: '/tmp' })).toBe(true)

      const restartedEvents: any[] = []
      manager.on('session-restarted', (e) => restartedEvents.push(e))

      const session = manager.getSession('session-reactive')
      expect(session).toBeTruthy()
      session!.needsRestart = true

      const initialSpawnCount = hostClient.getSessionCount()

      // TT-04: 通过直接回调触发重启（新机制取代日志字符串解析）
      ;(manager as any).handleNeedsRestartCallback('session-reactive')

      expect(hostClient.getSessionCount()).toBe(initialSpawnCount + 1)
      expect(restartedEvents).toHaveLength(1)
      expect(restartedEvents[0].sessionId).toBe('session-reactive')

      const restartedSession = manager.getSession('session-reactive')
      expect(restartedSession!.needsRestart).toBeFalsy()
      expect(restartedSession!.isRunning).toBe(true)
    })

    it('如果 needsRestart 为 false 则不触发重启', () => {
      expect(manager.spawn('session-no-restart', { cwd: '/tmp' })).toBe(true)
      const initialSpawnCount = hostClient.getSessionCount()

      // TT-04: 即使回调被调用，needsRestart=false 时也不应触发重启
      ;(manager as any).handleNeedsRestartCallback('session-no-restart')

      // needsRestart was not set, so no restart should happen
      expect(hostClient.getSessionCount()).toBe(initialSpawnCount)
    })
  })

  describe('needsRestart 边界: restart 失败时保留标记', () => {
    it('restart 失败时 needsRestart 保持 true 以允许重试', () => {
      expect(manager.spawn('session-fail', { cwd: '/tmp' })).toBe(true)

      const session = manager.getSession('session-fail')
      expect(session).toBeTruthy()
      session!.needsRestart = true

      // Make hostClient.spawn throw to simulate restart failure
      hostClient.spawn.mockImplementationOnce(() => {
        throw new Error('spawn failed')
      })

      const result = (manager as any).restartSessionShell('session-fail')
      expect(result).toBe(false)

      // needsRestart should remain true for retry
      const failedSession = manager.getSession('session-fail')
      expect(failedSession).toBeTruthy()
      expect(failedSession!.needsRestart).toBe(true)
      expect(failedSession!.isRunning).toBe(false)
    })

    it('重启后 resolveThreadSession 仍能找到 session', () => {
      const sessionId = manager.spawnAgentSession('space-thread-test', {
        cwd: '/tmp',
        threadId: 'thread-persist',
      })
      expect(sessionId).toBeTruthy()
      expect(manager.resolveThreadSession('thread-persist')).toBe(sessionId)

      const session = manager.getSession(sessionId!)
      session!.needsRestart = true

      ;(manager as any).restartSessionShell(sessionId!)

      // Thread mapping should survive restart
      expect(manager.resolveThreadSession('thread-persist')).toBe(sessionId)
      const restartedSession = manager.getSession(sessionId!)
      expect(restartedSession!.isRunning).toBe(true)
    })
  })

  describe('端到端: 超时 → Ctrl+C → needsRestart → 恢复', () => {
    it('完整流程: 命令超时后发送 Ctrl+C，若未停止则 session 自动重启', async () => {
      vi.useFakeTimers()
      try {
        expect(manager.spawn('e2e-session', { cwd: '/tmp' })).toBe(true)
        const hostSession = hostClient.getLastSession()

        const resultPromise = manager.executeCommand('e2e-session', 'yes', {
          blockUntilMs: 1000,
        })

        // Advance past timeout → Ctrl+C sent
        vi.advanceTimersByTime(1001)
        const result = await resultPromise
        expect(result.backgrounded).toBe(false)
        expect(result.timedOut).toBe(true)

        // Verify Ctrl+C was sent
        const ctrlCWrites = hostSession.write.mock.calls.filter(
          (call: any[]) => call[0] === '\x03',
        )
        expect(ctrlCWrites).toHaveLength(1)

        // Simulate the command ignoring Ctrl+C (new output after kill)
        const session = manager.getSession('e2e-session')
        expect(session).toBeTruthy()
        session!.outputBuffer.append('y\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\n')

        // Advance 2 seconds → needsRestart check fires
        vi.advanceTimersByTime(2001)

        // At this point PtyCommandRunner's setTimeout should have set needsRestart
        // and PtyManager's logger.warn should have triggered reactive restart
        // Verify the session was restarted (new PTY process spawned)
        expect(hostClient.getSessionCount()).toBeGreaterThanOrEqual(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
