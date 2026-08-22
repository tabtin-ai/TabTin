import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitWorkflowPanel } from './GitWorkflowPanel'

const mocks = vi.hoisted(() => ({
  loadData: vi.fn(),
  toast: vi.fn(),
  logGitActionFailure: vi.fn(),
  branchMeta: {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    isDetached: false,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  toast: mocks.toast,
}))

vi.mock('@components/ui', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  toast: mocks.toast,
}))

vi.mock('./useGitWorkflowData', () => ({
  useGitWorkflowData: () => ({
    currentBranchName: 'main',
    branchMeta: mocks.branchMeta,
    branchNames: ['main'],
    files: [],
    groups: [],
    worktrees: [],
    checkoutBranch: 'main',
    setCheckoutBranch: vi.fn(),
    newBranchBase: 'main',
    setNewBranchBase: vi.fn(),
    worktreeBaseBranch: 'main',
    setWorktreeBaseBranch: vi.fn(),
    worktreeBranch: '',
    setWorktreeBranch: vi.fn(),
    isLoading: false,
    loadData: mocks.loadData,
  }),
}))

vi.mock('./CommitBar', () => ({
  CommitBar: () => <div data-testid="commit-bar" />,
}))

vi.mock('./ChangesPanel', () => ({
  ChangesPanel: () => <div data-testid="changes-panel" />,
}))

vi.mock('./AdvancedSheet', () => ({
  AdvancedSheet: () => null,
}))

vi.mock('../../utils/gitActionDiagnostics', () => ({
  logGitActionFailure: mocks.logGitActionFailure,
}))

beforeEach(() => {
  mocks.loadData.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('GitWorkflowPanel', () => {
  it('不再渲染顶栏同步按钮，直接展示 Commit 与 Changes', () => {
    render(
      <GitWorkflowPanel
        rootPath="/repo"
        currentBranch="main"
        stagedCount={0}
        unstagedCount={0}
        onRefreshGit={vi.fn()}
      />,
    )

    expect(screen.getByTestId('commit-bar')).toBeTruthy()
    expect(screen.getByTestId('changes-panel')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'gitFlow.fetch' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'gitFlow.pull' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'gitFlow.push' })).toBeNull()
    expect(screen.queryByText('main')).toBeNull()
  })
})
