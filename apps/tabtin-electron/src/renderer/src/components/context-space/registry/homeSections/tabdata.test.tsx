import { describe, expect, it } from 'vitest'
import type { Table } from '@tabtin/table-core'
import { tableToContextItem } from './tabdata'

describe('tableToContextItem', () => {
  it('bridges tabdata visibility and status into a SpaceContextItem', () => {
    const item = tableToContextItem({
      id: 'table-1',
      name: 'Visible Table',
      space_id: 'space-1',
      space_name: 'Current Space',
      icon: '📊',
      row_count: 12,
      field_count: 4,
      visibility: 'hidden',
      is_archived: true,
      updated_at: '2026-01-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
    } as Table)

    expect(item.resource_id).toBe('table-1')
    expect(item.status).toBe('archived')
    expect(item.metadata).toMatchObject({
      visibility: 'hidden',
      record_count: 12,
      field_count: 4,
    })
  })
})
