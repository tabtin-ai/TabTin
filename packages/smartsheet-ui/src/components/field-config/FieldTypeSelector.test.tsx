import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FieldTypeSelector } from './FieldTypeSelector'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('../popover', () => ({
  Popover: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PopoverTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PopoverContent: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid="field-type-content" {...props}>{children}</div>
  ),
}))

vi.mock('../sheet', () => ({
  Sheet: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SheetTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SheetContent: ({ children, onOpenAutoFocus: _onOpenAutoFocus, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid="field-type-sheet" {...props}>{children}</div>
  ),
  SheetHeader: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <header {...props}>{children}</header>,
  SheetTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  SheetDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 639px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
})

describe('FieldTypeSelector mobile layout', () => {
  it('uses a viewport-safe bottom sheet instead of a form-covering popover on phones', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => root.render(<FieldTypeSelector value="text" onChange={vi.fn()} />))

      const sheet = container.querySelector('[data-testid="field-type-sheet"]')
      expect(sheet?.className).toContain('h-[min(70dvh,32rem)]')
      expect(sheet?.className).toContain('max-h-[calc(100dvh-1rem)]')
      expect(container.querySelector('[data-testid="field-type-content"]')).toBeNull()
      expect(container.querySelector('button[role="combobox"]')?.getAttribute('aria-expanded')).toBe('false')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
