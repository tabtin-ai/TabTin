import { describe, expect, it } from 'vitest'

import type { HistoryOperation } from './record-history-dialog'
import { groupOperations } from './history-utils'

function operation(overrides: Partial<HistoryOperation> = {}): HistoryOperation {
  return {
    id: 'history-1',
    record_id: 'record-1',
    action: 'update',
    action_display: '更新',
    field_changes: {},
    items: [],
    user: { id: 1, name: '测试用户' },
    created_at: '2026-08-15T04:02:00.000Z',
    is_undone: false,
    undone_at: null,
    undone_by: null,
    operation_group_id: null,
    ...overrides,
  }
}

describe('groupOperations history noise filtering', () => {
  it('hides legacy updates whose before and after values are semantically equal', () => {
    const groups = groupOperations([
      operation({
        field_changes: {
          'field-date': {
            old: { date: '2026-08-15' },
            new: { date: '2026-08-15' },
          },
        },
      }),
    ])

    expect(groups).toEqual([])
  })

  it('hides legacy system-managed field changes returned with field metadata', () => {
    const groups = groupOperations([
      operation({
        items: [
          {
            field_key: 'field-modified-by',
            field_name: '最后修改者',
            field_type: 'last_modified_by',
            before: 18,
            after: 19456,
          },
        ],
      } as Partial<HistoryOperation>),
    ])

    expect(groups).toEqual([])
  })
})
