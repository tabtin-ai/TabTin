import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { COLLABORATIVE_BLOCK_TYPES } from '../extensions/createCollaborativeDocExtensions.js'
import { markdownToPmJson } from '../converters/markdownToPmJson.js'
import type { AutoSaveControllerOptions } from '../types.js'
import { createAutoSaveController } from '../controller/createAutoSaveController.js'

/* ─── EC-02: COLLABORATIVE_BLOCK_TYPES 包含 tabwhiteboard ─── */

describe('EC-02: COLLABORATIVE_BLOCK_TYPES 包含 tabwhiteboard', () => {
  it('tabwhiteboard 应在协作 block 类型列表中', () => {
    expect(COLLABORATIVE_BLOCK_TYPES).toContain('tabwhiteboard')
  })

  it('tabdataBlock 仍在列表中', () => {
    expect(COLLABORATIVE_BLOCK_TYPES).toContain('tabdataBlock')
  })
})

/* ─── EC-04: markdownToPmJson Link 安全验证 ─── */

describe('EC-04: markdownToPmJson Link href 安全验证', () => {
  it('https 链接正常生成 link mark', () => {
    const result = markdownToPmJson('[hello](https://example.com)')
    const para = result.content as any[]
    const textNode = para[0]?.content?.[0]
    expect(textNode?.marks?.[0]?.type).toBe('link')
    expect(textNode?.marks?.[0]?.attrs?.href).toBe('https://example.com')
  })

  it('http 链接正常生成 link mark', () => {
    const result = markdownToPmJson('[hello](http://example.com)')
    const para = result.content as any[]
    const textNode = para[0]?.content?.[0]
    expect(textNode?.marks?.[0]?.type).toBe('link')
  })

  it('mailto 链接正常生成 link mark', () => {
    const result = markdownToPmJson('[email](mailto:test@example.com)')
    const para = result.content as any[]
    const textNode = para[0]?.content?.[0]
    expect(textNode?.marks?.[0]?.type).toBe('link')
  })

  it('tel 链接正常生成 link mark', () => {
    const result = markdownToPmJson('[call](tel:+1234567890)')
    const para = result.content as any[]
    const textNode = para[0]?.content?.[0]
    expect(textNode?.marks?.[0]?.type).toBe('link')
  })

  it('相对路径链接正常生成 link mark', () => {
    const result = markdownToPmJson('[page](/docs/page)')
    const para = result.content as any[]
    const textNode = para[0]?.content?.[0]
    expect(textNode?.marks?.[0]?.type).toBe('link')
  })

  it('锚点链接正常生成 link mark', () => {
    const result = markdownToPmJson('[section](#heading)')
    const para = result.content as any[]
    const textNode = para[0]?.content?.[0]
    expect(textNode?.marks?.[0]?.type).toBe('link')
  })

  it('javascript: 协议被拒绝，不生成 link mark', () => {
    const result = markdownToPmJson('[click](javascript:alert(1))')
    const para = result.content as any[]
    const textNode = para[0]?.content?.[0]
    expect(textNode?.text).toBe('click')
    expect(textNode?.marks).toBeUndefined()
  })

  it('data: 协议被拒绝，不生成 link mark', () => {
    const result = markdownToPmJson('[evil](data:text/html,<script>alert(1)</script>)')
    const para = result.content as any[]
    const textNode = para[0]?.content?.[0]
    expect(textNode?.text).toBe('evil')
    expect(textNode?.marks).toBeUndefined()
  })

  it('vbscript: 协议被拒绝', () => {
    const result = markdownToPmJson('[x](vbscript:msgbox)')
    const para = result.content as any[]
    const textNode = para[0]?.content?.[0]
    expect(textNode?.marks).toBeUndefined()
  })
})

/* ─── EC-05: flush() 等待当前保存完成后再保存 dirty 内容 ─── */

describe('EC-05: flush() 在 saving 期间等待后重保存', () => {
  it('flush 在保存期间被调用时应等待完成后再次保存', async () => {
    let saveCount = 0
    let resolveFirstSave: () => void = () => {}

    const opts: AutoSaveControllerOptions = {
      getDraft: () => ({ pmJson: { type: 'doc' }, markdown: '# test' }),
      getBaseVersion: () => 1,
      save: vi.fn().mockImplementation(() => {
        saveCount++
        if (saveCount === 1) {
          return new Promise<{ version: number }>((resolve) => {
            resolveFirstSave = () => resolve({ version: saveCount })
          })
        }
        return Promise.resolve({ version: saveCount })
      }),
      debounceMs: 0,
    }

    const ctrl = createAutoSaveController(opts)
    ctrl.markDirty()

    // 等待 saveNow 开始执行（microtask）
    await new Promise(r => setTimeout(r, 10))
    expect(ctrl.isSaving()).toBe(true)

    // 在保存期间再次标记为 dirty 并 flush
    ctrl.markDirty()
    const flushPromise = ctrl.flush()

    // 完成第一次保存
    resolveFirstSave()
    await flushPromise

    // flush 完成后应该不再 dirty
    expect(ctrl.isDirty()).toBe(false)
    expect(saveCount).toBeGreaterThanOrEqual(2)
  })
})

/* ─── EC-06: 网络恢复后重试 ─── */

describe('EC-06: 网络恢复后自动重试', () => {
  let restoreGlobalEventTarget: (() => void) | null = null

  beforeEach(() => {
    const target = new EventTarget()
    const previous = {
      addEventListener: (globalThis as typeof globalThis & { addEventListener?: typeof target.addEventListener }).addEventListener,
      removeEventListener: (globalThis as typeof globalThis & { removeEventListener?: typeof target.removeEventListener }).removeEventListener,
      dispatchEvent: (globalThis as typeof globalThis & { dispatchEvent?: typeof target.dispatchEvent }).dispatchEvent,
    }

    Object.assign(globalThis, {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    })

    restoreGlobalEventTarget = () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value) {
          ;(globalThis as Record<string, unknown>)[key] = value
        } else {
          delete (globalThis as Record<string, unknown>)[key]
        }
      }
    }
  })

  afterEach(() => {
    restoreGlobalEventTarget?.()
    restoreGlobalEventTarget = null
  })

  it('重试耗尽后 online 事件触发重新调度', async () => {
    let saveCallCount = 0

    const opts: AutoSaveControllerOptions = {
      getDraft: () => ({ pmJson: { type: 'doc' }, markdown: '# test' }),
      getBaseVersion: () => 1,
      save: vi.fn().mockImplementation(() => {
        saveCallCount++
        if (saveCallCount <= 4) {
          return Promise.reject(new Error('network error'))
        }
        return Promise.resolve({ version: 1 })
      }),
      onError: vi.fn(),
      debounceMs: 0,
      retryDelayMs: 0,
      maxRetryCount: 3,
    }

    const ctrl = createAutoSaveController(opts)
    ctrl.markDirty()

    // 等待初次保存 + 3 次重试耗尽
    await new Promise(r => setTimeout(r, 200))
    expect(ctrl.isDirty()).toBe(true)
    expect(saveCallCount).toBe(4) // 1 initial + 3 retries

    // 模拟网络恢复
    globalThis.dispatchEvent(new Event('online'))

    // 等待重新调度的保存
    await new Promise(r => setTimeout(r, 200))
    expect(saveCallCount).toBeGreaterThanOrEqual(5)
    expect(ctrl.isDirty()).toBe(false)

    ctrl.cancel()
  })

  it('cancel 后 online 事件不再触发保存', async () => {
    let saveCallCount = 0

    const opts: AutoSaveControllerOptions = {
      getDraft: () => ({ pmJson: { type: 'doc' }, markdown: '# test' }),
      getBaseVersion: () => 1,
      save: vi.fn().mockImplementation(() => {
        saveCallCount++
        return Promise.reject(new Error('network error'))
      }),
      onError: vi.fn(),
      debounceMs: 0,
      retryDelayMs: 0,
      maxRetryCount: 0,
    }

    const ctrl = createAutoSaveController(opts)
    ctrl.markDirty()

    await new Promise(r => setTimeout(r, 100))
    const countAfterExhaust = saveCallCount

    ctrl.cancel()

    // online 事件不应触发新保存
    globalThis.dispatchEvent(new Event('online'))
    await new Promise(r => setTimeout(r, 100))
    expect(saveCallCount).toBe(countAfterExhaust)
  })
})
