import { describe, expect, it } from 'vitest'
import {
  isEmptyDiffBaseline,
  summarizeMonacoLineChanges,
} from '../tabCodeDiffStats'

describe('isEmptyDiffBaseline', () => {
  it('仅精确空串为空基线', () => {
    expect(isEmptyDiffBaseline('')).toBe(true)
    expect(isEmptyDiffBaseline('\n')).toBe(false)
    expect(isEmptyDiffBaseline(' ')).toBe(false)
    expect(isEmptyDiffBaseline(null)).toBe(false)
  })
})

describe('summarizeMonacoLineChanges', () => {
  it('新文件（空 original）：忽略 Monaco 合成空删除，deletions 为 0', () => {
    const modified = 'line1\nline2\n'
    // Monaco 典型假删：先删 original 第 1 行空行，再插入全文
    const monacoPhantom = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 2,
      },
    ]
    const stats = summarizeMonacoLineChanges(monacoPhantom, '', modified)
    expect(stats.deletions).toBe(0)
    expect(stats.insertions).toBe(2)
    expect(stats.hasChanges).toBe(true)
  })

  it('新文件无尾换行时按行数计插入', () => {
    const stats = summarizeMonacoLineChanges(
      [{
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 3,
      }],
      '',
      'a\nb\nc',
    )
    expect(stats).toEqual({ insertions: 3, deletions: 0, hasChanges: true })
  })

  it('删除文件（空 modified）：忽略合成空插入', () => {
    const stats = summarizeMonacoLineChanges(
      [{
        originalStartLineNumber: 1,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 0,
      }],
      'gone\nline\n',
      '',
    )
    expect(stats.insertions).toBe(0)
    expect(stats.deletions).toBe(2)
    expect(stats.hasChanges).toBe(true)
  })

  it('已跟踪文件真实空行删除不被特判吞掉', () => {
    // original 是单换行（真实内容），不是空基线
    const stats = summarizeMonacoLineChanges(
      [{
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 2,
      }],
      '\n',
      'first\nsecond\n',
    )
    expect(stats.deletions).toBe(1)
    expect(stats.insertions).toBe(2)
  })

  it('普通修改沿用 Monaco 行变更计数', () => {
    const stats = summarizeMonacoLineChanges(
      [{
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 3,
      }],
      'a\nold\nc\n',
      'a\nnew1\nnew2\nc\n',
    )
    expect(stats).toEqual({ insertions: 2, deletions: 1, hasChanges: true })
  })

  it('两侧皆空无变更', () => {
    expect(summarizeMonacoLineChanges([], '', '')).toEqual({
      insertions: 0,
      deletions: 0,
      hasChanges: false,
    })
  })
})
