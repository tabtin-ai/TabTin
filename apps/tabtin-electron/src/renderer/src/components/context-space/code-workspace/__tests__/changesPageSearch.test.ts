import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeFile } from '@components/tabcode/components/git-workflow/useGitWorkflowData'
import {
  buildChangesSearchIndex,
  matchStaticDiffRows,
  stepSearchHitIndex,
} from '../changesPageSearch'
import { buildStaticUnifiedDiffViewModel, getSearchableStaticDiffRows } from '../staticUnifiedDiffModel'

const loadDiffContents = vi.fn()

vi.mock('@components/tabcode/components/diffContentCache', () => ({
  loadDiffContents: (...args: unknown[]) => loadDiffContents(...args),
}))

function file(path: string): ChangeFile {
  return {
    path,
    status: 'M',
    staged: false,
    unstaged: true,
    partiallyStaged: false,
    added: 1,
    deleted: 1,
    untracked: false,
    conflict: false,
  }
}

describe('changesPageSearch', () => {
  beforeEach(() => {
    loadDiffContents.mockReset()
  })

  it('matchStaticDiffRows finds case-insensitive substring hits in order', () => {
    const model = buildStaticUnifiedDiffViewModel(
      'alpha\nkeep\n',
      'AlphaFoo\nkeep\n',
      { context: 1 },
    )
    const hits = matchStaticDiffRows(
      'a.ts',
      getSearchableStaticDiffRows(model),
      'alpha',
    )
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].path).toBe('a.ts')
    expect(hits.every((hit) => hit.text.toLowerCase().includes('alpha'))).toBe(true)
  })

  it('buildChangesSearchIndex walks files in order and skips missing revisions', async () => {
    loadDiffContents.mockImplementation(async ({ filePath }: { filePath: string }) => {
      if (filePath.endsWith('a.ts')) {
        return { left: 'old-a\n', right: 'needle-a\n' }
      }
      return { left: 'old-b\n', right: 'needle-b\n' }
    })

    const result = await buildChangesSearchIndex({
      rootPath: '/repo',
      files: [file('a.ts'), file('b.ts'), file('c.ts')],
      contentRevisions: { 'a.ts': 1, 'b.ts': 2 },
      query: 'needle',
      generation: 3,
    })

    expect(result.status).toBe('ready')
    expect(result.generation).toBe(3)
    expect(result.skippedFileCount).toBe(1)
    expect(result.hits.map((hit) => hit.path)).toEqual(['a.ts', 'b.ts'])
    expect(loadDiffContents).toHaveBeenCalledTimes(2)
  })

  it('buildChangesSearchIndex counts load failures as error files', async () => {
    loadDiffContents.mockRejectedValueOnce(new Error('boom'))
    const result = await buildChangesSearchIndex({
      rootPath: '/repo',
      files: [file('a.ts')],
      contentRevisions: { 'a.ts': 1 },
      query: 'x',
      generation: 1,
    })
    expect(result.errorFileCount).toBe(1)
    expect(result.hits).toEqual([])
  })

  it('buildChangesSearchIndex returns empty-query without reading files', async () => {
    const result = await buildChangesSearchIndex({
      rootPath: '/repo',
      files: [file('a.ts')],
      contentRevisions: { 'a.ts': 1 },
      query: '   ',
      generation: 1,
    })
    expect(result.status).toBe('empty-query')
    expect(loadDiffContents).not.toHaveBeenCalled()
  })

  it('stepSearchHitIndex wraps around', () => {
    expect(stepSearchHitIndex(-1, 3, 1)).toBe(0)
    expect(stepSearchHitIndex(2, 3, 1)).toBe(0)
    expect(stepSearchHitIndex(0, 3, -1)).toBe(2)
    expect(stepSearchHitIndex(0, 0, 1)).toBe(-1)
  })

  it('cancelling mid-index stops further reads', async () => {
    const signal = { cancelled: false }
    loadDiffContents.mockImplementation(async () => {
      signal.cancelled = true
      return { left: 'a\n', right: 'b\n' }
    })
    const result = await buildChangesSearchIndex({
      rootPath: '/repo',
      files: [file('a.ts'), file('b.ts')],
      contentRevisions: { 'a.ts': 1, 'b.ts': 1 },
      query: 'b',
      generation: 9,
      signal,
    })
    expect(result.status).toBe('indexing')
    expect(loadDiffContents).toHaveBeenCalledTimes(1)
  })
})
