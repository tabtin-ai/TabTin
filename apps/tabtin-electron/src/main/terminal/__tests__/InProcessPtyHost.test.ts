import { describe, expect, it, vi } from 'vitest'
import { InProcessPtyHostClient } from '../InProcessPtyHost'

describe('InProcessPtyHostClient', () => {
  it('把 spawn 请求透传给 node-pty，并返回 host session 适配器', async () => {
    const spawnMock = vi.fn()
    const ptyProcess = {
      pid: 42,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      onData: vi.fn((handler: (data: string) => void) => {
        handler('hello')
        return { dispose: vi.fn() }
      }),
      onExit: vi.fn((handler: (e: { exitCode: number; signal?: number }) => void) => {
        handler({ exitCode: 3, signal: 15 })
        return { dispose: vi.fn() }
      }),
    }
    spawnMock.mockReturnValueOnce(ptyProcess)

    const mockPtyModule = { spawn: spawnMock } as unknown as typeof import('node-pty')
    const hostClient = new InProcessPtyHostClient(mockPtyModule)
    const session = hostClient.spawn({
      shell: '/bin/zsh',
      cwd: '/tmp',
      cols: 100,
      rows: 40,
      env: { TERM: 'xterm-256color' },
      termName: 'xterm-256color',
    })

    expect(spawnMock).toHaveBeenCalledWith('/bin/zsh', [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 40,
      cwd: '/tmp',
      env: { TERM: 'xterm-256color' },
    })

    expect(session.pid).toBe(42)

    session.write('echo 1\n')
    session.resize(120, 50)
    session.kill('SIGTERM')

    expect(ptyProcess.write).toHaveBeenCalledWith('echo 1\n')
    expect(ptyProcess.resize).toHaveBeenCalledWith(120, 50)
    expect(ptyProcess.kill).toHaveBeenCalledWith('SIGTERM')

    const onSpawned = vi.fn()
    const onData = vi.fn()
    const onExit = vi.fn()
    session.onSpawned(onSpawned)
    session.onData(onData)
    session.onExit(onExit)
    await Promise.resolve()

    expect(onSpawned).toHaveBeenCalledWith({ pid: 42 })
    expect(onData).toHaveBeenCalledWith('hello')
    expect(onExit).toHaveBeenCalledWith({ exitCode: 3, signal: 15 })
  })
})
