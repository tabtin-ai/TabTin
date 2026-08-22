import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Organization } from '@tabtin/app-shell'
import { OrganizationAppCatalogPanel } from './OrganizationAppCatalogPanel'

const loadCatalog = vi.fn()
const installApp = vi.fn()
const uninstallApp = vi.fn()
const setSearchQuery = vi.fn()
const setSelectedCategory = vi.fn()
const setExpandedAppId = vi.fn()
const getFilteredApps = vi.fn(() => [])
let mockIsLoading = false

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => ({
      'appCatalog.refreshShort': '刷新',
      'appCatalog.searchPlaceholder': '搜索应用...',
      'appCatalog.emptyState': '暂无应用',
      'appCatalog.noResults': '没有找到匹配的应用',
      'appCatalog.noResultsHint': '尝试调整搜索词或切换分类',
      'appCatalog.uninstallConfirmTitle': '确认卸载',
      'appCatalog.uninstallConfirmDesc': '确认卸载这个应用？',
      'appCatalog.uninstallConfirm': '卸载',
      'appCatalog.cancel': '取消',
    }[key] ?? options?.defaultValue ?? key),
  }),
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}))

vi.mock('@stores/useOrganizationAppCatalog', () => ({
  useOrganizationAppCatalog: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      apps: [],
      categories: [],
      canManage: true,
      isLoading: mockIsLoading,
      error: null,
      searchQuery: '',
      selectedCategory: 'all',
      expandedAppId: null,
      installingAppId: null,
      uninstallingAppId: null,
      loadCatalog,
      installApp,
      uninstallApp,
      setSearchQuery,
      setSelectedCategory,
      setExpandedAppId,
      getFilteredApps,
    }),
}))

vi.mock('@components/ui', () => ({
  Button: ({
    children,
    type = 'button',
    variant,
    size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string
    size?: string
  }) => (
    <button type={type} data-variant={variant} data-size={size} {...props}>
      {children}
    </button>
  ),
  ConfirmDialog: () => null,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Skeleton: ({ className }: { className?: string }) => <div className={className}>loading</div>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      layout: _layout,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { layout?: boolean }) => <div {...props}>{children}</div>,
  },
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

const organization = {
  id: 'team-1',
  name: 'Team One',
} as Organization

describe('OrganizationAppCatalogPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsLoading = false
  })

  it('renders the embedded refresh button like the Skill Marketplace toolbar action', () => {
    render(<OrganizationAppCatalogPanel organization={organization} showHeader={false} embedded />)

    const refreshButton = screen.getByRole('button', { name: '刷新' })
    expect(refreshButton.dataset.variant).toBe('outline')
    expect(refreshButton.dataset.size).toBe('sm')
    expect(refreshButton.className).toContain('shrink-0')

    fireEvent.click(refreshButton)

    expect(loadCatalog).toHaveBeenCalledWith('team-1')
    expect(loadCatalog).toHaveBeenCalledTimes(2)
  })

  it('uses the same auto-fill card grid as the desktop apps pane', () => {
    mockIsLoading = true
    const { container } = render(<OrganizationAppCatalogPanel organization={organization} showHeader={false} embedded />)

    const grid = Array.from(container.querySelectorAll('div')).find((element) =>
      element.className.includes('auto-fill'),
    )

    expect(grid?.className).toContain('grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))]')
    expect(grid?.className).toContain('gap-3')
  })
})
