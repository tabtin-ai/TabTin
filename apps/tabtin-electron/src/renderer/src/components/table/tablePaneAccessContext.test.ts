import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@stores/sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveTableParentDocumentId } from './tablePaneAccessContext'

const TABLE_ID = 'shared-table'
const TAB_KEY = `tabdata:${TABLE_ID}`
const EMBEDDED_SCOPE = 'conversation:session-1'
const STANDALONE_SCOPE = 'desktop:organization:org-1:user:user-1'

function resolveParentDocumentId() {
  return resolveTableParentDocumentId(useSpaceContextTabsStore.getState(), TABLE_ID)
}

beforeEach(() => {
  useSpaceContextTabsStore.setState({
    activeKeyBySpace: {},
    displayKeyBySpace: {},
    tabOrderBySpace: {},
    itemsBySpace: {},
    explicitCloseRevisionByScope: {},
    explicitClosedTabKeysByScope: {},
    lastActiveSubagentByParentSession: {},
  })
})

describe('resolveTableParentDocumentId', () => {
  it('同 tableId 跨 scope 切到独立页签后不再继承父文档上下文', () => {
    useSpaceContextTabsStore.setState({
      tabOrderBySpace: {
        [EMBEDDED_SCOPE]: [TAB_KEY, 'tabdoc:parent-doc'],
        [STANDALONE_SCOPE]: [TAB_KEY, 'tabdata:other'],
      },
      activeKeyBySpace: {
        [EMBEDDED_SCOPE]: TAB_KEY,
        [STANDALONE_SCOPE]: 'tabdata:other',
      },
      displayKeyBySpace: {
        [EMBEDDED_SCOPE]: TAB_KEY,
        [STANDALONE_SCOPE]: 'tabdata:other',
      },
      itemsBySpace: {
        [EMBEDDED_SCOPE]: {
          [TAB_KEY]: {
            tabKey: TAB_KEY,
            type: 'tabdata',
            id: TABLE_ID,
            meta: { parentDocumentId: 'parent-doc' },
          },
        },
        [STANDALONE_SCOPE]: {
          [TAB_KEY]: {
            tabKey: TAB_KEY,
            type: 'tabdata',
            id: TABLE_ID,
          },
        },
      },
    })

    expect(resolveParentDocumentId()).toBe('parent-doc')

    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {
        [EMBEDDED_SCOPE]: 'tabdoc:parent-doc',
        [STANDALONE_SCOPE]: TAB_KEY,
      },
      displayKeyBySpace: {
        [EMBEDDED_SCOPE]: 'tabdoc:parent-doc',
        [STANDALONE_SCOPE]: TAB_KEY,
      },
    })

    expect(resolveParentDocumentId()).toBeNull()
  })
})
