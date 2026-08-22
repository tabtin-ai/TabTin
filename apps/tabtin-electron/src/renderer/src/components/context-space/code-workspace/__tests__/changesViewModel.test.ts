import { describe, expect, it } from 'vitest'
import type { ChangeFile } from '@components/tabcode/components/git-workflow/useGitWorkflowData'
import {
  aggregateUncommittedTotals,
  buildCommitContentRevisions,
  collectAgentFrozenDiffs,
  filterFilesForChangesView,
  joinRootPath,
  mapCommitFilesToChangeFiles,
  mapEditorTurnFinalsToChangeFiles,
  normalizeLiveView,
  resolveNavigationAnchor,
} from '../changesViewModel'

function file(partial: Partial<ChangeFile> & { path: string }): ChangeFile {
  return {
    path: partial.path,
    status: partial.status ?? 'M',
    staged: partial.staged ?? false,
    unstaged: partial.unstaged ?? false,
    partiallyStaged: partial.partiallyStaged ?? false,
    untracked: partial.untracked ?? false,
    conflict: partial.conflict ?? false,
    added: partial.added ?? 1,
    deleted: partial.deleted ?? 0,
  }
}

describe('changesViewModel', () => {
  it('joins root and relative paths with the host separator', () => {
    expect(joinRootPath('/repo/', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(joinRootPath('C:\\repo\\', 'src\\a.ts')).toBe('C:\\repo\\src\\a.ts')
  })

  it('normalizes staged/unstaged entry points into uncommitted', () => {
    expect(normalizeLiveView('staged')).toBe('uncommitted')
    expect(normalizeLiveView('unstaged')).toBe('uncommitted')
    expect(normalizeLiveView('agent')).toBe('agent')
  })

  it('keeps the full uncommitted file list for live review', () => {
    const files = [
      file({ path: 'a.ts', staged: true, added: 2, deleted: 1 }),
      file({ path: 'b.ts', unstaged: true, added: 3, deleted: 0 }),
      file({ path: 'c.ts', untracked: true, added: 0, deleted: 0 }),
    ]
    expect(filterFilesForChangesView(files, 'uncommitted')).toHaveLength(3)
    expect(filterFilesForChangesView(files, 'staged')).toHaveLength(3)
    expect(filterFilesForChangesView(files, 'agent')).toEqual([])
  })

  it('aggregates uncommitted added/deleted totals', () => {
    const files = [
      file({ path: 'a.ts', added: 2, deleted: 1 }),
      file({ path: 'b.ts', added: 5, deleted: 4 }),
    ]
    expect(aggregateUncommittedTotals(files)).toEqual({
      fileCount: 2,
      added: 7,
      deleted: 5,
    })
  })

  it('keeps navigation when file still exists, otherwise picks first', () => {
    const files = [file({ path: 'still.ts' }), file({ path: 'next.ts' })]
    expect(resolveNavigationAnchor(files, 'still.ts')).toBe('still.ts')
    expect(resolveNavigationAnchor(files, 'gone.ts')).toBe('still.ts')
    expect(resolveNavigationAnchor([], 'still.ts')).toBeNull()
  })

  it('maps commit file summaries to read-only ChangeFile rows', () => {
    const mapped = mapCommitFilesToChangeFiles([
      { path: 'a.ts', status: 'M', added: 2, deleted: 1 },
      { path: 'b.ts', status: 'A', added: 5, deleted: 0 },
    ])
    expect(mapped).toHaveLength(2)
    expect(mapped[0]).toMatchObject({
      path: 'a.ts',
      status: 'M',
      added: 2,
      deleted: 1,
      staged: false,
      unstaged: false,
      untracked: false,
      conflict: false,
    })
    expect(mapped[1].status).toBe('A')
    expect(mapCommitFilesToChangeFiles([])).toEqual([])
    expect(mapCommitFilesToChangeFiles(null)).toEqual([])
  })

  it('builds stable content revisions bound to commit hash', () => {
    const files = [file({ path: 'a.ts' }), file({ path: 'b.ts' })]
    const a = buildCommitContentRevisions(files, 'abc123')
    const b = buildCommitContentRevisions(files, 'abc123')
    const c = buildCommitContentRevisions(files, 'def456')
    expect(a).toEqual(b)
    expect(a['a.ts']).toBe(a['b.ts'])
    expect(a['a.ts']).not.toBe(c['a.ts'])
  })

  it('maps folded editor finals to read-only ChangeFile rows', () => {
    const mapped = mapEditorTurnFinalsToChangeFiles([
      {
        relativePath: 'a.ts',
        status: 'modified',
        displayable: true,
        insertions: 2,
        deletions: 1,
        opCount: 2,
      },
      {
        relativePath: 'new.ts',
        status: 'added',
        displayable: true,
        insertions: 4,
        deletions: 0,
        opCount: 1,
      },
    ])
    expect(mapped[0]).toMatchObject({
      path: 'a.ts',
      status: 'M',
      added: 2,
      deleted: 1,
      staged: false,
      untracked: false,
    })
    expect(mapped[1]).toMatchObject({
      path: 'new.ts',
      status: 'A',
      untracked: true,
    })
  })

  it('collects frozen texts and unreadable paths for Agent review', () => {
    const collected = collectAgentFrozenDiffs([
      {
        relativePath: 'ok.ts',
        status: 'modified',
        before: 'a',
        after: 'b',
        displayable: true,
        insertions: 1,
        deletions: 1,
        opCount: 1,
      },
      {
        relativePath: 'bad.bin',
        status: 'unreadable',
        displayable: false,
        insertions: 0,
        deletions: 0,
        opCount: 1,
        binary: true,
      },
    ])
    expect(collected.frozenTextsByPath).toEqual({
      'ok.ts': { leftText: 'a', rightText: 'b' },
    })
    expect([...collected.unreadablePaths]).toEqual(['bad.bin'])
    expect(collected.contentRevisions['ok.ts']).toBe(1)
    expect(collected.contentRevisions['bad.bin']).toBe(1)
  })
})
