/**
 * 回归测试：P1-STB-1, P1-STB-3, P1-FUN-4 修复验证
 *
 * P1-STB-1: kill 路径事件顺序 — 先 finalize 再 kill 进程，避免 onExit 冗余处理
 * P1-STB-3: listener 泄漏 — 保存 disposable 并在 session 销毁时释放
 * P1-FUN-4 / TT-04: auto-respond-triggered 事件 — 通过直接回调机制 re-emit（取代日志字符串解析）
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

  readonly spawnedDispose = vi.fn()
  readonly dataDispose = vi.fn()
  readonly exitDispose = vi.fn()

  write = vi.fn()
  pauseOutput = vi.fn()
  resumeOutput = vi.fn()
  resize = vi.fn()
  kill = vi.fn()

  onSpawned = vi.fn((handler: (event: { pid: number }) => void) => {
    this.spawnedHandler = handler
    return { dispose: this.spawnedDispose }
  })

  onData = vi.fn((handler: (data: string) => void) => {
    this.dataHandler = handler
    return { dispose: this.dataDispose }
  })

  onExit = vi.fn((handler: (event: { exitCode: number | null; signal?: number }) => void) => {
    this.exitHandler = handler
    return { dispose: this.exitDispose }
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

describe('P1-STB-1: kill 路径事件顺序', () => {
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

  it('kill 后 onExit 触发时不会产生冗余的 agent-session-closed 事件', () => {
    const closed = vi.fn()
    manager.on('agent-session-closed', closed)

    const sessionId = manager.spawnAgentSession('space-stb1', {
      cwd: '/tmp',
      threadId: 'thread-stb1',
    })
    expect(sessionId).toBeTruthy()

    const hostSession = hostClient.getLastSession()

    // kill session
    expect(manager.kill(sessionId!)).toBe(true)
    expect(closed).toHaveBeenCalledTimes(1)

    // 模拟进程异步退出 — onExit 回调触发
    hostSession.triggerExit(0, 9)

    // 关键断言：closed 仍然只有 1 次，没有冗余事件
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('kill 后 onExit 触发时仍然 emit exit 事件（带正确的 exitCode）', () => {
    const exited = vi.fn()
    manager.on('exit', exited)

    expect(manager.spawn('session-stb1-exit', { cwd: '/tmp' })).toBe(true)
    const hostSession = hostClient.getLastSession()

    manager.kill('session-stb1-exit')

    // onExit 触发
    hostSession.triggerExit(137, 9)

    // exit 事件应该正常触发（报告实际 exitCode）
    expect(exited).toHaveBeenCalledTimes(1)
    expect(exited).toHaveBeenCalledWith('session-stb1-exit', 137, 9)
  })

  it('kill 路径中 session 在进程 kill 之前仍然存在于 store 中', () => {
    expect(manager.spawn('session-stb1-order', { cwd: '/tmp' })).toBe(true)
    const hostSession = hostClient.getLastSession()

    // 在 pty.kill() 被调用时检查 session 是否仍在 store 中
    // 我们通过检查 kill mock 被调用的时机来间接验证
    let sessionExistedDuringKill = false
    hostSession.kill.mockImplementation(() => {
      // 在 pty.kill() 执行时，session 应该还存在
      sessionExistedDuringKill = manager.has('session-stb1-order')
    })

    manager.kill('session-stb1-order')

    // 验证：pty.kill() 执行时 session 仍在 store 中
    // （修复前是先删除再 kill，修复后是先 finalize 再 kill 再删除）
    // 注意：finalize 设置 terminationFinalized=true 但不删除 session
    expect(sessionExistedDuringKill).toBe(true)

    // kill 完成后 session 应该被删除
    expect(manager.has('session-stb1-order')).toBe(false)
  })
})

describe('P1-STB-3: listener 泄漏修复', () => {
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

  it('kill 时会 dispose 所有 pty listener', () => {
    expect(manager.spawn('session-leak-kill', { cwd: '/tmp' })).toBe(true)
    const hostSession = hostClient.getLastSession()

    expect(hostSession.spawnedDispose).not.toHaveBeenCalled()
    expect(hostSession.dataDispose).not.toHaveBeenCalled()
    expect(hostSession.exitDispose).not.toHaveBeenCalled()

    manager.kill('session-leak-kill')

    expect(hostSession.spawnedDispose).toHaveBeenCalledTimes(1)
    expect(hostSession.dataDispose).toHaveBeenCalledTimes(1)
    expect(hostSession.exitDispose).toHaveBeenCalledTimes(1)
  })

  it('自然退出时会 dispose 所有 pty listener', () => {
    expect(manager.spawn('session-leak-exit', { cwd: '/tmp' })).toBe(true)
    const hostSession = hostClient.getLastSession()

    expect(hostSession.spawnedDispose).not.toHaveBeenCalled()
    expect(hostSession.dataDispose).not.toHaveBeenCalled()
    expect(hostSession.exitDispose).not.toHaveBeenCalled()

    hostSession.triggerExit(0)

    expect(hostSession.spawnedDispose).toHaveBeenCalledTimes(1)
    expect(hostSession.dataDispose).toHaveBeenCalledTimes(1)
    expect(hostSession.exitDispose).toHaveBeenCalledTimes(1)
  })

  it('cleanup 时会 dispose 所有 session 的 pty listener', () => {
    expect(manager.spawn('session-leak-cleanup-1', { cwd: '/tmp' })).toBe(true)
    const hostSession1 = hostClient.getLastSession()

    expect(manager.spawn('session-leak-cleanup-2', { cwd: '/tmp' })).toBe(true)
    const hostSession2 = hostClient.getLastSession()

    manager.cleanup()

    expect(hostSession1.spawnedDispose).toHaveBeenCalledTimes(1)
    expect(hostSession1.dataDispose).toHaveBeenCalledTimes(1)
    expect(hostSession1.exitDispose).toHaveBeenCalledTimes(1)

    expect(hostSession2.spawnedDispose).toHaveBeenCalledTimes(1)
    expect(hostSession2.dataDispose).toHaveBeenCalledTimes(1)
    expect(hostSession2.exitDispose).toHaveBeenCalledTimes(1)
  })

  it('重复 dispose 是安全的（kill 后 onExit 触发时不会 double-dispose）', () => {
    expect(manager.spawn('session-leak-double', { cwd: '/tmp' })).toBe(true)
    const hostSession = hostClient.getLastSession()

    manager.kill('session-leak-double')

    // kill 已经 dispose 了一次
    expect(hostSession.dataDispose).toHaveBeenCalledTimes(1)

    // onExit 触发 handleSessionExit，其中 disposeSessionListeners 是 no-op
    hostSession.triggerExit(0)

    // 仍然只有 1 次 dispose（不是 2 次）
    expect(hostSession.dataDispose).toHaveBeenCalledTimes(1)
  })
})

describe('P1-FUN-4: auto-respond-triggered 事件', () => {
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

  it('当 PtyCommandRunner 触发 auto-respond 时，PtyManager emit auto-respond-triggered 事件', async () => {
    vi.useFakeTimers()
    try {
      const autoRespondTriggered = vi.fn()
      manager.on('auto-respond-triggered', autoRespondTriggered)

      const sessionId = manager.spawnAgentSession('space-ar', { cwd: '/tmp' })
      expect(sessionId).toBeTruthy()
      const hostSession = hostClient.getLastSession()

      // 执行带有 autoRespond 规则的命令（pattern 为字符串字面量匹配，不支持正则）
      const resultPromise = manager.executeCommand(sessionId!, 'some-command', {
        blockUntilMs: 10_000,
        autoRespond: [{ pattern: 'Continue?', response: 'yes\n' }],
      })

      // 模拟 pty 输出包含匹配 pattern 的文本
      hostSession.triggerData('Continue? [y/n] ')

      // auto-respond 有延迟（100ms）
      vi.advanceTimersByTime(150)

      expect(autoRespondTriggered).toHaveBeenCalledTimes(1)
      expect(autoRespondTriggered).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          spaceId: 'space-ar',
          pattern: expect.stringContaining('Continue'),
          timestamp: expect.any(Number),
        }),
      )

      // 清理：触发 exit 让 pending command resolve
      hostSession.triggerExit(0)
      await resultPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('不匹配 pattern 的数据不会触发事件', () => {
    const autoRespondTriggered = vi.fn()
    manager.on('auto-respond-triggered', autoRespondTriggered)

    expect(manager.spawn('session-ar-neg', { cwd: '/tmp' })).toBe(true)
    const hostSession = hostClient.getLastSession()

    // 触发普通数据，不匹配 auto-respond pattern
    hostSession.triggerData('normal output\n')

    expect(autoRespondTriggered).not.toHaveBeenCalled()
  })

  it('handleAutoRespondCallback 直接触发 auto-respond-triggered 事件', () => {
    const autoRespondTriggered = vi.fn()
    manager.on('auto-respond-triggered', autoRespondTriggered)

    manager.spawn('session-ar-direct', { cwd: '/tmp' })

    // TT-04: 直接回调机制——模拟 PtyCommandRunner 的 onAutoRespondTriggered 调用
    ;(manager as any).handleAutoRespondCallback('session-ar-direct', 'Continue?')

    expect(autoRespondTriggered).toHaveBeenCalledTimes(1)
    expect(autoRespondTriggered).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-ar-direct',
        pattern: 'Continue?',
        timestamp: expect.any(Number),
      }),
    )
  })
})
