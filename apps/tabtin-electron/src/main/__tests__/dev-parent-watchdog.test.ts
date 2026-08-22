/**
 * dev-parent-watchdog 单元测试
 *
 * 验证：
 * - ppid undefined 时跳过（dispose noop，不安装计时器，不退出）
 * - ppid <= 1 时立即退出，避免 dev Electron 孤儿进程留在 Dock
 * - 父进程一直存活时不退出
 * - 父进程消失时调 exitProcess 且停止计时
 * - dispose 后停止计时（不再调 isAlive 探活）
 *
 * 注：故意通过依赖注入避开真实 process.kill / app.exit，让测试纯 in-process 跑。
 */
import { describe, it, expect, vi } from 'vitest'

import { startDevParentWatchdog } from '../dev-parent-watchdog'

const makeLog = () => ({
  info: vi.fn(),
  warn: vi.fn(),
})

/**
 * 用 fake setInterval 收集回调，手动 tick——比 vi.useFakeTimers 更轻、
 * 也避免污染同文件其它测试的真实计时器。
 */
function makeFakeTimer() {
  let callback: (() => void) | null = null
  let active = true
  const setIntervalFn = ((handler: () => void, _ms: number) => {
    callback = handler
    active = true
    return { unref: () => {} } as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  const clearIntervalFn = (() => {
    active = false
    callback = null
  }) as typeof clearInterval
  return {
    setIntervalFn,
    clearIntervalFn,
    tick: () => {
      if (active && callback) callback()
    },
    isActive: () => active,
  }
}

describe('startDevParentWatchdog', () => {
  it('ppid 为 undefined 时跳过，dispose 是 no-op', () => {
    const log = makeLog()
    const exitProcess = vi.fn()
    const dispose = startDevParentWatchdog({
      log,
      getParentPid: () => undefined,
      isProcessAlive: () => true,
      exitProcess,
    })

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('跳过'))
    expect(exitProcess).not.toHaveBeenCalled()
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('ppid=1（已被 init/launchd 接管）时立即退出', () => {
    const log = makeLog()
    const exitProcess = vi.fn()
    startDevParentWatchdog({
      log,
      getParentPid: () => 1,
      isProcessAlive: () => true,
      exitProcess,
    })

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('init/launchd'))
    expect(exitProcess).toHaveBeenCalledTimes(1)
  })

  it('父进程一直存活时不退出（多次 tick）', () => {
    const log = makeLog()
    const exitProcess = vi.fn()
    const timer = makeFakeTimer()
    const isAlive = vi.fn(() => true)

    startDevParentWatchdog({
      log,
      getParentPid: () => 12345,
      isProcessAlive: isAlive,
      exitProcess,
      setInterval: timer.setIntervalFn,
      clearInterval: timer.clearIntervalFn,
    })

    timer.tick()
    timer.tick()
    timer.tick()

    expect(isAlive).toHaveBeenCalledTimes(3)
    expect(exitProcess).not.toHaveBeenCalled()
    expect(timer.isActive()).toBe(true)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('已启动'))
  })

  it('父进程消失时调 exitProcess 且停止计时器', () => {
    const log = makeLog()
    const exitProcess = vi.fn()
    const timer = makeFakeTimer()
    let alive = true
    const isAlive = vi.fn(() => alive)

    startDevParentWatchdog({
      log,
      getParentPid: () => 12345,
      isProcessAlive: isAlive,
      exitProcess,
      setInterval: timer.setIntervalFn,
      clearInterval: timer.clearIntervalFn,
    })

    timer.tick()
    expect(exitProcess).not.toHaveBeenCalled()

    alive = false
    timer.tick()

    expect(exitProcess).toHaveBeenCalledTimes(1)
    expect(timer.isActive()).toBe(false)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('父进程已消失'))
  })

  it('dispose 后停止计时器，不再探活', () => {
    const log = makeLog()
    const exitProcess = vi.fn()
    const timer = makeFakeTimer()
    const isAlive = vi.fn(() => true)

    const dispose = startDevParentWatchdog({
      log,
      getParentPid: () => 12345,
      isProcessAlive: isAlive,
      exitProcess,
      setInterval: timer.setIntervalFn,
      clearInterval: timer.clearIntervalFn,
    })

    timer.tick()
    expect(isAlive).toHaveBeenCalledTimes(1)

    dispose()
    expect(timer.isActive()).toBe(false)

    timer.tick()
    expect(isAlive).toHaveBeenCalledTimes(1)
    expect(exitProcess).not.toHaveBeenCalled()
  })

  it('使用默认 ppid 时不会越界，但若进程不存在仍能正常触发退出（行为冒烟）', () => {
    const log = makeLog()
    const exitProcess = vi.fn()
    const timer = makeFakeTimer()
    startDevParentWatchdog({
      log,
      getParentPid: () => 99999999,
      isProcessAlive: () => false,
      exitProcess,
      setInterval: timer.setIntervalFn,
      clearInterval: timer.clearIntervalFn,
    })

    timer.tick()
    expect(exitProcess).toHaveBeenCalledTimes(1)
  })
})
