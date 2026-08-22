import { describe, expect, it } from 'vitest'
import {
  parseRecordCommentNotificationIntent,
  selectRecordCommentNotificationIntent,
} from './recordCommentNotificationIntent'

describe('record comment notification intent', () => {
  it('selects an exact record comment intent from the table tab metadata', () => {
    const encoded = selectRecordCommentNotificationIntent({
      'desktop:org-1:user-1': {
        'tabdata:table-1': {
          meta: {
            recordId: 'record-1',
            commentId: 'comment-1',
            openComments: true,
            notificationIntentKey: 42,
          },
        },
      },
    }, 'tabdata:table-1')

    expect(parseRecordCommentNotificationIntent(encoded)).toEqual({
      scopeKey: 'desktop:org-1:user-1',
      recordId: 'record-1',
      commentId: 'comment-1',
      intentKey: '42',
    })
  })

  it('ignores stale metadata that does not explicitly request the comments panel', () => {
    expect(selectRecordCommentNotificationIntent({
      scope: {
        'tabdata:table-1': {
          meta: { recordId: 'record-1', notificationIntentKey: 42 },
        },
      },
    }, 'tabdata:table-1')).toBeNull()
  })
})
