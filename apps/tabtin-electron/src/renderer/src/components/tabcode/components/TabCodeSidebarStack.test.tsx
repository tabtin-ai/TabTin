import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TabCodeSidebarStack } from './TabCodeSidebarStack'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

describe('TabCodeSidebarStack', () => {
  it('renders files as the active tab and keeps panels mounted', () => {
    const onActiveTabChange = vi.fn()

    render(
      <TabCodeSidebarStack
        fileTree={<div data-testid="files-panel">files</div>}
        gitPanel={<div data-testid="git-panel">git</div>}
        searchPanel={<div data-testid="search-panel">search</div>}
        activeTab="files"
        onActiveTabChange={onActiveTabChange}
      />,
    )

    expect(screen.getByTestId('files-panel')).toBeTruthy()
    expect(screen.getByTestId('git-panel')).toBeTruthy()
    expect(screen.getByTestId('search-panel')).toBeTruthy()
    expect(screen.getByRole('tab', { name: '目录' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: '目录' }).hasAttribute('hidden')).toBe(false)
    expect(screen.getByTestId('search-panel').parentElement?.hasAttribute('hidden')).toBe(true)
  })

  it('requests Git tab activation when the Git tab is clicked', () => {
    const onActiveTabChange = vi.fn()

    render(
      <TabCodeSidebarStack
        fileTree={<div>files</div>}
        gitPanel={<div>git</div>}
        searchPanel={<div>search</div>}
        activeTab="files"
        onActiveTabChange={onActiveTabChange}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Git' }))
    expect(onActiveTabChange).toHaveBeenCalledWith('git')
  })

  it('requests Search tab activation and shows the search panel', () => {
    const onActiveTabChange = vi.fn()

    const { rerender } = render(
      <TabCodeSidebarStack
        fileTree={<div>files</div>}
        gitPanel={<div>git</div>}
        searchPanel={<div data-testid="search-panel">search</div>}
        activeTab="files"
        onActiveTabChange={onActiveTabChange}
      />,
    )

    fireEvent.click(screen.getByRole('tab', { name: '搜索' }))
    expect(onActiveTabChange).toHaveBeenCalledWith('search')

    rerender(
      <TabCodeSidebarStack
        fileTree={<div>files</div>}
        gitPanel={<div>git</div>}
        searchPanel={<div data-testid="search-panel">search</div>}
        activeTab="search"
        onActiveTabChange={onActiveTabChange}
      />,
    )

    expect(screen.getByRole('tab', { name: '搜索' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: '搜索' }).hasAttribute('hidden')).toBe(false)
  })

  it('hides the Git tab when gitPanel is omitted', () => {
    render(
      <TabCodeSidebarStack
        fileTree={<div>files</div>}
        searchPanel={<div>search</div>}
        activeTab="files"
        onActiveTabChange={vi.fn()}
      />,
    )

    expect(screen.queryByRole('tab', { name: 'Git' })).toBeNull()
    expect(screen.getByRole('tab', { name: '搜索' })).toBeTruthy()
  })

})
