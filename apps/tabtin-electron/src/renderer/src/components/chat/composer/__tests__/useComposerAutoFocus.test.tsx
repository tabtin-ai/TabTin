import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canSafelyFocusComposer,
  focusComposerTextareaSoon,
  useComposerAutoFocus,
} from '../useComposerAutoFocus'

describe('canSafelyFocusComposer', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('activeElement 为 body 时允许 focus', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    document.body.focus()
    expect(canSafelyFocusComposer(ta)).toBe(true)
  })

  it('焦点在其他 INPUT 时不抢', () => {
    const ta = document.createElement('textarea')
    const input = document.createElement('input')
    document.body.append(ta, input)
    input.focus()
    expect(canSafelyFocusComposer(ta)).toBe(false)
  })

  it('焦点在 dialog 内时不抢', () => {
    const ta = document.createElement('textarea')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const btn = document.createElement('button')
    dialog.appendChild(btn)
    document.body.append(ta, dialog)
    btn.focus()
    expect(canSafelyFocusComposer(ta)).toBe(false)
  })

  it('焦点在模型选择器菜单内时不抢', () => {
    const ta = document.createElement('textarea')
    const menu = document.createElement('div')
    menu.setAttribute('data-testid', 'compact-model-selector-menu')
    const btn = document.createElement('button')
    menu.appendChild(btn)
    document.body.append(ta, menu)
    btn.focus()
    expect(canSafelyFocusComposer(ta)).toBe(false)
  })
})

describe('focusComposerTextareaSoon', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => {
        cb(0)
        return 0
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('对可编辑 textarea 调用 focus({ preventScroll: true })', () => {
    const ta = document.createElement('textarea')
    const focus = vi.spyOn(ta, 'focus')
    document.body.appendChild(ta)
    focusComposerTextareaSoon(ta)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('disabled 时不 focus', () => {
    const ta = document.createElement('textarea')
    ta.disabled = true
    const focus = vi.spyOn(ta, 'focus')
    document.body.appendChild(ta)
    focusComposerTextareaSoon(ta)
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('useComposerAutoFocus', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => {
        cb(0)
        return 0
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  function mountTextarea() {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    const focus = vi.spyOn(ta, 'focus')
    const textareaRef = { current: ta }
    return { ta, focus, textareaRef }
  }

  it('mount 且可编辑时 focus', () => {
    const { focus, textareaRef } = mountTextarea()
    renderHook(() =>
      useComposerAutoFocus({
        textareaRef,
        draftKey: 'draft:s1',
        sessionId: 's1',
        disabled: false,
        acceptGlobalInputEvents: true,
      }),
    )
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('draftKey 变化时重新 focus', () => {
    const { focus, textareaRef } = mountTextarea()
    const { rerender } = renderHook(
      (props: { draftKey: string }) =>
        useComposerAutoFocus({
          textareaRef,
          draftKey: props.draftKey,
          sessionId: 's1',
          disabled: false,
          acceptGlobalInputEvents: true,
        }),
      { initialProps: { draftKey: 'draft:a' } },
    )
    focus.mockClear()
    rerender({ draftKey: 'draft:b' })
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('disabled true→false 后 focus（发送结束）', () => {
    const { focus, textareaRef } = mountTextarea()
    const { rerender } = renderHook(
      (props: { disabled: boolean }) =>
        useComposerAutoFocus({
          textareaRef,
          draftKey: 'draft:s1',
          sessionId: 's1',
          disabled: props.disabled,
          acceptGlobalInputEvents: true,
        }),
      { initialProps: { disabled: true } },
    )
    expect(focus).not.toHaveBeenCalled()
    act(() => {
      rerender({ disabled: false })
    })
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('acceptGlobalInputEvents=false 时不 focus', () => {
    const { focus, textareaRef } = mountTextarea()
    renderHook(() =>
      useComposerAutoFocus({
        textareaRef,
        draftKey: 'draft:s1',
        sessionId: 's1',
        disabled: false,
        acceptGlobalInputEvents: false,
      }),
    )
    expect(focus).not.toHaveBeenCalled()
  })
})
