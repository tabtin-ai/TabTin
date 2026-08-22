/**
 * useCapsLockWarning hook 测试
 *
 * 覆盖：初始态、按键/鼠标同步、跨框 focus 复用、blur/reset 清状态。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { KeyboardEvent } from 'react'
import {
  useCapsLockWarning,
  __resetCapsLockWarningCacheForTests,
} from '@tabtin/shared/use-caps-lock-warning'

function fakeModifierEvent(capsLockOn: boolean): KeyboardEvent<HTMLInputElement> {
  return {
    getModifierState: (key: string) => (key === 'CapsLock' ? capsLockOn : false),
  } as unknown as KeyboardEvent<HTMLInputElement>
}

describe('useCapsLockWarning', () => {
  beforeEach(() => {
    __resetCapsLockWarningCacheForTests()
  })

  it('初始状态应为 false', () => {
    const { result } = renderHook(() => useCapsLockWarning())
    expect(result.current.capsLockOn).toBe(false)
  })

  it('按键事件检测到 Caps Lock 开启后应更新状态', () => {
    const { result } = renderHook(() => useCapsLockWarning())

    act(() => {
      result.current.handleKeyEvent(fakeModifierEvent(true))
    })

    expect(result.current.capsLockOn).toBe(true)
  })

  it('Caps Lock 关闭后再次按键应回落为 false', () => {
    const { result } = renderHook(() => useCapsLockWarning())

    act(() => {
      result.current.handleKeyEvent(fakeModifierEvent(true))
    })
    expect(result.current.capsLockOn).toBe(true)

    act(() => {
      result.current.handleKeyEvent(fakeModifierEvent(false))
    })
    expect(result.current.capsLockOn).toBe(false)
  })

  it('resetCapsLockWarning 应手动清空状态', () => {
    const { result } = renderHook(() => useCapsLockWarning())

    act(() => {
      result.current.handleKeyEvent(fakeModifierEvent(true))
    })
    expect(result.current.capsLockOn).toBe(true)

    act(() => {
      result.current.resetCapsLockWarning()
    })
    expect(result.current.capsLockOn).toBe(false)
  })

  it('不支持 getModifierState 的合成事件应静默忽略而不抛错', () => {
    const { result } = renderHook(() => useCapsLockWarning())
    const eventWithoutModifierState = {} as KeyboardEvent<HTMLInputElement>

    expect(() => {
      act(() => {
        result.current.handleKeyEvent(eventWithoutModifierState)
      })
    }).not.toThrow()
    expect(result.current.capsLockOn).toBe(false)
  })

  it('另一框按键观测到 Caps Lock 后，本框 focus 应立刻带上提示', () => {
    const fieldA = renderHook(() => useCapsLockWarning())
    const fieldB = renderHook(() => useCapsLockWarning())

    act(() => {
      fieldA.result.current.handleKeyEvent(fakeModifierEvent(true))
    })
    expect(fieldA.result.current.capsLockOn).toBe(true)
    expect(fieldB.result.current.capsLockOn).toBe(false)

    act(() => {
      fieldA.result.current.handleBlur()
      fieldB.result.current.handleFocus()
    })

    expect(fieldA.result.current.capsLockOn).toBe(false)
    expect(fieldB.result.current.capsLockOn).toBe(true)
  })

  it('尚未有任何观测时 focus 不应凭空打开提示', () => {
    const { result } = renderHook(() => useCapsLockWarning())

    act(() => {
      result.current.handleFocus()
    })

    expect(result.current.capsLockOn).toBe(false)
  })

  it('resetCapsLockWarning 后 focus 不应再沿用已清掉的观测', () => {
    const fieldA = renderHook(() => useCapsLockWarning())
    const fieldB = renderHook(() => useCapsLockWarning())

    act(() => {
      fieldA.result.current.handleKeyEvent(fakeModifierEvent(true))
      fieldA.result.current.resetCapsLockWarning()
      fieldB.result.current.handleFocus()
    })

    expect(fieldA.result.current.capsLockOn).toBe(false)
    expect(fieldB.result.current.capsLockOn).toBe(false)
  })

  it('mousedown 检测到 Caps Lock 开启后应立刻提示（无需敲字母）', () => {
    const { result } = renderHook(() => useCapsLockWarning())

    act(() => {
      result.current.inputHandlers.onMouseDown?.(fakeModifierEvent(true))
    })

    expect(result.current.capsLockOn).toBe(true)
  })
})
