import { describe, expect, it, vi } from 'vitest'

import {
  handleNativeHistoryAppCommand,
  handleNativeHistoryNavigationInput,
  repairUnsafeInternalHistoryNavigation,
} from '../native-history-navigation-guard'

type TestInput = Electron.Input
type TestWebContents = Parameters<typeof handleNativeHistoryNavigationInput>[2]

function createEvent() {
  return { preventDefault: vi.fn() }
}

function createWebContents(entries: string[], activeIndex: number) {
  return {
    isDestroyed: vi.fn(() => false),
    navigationHistory: {
      canGoBack: vi.fn(() => activeIndex > 0),
      canGoForward: vi.fn(() => activeIndex < entries.length - 1),
      getActiveIndex: vi.fn(() => activeIndex),
      getAllEntries: vi.fn(() => entries.map(url => ({ url }))),
      goBack: vi.fn(),
      goForward: vi.fn(),
    },
  }
}

describe('native-history-navigation-guard', () => {
  it('blocks native back shortcuts before the first user page', () => {
    const event = createEvent()
    const webContents = createWebContents(['about:blank', 'https://example.com/article'], 1)
    const emitNavigationState = vi.fn()

    const handled = handleNativeHistoryNavigationInput(
      event,
      { type: 'keyDown', key: 'ArrowLeft', alt: true, control: false, meta: false, shift: false } as TestInput,
      webContents as unknown as TestWebContents,
      emitNavigationState,
    )

    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(webContents.navigationHistory.goBack).not.toHaveBeenCalled()
    expect(emitNavigationState).toHaveBeenCalled()
  })

  it('routes native back shortcuts through guarded history after a second real page', () => {
    const event = createEvent()
    const webContents = createWebContents([
      'about:blank',
      'https://example.com/article',
      'https://example.com/next',
    ], 2)
    const emitNavigationState = vi.fn()

    const handled = handleNativeHistoryNavigationInput(
      event,
      { type: 'keyDown', key: 'ArrowLeft', alt: true, control: false, meta: false, shift: false } as TestInput,
      webContents as unknown as TestWebContents,
      emitNavigationState,
    )

    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(webContents.navigationHistory.goBack).toHaveBeenCalled()
    expect(emitNavigationState).toHaveBeenCalled()
  })

  it('prevents browser-backward app commands and emits state when blocked', () => {
    const event = createEvent()
    const actions = {
      goBack: vi.fn(() => false),
      goForward: vi.fn(() => false),
      emitNavigationState: vi.fn(),
    }

    const handled = handleNativeHistoryAppCommand(event, 'browser-backward', actions)

    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(actions.goBack).toHaveBeenCalled()
    expect(actions.emitNavigationState).toHaveBeenCalled()
  })

  it('repairs completed traversal to internal bootstrap entries by going forward', () => {
    const webContents = createWebContents(['about:blank', 'https://example.com/article'], 0)
    const emitNavigationState = vi.fn()

    const handled = repairUnsafeInternalHistoryNavigation(
      'about:blank',
      webContents as unknown as TestWebContents,
      emitNavigationState,
    )

    expect(handled).toBe(true)
    expect(webContents.navigationHistory.goForward).toHaveBeenCalled()
    expect(emitNavigationState).toHaveBeenCalled()
  })
})
