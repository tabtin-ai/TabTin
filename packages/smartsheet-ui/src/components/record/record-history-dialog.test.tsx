import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  RecordHistoryPanel,
  type HistoryOperation,
} from './record-history-dialog'

function operation(overrides: Partial<HistoryOperation> = {}): HistoryOperation {
  return {
    id: 'history-1',
    record_id: 'record-1',
    action: 'update',
    action_display: 'update',
    field_changes: {},
    items: [],
    user: { id: 1, name: 'Tester' },
    created_at: '2026-08-15T04:02:00.000Z',
    is_undone: false,
    undone_at: null,
    undone_by: null,
    operation_group_id: null,
    ...overrides,
  }
}

describe('RecordHistoryPanel change filtering', () => {
  it('does not render rows for update operations with only system-managed or no-op changes', () => {
    render(
      <RecordHistoryPanel
        operations={[
          operation({
            id: 'system-field',
            items: [
              {
                field_key: 'field-modified-by',
                field_type: 'last_modified_by',
                before: 18,
                after: 19456,
              },
            ],
          }),
          operation({
            id: 'noop-field',
            field_changes: {
              title: {
                old: { value: 'A', tags: ['x'] },
                new: { tags: ['x'], value: 'A' },
              },
            },
          }),
        ]}
        total={2}
        fieldTypeMap={{ title: 'text' }}
      />,
    )

    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})
