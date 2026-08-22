import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { HistoryOperation } from './record-history-dialog'
import { HistoryTimeline } from './history-timeline'

afterEach(cleanup)

describe('HistoryTimeline historical field metadata', () => {
  it('uses the history item field name when the field is absent from the current table', () => {
    const operations: HistoryOperation[] = [{
      id: 'history-1',
      record_id: 'record-1',
      action: 'update',
      action_display: '更新',
      field_changes: {},
      items: [{
        field_key: 'deleted-field-id',
        field_name: '历史工单号',
        before: '18',
        after: '19456',
      }],
      user: { id: 1, name: '测试用户' },
      created_at: '2026-08-15T04:02:00.000Z',
      is_undone: false,
      undone_at: null,
      undone_by: null,
      operation_group_id: null,
    }]

    render(<HistoryTimeline operations={operations} total={1} />)

    expect(screen.getByText('历史工单号')).not.toBeNull()
    expect(screen.queryByText('已删除字段')).toBeNull()
  })
})
