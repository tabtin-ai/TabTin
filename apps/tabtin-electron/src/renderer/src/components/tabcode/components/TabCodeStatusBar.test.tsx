import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TabCodeStatusBar } from './TabCodeStatusBar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'gitFlow.pushDisabledBehind') {
        return `behind ${String(options?.count ?? 0)}`
      }
      return key
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    title,
  }: {
    children: React.ReactNode
    onSelect?: () => void
    disabled?: boolean
    title?: string
  }) => (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
    >
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('TabCodeStatusBar', () => {
  it('opens Changes and shows current insertion/deletion totals', () => {
    const onOpenChanges = vi.fn()

    render(
      <TabCodeStatusBar
        isGitRepo
        branch="main"
        changeStats={{ insertions: 24, deletions: 7 }}
        onOpenChanges={onOpenChanges}
      />,
    )

    expect(screen.getByText('toolbar.changes')).toBeTruthy()
    expect(screen.getByText('+24')).toBeTruthy()
    expect(screen.getByText('-7')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'toolbar.openChanges' }))
    expect(onOpenChanges).toHaveBeenCalledOnce()
  })

  it('omits zero change totals without hiding the Changes entry', () => {
    render(
      <TabCodeStatusBar
        isGitRepo
        branch="main"
        changeStats={{ insertions: 0, deletions: 0 }}
        onOpenChanges={vi.fn()}
      />,
    )

    expect(screen.getByText('toolbar.changes')).toBeTruthy()
    expect(screen.queryByText('+0')).toBeNull()
    expect(screen.queryByText('-0')).toBeNull()
  })

  it('exposes branch, sync menu, worktree, collapse, and switch-to-file-browser actions', () => {
    const onOpenBranchOperations = vi.fn()
    const onFetch = vi.fn()
    const onPull = vi.fn()
    const onPush = vi.fn()
    const onOpenWorktree = vi.fn()
    const onOpenHistory = vi.fn()
    const onToggleSidebar = vi.fn()
    const onSwitchToFileBrowser = vi.fn()

    render(
      <TabCodeStatusBar
        isGitRepo
        branch="feat/tabcode-git-experience-upgrade"
        branchMeta={{
          branch: 'feat/tabcode-git-experience-upgrade',
          upstream: 'origin/feat/tabcode-git-experience-upgrade',
          ahead: 1,
          behind: 0,
          isDetached: false,
        }}
        onOpenBranchOperations={onOpenBranchOperations}
        onFetch={onFetch}
        onPull={onPull}
        onPush={onPush}
        onOpenWorktree={onOpenWorktree}
        onOpenHistory={onOpenHistory}
        onToggleSidebar={onToggleSidebar}
        onSwitchToFileBrowser={onSwitchToFileBrowser}
      />,
    )

    expect(
      screen.getByText('feat/tabcode-git-experience-upgrade'),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.syncStatus' }))
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.fetch' }))
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.pull' }))
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.push' }))

    expect(onFetch).toHaveBeenCalledOnce()
    expect(onPull).toHaveBeenCalledOnce()
    expect(onPush).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'toolbar.switchBranch' }))
    fireEvent.click(screen.getByRole('button', { name: 'toolbar.gitHistory' }))
    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.worktreePanel' }))
    fireEvent.click(screen.getByRole('button', { name: 'toolbar.collapseSidebar' }))
    fireEvent.click(screen.getByRole('button', { name: 'toolbar.switchToFileBrowser' }))

    expect(onOpenBranchOperations).toHaveBeenCalledOnce()
    expect(onOpenHistory).toHaveBeenCalledOnce()
    expect(onOpenWorktree).toHaveBeenCalledOnce()
    expect(onToggleSidebar).toHaveBeenCalledOnce()
    expect(onSwitchToFileBrowser).toHaveBeenCalledOnce()
  })

  it('hides history when the folder is not a git repo', () => {
    render(
      <TabCodeStatusBar
        isGitRepo={false}
        branch={null}
        onOpenChanges={vi.fn()}
        onOpenHistory={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: 'toolbar.openChanges' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'toolbar.gitHistory' })).toBeNull()
  })

  it('disables push in sync menu when ahead=0', () => {
    const onPush = vi.fn()

    render(
      <TabCodeStatusBar
        isGitRepo
        branch="main"
        branchMeta={{
          branch: 'main',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          isDetached: false,
        }}
        onFetch={vi.fn()}
        onPull={vi.fn()}
        onPush={onPush}
      />,
    )

    const pushButton = screen.getByRole('button', { name: 'gitFlow.push' }) as HTMLButtonElement
    expect(pushButton.disabled).toBe(true)
    expect(pushButton.title).toBe('gitFlow.pushDisabledNoAhead')
    fireEvent.click(pushButton)
    expect(onPush).not.toHaveBeenCalled()
  })

  it('disables push when behind upstream', () => {
    render(
      <TabCodeStatusBar
        isGitRepo
        branch="main"
        branchMeta={{
          branch: 'main',
          upstream: 'origin/main',
          ahead: 1,
          behind: 2,
          isDetached: false,
        }}
        onFetch={vi.fn()}
        onPull={vi.fn()}
        onPush={vi.fn()}
      />,
    )

    const pushButton = screen.getByRole('button', { name: 'gitFlow.push' }) as HTMLButtonElement
    expect(pushButton.disabled).toBe(true)
    expect(pushButton.title).toBe('behind 2')
  })

  it('shows expand control when sidebar is collapsed', () => {
    const onToggleSidebar = vi.fn()

    render(
      <TabCodeStatusBar
        isGitRepo={false}
        branch={null}
        sidebarCollapsed
        onToggleSidebar={onToggleSidebar}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'toolbar.expandSidebar' }))
    expect(onToggleSidebar).toHaveBeenCalledOnce()
  })

  it('shows sync loading spinner and disables menu while syncing', () => {
    const onFetch = vi.fn()

    render(
      <TabCodeStatusBar
        isGitRepo
        branch="main"
        branchMeta={{
          branch: 'main',
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          isDetached: false,
        }}
        syncActionKey="fetch"
        onFetch={onFetch}
        onPull={vi.fn()}
        onPush={vi.fn()}
      />,
    )

    const syncButton = screen.getByRole('button', { name: 'gitFlow.syncStatus' }) as HTMLButtonElement
    expect(syncButton.disabled).toBe(true)
    expect(syncButton.getAttribute('aria-busy')).toBe('true')

    const fetchButton = screen.getByRole('button', { name: 'gitFlow.fetch' }) as HTMLButtonElement
    expect(fetchButton.disabled).toBe(true)
    fireEvent.click(fetchButton)
    expect(onFetch).not.toHaveBeenCalled()
  })
})
