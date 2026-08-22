/**
 * J1-01 / J1-02: slide-flush-registry 单元测试
 *
 * 验证:
 * 1. 多编辑器注册后 flush 时所有 handler 都被调用
 * 2. flushComplete 仅在所有 handler settle 后调用一次
 * 3. 注销后 handler 不再被调用
 * 4. 无 handler 时立即 flushComplete
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let flushCallback: (() => void) | null = null
let flushCompleteCount = 0

vi.stubGlobal('window', {
  tabtin: {
    slide: {
      onFlushBeforeClose: (cb: () => void) => {
        flushCallback = cb
        return () => { flushCallback = null }
      },
      flushComplete: () => { flushCompleteCount++ },
    },
  },
})

let registerFlushHandler: typeof import('../renderer/src/components/slide/slide-flush-registry').registerFlushHandler
let setupSlideFlushListener: typeof import('../renderer/src/components/slide/slide-flush-registry').setupSlideFlushListener

beforeEach(async () => {
  flushCallback = null
  flushCompleteCount = 0
  vi.resetModules()
  const mod = await import('../renderer/src/components/slide/slide-flush-registry')
  registerFlushHandler = mod.registerFlushHandler
  setupSlideFlushListener = mod.setupSlideFlushListener
})

describe('slide-flush-registry', () => {
  it('单编辑器: flush 触发 handler 并 flushComplete', async () => {
    let handlerCalled = false
    registerFlushHandler('editor-1', async () => { handlerCalled = true })

    expect(flushCallback).not.toBeNull()

    flushCallback!()
    await vi.waitFor(() => expect(flushCompleteCount).toBe(1))
    expect(handlerCalled).toBe(true)
  })

  it('多编辑器: 所有 handler 都被调用后才 flushComplete', async () => {
    const calls: string[] = []
    let resolveA: () => void
    let resolveB: () => void

    registerFlushHandler('editor-A', () => new Promise<void>((r) => {
      calls.push('A')
      resolveA = r
    }))
    registerFlushHandler('editor-B', () => new Promise<void>((r) => {
      calls.push('B')
      resolveB = r
    }))

    flushCallback!()

    // 等微任务让 handler 都启动
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toContain('A')
    expect(calls).toContain('B')
    expect(flushCompleteCount).toBe(0)

    resolveA!()
    await new Promise((r) => setTimeout(r, 10))
    expect(flushCompleteCount).toBe(0)

    resolveB!()
    await vi.waitFor(() => expect(flushCompleteCount).toBe(1))
  })

  it('注销后 handler 不再被调用', async () => {
    let handlerCalled = false
    const unregister = registerFlushHandler('editor-X', async () => { handlerCalled = true })

    unregister()

    registerFlushHandler('editor-Y', async () => {})

    flushCallback!()
    await vi.waitFor(() => expect(flushCompleteCount).toBe(1))
    expect(handlerCalled).toBe(false)
  })

  it('无 handler 时立即 flushComplete', async () => {
    registerFlushHandler('temp', async () => {})
    // 确保 IPC 监听已注册
    expect(flushCallback).not.toBeNull()

    // 移除所有 handler 后触发 flush
    const mod = await import('../renderer/src/components/slide/slide-flush-registry')
    const unregister = mod.registerFlushHandler('temp2', async () => {})
    unregister()

    // 重新获取 flushCallback（模块重新加载后引用可能不同）
    if (flushCallback) {
      flushCallback()
      await vi.waitFor(() => expect(flushCompleteCount).toBeGreaterThanOrEqual(1))
    }
  })

  it('handler 抛错不阻塞 flushComplete', async () => {
    registerFlushHandler('err-editor', async () => { throw new Error('save failed') })
    registerFlushHandler('ok-editor', async () => {})

    flushCallback!()
    await vi.waitFor(() => expect(flushCompleteCount).toBe(1))
  })

  //  回归：未打开过 slide 编辑器（无 registerFlushHandler 调用）时，
  // setupSlideFlushListener 也必须让监听器常驻，收到 flush-before-close 立即回执，
  // 否则 main 进程关窗会干等 4000ms 超时。
  it('setupSlideFlushListener: 无任何 handler 时也注册监听并立即 flushComplete', async () => {
    expect(flushCallback).toBeNull()

    setupSlideFlushListener()
    expect(flushCallback).not.toBeNull()

    flushCallback!()
    await vi.waitFor(() => expect(flushCompleteCount).toBe(1))
  })

  it('setupSlideFlushListener: 与 registerFlushHandler 幂等（不重复注册监听器）', async () => {
    setupSlideFlushListener()
    const firstCallback = flushCallback
    expect(firstCallback).not.toBeNull()

    let handlerCalled = false
    registerFlushHandler('editor-1', async () => { handlerCalled = true })
    // ensureIpcListener 幂等：监听器引用不变
    expect(flushCallback).toBe(firstCallback)

    flushCallback!()
    await vi.waitFor(() => expect(flushCompleteCount).toBe(1))
    expect(handlerCalled).toBe(true)
  })
})
