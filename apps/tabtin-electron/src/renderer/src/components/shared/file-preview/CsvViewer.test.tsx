import { describe, expect, it } from 'vitest'
import { parseCsvPreview } from './CsvViewer'

describe('parseCsvPreview', () => {
  it('parses quoted commas and multiline quoted fields into rows and columns', () => {
    const parsed = parseCsvPreview('name,note\nAlice,"hello, world"\nBob,"line 1\nline 2"')

    expect(parsed.headers).toEqual(['name', 'note'])
    expect(parsed.rows).toEqual([
      ['Alice', 'hello, world'],
      ['Bob', 'line 1\nline 2'],
    ])
    expect(parsed.totalRows).toBe(2)
    expect(parsed.truncated).toBe(false)
  })

  it('creates spreadsheet-like column headers when the first row is data', () => {
    const parsed = parseCsvPreview('Alice,10\nBob,20', { hasHeader: false })

    expect(parsed.headers).toEqual(['A', 'B'])
    expect(parsed.rows).toEqual([
      ['Alice', '10'],
      ['Bob', '20'],
    ])
  })

  it('caps rendered rows while reporting the full row count', () => {
    const csv = ['name', ...Array.from({ length: 4 }, (_, i) => `row-${i}`)].join('\n')
    const parsed = parseCsvPreview(csv, { maxRows: 2 })

    expect(parsed.rows).toEqual([['row-0'], ['row-1']])
    expect(parsed.totalRows).toBe(4)
    expect(parsed.truncated).toBe(true)
  })

  it('parses tab-separated values when delimiter is tab', () => {
    const parsed = parseCsvPreview('name\tnote\nAlice\thello\nBob\tworld', { delimiter: '\t' })

    expect(parsed.headers).toEqual(['name', 'note'])
    expect(parsed.rows).toEqual([
      ['Alice', 'hello'],
      ['Bob', 'world'],
    ])
  })
})
