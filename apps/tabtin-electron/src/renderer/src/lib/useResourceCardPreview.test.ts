import { describe, expect, it } from 'vitest'
import {
  normalizeFetchedTablePreview,
  resolveResourceCardAvailability,
  resolveResourceCardPreviewText,
} from './useResourceCardPreview'

describe('resolveResourceCardPreviewText', () => {
  it('prefers live preview from unified resources over stored metadata', () => {
    expect(
      resolveResourceCardPreviewText('旧摘要', '最新正文摘要'),
    ).toBe('最新正文摘要')
  })

  it('falls back to stored description when live preview is empty', () => {
    expect(
      resolveResourceCardPreviewText('发送时快照', ''),
    ).toBe('发送时快照')
  })

  it('keeps the stored description when live preview is only an empty editor shell', () => {
    expect(
      resolveResourceCardPreviewText('跨组织权限实时刷新', '<p></p>'),
    ).toBe('跨组织权限实时刷新')
  })

  it('returns undefined when both sources are empty', () => {
    expect(resolveResourceCardPreviewText('', '   ')).toBeUndefined()
  })
})

describe('normalizeFetchedTablePreview', () => {
  it('keeps columns with key+label and passes rows/total through', () => {
    expect(
      normalizeFetchedTablePreview({
        columns: [{ key: 'f1', label: '客户' }, { key: 'f2', label: '阶段' }],
        rows: [{ f1: 'Acme', f2: '跟进中' }],
        total_rows: 12,
      }),
    ).toEqual({
      columns: [{ key: 'f1', label: '客户' }, { key: 'f2', label: '阶段' }],
      rows: [{ f1: 'Acme', f2: '跟进中' }],
      total_rows: 12,
    })
  })

  it('drops columns missing key or label', () => {
    expect(
      normalizeFetchedTablePreview({
        columns: [{ key: 'f1', label: '客户' }, { label: '无 key' }, { key: 'f3' }],
        rows: [],
      }),
    ).toEqual({ columns: [{ key: 'f1', label: '客户' }], rows: [], total_rows: undefined })
  })

  it('returns undefined when no valid columns', () => {
    expect(normalizeFetchedTablePreview({ columns: [] })).toBeUndefined()
    expect(normalizeFetchedTablePreview(null)).toBeUndefined()
    expect(normalizeFetchedTablePreview(undefined)).toBeUndefined()
  })
})

describe('resolveResourceCardAvailability', () => {
  it('does not treat preview 404 as a hard deleted IM card state', () => {
    expect(resolveResourceCardAvailability({ status: 'deleted' })).toBe('unknown')
  })

  it('keeps forbidden distinct from transient preview failures', () => {
    expect(resolveResourceCardAvailability({ status: 'forbidden' })).toBe('forbidden')
    expect(resolveResourceCardAvailability({ status: 'error' })).toBe('unknown')
  })
})
