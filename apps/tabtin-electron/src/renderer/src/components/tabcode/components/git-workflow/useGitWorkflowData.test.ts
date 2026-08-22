import { describe, expect, it } from 'vitest'
import {
  buildChangeFiles,
  isConflictEntry,
  partitionChangeFiles,
} from './useGitWorkflowData'

const emptyStat = new Map<string, { added: number; deleted: number }>()

describe('isConflictEntry', () => {
  it('识别 UU / AU / AA / DD 为冲突', () => {
    expect(isConflictEntry('U', 'U')).toBe(true)
    expect(isConflictEntry('A', 'U')).toBe(true)
    expect(isConflictEntry('U', 'D')).toBe(true)
    expect(isConflictEntry('A', 'A')).toBe(true)
    expect(isConflictEntry('D', 'D')).toBe(true)
  })

  it('普通修改与未跟踪不是冲突', () => {
    expect(isConflictEntry('M', '')).toBe(false)
    expect(isConflictEntry('', 'M')).toBe(false)
    expect(isConflictEntry('M', 'M')).toBe(false)
    expect(isConflictEntry('?', '?')).toBe(false)
  })
})

describe('buildChangeFiles + partitionChangeFiles', () => {
  it('拆分 staged / unstaged / untracked / partially staged / conflict', () => {
    const files = buildChangeFiles(
      {
        'a.ts': { x: 'M', y: ' ' },
        'b.ts': { x: ' ', y: 'M' },
        'c.ts': { x: 'M', y: 'M' },
        'new.ts': { x: '?', y: '?' },
        'conflict.ts': { x: 'U', y: 'U' },
        'both-added.ts': { x: 'A', y: 'A' },
      },
      emptyStat,
      emptyStat,
    )

    const byPath = Object.fromEntries(files.map((file) => [file.path, file]))
    expect(byPath['a.ts']).toMatchObject({
      staged: true,
      unstaged: false,
      conflict: false,
      partiallyStaged: false,
    })
    expect(byPath['b.ts']).toMatchObject({
      staged: false,
      unstaged: true,
      conflict: false,
    })
    expect(byPath['c.ts']).toMatchObject({
      staged: true,
      unstaged: true,
      partiallyStaged: true,
      conflict: false,
    })
    expect(byPath['new.ts']).toMatchObject({
      untracked: true,
      staged: false,
      unstaged: true,
      conflict: false,
      status: '?',
    })
    expect(byPath['conflict.ts']).toMatchObject({
      conflict: true,
      staged: false,
      unstaged: false,
      status: 'U',
    })
    expect(byPath['both-added.ts']).toMatchObject({
      conflict: true,
      staged: false,
      unstaged: false,
      status: 'U',
    })

    const sections = partitionChangeFiles(files)
    expect(sections.conflicts.map((f) => f.path)).toEqual([
      'both-added.ts',
      'conflict.ts',
    ])
    expect(sections.staged.map((f) => f.path)).toEqual(['a.ts', 'c.ts'])
    expect(sections.unstaged.map((f) => f.path)).toEqual([
      'b.ts',
      'c.ts',
      'new.ts',
    ])
  })

  it('冲突区置顶语义：partition 顺序为 conflicts → staged → unstaged', () => {
    const files = buildChangeFiles(
      {
        'z-staged.ts': { x: 'M', y: ' ' },
        'a-conflict.ts': { x: 'U', y: 'U' },
        'm-unstaged.ts': { x: ' ', y: 'M' },
      },
      emptyStat,
      emptyStat,
    )
    const sections = partitionChangeFiles(files)
    expect(sections.conflicts[0]?.path).toBe('a-conflict.ts')
    expect(sections.staged[0]?.path).toBe('z-staged.ts')
    expect(sections.unstaged[0]?.path).toBe('m-unstaged.ts')
  })
})
