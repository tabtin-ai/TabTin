import { describe, it, expect, vi, beforeEach } from 'vitest'

let registerResetAction: typeof import('../sessionResetRegistry').registerResetAction
let runAllResetActions: typeof import('../sessionResetRegistry').runAllResetActions

beforeEach(async () => {
  vi.resetModules()
  const mod = await import('../sessionResetRegistry')
  registerResetAction = mod.registerResetAction
  runAllResetActions = mod.runAllResetActions
})

describe('sessionResetRegistry', () => {
  it('按 teardown → reset → cleanup 顺序执行', async () => {
    const order: string[] = []
    registerResetAction('c', 'cleanup', () => { order.push('cleanup:c') })
    registerResetAction('r', 'reset', () => { order.push('reset:r') })
    registerResetAction('t', 'teardown', () => { order.push('teardown:t') })

    await runAllResetActions()
    expect(order).toEqual(['teardown:t', 'reset:r', 'cleanup:c'])
  })

  it('同 phase 内按注册顺序执行', async () => {
    const order: string[] = []
    registerResetAction('a', 'reset', () => { order.push('a') })
    registerResetAction('b', 'reset', () => { order.push('b') })
    registerResetAction('c', 'reset', () => { order.push('c') })

    await runAllResetActions()
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('同名 action 覆盖（HMR 安全）', async () => {
    const order: string[] = []
    registerResetAction('store-x', 'reset', () => { order.push('old') })
    registerResetAction('store-x', 'reset', () => { order.push('new') })

    await runAllResetActions()
    expect(order).toEqual(['new'])
  })

  it('单个 action 异常不阻塞后续执行', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const order: string[] = []

    registerResetAction('ok-1', 'reset', () => { order.push('ok-1') })
    registerResetAction('fail', 'reset', () => { throw new Error('boom') })
    registerResetAction('ok-2', 'reset', () => { order.push('ok-2') })

    await runAllResetActions()

    expect(order).toEqual(['ok-1', 'ok-2'])
    // createLogger('SessionReset').error → console.error('[SessionReset]', 'reset action failed:', { action, phase, error })
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('SessionReset'),
      expect.stringContaining('reset action failed'),
      expect.objectContaining({ action: 'fail', error: expect.any(Error) }),
    )
    consoleSpy.mockRestore()
  })

  it('空注册表执行不报错', async () => {
    await expect(runAllResetActions()).resolves.toBeUndefined()
  })

  it('支持 async action', async () => {
    const order: string[] = []
    registerResetAction('async-action', 'teardown', async () => {
      await new Promise(r => setTimeout(r, 10))
      order.push('async-done')
    })
    registerResetAction('sync-after', 'reset', () => { order.push('sync') })

    await runAllResetActions()
    expect(order).toEqual(['async-done', 'sync'])
  })

  it('覆盖可以更改 phase', async () => {
    const order: string[] = []
    registerResetAction('mover', 'cleanup', () => { order.push('cleanup') })
    registerResetAction('mover', 'teardown', () => { order.push('teardown') })

    await runAllResetActions()
    expect(order).toEqual(['teardown'])
  })
})
