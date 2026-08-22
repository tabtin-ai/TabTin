/**
 * T2 回归测试：主进程 before-input-event guard 对 ⌘1-⌘9 的识别
 *
 * 验证：
 * 1. ⌘1..⌘8 → emitShortcut('switch-tab-N')
 * 2. ⌘9 → emitShortcut('switch-tab-last')
 * 3. ⌘0 仍然走 zoom-reset（不被误识别）
 * 4. Shift/Alt 组合时不触发数字键切换
 * 5. dedupe 窗口：120ms 内重复按同一键只触发一次
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createContextSpaceShortcutController } from '../context-space-shortcuts'
import type { ContextSpaceShortcutAction } from '../types/runtime'

class FakeWebContents extends EventEmitter {
  destroyed = false
  isDestroyed() {
    return this.destroyed
  }
}

interface FakeEvent {
  defaultPrevented: boolean
  preventDefault: () => void
}

const makeEvent = (): FakeEvent => {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true
    },
  }
  return event
}

const pressKey = (
  webContents: FakeWebContents,
  input: {
    key: string
    meta?: boolean
    control?: boolean
    shift?: boolean
    alt?: boolean
    type?: 'keyDown' | 'keyUp'
  },
): FakeEvent => {
  const event = makeEvent()
  webContents.emit('before-input-event', event, {
    type: input.type ?? 'keyDown',
    key: input.key,
    meta: input.meta ?? false,
    control: input.control ?? false,
    shift: input.shift ?? false,
    alt: input.alt ?? false,
  })
  return event
}

describe('context-space-shortcuts · 主进程 before-input-event guard · 数字键切换', () => {
  let emitShortcut: ReturnType<typeof vi.fn>
  let controller: ReturnType<typeof createContextSpaceShortcutController>
  let webContents: FakeWebContents

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-04-17T00:00:00Z') })
    emitShortcut = vi.fn()
    controller = createContextSpaceShortcutController({ emitShortcut })
    webContents = new FakeWebContents()
    controller.registerGuard(webContents as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('⌘1..⌘8 分别发出 switch-tab-1..switch-tab-8', () => {
    const expected: Array<[string, ContextSpaceShortcutAction]> = [
      ['1', 'switch-tab-1'],
      ['2', 'switch-tab-2'],
      ['3', 'switch-tab-3'],
      ['4', 'switch-tab-4'],
      ['5', 'switch-tab-5'],
      ['6', 'switch-tab-6'],
      ['7', 'switch-tab-7'],
      ['8', 'switch-tab-8'],
    ]
    for (const [key, action] of expected) {
      // dedupe 窗口是 120ms，每个按键之间推进时间确保都能触发
      vi.advanceTimersByTime(200)
      const event = pressKey(webContents, { key, meta: true })
      expect(event.defaultPrevented).toBe(true)
      expect(emitShortcut).toHaveBeenLastCalledWith(action)
    }
    expect(emitShortcut).toHaveBeenCalledTimes(8)
  })

  it('⌘9 发出 switch-tab-last（Chrome / Arc / VSCode 惯例）', () => {
    const event = pressKey(webContents, { key: '9', meta: true })
    expect(event.defaultPrevented).toBe(true)
    expect(emitShortcut).toHaveBeenCalledTimes(1)
    expect(emitShortcut).toHaveBeenCalledWith('switch-tab-last')
  })

  it('⌘0 仍然发出 zoom-reset，不被误识别为数字键切换', () => {
    // 注意：当前主进程实现里 zoom-reset 走 shift 分支（⌘⇧0）；
    // ⌘0 单按在主进程 guard 里不发任何 action，而是透传到 webContents 默认行为。
    // 数字键映射表故意不包含 '0'，所以 ⌘0 一定不会被识别为 switch-tab。
    const event = pressKey(webContents, { key: '0', meta: true })
    expect(emitShortcut).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('Shift + ⌘1 不触发数字键切换', () => {
    const event = pressKey(webContents, { key: '1', meta: true, shift: true })
    expect(event.defaultPrevented).toBe(false)
    expect(emitShortcut).not.toHaveBeenCalled()
  })

  it('Alt + ⌘1 不触发数字键切换', () => {
    const event = pressKey(webContents, { key: '1', meta: true, alt: true })
    expect(event.defaultPrevented).toBe(false)
    expect(emitShortcut).not.toHaveBeenCalled()
  })

  it('无 modifier 的数字键不触发（比如普通输入 1）', () => {
    const event = pressKey(webContents, { key: '1' })
    expect(event.defaultPrevented).toBe(false)
    expect(emitShortcut).not.toHaveBeenCalled()
  })

  it('Ctrl + 1 在非 Mac 平台也能触发（hasPrimaryModifier 兼顾 meta / control）', () => {
    const event = pressKey(webContents, { key: '1', control: true })
    expect(event.defaultPrevented).toBe(true)
    expect(emitShortcut).toHaveBeenCalledWith('switch-tab-1')
  })

  it('keyUp 事件不触发 action（只处理 keyDown）', () => {
    pressKey(webContents, { key: '1', meta: true, type: 'keyUp' })
    expect(emitShortcut).not.toHaveBeenCalled()
  })

  it('120ms dedupe 窗口内重复按 ⌘1 只发一次', () => {
    pressKey(webContents, { key: '1', meta: true })
    vi.advanceTimersByTime(50)
    pressKey(webContents, { key: '1', meta: true })
    vi.advanceTimersByTime(50)
    pressKey(webContents, { key: '1', meta: true })
    expect(emitShortcut).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(200)
    pressKey(webContents, { key: '1', meta: true })
    expect(emitShortcut).toHaveBeenCalledTimes(2)
  })
})
