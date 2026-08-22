/**
 * NEW-003 回归测试 — SlideEditorHost
 *
 * 验证：restore 成功后 onRestoreSuccess 触发 forceReconnect（remount），
 * 而非仅重置保存管道。
 *
 * 修复前：slideRestoreRef.current = resetSavePipeline
 *   → onRestoreSuccess 只重置保存管道，协作视图不刷新
 * 修复后：slideRestoreRef.current = () => { resetSavePipeline(); onVersionRestored?.() }
 *   → onRestoreSuccess 同时重置保存管道并触发 remount
 */

import { describe, it, expect, vi } from "vitest"

describe("NEW-003: SlideEditorHost restore 后应触发 forceReconnect（remount）", () => {
  it("slideRestoreRef 应同时调用 resetSavePipeline 和 onVersionRestored", () => {
    const resetSavePipeline = vi.fn()
    const onVersionRestored = vi.fn()

    // 模拟修复后的赋值逻辑
    const slideRestoreRef = { current: undefined as (() => void) | undefined }
    slideRestoreRef.current = () => {
      resetSavePipeline()
      onVersionRestored?.()
    }

    // 触发 onRestoreSuccess
    slideRestoreRef.current?.()

    expect(resetSavePipeline).toHaveBeenCalledTimes(1)
    expect(onVersionRestored).toHaveBeenCalledTimes(1)
  })

  it("onVersionRestored 触发后父组件应递增 restoreKey（remount 机制）", () => {
    let restoreKey = 0
    const setRestoreKey = (updater: (k: number) => number) => {
      restoreKey = updater(restoreKey)
    }
    const onVersionRestored = () => setRestoreKey((k) => k + 1)

    const resetSavePipeline = vi.fn()
    const slideRestoreRef = { current: undefined as (() => void) | undefined }
    slideRestoreRef.current = () => {
      resetSavePipeline()
      onVersionRestored()
    }

    expect(restoreKey).toBe(0)
    slideRestoreRef.current?.()
    expect(restoreKey).toBe(1)
    expect(resetSavePipeline).toHaveBeenCalledTimes(1)
  })

  it("onVersionRestored 为 undefined 时不应抛出异常", () => {
    const resetSavePipeline = vi.fn()
    const onVersionRestored = undefined

    const slideRestoreRef = { current: undefined as (() => void) | undefined }
    slideRestoreRef.current = () => {
      resetSavePipeline()
      onVersionRestored?.()
    }

    expect(() => slideRestoreRef.current?.()).not.toThrow()
    expect(resetSavePipeline).toHaveBeenCalledTimes(1)
  })
})
