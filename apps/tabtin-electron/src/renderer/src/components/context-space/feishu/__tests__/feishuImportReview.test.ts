import { describe, expect, it } from 'vitest'
import {
  buildPreviewWithoutRelations,
  defaultCheckedFromPreview,
  filterDegradedEdges,
  filterVisibleEdges,
  resolveFinalImportTables,
  toggleReviewTable,
  type FeishuImportPreview,
} from '../feishuImportReview'

const preview: FeishuImportPreview = {
  tables: [
    {
      app_token: 'app1',
      table_id: 'tblA',
      name: '订单',
      selected: true,
      auto_included: false,
    },
    {
      app_token: 'app1',
      table_id: 'tblB',
      name: '客户',
      selected: false,
      auto_included: true,
    },
  ],
  edges: [
    {
      app_token: 'app1',
      from_table_id: 'tblA',
      from_table_name: '订单',
      field_name: '客户',
      to_table_id: 'tblB',
      to_table_name: '客户',
      duplex: false,
      same_base: true,
    },
  ],
  warnings: [],
  has_attachments: false,
}

describe('feishuImportReview', () => {
  it('defaults to checking all preview tables', () => {
    const checked = defaultCheckedFromPreview(preview)
    expect(checked.has('app1:tblA')).toBe(true)
    expect(checked.has('app1:tblB')).toBe(true)
  })

  it('toggleReviewTable removes dependency', () => {
    const checked = defaultCheckedFromPreview(preview)
    const next = toggleReviewTable(checked, 'app1', 'tblB', false)
    expect(next.has('app1:tblB')).toBe(false)
    expect(resolveFinalImportTables(preview, next)).toEqual([
      { app_token: 'app1', table_id: 'tblA', name: '订单' },
    ])
    expect(filterVisibleEdges(preview.edges, next)).toHaveLength(0)
    expect(filterDegradedEdges(preview.edges, next)).toHaveLength(1)
  })

  it('keeps edges when both ends checked', () => {
    const checked = defaultCheckedFromPreview(preview)
    expect(filterVisibleEdges(preview.edges, checked)).toHaveLength(1)
  })

  it('buildPreviewWithoutRelations keeps only selected tables and no edges', () => {
    const result = buildPreviewWithoutRelations([
      { app_token: 'app1', table_id: 'tblA', name: '订单' },
      { app_token: 'app1', table_id: 'tblC', name: '商品' },
    ])
    expect(result.edges).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.tables).toEqual([
      {
        app_token: 'app1',
        table_id: 'tblA',
        name: '订单',
        selected: true,
        auto_included: false,
      },
      {
        app_token: 'app1',
        table_id: 'tblC',
        name: '商品',
        selected: true,
        auto_included: false,
      },
    ])
    expect(defaultCheckedFromPreview(result).size).toBe(2)
  })
})
