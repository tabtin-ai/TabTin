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
    if (!session) {
      throw new Error('No host session created')
    }
    return session
  }
}

class MockProcessTerminator {
  terminateTree = vi.fn()
}

describe('PtyManager lifecycle', () => {
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

  it('通过可注入 host client 创建 session，并在自然退出时释放 thread 映射', () => {
    const closed = vi.fn()
    const exited = vi.fn()
    manager.on('agent-session-closed', closed)
    manager.on('exit', exited)

    const sessionId = manager.spawnAgentSession('space-natural', {
      cwd: '/tmp',
      threadId: 'thread-natural',
    })

    expect(sessionId).toBeTruthy()
    expect(hostClient.spawn).toHaveBeenCalledTimes(1)
    expect(hostClient.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: expect.any(String),
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        termName: 'xterm-256color',
      }),
    )
    expect(manager.resolveThreadSession('thread-natural')).toBe(sessionId)

    const hostSession = hostClient.getLastSession()
    hostSession.triggerSpawned(777)
    hostSession.triggerExit(7, 15)

    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith({
      sessionId,
      spaceId: 'space-natural',
      reason: 'exit',
    })
    expect(exited).toHaveBeenCalledWith(sessionId, 7, 15)
    expect(manager.resolveThreadSession('thread-natural')).toBeNull()
    expect(manager.has(sessionId!)).toBe(true)
    expect(manager.getSession(sessionId!)?.isRunning).toBe(false)
    expect(manager.getSession(sessionId!)?.writeChannel.isClosed()).toBe(true)
    expect(manager.getSession(sessionId!)?.pid).toBe(777)
  })

  it('在显式 kill 后只发出一次关闭事件，并移除 session 状态', () => {
    const closed = vi.fn()
    const exited = vi.fn()
    manager.on('agent-session-closed', closed)
    manager.on('exit', exited)

    const sessionId = manager.spawnAgentSession('space-kill', {
      cwd: '/tmp',
      threadId: 'thread-kill',
    })

    expect(sessionId).toBeTruthy()
    const session = manager.getSession(sessionId!)
    const hostSession = hostClient.getLastSession()

    expect(manager.kill(sessionId!)).toBe(true)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith({
      sessionId,
      spaceId: 'space-kill',
      reason: 'kill',
    })
    expect(manager.resolveThreadSession('thread-kill')).toBeNull()
    expect(manager.has(sessionId!)).toBe(false)
    expect(session?.writeChannel.isClosed()).toBe(true)
    expect(hostSession.kill).toHaveBeenCalledTimes(1)
    expect(processTerminator.terminateTree).toHaveBeenCalledWith(
      9527,
      expect.objectContaining({
        gracefulSignal: 'SIGTERM',
        forceSignal: 'SIGKILL',
      }),
    )

    hostSession.triggerExit(0, 9)

    expect(closed).toHaveBeenCalledTimes(1)
    expect(exited).toHaveBeenCalledTimes(1)
    expect(exited).toHaveBeenCalledWith(sessionId, 0, 9)
  })

  it('在 shell 自然退出时，会用部分输出 resolve 正在等待的命令', async () => {
    expect(manager.spawn('session-pending', { cwd: '/tmp' })).toBe(true)

    const resultPromise = manager.executeCommand('session-pending', 'sleep 10', {
      blockUntilMs: 5_000,
    })

    const hostSession = hostClient.getLastSession()
    hostSession.triggerData('partial output\n')
    hostSession.triggerExit(137, 9)

    await expect(resultPromise).resolves.toMatchObject({
      output: 'partial output',
      exitCode: 137,
      backgrounded: false,
      sessionId: 'session-pending',
    })
    expect(manager.hasPendingCommand('session-pending')).toBe(false)
  })

  it('在 manager cleanup 时也会发出一致的 Agent session 关闭语义', () => {
    const closed = vi.fn()
    manager.on('agent-session-closed', closed)

    const sessionId = manager.spawnAgentSession('space-cleanup', {
      cwd: '/tmp',
      threadId: 'thread-cleanup',
    })

    expect(sessionId).toBeTruthy()
    const hostSession = hostClient.getLastSession()

    manager.cleanup()

    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledWith({
      sessionId,
      spaceId: 'space-cleanup',
      reason: 'cleanup',
    })
    expect(manager.has(sessionId!)).toBe(false)
    expect(manager.resolveThreadSession('thread-cleanup')).toBeNull()
    expect(hostSession.kill).toHaveBeenCalledWith('SIGKILL')
    expect(processTerminator.terminateTree).toHaveBeenCalledWith(
      9527,
      expect.objectContaining({
        gracefulSignal: 'SIGKILL',
        forceSignal: 'SIGKILL',
        forceAfterMs: 0,
      }),
    )

    hostSession.triggerExit(0, 9)

    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('会根据 renderer 订阅和命令状态切换输出 pause/resume', async () => {
    expect(manager.spawn('session-flow', { cwd: '/tmp' })).toBe(true)
    const hostSession = hostClient.getLastSession()

    expect(hostSession.pauseOutput).toHaveBeenCalledTimes(1)

    manager.setRendererDataSubscription('session-flow', true)
    expect(hostSession.resumeOutput).toHaveBeenCalledTimes(1)

    manager.setRendererDataSubscription('session-flow', false)
    expect(hostSession.pauseOutput).toHaveBeenCalledTimes(2)

    const resultPromise = manager.executeCommand('session-flow', 'echo ok', {
      blockUntilMs: 5_000,
    })
    expect(hostSession.resumeOutput).toHaveBeenCalledTimes(2)

    const wrappedCommand = hostSession.write.mock.calls.at(-1)?.[0] as string
    const startMarker = wrappedCommand.match(/__TABTIN_CMD_START_[a-f0-9]+__/)?.[0]
    const endMarkerPrefix = wrappedCommand.match(/__TABTIN_CMD_END_[a-f0-9]+_/)?.[0]
    expect(startMarker).toBeTruthy()
    expect(endMarkerPrefix).toBeTruthy()

    hostSession.triggerData(`${startMarker!}\nhello\n${endMarkerPrefix!}0_/tmp__\n`)

    await expect(resultPromise).resolves.toMatchObject({
      output: 'hello',
      exitCode: 0,
      sessionId: 'session-flow',
    })

    expect(hostSession.pauseOutput).toHaveBeenCalledTimes(3)
  })

  it('readOutput demand window 到期后会自动重新 pause 输出', () => {
    vi.useFakeTimers()
    try {
      expect(manager.spawn('session-read-demand', { cwd: '/tmp' })).toBe(true)
      const hostSession = hostClient.getLastSession()

      expect(hostSession.pauseOutput).toHaveBeenCalledTimes(1)

      const output = manager.getSessionOutput('session-read-demand')
      expect(output).not.toBeNull()
      expect(hostSession.resumeOutput).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(30_000)

      expect(hostSession.pauseOutput).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
