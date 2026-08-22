import { afterEach, describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { AddressBarSuggestions } from '../AddressBarSuggestions'
import {
  getAddressBarSuggestionsPortalStyle,
  getBrowserSidePanelPortalStyle,
  getBrowserSidePanelPositionClassName,
  shouldHideWebviewForAddressSuggestions,
  shouldHideWebviewForSidePanel,
} from '../browserSidePanelLayout'

vi.mock('@stores/useBrowsingHistoryStore', () => ({
  useBrowsingHistoryStore: (sel: (s: { items: unknown[] }) => unknown) =>
    sel({
      items: [{ id: '1', url: 'https://example.com', title: 'Example', visitedAt: 1 }],
    }),
}))
vi.mock('@stores/useBookmarkStore', () => ({
  useBookmarkStore: (sel: (s: { items: unknown[] }) => unknown) => sel({ items: [] }),
}))

afterEach(() => {
  document.documentElement.classList.remove('dark')
})

describe('AddressBarSuggestions overlay', () => {
  it('uses overlay positioning classes that can sit above the webview layer', () => {
    const { container } = render(
      <AddressBarSuggestions query="exam" onSelect={() => {}} visible />,
    )
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toMatch(/absolute|fixed/)
    expect(root.className).toMatch(/z-modal/)
  })

  it('uses a theme-aware surface instead of a fixed light background', () => {
    document.documentElement.classList.add('dark')
    const anchor = document.createElement('div')
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      left: 20,
      top: 40,
      width: 500,
      height: 32,
    } as DOMRect)

    render(
      <AddressBarSuggestions
        query="exam"
        onSelect={() => {}}
        visible
        anchorRef={{ current: anchor }}
      />,
    )
    const root = document.body.querySelector('[data-testid="address-bar-suggestions"]') as HTMLElement

    expect(root.classList.contains('bg-background')).toBe(true)
    expect(root.classList.contains('bg-white')).toBe(false)
  })
})

describe('browserSidePanelLayout', () => {
  describe('shouldHideWebviewForSidePanel', () => {
    it('never hides webview for overlay side panels in webview mode', () => {
      expect(
        shouldHideWebviewForSidePanel({
          panel: 'resource',
          resourceViewMode: 'wide',
          containerMode: 'webview',
        }),
      ).toBe(false)
    })

    it('never hides webview in webview mode even with narrow panel open', () => {
      expect(
        shouldHideWebviewForSidePanel({
          panel: 'tins',
          resourceViewMode: 'narrow',
          containerMode: 'webview',
        }),
      ).toBe(false)
    })

    it('never hides webview in webview mode when no panel is open', () => {
      expect(
        shouldHideWebviewForSidePanel({
          panel: null,
          resourceViewMode: 'narrow',
          containerMode: 'webview',
        }),
      ).toBe(false)
    })

    it('degrades (hides) the native WCV when a side panel is open, regardless of view mode', () => {
      expect(
        shouldHideWebviewForSidePanel({
          panel: 'resource',
          resourceViewMode: 'narrow',
          containerMode: 'wcv',
        }),
      ).toBe(true)
      expect(
        shouldHideWebviewForSidePanel({
          panel: 'resource',
          resourceViewMode: 'wide',
          containerMode: 'wcv',
        }),
      ).toBe(true)
      expect(
        shouldHideWebviewForSidePanel({
          panel: 'tins',
          resourceViewMode: 'narrow',
          containerMode: 'wcv',
        }),
      ).toBe(true)
    })

    it('does not degrade the WCV when no side panel is open', () => {
      expect(
        shouldHideWebviewForSidePanel({
          panel: null,
          resourceViewMode: 'narrow',
          containerMode: 'wcv',
        }),
      ).toBe(false)
    })
  })

  describe('shouldHideWebviewForAddressSuggestions', () => {
    it('never hides webview in webview mode even when suggestions are visible', () => {
      expect(
        shouldHideWebviewForAddressSuggestions({ visible: true, containerMode: 'webview' }),
      ).toBe(false)
    })

    it('degrades (hides) the native WCV while address bar suggestions are visible', () => {
      expect(
        shouldHideWebviewForAddressSuggestions({ visible: true, containerMode: 'wcv' }),
      ).toBe(true)
    })

    it('does not degrade the WCV when suggestions are not visible', () => {
      expect(
        shouldHideWebviewForAddressSuggestions({ visible: false, containerMode: 'wcv' }),
      ).toBe(false)
    })
  })

  describe('getBrowserSidePanelPositionClassName', () => {
    it('positions side panel as fixed body portal above the webview layer', () => {
      const cls = getBrowserSidePanelPositionClassName({
        panel: 'resource',
        resourceViewMode: 'narrow',
      })
      expect(cls).toMatch(/fixed/)
      expect(cls).toMatch(/z-modal/)
    })

    it('drops the left border when resource panel is wide', () => {
      const cls = getBrowserSidePanelPositionClassName({
        panel: 'resource',
        resourceViewMode: 'wide',
      })
      expect(cls).toMatch(/border-l-0/)
    })

    it('does not apply the wide-only classes to the tins panel', () => {
      const cls = getBrowserSidePanelPositionClassName({
        panel: 'tins',
        resourceViewMode: 'wide',
      })
      expect(cls).not.toMatch(/border-l-0/)
      expect(cls).toMatch(/border-l border-border/)
    })
  })

  describe('getBrowserSidePanelPortalStyle', () => {
    const contentRect = { left: 1000, top: 100, width: 800, height: 600 }

    it('pins the narrow resource panel to the right edge of the content rect', () => {
      expect(
        getBrowserSidePanelPortalStyle({
          contentRect,
          panel: 'resource',
          resourceViewMode: 'narrow',
          resourcePanelWidth: 380,
        }),
      ).toEqual({ top: 100, left: 1420, width: 380, height: 600 })
    })

    it('covers the full content rect in wide resource mode', () => {
      expect(
        getBrowserSidePanelPortalStyle({
          contentRect,
          panel: 'resource',
          resourceViewMode: 'wide',
          resourcePanelWidth: 380,
        }),
      ).toEqual({ top: 100, left: 1000, width: 800, height: 600 })
    })

    it('caps tins panel width at 45% of content width', () => {
      expect(
        getBrowserSidePanelPortalStyle({
          contentRect,
          panel: 'tins',
          resourceViewMode: 'narrow',
          resourcePanelWidth: 380,
        }),
      ).toEqual({ top: 100, left: 1440, width: 360, height: 600 })
    })
  })

  describe('getAddressBarSuggestionsPortalStyle', () => {
    it('places suggestions directly under the toolbar rect', () => {
      expect(
        getAddressBarSuggestionsPortalStyle({
          left: 100,
          top: 40,
          width: 500,
          height: 48,
        }),
      ).toEqual({ top: 88, left: 100, width: 500 })
    })
  })
})
