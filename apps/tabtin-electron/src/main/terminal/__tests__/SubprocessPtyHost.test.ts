import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InProcessPtyHostClient } from '../InProcessPtyHost'
import {
  SubprocessPtyHostClient,
  createDefaultPtyHostClient,
  createPtyHostChildFromElectron,
  createUtilityPtyHostChild,
} from '../SubprocessPtyHost'

const { forkMock } = vi.hoisted(() => ({
  forkMock: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    default: {
      ...actual,
      fork: forkMock,
    },
    fork: forkMock,
  }
})

class MockChildProcess extends EventEmitter {
  pid = 321
  send = vi.fn()
  kill = vi.fn()
  stderr = new EventEmitter()
}

class MockUtilityProcess extends EventEmitter {
  pid = 654
  postMessage = vi.fn()
  kill = vi.fn(() => true)
  stderr = new EventEmitter()
  stdout = new EventEmitter()
}

describe('SubprocessPtyHostClient', () => {
  const originalHostMode = process.env.TABTIN_PTY_HOST_MODE

  beforeEach(() => {
    forkMock.mockReset()
  })

  afterEach(() => {
    if (originalHostMode == null) {
      delete process.env.TABTIN_PTY_HOST_MODE
    } else {
      process.env.TABTIN_PTY_HOST_MODE = originalHostMode
    }
  })

  it('在 ready/spawned 握手后转发排队命令，并分发 data/exit 事件', () => {
    const child = new MockChildProcess()
    forkMock.mockReturnValueOnce(child)

    const hostClient = new SubprocessPtyHostClient({
      scriptPath: '/tmp/pty-host-process.mjs',
    })
    const request = {
      shell: '/bin/zsh',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { TERM: 'xterm-256color' },
      termName: 'xterm-256color',
    }
    const session = hostClient.spawn(request)

    const onSpawned = vi.fn()
    const onData = vi.fn()
    const onExit = vi.fn()
    session.onSpawned(onSpawned)
    session.onData(onData)
    session.onExit(onExit)

    session.write('echo 1\n')
    expect(child.send).not.toHaveBeenCalled()

    child.emit('message', { kind: 'ready' })

    expect(child.send).toHaveBeenNthCalledWith(1, {
      kind: 'spawn',
      request,
    })

    child.emit('message', { kind: 'spawned', pid: 999 })

    expect(session.pid).toBe(999)
    expect(onSpawned).toHaveBeenCalledWith({ pid: 999 })
    expect(child.send).toHaveBeenNthCalledWith(2, {
      kind: 'write',
      data: 'echo 1\n',
    })

    session.resize(120, 40)
    expect(child.send).toHaveBeenNthCalledWith(3, {
      kind: 'resize',
      cols: 120,
      rows: 40,
    })

    session.pauseOutput()
    expect(child.send).toHaveBeenNthCalledWith(4, {
      kind: 'pause-output',
    })

    session.resumeOutput()
    expect(child.send).toHaveBeenNthCalledWith(5, {
      kind: 'resume-output',
    })

    session.kill('SIGKILL')
    expect(child.send).toHaveBeenNthCalledWith(6, {
      kind: 'kill',
      signal: 'SIGKILL',
    })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')

    child.emit('message', { kind: 'data', data: 'hello\n' })
    child.emit('message', { kind: 'exit', exitCode: 0, signal: 15 })

    expect(onData).toHaveBeenCalledWith('hello\n')
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0, signal: 15 })
  })

  it('P1-FUN-1: fork 失败（child error）触发 exit 通知并清理队列', () => {
    const child = new MockChildProcess()
    forkMock.mockReturnValueOnce(child)

    const hostClient = new SubprocessPtyHostClient({
      scriptPath: '/tmp/pty-host-process.mjs',
    })
    const session = hostClient.spawn({
      shell: '/bin/zsh',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: {},
      termName: 'xterm-256color',
    })

    const onExit = vi.fn()
    session.onExit(onExit)

    // 在 ready 之前写入命令，使其排入队列
    session.write('queued command\n')

    // 模拟 fork 失败
    child.emit('error', new Error('spawn ENOENT'))

    expect(onExit).toHaveBeenCalledWith({ exitCode: null, signal: undefined })

    // 确认 session 进入 closed 状态，后续写入被丢弃
    session.write('after-error\n')
    expect(child.send).not.toHaveBeenCalled()
  })

  it('P1-FUN-1: error + exit 只触发一次 exit 通知', () => {
    const child = new MockChildProcess()
    forkMock.mockReturnValueOnce(child)

    const hostClient = new SubprocessPtyHostClient({
      scriptPath: '/tmp/pty-host-process.mjs',
    })
    const session = hostClient.spawn({
      shell: '/bin/zsh',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: {},
      termName: 'xterm-256color',
    })

    const onExit = vi.fn()
    session.onExit(onExit)

    child.emit('error', new Error('spawn ENOENT'))
    child.emit('exit', 1, null)

    // emitExitOnce 保证只触发一次
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('P1-FUN-2: ready 超时后 kill 子进程并触发 exit', () => {
    vi.useFakeTimers()
    try {
      const child = new MockChildProcess()
      forkMock.mockReturnValueOnce(child)

      const hostClient = new SubprocessPtyHostClient({
        scriptPath: '/tmp/pty-host-process.mjs',
      })
      const session = hostClient.spawn({
        shell: '/bin/zsh',
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        env: {},
        termName: 'xterm-256color',
      })

      const onExit = vi.fn()
      session.onExit(onExit)

      // 不发送 ready 消息，推进时间到超时
      vi.advanceTimersByTime(10_000)

      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(onExit).toHaveBeenCalledWith({ exitCode: null, signal: undefined })
    } finally {
      vi.useRealTimers()
    }
  })

  it('P1-FUN-2: ready 在超时前到达则不触发超时逻辑', () => {
    vi.useFakeTimers()
    try {
      const child = new MockChildProcess()
      forkMock.mockReturnValueOnce(child)

      const hostClient = new SubprocessPtyHostClient({
        scriptPath: '/tmp/pty-host-process.mjs',
      })
      const session = hostClient.spawn({
        shell: '/bin/zsh',
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        env: {},
        termName: 'xterm-256color',
      })

      const onExit = vi.fn()
      session.onExit(onExit)

      // 5 秒后发送 ready
      vi.advanceTimersByTime(5_000)
      child.emit('message', { kind: 'ready' })

      // 推进到超时时间之后
      vi.advanceTimersByTime(10_000)

      // 不应触发 exit
      expect(onExit).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('通过 utilityProcess.fork 适配器运行 pty host（不依赖 RunAsNode fuse）', () => {
    const utilityChild = new MockUtilityProcess()
    const utilityFork = vi.fn(() => utilityChild)

    const child = createUtilityPtyHostChild('/tmp/pty-host-process.mjs', {
      fork: utilityFork,
    } as unknown as Pick<typeof Electron.UtilityProcess, 'fork'>)

    const onMessage = vi.fn()
    const onExit = vi.fn()
    const onError = vi.fn()
    child.on('message', onMessage)
    child.on('exit', onExit)
    child.on('error', onError)

    expect(utilityFork).toHaveBeenCalledWith('/tmp/pty-host-process.mjs', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      serviceName: 'TabTin PTY Host',
      env: process.env,
    })
    expect(child.pid).toBe(654)
    expect(child.stderr).toBe(utilityChild.stderr)

    child.send({ kind: 'write', data: 'echo ok\n' })
    expect(utilityChild.postMessage).toHaveBeenCalledWith({ kind: 'write', data: 'echo ok\n' })

    utilityChild.emit('message', { kind: 'ready' })
    expect(onMessage).toHaveBeenCalledWith({ kind: 'ready' })

    utilityChild.emit('exit', 0)
    expect(onExit).toHaveBeenCalledWith(0, null)

    utilityChild.emit('error', 'FatalError', 'node', 'report')
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(child.kill('SIGKILL')).toBe(true)
  })

  it('Electron 环境优先选择 utilityProcess，缺失时交给 Node fallback', () => {
    const utilityChild = new MockUtilityProcess()
    const utilityFork = vi.fn(() => utilityChild)

    const child = createPtyHostChildFromElectron('/tmp/pty-host-process.mjs', {
      utilityProcess: {
        fork: utilityFork,
      } as unknown as typeof Electron.UtilityProcess,
    })

    expect(child?.pid).toBe(654)
    expect(utilityFork).toHaveBeenCalledWith('/tmp/pty-host-process.mjs', [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      serviceName: 'TabTin PTY Host',
      env: process.env,
    })
    expect(createPtyHostChildFromElectron('/tmp/pty-host-process.mjs', {})).toBeNull()
  })

  it('默认 host 模式为 subprocess（：避免主进程 forkpty 崩溃）', () => {
    delete process.env.TABTIN_PTY_HOST_MODE

    const hostClient = createDefaultPtyHostClient()

    expect(hostClient).toBeInstanceOf(SubprocessPtyHostClient)
  })

  it('TABTIN_PTY_HOST_MODE=in-process 时回退到 in-process host（排障用）', () => {
    process.env.TABTIN_PTY_HOST_MODE = 'in-process'

    const hostClient = createDefaultPtyHostClient()

    expect(hostClient).toBeInstanceOf(InProcessPtyHostClient)
  })

  it('TABTIN_PTY_HOST_MODE=subprocess 显式指定仍为 subprocess host', () => {
    process.env.TABTIN_PTY_HOST_MODE = 'subprocess'

    const hostClient = createDefaultPtyHostClient()

    expect(hostClient).toBeInstanceOf(SubprocessPtyHostClient)
  })
})
