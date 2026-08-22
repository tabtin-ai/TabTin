import { describe, expect, it, vi } from 'vitest'
import { PtyProcessTerminator } from '../PtyProcessTerminator'

describe('PtyProcessTerminator', () => {
  it('按子进程到根进程的顺序终止进程树，并在超时后升级到强杀', async () => {
    const killProcess = vi.fn()
    const schedule = vi.fn((callback: () => void) => {
      callback()
      return setTimeout(() => {}, 0)
    })
    const collectProcessTable = vi
      .fn()
      .mockResolvedValue(new Map([
        [100, { pid: 100, ppid: 1, cpu: 0, memory: 0, command: 'shell' }],
        [101, { pid: 101, ppid: 100, cpu: 0, memory: 0, command: 'child-a' }],
        [102, { pid: 102, ppid: 100, cpu: 0, memory: 0, command: 'child-b' }],
      ]))

    const terminator = new PtyProcessTerminator({
      collectProcessTable,
      killProcess,
      schedule,
    })

    terminator.terminateTree(100, {
      gracefulSignal: 'SIGTERM',
      forceSignal: 'SIGKILL',
      forceAfterMs: 50,
      // ：默认 guard 会用 process.kill(rootPid, 0) 探测 pid 是否存活，
      // 而本用例的 pid 100/101/102 是假 pid（真实进程表里不存在）→ 默认 guard
      // 抛 ESRCH 返回 false，会中止 SIGKILL 升级。显式注入"pid 仍存活"的 guard，
      // 以验证升级路径本身的顺序/信号行为。
      guard: () => true,
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(killProcess.mock.calls.slice(0, 3)).toEqual([
      [102, 'SIGTERM'],
      [101, 'SIGTERM'],
      [100, 'SIGTERM'],
    ])
    expect(killProcess.mock.calls.slice(3, 6)).toEqual([
      [102, 'SIGKILL'],
      [101, 'SIGKILL'],
      [100, 'SIGKILL'],
    ])
    expect(schedule).toHaveBeenCalledTimes(1)
  })

  it('在无法收集进程树时回退为仅终止 root pid', async () => {
    const killProcess = vi.fn()
    const terminator = new PtyProcessTerminator({
      collectProcessTable: vi.fn().mockRejectedValue(new Error('ps failed')),
      killProcess,
      schedule: vi.fn(() => setTimeout(() => {}, 0)),
    })

    terminator.terminateTree(200, {
      gracefulSignal: 'SIGTERM',
      forceSignal: 'SIGTERM',
      forceAfterMs: 0,
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(killProcess).toHaveBeenCalledWith(200, 'SIGTERM')
  })
})
