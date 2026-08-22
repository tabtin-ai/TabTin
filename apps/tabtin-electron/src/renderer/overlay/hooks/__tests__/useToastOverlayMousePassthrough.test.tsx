import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useToastOverlayMousePassthrough } from '../useToastOverlayMousePassthrough'

describe('useToastOverlayMousePassthrough', () => {
  const setToastIgnoreMouseEvents = vi.fn().mockResolvedValue({ success: true })
  const getToastCursorClientPoint = vi.fn().mockResolvedValue(null)

  beforeEach(() => {
    setToastIgnoreMouseEvents.mockClear()
    getToastCursorClientPoint.mockClear()
    getToastCursorClientPoint.mockResolvedValue(null)
    ;(window as any).tabtin = {
      overlay: { setToastIgnoreMouseEvents, getToastCursorClientPoint },
    }
  })

  afterEach(() => {
    delete (window as any).tabtin
    vi.useRealTimers()
  })

  it('指针进入命中区时取消穿透，离开后恢复', () => {
    const track = document.createElement('div')
    track.setAttribute('data-overlay-track', 'true')
    document.body.appendChild(track)

    renderHook(() => useToastOverlayMousePassthrough(true))

    act(() => {
      document.elementFromPoint = () => track
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 12, clientY: 8 }))
    })
    expect(setToastIgnoreMouseEvents).toHaveBeenCalledWith(false)

    act(() => {
      document.elementFromPoint = () => document.body
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1 }))
    })
    expect(setToastIgnoreMouseEvents).toHaveBeenLastCalledWith(true)

    track.remove()
  })

  it('无可见 toast 时强制恢复穿透', () => {
    const track = document.createElement('div')
    track.setAttribute('data-overlay-track', 'true')
    document.body.appendChild(track)

    const { rerender } = renderHook(
      ({ hasVisible }) => useToastOverlayMousePassthrough(hasVisible),
      { initialProps: { hasVisible: true } },
    )

    act(() => {
      document.elementFromPoint = () => track
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 12, clientY: 8 }))
    })
    expect(setToastIgnoreMouseEvents).toHaveBeenCalledWith(false)
    setToastIgnoreMouseEvents.mockClear()

    act(() => {
      rerender({ hasVisible: false })
    })

    expect(setToastIgnoreMouseEvents).toHaveBeenCalledWith(true)
    track.remove()
  })

  it('toast 出现后用主进程光标做一次静止指针命中同步', async () => {
    vi.useFakeTimers()
    const track = document.createElement('div')
    track.setAttribute('data-overlay-track', 'true')
    document.body.appendChild(track)
    document.elementFromPoint = () => track
    getToastCursorClientPoint.mockResolvedValue({ clientX: 20, clientY: 10 })

    renderHook(() => useToastOverlayMousePassthrough(true))

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(getToastCursorClientPoint).toHaveBeenCalled()
    expect(setToastIgnoreMouseEvents).toHaveBeenCalledWith(false)
    track.remove()
  })
})
