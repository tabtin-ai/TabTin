import { describe, expect, it } from 'vitest'
import { computeHighlightRanges, splitByHighlightRanges } from './searchHighlight'

describe('computeHighlightRanges', () => {
  it('空查询或空文本不产生高亮', () => {
    expect(computeHighlightRanges('foo.ts', '')).toEqual([])
    expect(computeHighlightRanges('foo.ts', '   ')).toEqual([])
    expect(computeHighlightRanges('', 'foo')).toEqual([])
  })

  it('大小写不敏感地高亮所有连续子串命中', () => {
    expect(computeHighlightRanges('FooBarFoo.ts', 'foo')).toEqual([
      { start: 0, end: 3 },
      { start: 6, end: 9 },
    ])
  })

  it('子串不命中时退化为贪心逐字高亮，相邻字符合并成区间', () => {
    // "fbt" 在 "file-bar.ts" 中按序命中 f / b / t
    expect(computeHighlightRanges('file-bar.ts', 'fbt')).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 6 },
      { start: 9, end: 10 },
    ])
    // 相邻命中合并："fi" 命中开头两个连续字符
    expect(computeHighlightRanges('file.ts', 'fi')).toEqual([
      { start: 0, end: 2 },
    ])
  })

  it('逐字匹配不完整时整个字段不高亮', () => {
    expect(computeHighlightRanges('file.ts', 'fz')).toEqual([])
  })

  it('fuzzy=false 时只做子串高亮，不做逐字退化', () => {
    expect(computeHighlightRanges('src/components/file.ts', 'file', { fuzzy: false })).toEqual([
      { start: 15, end: 19 },
    ])
    expect(computeHighlightRanges('src/components/file.ts', 'sft', { fuzzy: false })).toEqual([])
  })

  it('逐字匹配忽略查询里的空格', () => {
    expect(computeHighlightRanges('file-bar.ts', 'f b')).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 6 },
    ])
  })
})

describe('splitByHighlightRanges', () => {
  it('无区间时原样返回单段', () => {
    expect(splitByHighlightRanges('foo.ts', [])).toEqual([
      { text: 'foo.ts', highlighted: false },
    ])
  })

  it('按区间切成交替片段并保留首尾未命中文本', () => {
    expect(
      splitByHighlightRanges('src/file.ts', [
        { start: 4, end: 8 },
      ]),
    ).toEqual([
      { text: 'src/', highlighted: false },
      { text: 'file', highlighted: true },
      { text: '.ts', highlighted: false },
    ])
  })

  it('区间贴住文本开头和结尾时不产生空片段', () => {
    expect(
      splitByHighlightRanges('foo', [
        { start: 0, end: 3 },
      ]),
    ).toEqual([{ text: 'foo', highlighted: true }])
  })
})
