import { describe, expect, it } from 'vitest'
import {
  buildKanbanViewRecords,
  getKanbanOffsetKey,
  KANBAN_UNGROUPED_OFFSET_KEY,
} from '../kanban-view-runtime'

const statusField = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  id_hex: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  name: '状态',
  field_type: 'select' as const,
  config: {
    choices: [
      { value: 'open', label: 'Open', color: '#00f' },
      { value: 'done', label: 'Done', color: '#0f0' },
    ],
  },
}

const titleField = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  id_hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  name: '标题',
  field_type: 'text' as const,
}

const makeRecord = (values: Record<string, unknown>) =>
  new Map<string, unknown>(Object.entries(values))

const kanbanView = {
  id: 'view-kanban',
  table_id: 'table-1',
  name: '看板',
  view_type: 'kanban' as const,
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  column_meta: {},
  config: { group_by_field: statusField.id },
  is_shared: false,
  is_locked: false,
  order: 0,
  created_at: '',
}

describe('buildKanbanViewRecords', () => {
  it('groups records by select field and slices per_group_limit', () => {
    const recordsSnapshot = new Map([
      ...Array.from({ length: 3 }, (_, i) => [
        `open-${i}`,
        makeRecord({
          [titleField.id_hex]: `open-${i}`,
          [statusField.id_hex]: 'open',
          __order: i,
        }),
      ] as const),
      ['done-0', makeRecord({ [titleField.id_hex]: 'done-0', [statusField.id_hex]: 'done', __order: 10 })],
    ])

    const result = buildKanbanViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['open-0', 'open-1', 'open-2', 'done-0'],
      fieldsMeta: [titleField, statusField],
      view: kanbanView,
      perGroupLimit: 2,
    })

    const groups = result.metadata?.groups ?? []
    const openGroup = groups.find(g => g.group_value === 'open')
    const doneGroup = groups.find(g => g.group_value === 'done')

    expect(openGroup?.count).toBe(3)
    expect(openGroup?.records).toHaveLength(2)
    expect(openGroup?.has_more).toBe(true)
    expect(doneGroup?.count).toBe(1)
    expect(doneGroup?.has_more).toBe(false)
    expect(result.records).toEqual([])
    expect(result.total).toBe(4)
  })

  it('respects group_offsets for client-side load more', () => {
    const recordsSnapshot = new Map(
      Array.from({ length: 5 }, (_, i) => [
        `r${i}`,
        makeRecord({
          [titleField.id_hex]: `r${i}`,
          [statusField.id_hex]: 'open',
          __order: i,
        }),
      ]),
    )

    const firstPage = buildKanbanViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r0', 'r1', 'r2', 'r3', 'r4'],
      fieldsMeta: [titleField, statusField],
      view: kanbanView,
      perGroupLimit: 2,
    })

    const openKey = getKanbanOffsetKey('open')
    const secondPage = buildKanbanViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r0', 'r1', 'r2', 'r3', 'r4'],
      fieldsMeta: [titleField, statusField],
      view: kanbanView,
      perGroupLimit: 2,
      groupOffsets: { [openKey]: 2 },
    })

    const firstOpen = firstPage.metadata?.groups?.find(g => g.group_value === 'open')
    const secondOpen = secondPage.metadata?.groups?.find(g => g.group_value === 'open')

    expect(firstOpen?.records.map(r => r.id)).toEqual(['r0', 'r1'])
    expect(secondOpen?.records.map(r => r.id)).toEqual(['r0', 'r1', 'r2', 'r3'])
    expect(secondOpen?.offset).toBe(2)
    expect(secondOpen?.has_more).toBe(true)
  })

  it('puts unset group values into ungrouped bucket', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'no status', __order: 1 })],
      ['r2', makeRecord({ [titleField.id_hex]: 'open', [statusField.id_hex]: 'open', __order: 2 })],
    ])

    const result = buildKanbanViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2'],
      fieldsMeta: [titleField, statusField],
      view: kanbanView,
      perGroupLimit: 50,
    })

    const ungrouped = result.metadata?.groups?.find(g => g.group_value === null)
    expect(ungrouped?.count).toBe(1)
    expect(ungrouped?.records.map(r => r.id)).toEqual(['r1'])
    expect(getKanbanOffsetKey(null)).toBe(KANBAN_UNGROUPED_OFFSET_KEY)
  })

  // ：effective view 可能只带 groups[0]（本地草稿预览），尚无 config.group_by_field
  it('falls back to groups[0] when config.group_by_field is absent', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'a', [statusField.id_hex]: 'open', __order: 1 })],
      ['r2', makeRecord({ [titleField.id_hex]: 'b', [statusField.id_hex]: 'done', __order: 2 })],
    ])

    const result = buildKanbanViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2'],
      fieldsMeta: [titleField, statusField],
      view: {
        ...kanbanView,
        groups: [{ field_id: statusField.id, direction: 'asc' }],
        config: {},
      },
      perGroupLimit: 50,
    })

    const groups = result.metadata?.groups ?? []
    expect(groups.find(g => g.group_value === 'open')?.count).toBe(1)
    expect(groups.find(g => g.group_value === 'done')?.count).toBe(1)
  })
})
