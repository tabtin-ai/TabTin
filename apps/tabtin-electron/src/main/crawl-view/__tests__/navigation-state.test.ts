import { describe, expect, it, vi } from 'vitest'

import {
  canGoBackToUserPage,
  getEffectiveNavigationState,
  type NavigationHistoryForState,
} from '../navigation-state'

function createHistory(entries: string[], activeIndex: number): NavigationHistoryForState {
  return {
    canGoBack: vi.fn(() => activeIndex > 0),
    canGoForward: vi.fn(() => activeIndex < entries.length - 1),
    getActiveIndex: vi.fn(() => activeIndex),
    getAllEntries: vi.fn(() => entries.map(url => ({ url, title: url }))),
  }
}

describe('navigation-state', () => {
  it('treats the bootstrap about:blank entry as not user-backable', () => {
    const history = createHistory(['about:blank', 'https://example.com'], 1)

    expect(canGoBackToUserPage(history)).toBe(false)
    expect(getEffectiveNavigationState({ navigationHistory: history })).toMatchObject({
      canGoBack: false,
      canGoForward: false,
    })
  })

  it('allows back once the previous entry is a real user page', () => {
    const history = createHistory(['about:blank', 'https://example.com/a', 'https://example.com/b'], 2)

    expect(canGoBackToUserPage(history)).toBe(true)
    expect(getEffectiveNavigationState({ navigationHistory: history })).toMatchObject({
      canGoBack: true,
      canGoForward: false,
    })
  })

  it('allows back for normal two-page history without an internal bootstrap entry', () => {
    const history = createHistory(['https://example.com/a', 'https://example.com/b'], 1)

    expect(canGoBackToUserPage(history)).toBe(true)
  })

  it('keeps forward available when the current page is the first real page', () => {
    const history = createHistory(['about:blank', 'https://example.com/a', 'https://example.com/b'], 1)

    expect(getEffectiveNavigationState({ navigationHistory: history })).toMatchObject({
      canGoBack: false,
      canGoForward: true,
    })
  })

  it('does not expose back when history entries are unavailable', () => {
    const history: NavigationHistoryForState = {
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => false),
      getActiveIndex: vi.fn(() => {
        throw new Error('history unavailable')
      }),
      getAllEntries: vi.fn(() => {
        throw new Error('history unavailable')
      }),
    }

    expect(canGoBackToUserPage(history)).toBe(false)
  })
})
