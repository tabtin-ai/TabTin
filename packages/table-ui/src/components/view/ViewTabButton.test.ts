import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ViewTabButton } from './ViewTabButton'

vi.mock('@tabtin/smartsheet-ui', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}), { virtual: true })

const renderRenamingTab = (overrides: Partial<React.ComponentProps<typeof ViewTabButton>> = {}) => {
  const props: React.ComponentProps<typeof ViewTabButton> = {
    view: {
      id: 'view-1',
      name: '表格视图',
      view_type: 'grid',
    },
    isActive: true,
    isPinned: false,
    isLoading: false,
    isRenaming: true,
    isRenamingSubmitting: false,
    renameDraftName: '表格视图',
    renameInputRef: { current: null },
    onSelect: vi.fn(),
    onBeginRename: vi.fn(),
    onOpenContextMenu: vi.fn(),
    onRenameDraftChange: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    ...overrides,
  }

  render(React.createElement(ViewTabButton, props))

  return props
}

describe('ViewTabButton', () => {
  it('does not commit or cancel view rename while IME composition is active', () => {
    const props = renderRenamingTab()
    const input = screen.getByDisplayValue('表格视图')

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })

    expect(props.onCommitRename).not.toHaveBeenCalled()
    expect(props.onCancelRename).not.toHaveBeenCalled()
  })

  it('does not commit view rename for IME keyCode 229 fallback events', () => {
    const props = renderRenamingTab()
    const input = screen.getByDisplayValue('表格视图')

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })

    expect(props.onCommitRename).not.toHaveBeenCalled()
  })

  it('still commits and cancels rename when not composing', () => {
    const props = renderRenamingTab()
    const input = screen.getByDisplayValue('表格视图')

    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(props.onCommitRename).toHaveBeenCalledTimes(1)
    expect(props.onCancelRename).toHaveBeenCalledTimes(1)
  })

  it('routes blur to onBlurRename when provided, keeping Enter on onCommitRename', () => {
    vi.useFakeTimers()
    const onBlurRename = vi.fn()
    const props = renderRenamingTab({ onBlurRename })
    const input = screen.getByDisplayValue('表格视图')
    const activeSpy = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body)

    fireEvent.blur(input)
    vi.runAllTimers()
    activeSpy.mockRestore()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onBlurRename).toHaveBeenCalledTimes(1)
    expect(props.onCommitRename).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('falls back to onCommitRename on blur when onBlurRename is omitted', () => {
    vi.useFakeTimers()
    const props = renderRenamingTab()
    const input = screen.getByDisplayValue('表格视图')
    const activeSpy = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body)

    fireEvent.blur(input)
    vi.runAllTimers()
    activeSpy.mockRestore()

    expect(props.onCommitRename).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('skips deferred blur commit when input is refocused before the macrotask', () => {
    vi.useFakeTimers()
    const onBlurRename = vi.fn()
    const renameInputRef: { current: HTMLInputElement | null } = { current: null }
    renderRenamingTab({ onBlurRename, renameInputRef })
    const input = screen.getByDisplayValue('表格视图') as HTMLInputElement
    renameInputRef.current = input
    const activeSpy = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(input)

    fireEvent.blur(input)
    vi.runAllTimers()
    activeSpy.mockRestore()

    expect(onBlurRename).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('notifies onRenameInputFocus when the rename input receives focus', () => {
    const onRenameInputFocus = vi.fn()
    renderRenamingTab({ onRenameInputFocus })
    const input = screen.getByDisplayValue('表格视图')

    // autoFocus 可能已触发一次；再手动 focus 也应回调
    const before = onRenameInputFocus.mock.calls.length
    fireEvent.focus(input)

    expect(onRenameInputFocus.mock.calls.length).toBeGreaterThan(before)
  })
})
