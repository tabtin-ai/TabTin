import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

import { PERSIST_KEYS } from '../persist-key-registry'
import { useSpaceContextTabsStore } from '../useSpaceContextTabsStore'

const SPACE_ID = 'space-record-focus'

beforeEach(() => {
  useSpaceContextTabsStore.setState({
    activeKeyBySpace: {},
    displayKeyBySpace: {},
    tabOrderBySpace: {},
    itemsBySpace: {},
  })
  localStorage.removeItem(PERSIST_KEYS.contextTabs)
})

describe('context tab 记录定位意图持久化', () => {
  it('应保留资源元数据，但不应将一次性记录聚焦意图写入 localStorage', async () => {
    useSpaceContextTabsStore.getState().openResourceTab(SPACE_ID, {
      type: 'tabdata',
      id: 'table-1',
      meta: {
        recordIds: 'record-42',
        recordFocusRecordId: 'record-42',
        recordFocusRequestId: 'record-focus:1',
      },
    })

    await Promise.resolve()
    await Promise.resolve()

    const raw = localStorage.getItem(PERSIST_KEYS.contextTabs)
    const state = raw ? JSON.parse(raw)?.state : null
    const meta = state?.itemsBySpace?.[SPACE_ID]?.['tabdata:table-1']?.meta

    expect(meta?.recordIds).toBe('record-42')
    expect(meta?.recordFocusRecordId).toBeUndefined()
    expect(meta?.recordFocusRequestId).toBeUndefined()
  })

  it('不应将一次性评论定位意图写入 localStorage', async () => {
    useSpaceContextTabsStore.getState().openResourceTab(SPACE_ID, {
      type: 'tabdata',
      id: 'table-1',
      meta: {
        spaceId: SPACE_ID,
        recordId: 'record-1',
        commentId: 'comment-1',
        openComments: true,
        notificationIntentKey: 99,
      },
    })

    await Promise.resolve()
    await Promise.resolve()

    const raw = localStorage.getItem(PERSIST_KEYS.contextTabs)
    const state = raw ? JSON.parse(raw)?.state : null
    const meta = state?.itemsBySpace?.[SPACE_ID]?.['tabdata:table-1']?.meta

    expect(meta?.spaceId).toBe(SPACE_ID)
    expect(meta?.recordId).toBeUndefined()
    expect(meta?.commentId).toBeUndefined()
    expect(meta?.openComments).toBeUndefined()
    expect(meta?.notificationIntentKey).toBeUndefined()
  })
})
