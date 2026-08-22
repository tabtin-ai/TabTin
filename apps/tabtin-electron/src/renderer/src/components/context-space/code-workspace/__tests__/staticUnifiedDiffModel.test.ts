import { describe, expect, it } from 'vitest'
import {
  buildStaticUnifiedDiffViewModel,
  getSearchableStaticDiffRows,
} from '../staticUnifiedDiffModel'

describe('buildStaticUnifiedDiffViewModel', () => {
  it('identical content has no changes', () => {
    const model = buildStaticUnifiedDiffViewModel('a\nb\n', 'a\nb\n')
    expect(model.hasChanges).toBe(false)
    expect(model.rows).toEqual([])
    expect(model.insertions).toBe(0)
    expect(model.deletions).toBe(0)
  })

  it('builds add/remove/context rows with line numbers', () => {
    const original = ['keep', 'old', 'tail'].join('\n')
    const modified = ['keep', 'new', 'tail'].join('\n')
    const model = buildStaticUnifiedDiffViewModel(original, modified, {
      filePath: 'demo.ts',
      context: 1,
    })
    expect(model.hasChanges).toBe(true)
    expect(model.insertions).toBe(1)
    expect(model.deletions).toBe(1)
    const kinds = model.rows.map((row) => row.kind)
    expect(kinds).toContain('remove')
    expect(kinds).toContain('add')
    expect(kinds).toContain('context')
    const removed = model.rows.find((row) => row.kind === 'remove')
    const added = model.rows.find((row) => row.kind === 'add')
    expect(removed?.text).toBe('old')
    expect(removed?.oldLine).toBe(2)
    expect(added?.text).toBe('new')
    expect(added?.newLine).toBe(2)
  })

  it('inserts gap markers between distant hunks', () => {
    const original = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n')
    const modified = original
      .replace('line-2', 'changed-2')
      .replace('line-35', 'changed-35')
    const model = buildStaticUnifiedDiffViewModel(original, modified, { context: 1 })
    expect(model.rows.some((row) => row.kind === 'gap')).toBe(true)
    const gap = model.rows.find((row) => row.kind === 'gap')
    expect((gap?.skippedLines ?? 0)).toBeGreaterThan(0)
  })

  it('getSearchableStaticDiffRows excludes gaps', () => {
    const original = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n')
    const modified = original
      .replace('line-2', 'changed-2')
      .replace('line-35', 'changed-35')
    const model = buildStaticUnifiedDiffViewModel(original, modified, { context: 1 })
    const searchable = getSearchableStaticDiffRows(model)
    expect(searchable.every((row) => row.kind !== 'gap')).toBe(true)
    expect(searchable.length).toBeLessThan(model.rows.length)
  })

  it('normalizes CRLF before comparing', () => {
    const model = buildStaticUnifiedDiffViewModel('a\r\nb\r\n', 'a\nb\n')
    expect(model.hasChanges).toBe(false)
  })
})
