import { describe, expect, it } from 'vitest'
import { resolveRecordFocusIntentMeta } from './recordFocusIntent'

describe('resolveRecordFocusIntentMeta', () => {
  it('同一张表跨多个标签域打开时应只消费当前可见域的定位意图', () => {
    const tableTabKey = 'tabdata:table-1'
    const itemsBySpace = {
      'conversation:draft:old': {
        [tableTabKey]: {
          meta: { resourceMembershipPendingSince: 1 },
        },
      },
      'im:current': {
        [tableTabKey]: {
          meta: {
            recordFocusRecordId: 'record-42',
            recordFocusRequestId: 'record-focus:1',
          },
        },
      },
    }

    expect(resolveRecordFocusIntentMeta(itemsBySpace, tableTabKey, 'im:current')).toEqual({
      scopeKey: 'im:current',
      requestId: 'record-focus:1',
      recordId: 'record-42',
    })
  })

  it('全局表格运行时沿用旧域上下文时应选择最新的定位意图', () => {
    const tableTabKey = 'tabdata:table-1'
    const itemsBySpace = {
      'conversation:draft:old': {
        [tableTabKey]: {
          meta: {
            recordFocusRecordId: 'record-old',
            recordFocusRequestId: 'record-focus:100:1',
          },
        },
      },
      'im:current': {
        [tableTabKey]: {
          meta: {
            recordFocusRecordId: 'record-42',
            recordFocusRequestId: 'record-focus:101:1',
          },
        },
      },
    }

    expect(resolveRecordFocusIntentMeta(
      itemsBySpace,
      tableTabKey,
      'conversation:draft:old',
    )).toEqual({
      scopeKey: 'im:current',
      requestId: 'record-focus:101:1',
      recordId: 'record-42',
    })
  })
})
