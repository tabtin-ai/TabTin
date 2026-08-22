import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeChangesPane } from '../CodeChangesPane'

const listCommits = vi.fn()
const getCommitDetail = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))

vi.mock('@components/tabcode/hooks/useGitStatus', () => ({
  useGitStatus: () => ({
    branch: 'main',
    gitStatus: new Map(),
    stagedStatus: new Map(),
    unstagedStatus: new Map(),
    isGitRepo: true,
    isLoading: false,
    statusRevision: 1,
    contentRevisions: {},
    refresh: vi.fn(),
  }),
}))

vi.mock('@components/tabcode/components/git-workflow/useGitWorkflowData', () => ({
  useGitWorkflowData: () => ({
    files: [],
    branchNames: ['main'],
    isLoading: false,
    ensureBranchContext: vi.fn(),
  }),
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: { messagesBySessionId: Record<string, never> }) => unknown) =>
    selector({ messagesBySessionId: {} }),
}))

vi.mock('../agentTurnDiffSnapshots', () => ({
  useAgentTurnDiffStore: (
    selector: (state: {
      captureFromMessages: () => void
      listForSessionRoot: () => []
      byMessageId: Record<string, never>
    }) => unknown,
  ) =>
    selector({
      captureFromMessages: vi.fn(),
      listForSessionRoot: () => [],
      byMessageId: {},
    }),
}))

vi.mock('../fileEditPatchJournalStore', () => ({
  useFileEditPatchJournalStore: (
    selector: (state: { byThread: Record<string, never>; load: () => Promise<void> }) => unknown,
  ) => selector({ byThread: {}, load: vi.fn(async () => undefined) }),
}))

vi.mock('../ContinuousChangesDiff', () => ({
  ContinuousChangesDiff: (props: {
    diffMode?: string
    commitHash?: string
    files?: Array<{ path: string }>
  }) => (
    <div
      data-testid="mock-continuous-diff"
      data-diff-mode={props.diffMode || 'head'}
      data-commit-hash={props.commitHash || ''}
      data-files={(props.files ?? []).map((file) => file.path).join(',')}
    />
  ),
}))

vi.mock('../ChangesFileTree', () => ({
  ChangesFileTree: (props: { readOnly?: boolean; files?: Array<{ path: string }> }) => (
    <div
      data-testid="mock-changes-tree"
      data-readonly={props.readOnly ? 'true' : 'false'}
      data-files={(props.files ?? []).map((file) => file.path).join(',')}
    />
  ),
}))

vi.mock('@components/tabcode/components/TabCodeConfirmDialog', () => ({
  TabCodeConfirmDialog: () => null,
}))

describe('CodeChangesPane history dual-pane', () => {
  beforeEach(() => {
    listCommits.mockReset()
    getCommitDetail.mockReset()
    listCommits.mockResolvedValue({
      success: true,
      commits: [{
        hash: 'abc123456789',
        shortHash: 'abc1234',
        subject: 'Improve history layout',
        authorName: 'Yang',
        authoredAt: '2026-08-12T00:00:00.000Z',
      }],
    })
    getCommitDetail.mockResolvedValue({
      success: true,
      commit: {
        hash: 'abc123456789',
        shortHash: 'abc1234',
        subject: 'Improve history layout',
        authorName: 'Yang',
        authoredAt: '2026-08-12T00:00:00.000Z',
      },
      files: [{ path: 'a.ts', status: 'M', added: 2, deleted: 1 }],
      insertions: 2,
      deletions: 1,
    })
    ;(window as unknown as {
      tabtin: { git: { listCommits: typeof listCommits; getCommitDetail: typeof getCommitDetail } }
    }).tabtin = {
      git: {
        listCommits,
        getCommitDetail,
      },
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('进入历史先显示提交列表，选中后进入左 Diff + 右只读文件树', async () => {
    render(
      <CodeChangesPane
        rootPath="/repo"
        initialView="history"
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('commit-history-list')).toBeTruthy()
    })
    expect(screen.getByText(/选择右侧一条提交查看变更/)).toBeTruthy()
    expect(screen.queryByTestId('mock-continuous-diff')).toBeNull()

    fireEvent.click(screen.getByTestId('commit-history-item'))

    await waitFor(() => {
      expect(screen.getByTestId('mock-continuous-diff')).toBeTruthy()
    })
    const diff = screen.getByTestId('mock-continuous-diff')
    expect(diff.getAttribute('data-diff-mode')).toBe('commit')
    expect(diff.getAttribute('data-commit-hash')).toBe('abc123456789')
    expect(screen.getByTestId('mock-changes-tree').getAttribute('data-readonly')).toBe('true')
    expect(screen.getByTestId('commit-history-aside').getAttribute('data-aside-mode')).toBe('files')

    fireEvent.click(screen.getByTestId('history-change-commit'))
    expect(screen.getByTestId('commit-history-aside').getAttribute('data-aside-mode')).toBe('commits')
    expect(screen.getByTestId('commit-history-list')).toBeTruthy()
  })

  it('clears the previous commit detail while the next commit is loading', async () => {
    let resolveSecondDetail: ((value: unknown) => void) | undefined
    const firstDetail = {
      success: true,
      commit: {
        hash: 'abc123456789',
        shortHash: 'abc1234',
        subject: 'Improve history layout',
        authorName: 'Yang',
        authoredAt: '2026-08-12T00:00:00.000Z',
      },
      files: [{ path: 'a.ts', status: 'M', added: 2, deleted: 1 }],
      insertions: 2,
      deletions: 1,
    }
    listCommits.mockResolvedValue({
      success: true,
      commits: [{
        hash: 'abc123456789',
        shortHash: 'abc1234',
        subject: 'Improve history layout',
        authorName: 'Yang',
        authoredAt: '2026-08-12T00:00:00.000Z',
      }, {
        hash: 'def987654321',
        shortHash: 'def9876',
        subject: 'Previous commit',
        authorName: 'Lin',
        authoredAt: '2026-08-11T00:00:00.000Z',
      }],
    })
    getCommitDetail.mockImplementation((
      _rootPath: string,
      { commitHash }: { commitHash: string },
    ) => {
      if (commitHash === 'abc123456789') {
        return Promise.resolve(firstDetail)
      }
      return new Promise((resolve) => {
        resolveSecondDetail = resolve
      })
    })

    render(
      <CodeChangesPane
        rootPath="/repo"
        initialView="history"
      />,
    )
    await waitFor(() => {
      expect(screen.getAllByTestId('commit-history-item')).toHaveLength(2)
    })

    fireEvent.click(screen.getByRole('button', { name: /Improve history layout/ }))
    await waitFor(() => {
      expect(screen.getByTestId('mock-continuous-diff').getAttribute('data-commit-hash')).toBe('abc123456789')
    })
    expect(screen.getByTestId('mock-continuous-diff').getAttribute('data-files')).toBe('a.ts')
    expect(screen.getByTestId('mock-changes-tree').getAttribute('data-files')).toBe('a.ts')

    fireEvent.click(screen.getByTestId('history-change-commit'))
    fireEvent.click(screen.getByRole('button', { name: /Previous commit/ }))
    await waitFor(() => {
      expect(screen.queryByTestId('mock-continuous-diff')).toBeNull()
      expect(screen.getByText('读取变更…')).toBeTruthy()
    })
    expect(screen.getByTestId('mock-changes-tree').getAttribute('data-files')).toBe('')

    act(() => {
      resolveSecondDetail?.({
        success: true,
        commit: {
          hash: 'def987654321',
          shortHash: 'def9876',
          subject: 'Previous commit',
          authorName: 'Lin',
          authoredAt: '2026-08-11T00:00:00.000Z',
        },
        files: [{ path: 'b.ts', status: 'M', added: 1, deleted: 0 }],
        insertions: 1,
        deletions: 0,
      })
    })
    await waitFor(() => {
      const diff = screen.getByTestId('mock-continuous-diff')
      expect(diff.getAttribute('data-commit-hash')).toBe('def987654321')
      expect(diff.getAttribute('data-files')).toBe('b.ts')
    })
    expect(screen.getByTestId('mock-changes-tree').getAttribute('data-files')).toBe('b.ts')
  })
})
