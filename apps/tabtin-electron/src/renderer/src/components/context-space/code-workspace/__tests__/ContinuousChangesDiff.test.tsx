import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeFile } from '@components/tabcode/components/git-workflow/useGitWorkflowData'
import {
  CHANGES_INITIAL_EXPANDED_BATCH,
  CHANGES_MAX_ACTIVE_STATIC_BLOCKS,
  CHANGES_SOFT_FILE_THRESHOLD,
  ContinuousChangesDiff,
} from '../ContinuousChangesDiff'

vi.mock('../StaticUnifiedFileDiff', () => ({
  StaticUnifiedFileDiff: function MockStaticDiff({
    filePath,
    relativePath,
    contentRevision,
    highlightRowId,
    diffMode,
    commitHash,
    leftText,
    rightText,
    onDiffReady,
  }: {
    filePath: string
    relativePath: string
    contentRevision?: number
    highlightRowId?: string | null
    diffMode?: string
    commitHash?: string
    leftText?: string
    rightText?: string
    onDiffReady?: (info: { hasChanges: boolean; insertions: number; deletions: number }) => void
  }) {
    const onDiffReadyRef = React.useRef(onDiffReady)
    onDiffReadyRef.current = onDiffReady
    React.useEffect(() => {
      diffMountCounts.set(filePath, (diffMountCounts.get(filePath) ?? 0) + 1)
      return () => {
        diffDisposeCounts.set(filePath, (diffDisposeCounts.get(filePath) ?? 0) + 1)
      }
    }, [filePath])
    React.useEffect(() => {
      onDiffReadyRef.current?.({
        hasChanges: diffReadyByPath.get(filePath) ?? true,
        insertions: 1,
        deletions: 0,
      })
    }, [filePath, contentRevision])
    return (
      <div
        data-testid="mock-static-diff-view"
        data-highlight-row={highlightRowId || ''}
        data-diff-mode={diffMode || 'head'}
        data-commit-hash={commitHash || ''}
        data-left={leftText ?? ''}
        data-right={rightText ?? ''}
      >
        {filePath}
        <span data-testid="mock-relative-path">{relativePath}</span>
      </div>
    )
  },
}))

const diffMountCounts = new Map<string, number>()
const diffDisposeCounts = new Map<string, number>()
const diffReadyByPath = new Map<string, boolean>()
let observerInstances: Array<{
  callback: IntersectionObserverCallback
  targets: Element[]
}> = []

function makeFiles(count: number): ChangeFile[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `f${index}.ts`,
    status: 'M',
    staged: false,
    unstaged: true,
    partiallyStaged: false,
    added: 1,
    deleted: 0,
    untracked: false,
    conflict: false,
  }))
}

function revisionsFor(count: number): Record<string, number> {
  const map: Record<string, number> = {}
  for (let i = 0; i < count; i += 1) map[`f${i}.ts`] = 1
  return map
}

describe('ContinuousChangesDiff', () => {
  beforeEach(() => {
    diffMountCounts.clear()
    diffDisposeCounts.clear()
    diffReadyByPath.clear()
    observerInstances = []
    Element.prototype.scrollIntoView = vi.fn()
    class MockIntersectionObserver {
      callback: IntersectionObserverCallback
      targets: Element[] = []
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback
        observerInstances.push(this)
      }
      observe(target: Element) {
        this.targets.push(target)
        const path = (target as HTMLElement).dataset.path
        // 默认激活前若干个相交，验证活跃上限会截断
        if (path && /^f([0-9]|1[0-5])\.ts$/.test(path)) {
          this.callback(
            [{ isIntersecting: true, target } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          )
        }
      }
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
      root = null
      rootMargin = ''
      thresholds = []
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('bootstrapping 时空列表显示骨架而非工作区干净', () => {
    render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={[]}
        selectedRelativePath={null}
        contentRevisions={{}}
        isBootstrapping
      />,
    )
    expect(screen.getByTestId('continuous-changes-bootstrapping')).toBeTruthy()
    expect(screen.queryByText(/工作区干净/)).toBeNull()
  })

  it('内容版本未就绪时不挂载 Diff，只显示段内加载占位', () => {
    render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={makeFiles(3)}
        selectedRelativePath={null}
        contentRevisions={{}}
      />,
    )
    expect(screen.queryAllByTestId('mock-static-diff-view')).toHaveLength(0)
    expect(screen.getAllByTestId('continuous-diff-placeholder').length).toBeGreaterThan(0)
  })

  it('仅给视口附近且受活跃上限约束的展开段挂载静态 Diff', async () => {
    render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={makeFiles(16)}
        selectedRelativePath={null}
        contentRevisions={revisionsFor(16)}
      />,
    )

    await waitFor(() => {
      expect(screen.getAllByTestId('mock-static-diff-view').length).toBe(CHANGES_MAX_ACTIVE_STATIC_BLOCKS)
    })
    expect(screen.getAllByTestId('continuous-diff-placeholder').length).toBe(
      16 - CHANGES_MAX_ACTIVE_STATIC_BLOCKS,
    )
  })

  it('右树选中隐藏段时先激活再挂载', async () => {
    render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={makeFiles(5)}
        selectedRelativePath="f4.ts"
        contentRevisions={revisionsFor(5)}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('/repo/f4.ts')).toBeTruthy()
    })
  })

  it('搜索命中时展开并挂载目标文件', async () => {
    render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={makeFiles(8)}
        selectedRelativePath={null}
        contentRevisions={revisionsFor(8)}
        searchHit={{ path: 'f7.ts', rowId: 'h0-r1-new2', requestId: 1 }}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('/repo/f7.ts')).toBeTruthy()
    })
    const hit = screen.getByText('/repo/f7.ts').closest('[data-testid="mock-static-diff-view"]')
    expect(hit?.getAttribute('data-highlight-row')).toBe('h0-r1-new2')
  })

  it('定位后的选中段保持活跃，普通段离开视口在滞后后才卸载', async () => {
    render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={makeFiles(8)}
        selectedRelativePath="f4.ts"
        contentRevisions={revisionsFor(8)}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('/repo/f4.ts')).toBeTruthy()
    })
    const observer = observerInstances[0]
    expect(observer).toBeTruthy()
    const f0 = screen.getByText('/repo/f0.ts').closest('[data-testid="continuous-diff-section"]')
    const f4 = screen.getByText('/repo/f4.ts').closest('[data-testid="continuous-diff-section"]')
    expect(f0).toBeTruthy()
    expect(f4).toBeTruthy()

    act(() => {
      observer.callback(
        [{ isIntersecting: false, target: f0! } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      )
    })
    expect(f0?.getAttribute('data-active')).toBe('true')
    expect(f4?.getAttribute('data-active')).toBe('true')

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 550))
    })
    expect(f0?.getAttribute('data-active')).toBe('false')
    expect(f4?.getAttribute('data-active')).toBe('true')
    expect(diffMountCounts.get('/repo/f4.ts')).toBe(1)
    expect(diffDisposeCounts.get('/repo/f4.ts') ?? 0).toBe(0)
  })

  it('连续 contentRevision 更新不重挂载同一路径的 Diff 段', async () => {
    const files = makeFiles(3)
    const { rerender } = render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={files}
        selectedRelativePath="f0.ts"
        contentRevisions={revisionsFor(3)}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('/repo/f0.ts')).toBeTruthy()
    })
    expect(diffMountCounts.get('/repo/f0.ts')).toBe(1)

    rerender(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={files}
        selectedRelativePath="f0.ts"
        contentRevisions={{ ...revisionsFor(3), 'f0.ts': 2 }}
      />,
    )

    expect(screen.getByText('/repo/f0.ts')).toBeTruthy()
    expect(diffMountCounts.get('/repo/f0.ts')).toBe(1)
    expect(diffDisposeCounts.get('/repo/f0.ts') ?? 0).toBe(0)
  })

  it('隐藏文件内容修订后重新参与 Diff 展示', async () => {
    diffReadyByPath.set('/repo/f0.ts', false)
    const files = makeFiles(3)
    const { rerender } = render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={files}
        selectedRelativePath="f1.ts"
        contentRevisions={revisionsFor(3)}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('/repo/f0.ts')).toBeNull()
    })

    diffReadyByPath.set('/repo/f0.ts', true)
    rerender(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={files}
        selectedRelativePath="f1.ts"
        contentRevisions={{ ...revisionsFor(3), 'f0.ts': 2 }}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('/repo/f0.ts')).toBeTruthy()
    })
  })

  it('rootPath 切换且文件集合不变时重新观察既有节点', async () => {
    const files = makeFiles(3)
    const { rerender } = render(
      <ContinuousChangesDiff
        rootPath="/repo-a"
        files={files}
        selectedRelativePath={null}
        contentRevisions={revisionsFor(3)}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('/repo-a/f0.ts')).toBeTruthy()
    })
    const firstObserverCount = observerInstances.length

    rerender(
      <ContinuousChangesDiff
        rootPath="/repo-b"
        files={files}
        selectedRelativePath={null}
        contentRevisions={revisionsFor(3)}
      />,
    )

    await waitFor(() => {
      expect(observerInstances.length).toBe(firstObserverCount + 1)
    })
    expect(observerInstances.at(-1)?.targets.length).toBeGreaterThan(0)
  })

  it('超过软阈值时展示继续加载入口', () => {
    const count = CHANGES_SOFT_FILE_THRESHOLD + 5
    render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={makeFiles(count)}
        selectedRelativePath={null}
        contentRevisions={revisionsFor(count)}
      />,
    )

    const button = screen.getByTestId('continuous-diff-load-more')
    expect(button).toBeTruthy()
    const remainingBefore = count - CHANGES_INITIAL_EXPANDED_BATCH
    fireEvent.click(button)
    const remainingAfter = count - CHANGES_INITIAL_EXPANDED_BATCH * 2
    if (remainingAfter > 0) {
      expect(screen.getByTestId('continuous-diff-load-more')).toBeTruthy()
    } else {
      expect(screen.queryByTestId('continuous-diff-load-more')).toBeNull()
    }
    expect(remainingBefore).toBeGreaterThan(remainingAfter)
  })

  it('commit 模式把 diffMode 与 commitHash 传给静态 Diff', async () => {
    render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={makeFiles(2)}
        selectedRelativePath="f0.ts"
        contentRevisions={revisionsFor(2)}
        diffMode="commit"
        commitHash="abcdef12"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('/repo/f0.ts')).toBeTruthy()
    })
    const node = screen.getByText('/repo/f0.ts').closest('[data-testid="mock-static-diff-view"]')
    expect(node?.getAttribute('data-diff-mode')).toBe('commit')
    expect(node?.getAttribute('data-commit-hash')).toBe('abcdef12')
  })

  it('选中无可展示 Diff 的文件时提示带路径，并建议改选首个可见文件', async () => {
    diffReadyByPath.set('/repo/f0.ts', false)
    const onPreferVisibleSelection = vi.fn()
    render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={makeFiles(3)}
        selectedRelativePath="f0.ts"
        contentRevisions={revisionsFor(3)}
        onPreferVisibleSelection={onPreferVisibleSelection}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('continuous-selected-no-line-diff')).toBeTruthy()
    })
    expect(
      screen.getByTestId('continuous-selected-no-line-diff').getAttribute('data-file'),
    ).toBe('f0.ts')
    expect(screen.queryByText('/repo/f0.ts')).toBeNull()
    expect(screen.getByText('/repo/f1.ts')).toBeTruthy()
    await waitFor(() => {
      expect(onPreferVisibleSelection).toHaveBeenCalledWith('f1.ts')
    })
  })

  it('隐藏文件内容修订后提示消失并恢复展示', async () => {
    diffReadyByPath.set('/repo/f0.ts', false)
    const files = makeFiles(3)
    const { rerender } = render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={files}
        selectedRelativePath="f0.ts"
        contentRevisions={revisionsFor(3)}
      />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('continuous-selected-no-line-diff')).toBeTruthy()
    })

    diffReadyByPath.set('/repo/f0.ts', true)
    rerender(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={files}
        selectedRelativePath="f0.ts"
        contentRevisions={{ ...revisionsFor(3), 'f0.ts': 2 }}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByTestId('continuous-selected-no-line-diff')).toBeNull()
      expect(screen.getByText('/repo/f0.ts')).toBeTruthy()
    })
  })

  it('frozen texts mount without waiting for git contentRevision', async () => {
    render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={makeFiles(1)}
        selectedRelativePath="f0.ts"
        contentRevisions={{}}
        frozenTextsByPath={{ 'f0.ts': { leftText: 'one', rightText: 'three' } }}
      />,
    )
    await waitFor(() => {
      const view = screen.getByTestId('mock-static-diff-view')
      expect(view.getAttribute('data-left')).toBe('one')
      expect(view.getAttribute('data-right')).toBe('three')
    })
  })

  it('unreadable paths show restore-failed copy instead of a diff', () => {
    render(
      <ContinuousChangesDiff
        rootPath="/repo"
        files={makeFiles(1)}
        selectedRelativePath="f0.ts"
        contentRevisions={{}}
        unreadablePaths={new Set(['f0.ts'])}
      />,
    )
    expect(screen.getByTestId('continuous-diff-unreadable')).toBeTruthy()
    expect(screen.queryByTestId('mock-static-diff-view')).toBeNull()
  })
})
