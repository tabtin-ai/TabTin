import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BranchOperationsDialog } from './BranchOperationsDialog'

const mocks = vi.hoisted(() => ({
  action: vi.fn().mockResolvedValue({ success: true }),
  loadData: vi.fn().mockResolvedValue(undefined),
  onRefreshGit: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@components/ui', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  toast: mocks.toast,
}))

vi.mock('./useGitWorkflowData', () => ({
  useGitWorkflowData: () => ({
    currentBranchName: 'feature/current',
    branchNames: ['main', 'feature/current'],
    files: [
      { staged: true, unstaged: false },
      { staged: false, unstaged: true },
      { staged: true, unstaged: true },
    ],
    checkoutBranch: 'feature/current',
    setCheckoutBranch: vi.fn(),
    newBranchBase: 'main',
    setNewBranchBase: vi.fn(),
    isLoading: false,
    loadData: mocks.loadData,
  }),
}))

vi.mock('./BranchSection', () => ({
  BranchSection: (props: {
    branchNames: string[]
    stagedCount: number
    unstagedCount: number
    runGitAction: (
      key: string,
      action: () => Promise<{ success: boolean }>,
      description: string,
    ) => Promise<boolean>
  }) => (
    <div
      data-testid="branch-section"
      data-branches={props.branchNames.join(',')}
      data-staged={props.stagedCount}
      data-unstaged={props.unstagedCount}
    >
      <button onClick={() => void props.runGitAction('checkout', mocks.action, 'checkout success')}>
        run checkout
      </button>
    </div>
  ),
}))

vi.mock('../../utils/gitActionDiagnostics', () => ({
  logGitActionFailure: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BranchOperationsDialog', () => {
  it('复用高级卡片的完整分支操作区并传入实时加载结果', () => {
    render(
      <BranchOperationsDialog
        open
        onOpenChange={vi.fn()}
        rootPath="/repo"
        currentBranch="feature/current"
        onRefreshGit={mocks.onRefreshGit}
      />,
    )

    expect(screen.getByText('gitFlow.branchDialogDesc')).not.toBeNull()
    expect(screen.getByText('feature/current')).not.toBeNull()
    expect(screen.getByTestId('branch-section').getAttribute('data-branches')).toBe('main,feature/current')
    expect(screen.getByTestId('branch-section').getAttribute('data-staged')).toBe('2')
    expect(screen.getByTestId('branch-section').getAttribute('data-unstaged')).toBe('2')
  })

  it('分支操作成功后刷新顶部 Git 状态与弹框数据', async () => {
    render(
      <BranchOperationsDialog
        open
        onOpenChange={vi.fn()}
        rootPath="/repo"
        currentBranch="feature/current"
        onRefreshGit={mocks.onRefreshGit}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'run checkout' }))

    await waitFor(() => {
      expect(mocks.action).toHaveBeenCalledOnce()
      expect(mocks.onRefreshGit).toHaveBeenCalledOnce()
      expect(mocks.loadData).toHaveBeenCalledOnce()
    })
  })
})
