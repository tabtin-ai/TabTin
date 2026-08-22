import { describe, expect, it } from 'vitest'
import { filterPreviewByExcludedKeys } from '../filterPreviewByExcludedKeys'

describe('filterPreviewByExcludedKeys', () => {
  const preview = {
    tables: [
      { app_token: 'app', table_id: 'a', name: 'A', selected: true },
      { app_token: 'app', table_id: 'b', name: 'B', auto_included: true },
      { app_token: 'app', table_id: 'c', name: 'C', selected: true },
    ],
    edges: [
      {
        app_token: 'app',
        from_table_id: 'a',
        from_table_name: 'A',
        field_name: '客户',
        to_table_id: 'b',
        to_table_name: 'B',
      },
      {
        app_token: 'app',
        from_table_id: 'c',
        from_table_name: 'C',
        field_name: '订单',
        to_table_id: 'a',
        to_table_name: 'A',
      },
    ],
    warnings: ['x'],
  }

  it('removes excluded tables and edges that touch them', () => {
    const next = filterPreviewByExcludedKeys(preview, new Set(['app:b']))
    expect(next.tables.map((row) => row.table_id)).toEqual(['a', 'c'])
    expect(next.edges).toHaveLength(1)
    expect(next.edges[0]?.from_table_id).toBe('c')
    expect(next.warnings).toEqual(['x'])
  })

  it('returns same reference when nothing excluded', () => {
    expect(filterPreviewByExcludedKeys(preview, new Set())).toBe(preview)
  })
})
