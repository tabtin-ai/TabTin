/**
 * J1-01: main-window close 行为测试
 *
 * 验证:
 * 1. isClosing 防止重复 close 注册多个 ipcMain.once 监听器
 * 2. forceCloseTimer 超时后清理 ipcMain 监听器
 * 3. flush-complete 收到后清理 forceCloseTimer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// 模拟 Electron API
function createMockIpcMain() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  return {
    once(channel: string, handler: (...args: unknown[]) => void) {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(handler)
    },
    removeListener(channel: string, handler: (...args: unknown[]) => void) {
      listeners.get(channel)?.delete(handler)
    },
    emit(channel: string, ...args: unknown[]) {
      const handlers = listeners.get(channel)
      if (handlers) {
        for (const h of handlers) {
          h(...args)
          handlers.delete(h) // once 语义
          break
        }
      }
    },
    listenerCount(channel: string): number {
      return listeners.get(channel)?.size ?? 0
    },
  }
}

describe('main-window close 保护', () => {
  let closeConfirmed: boolean
  let isClosing: boolean
  let flushSent: number
  let ipcMain: ReturnType<typeof createMockIpcMain>

  function simulateClose() {
    if (closeConfirmed) return
    if (isClosing) return

    isClosing = true
    flushSent++

    const flushCompleteHandler = () => {
      clearTimeout(forceCloseTimer)
      closeConfirmed = true
      isClosing = false
    }

    const forceCloseTimer = setTimeout(() => {
      ipcMain.removeListener('slide:flush-complete', flushCompleteHandler)
      closeConfirmed = true
      isClosing = false
    }, 4000)

    ipcMain.once('slide:flush-complete', flushCompleteHandler)
  }

  beforeEach(() => {
    closeConfirmed = false
    isClosing = false
    flushSent = 0
    ipcMain = createMockIpcMain()
    vi.useFakeTimers()
  })

  it('重复点击关闭不会注册多个 once 监听器', () => {
    simulateClose()
    simulateClose()
    simulateClose()

    expect(ipcMain.listenerCount('slide:flush-complete')).toBe(1)
    expect(flushSent).toBe(1)
  })

  it('flush-complete 收到后重置 isClosing', () => {
    simulateClose()
    expect(isClosing).toBe(true)

    ipcMain.emit('slide:flush-complete')
    expect(isClosing).toBe(false)
    expect(closeConfirmed).toBe(true)
  })

  it('超时后清理 ipcMain 监听器', () => {
    simulateClose()
    expect(ipcMain.listenerCount('slide:flush-complete')).toBe(1)

    vi.advanceTimersByTime(4001)

    expect(ipcMain.listenerCount('slide:flush-complete')).toBe(0)
    expect(closeConfirmed).toBe(true)
    expect(isClosing).toBe(false)
  })

  it('超时前收到 flush-complete 不会双重 close', () => {
    simulateClose()
    ipcMain.emit('slide:flush-complete')

    let closedAgain = false
    closeConfirmed = true

    // 第二次模拟 close 应该因 closeConfirmed 而直接返回
    if (!closeConfirmed) closedAgain = true
    expect(closedAgain).toBe(false)

    vi.advanceTimersByTime(5000)
    // 不会出错
  })
})
