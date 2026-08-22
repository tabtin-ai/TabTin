import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHistoryPane } from './GitHistoryPane'

const listCommits = vi.fn()
const getCommitDetail = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@components/context-space/code-workspace/ContinuousChangesDiff', () => ({
  ContinuousChangesDiff: (props: { commitHash?: string }) => (
    <div data-testid="mock-continuous-diff" data-commit-hash={props.commitHash || ''} />
  ),
}))

vi.mock('@components/context-space/code-workspace/ChangesFileTree', () => ({
  ChangesFileTree: () => <div data-testid="mock-changes-tree" />,
}))

describe('GitHistoryPane', () => {
  beforeEach(() => {
    listCommits.mockReset()
    getCommitDetail.mockReset()
    listCommits.mockResolvedValue({
      success: true,
      commits: [{
        hash: 'aaa111',
        shortHash: 'aaa1111',
        subject: 'Show branch history',
        authorName: 'Yang',
        authoredAt: '2026-08-14T00:00:00.000Z',
      }],
    })
    getCommitDetail.mockResolvedValue({
      success: true,
      commit: {
        hash: 'aaa111',
        shortHash: 'aaa1111',
        subject: 'Show branch history',
        authorName: 'Yang',
        authoredAt: '2026-08-14T00:00:00.000Z',
      },
      files: [{ path: 'a.ts', status: 'M', added: 2, deleted: 1 }],
      insertions: 2,
      deletions: 1,
    })
    ;(window as unknown as {
      tabtin: { git: { listCommits: typeof listCommits; getCommitDetail: typeof getCommitDetail } }
    }).tabtin = {
      git: { listCommits, getCommitDetail },
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('shows the current branch history as a plain list, then opens commit diff', async () => {
    listCommits.mockResolvedValue({
      success: true,
      commits: [{
        hash: 'aaa111',
        shortHash: 'aaa1111',
        subject: 'Show branch history',
        authorName: 'Yang',
        authoredAt: '2026-08-14T00:00:00.000Z',
      }, {
        hash: 'bbb222',
        shortHash: 'bbb2222',
        subject: 'Previous commit',
        authorName: 'Lin',
        authoredAt: '2026-08-13T00:00:00.000Z',
      }],
    })
    render(<GitHistoryPane rootPath="/repo" />)

    await waitFor(() => {
      expect(screen.getByTestId('git-history-list')).toBeTruthy()
    })
    expect(listCommits).toHaveBeenCalledWith('/repo')
    expect(screen.getByText('Show branch history')).toBeTruthy()
    const historyItems = screen.getAllByTestId('git-history-item')
    const historyItem = historyItems[0]
    expect(historyItem.getAttribute('aria-label')).toContain('Show branch history')
    expect(historyItem.querySelector('svg')).toBeNull()
    const markers = screen.getAllByTestId('git-history-linear-marker')
    expect(markers).toHaveLength(2)
    expect(markers[0].getAttribute('data-connects-previous')).toBe('false')
    expect(markers[0].getAttribute('data-connects-next')).toBe('true')
    expect(markers[1].getAttribute('data-connects-previous')).toBe('true')
    expect(markers[1].getAttribute('data-connects-next')).toBe('false')
    expect(screen.queryByTestId('mock-continuous-diff')).toBeNull()

    fireEvent.click(historyItem)
    await waitFor(() => {
      expect(screen.getByTestId('mock-continuous-diff')).toBeTruthy()
    })
    expect(screen.getByTestId('mock-continuous-diff').getAttribute('data-commit-hash')).toBe('aaa111')
    expect(screen.getByTestId('mock-changes-tree')).toBeTruthy()
    expect(screen.getByTestId('git-history-list')).toBeTruthy()

    fireEvent.click(screen.getAllByTestId('git-history-item')[0])
    expect(screen.getByTestId('git-history-list')).toBeTruthy()
    expect(screen.queryByTestId('mock-continuous-diff')).toBeNull()
  })

  it('shows labeled commit details after one second and stays put until a large move', async () => {
    render(<GitHistoryPane rootPath="/repo" />)
    await waitFor(() => {
      expect(screen.getByTestId('git-history-item')).toBeTruthy()
    })

    vi.useFakeTimers()
    const item = screen.getByTestId('git-history-item')
    fireEvent.mouseEnter(item, { clientX: 80, clientY: 40 })
    fireEvent.mouseMove(item, { clientX: 88, clientY: 46 })
    expect(screen.queryByTestId('git-history-hover-tip')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    const tip = screen.getByTestId('git-history-hover-tip')
    expect(tip.textContent).toContain('gitHistory.tipMessage')
    expect(tip.textContent).toContain('Show branch history')
    expect(tip.textContent).toContain('gitHistory.tipAuthor')
    expect(tip.textContent).toContain('Yang')
    expect(tip.textContent).toContain('gitHistory.tipTime')
    expect(tip.textContent).toContain('gitHistory.tipHash')
    expect(tip.textContent).toContain('aaa1111')
    expect(tip.textContent).not.toContain('gitHistory.tipRefs')
    expect(tip.style.left).toBe('92px')
    expect(tip.style.top).toBe('56px')

    fireEvent.mouseMove(item, { clientX: 96, clientY: 48 })
    expect(screen.getByTestId('git-history-hover-tip').style.left).toBe('92px')
    expect(screen.getByTestId('git-history-hover-tip').style.top).toBe('56px')

    fireEvent.mouseMove(item, { clientX: 160, clientY: 120 })
    expect(screen.queryByTestId('git-history-hover-tip')).toBeNull()
  })

  it('clears the previous commit detail while the next commit is loading', async () => {
    let resolveSecondDetail: ((value: unknown) => void) | undefined
    const firstDetail = {
      success: true,
      commit: {
        hash: 'aaa111',
        shortHash: 'aaa1111',
        subject: 'Add history graph',
        authorName: 'Yang',
        authoredAt: '2026-08-14T00:00:00.000Z',
      },
      files: [{ path: 'a.ts', status: 'M', added: 2, deleted: 1 }],
      insertions: 2,
      deletions: 1,
    }
    listCommits.mockResolvedValue({
      success: true,
      headHash: 'aaa111',
      commits: [{
        hash: 'aaa111',
        shortHash: 'aaa1111',
        subject: 'Add history graph',
        authorName: 'Yang',
        authoredAt: '2026-08-14T00:00:00.000Z',
        parents: ['bbb222'],
        refs: [{ kind: 'head', name: 'HEAD' }],
      }, {
        hash: 'bbb222',
        shortHash: 'bbb2222',
        subject: 'Previous commit',
        authorName: 'Lin',
        authoredAt: '2026-08-13T00:00:00.000Z',
        parents: [],
        refs: [],
      }],
    })
    getCommitDetail.mockImplementation((
      _rootPath: string,
      { commitHash }: { commitHash: string },
    ) => {
      if (commitHash === 'aaa111') {
        return Promise.resolve(firstDetail)
      }
      return new Promise((resolve) => {
        resolveSecondDetail = resolve
      })
    })

    render(<GitHistoryPane rootPath="/repo" />)
    await waitFor(() => {
      expect(screen.getAllByTestId('git-history-item')).toHaveLength(2)
    })

    const items = screen.getAllByTestId('git-history-item')
    fireEvent.click(items[0])
    await waitFor(() => {
      expect(screen.getByTestId('mock-continuous-diff')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /Previous commit/ }))
    await waitFor(() => {
      expect(screen.queryByTestId('mock-continuous-diff')).toBeNull()
      expect(screen.getByText('gitHistory.loadingDetail')).toBeTruthy()
    })

    act(() => {
      resolveSecondDetail?.({
        success: true,
        commit: {
          hash: 'bbb222',
          shortHash: 'bbb2222',
          subject: 'Previous commit',
          authorName: 'Lin',
          authoredAt: '2026-08-13T00:00:00.000Z',
        },
        files: [{ path: 'b.ts', status: 'M', added: 1, deleted: 0 }],
        insertions: 1,
        deletions: 0,
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('mock-continuous-diff').getAttribute('data-commit-hash')).toBe('bbb222')
    })
  })
})
