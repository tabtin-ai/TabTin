import { describe, expect, it } from 'vitest'
import { buildTableEventSubscribeOptions } from './useTableEventStream'

describe('buildTableEventSubscribeOptions', () => {
  it('attaches parent-document access context to the exact table topic', () => {
    expect(buildTableEventSubscribeOptions('table-1', {
      parent_document_id: 'doc-parent',
    })).toEqual({
      topicContexts: {
        'table.events.table-1': {
          parent_document_id: 'doc-parent',
        },
      },
    })
  })

  it('preserves the legacy subscribe shape without context', () => {
    expect(buildTableEventSubscribeOptions('table-1', undefined)).toBeUndefined()
  })
})
