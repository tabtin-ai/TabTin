import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BranchSection } from '../BranchSection'

const mocks = vi.hoisted(() => ({
  checkoutSessionBranch: vi.fn(),
  runGitAction: vi.fn(async (_key: string, action: () => Promise<{ success: boolean; error?: string }>) => {
    const result = await action()
    return Boolean(result?.success)
  }),
  toast: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { branch?: string; defaultValue?: string }) => {
      if (key === 'gitFlow.checkoutSuccess') return `checked-out-${opts?.branch}`
      return opts?.defaultValue ?? key
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/smartsheet-ui')>('@tabtin/smartsheet-ui')
  return {
    ...actual,
    toast: (...args: unknown[]) => mocks.toast(...args),
  }
})

vi.mock('@components/context-space/code-workspace/checkoutSessionBranch', () => ({
  checkoutSessionBranch: (...args: unknown[]) => mocks.checkoutSessionBranch(...args),
}))

vi.mock('../../TabCodeConfirmDialog', () => ({
  TabCodeConfirmDialog: ({
    open,
    onConfirm,
    confirmLabel,
  }: {
    open: boolean
    onConfirm: () => void
    confirmLabel?: string
  }) => (
    open ? (
      <button type="button" data-testid="branch-stash-confirm" onClick={() => onConfirm()}>
        {confirmLabel || 'confirm'}
      </button>
    ) : null
  ),
}))

describe('BranchSection checkoutSessionBranch', () => {
  beforeEach(() => {
    mocks.checkoutSessionBranch.mockReset()
    mocks.runGitAction.mockClear()
    mocks.toast.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('确认暂存后走 checkoutSessionBranch(confirmedStash=true)', async () => {
    mocks.checkoutSessionBranch
      .mockResolvedValueOnce({ success: false, needsStashConfirm: true })
      .mockResolvedValueOnce({ success: true })

    render(
      <BranchSection
        rootPath="/repo"
        branchNames={['main', 'feat']}
        currentBranchName="main"
        stagedCount={1}
        unstagedCount={0}
        checkoutBranch="feat"
        setCheckoutBranch={vi.fn()}
        newBranchBase=""
        setNewBranchBase={vi.fn()}
        actionKey={null}
        runGitAction={mocks.runGitAction}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.checkout' }))
    const confirm = await screen.findByTestId('branch-stash-confirm')
    await act(async () => {
      fireEvent.click(confirm)
    })

    await waitFor(() => {
      expect(mocks.checkoutSessionBranch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          rootPath: '/repo',
          branch: 'feat',
          confirmedStash: true,
        }),
      )
    })
  })

  it('仅未跟踪时直接切换，不弹 stash 确认', async () => {
    mocks.checkoutSessionBranch.mockResolvedValue({ success: true })

    render(
      <BranchSection
        rootPath="/repo"
        branchNames={['main', 'feat']}
        currentBranchName="main"
        stagedCount={0}
        unstagedCount={2}
        untrackedCount={2}
        checkoutBranch="feat"
        setCheckoutBranch={vi.fn()}
        newBranchBase=""
        setNewBranchBase={vi.fn()}
        actionKey={null}
        runGitAction={mocks.runGitAction}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'gitFlow.checkout' }))

    await waitFor(() => {
      expect(mocks.checkoutSessionBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'feat',
          confirmedStash: false,
          untrackedCount: 2,
        }),
      )
    })
    expect(screen.queryByTestId('branch-stash-confirm')).toBeNull()
    expect(mocks.runGitAction).toHaveBeenCalled()
  })
})
