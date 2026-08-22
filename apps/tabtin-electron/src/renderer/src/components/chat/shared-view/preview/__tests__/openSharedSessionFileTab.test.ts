import { beforeEach, describe, expect, it, vi } from 'vitest'

const openResourceTab = vi.fn()
const expandCanvasForScope = vi.fn()

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({ openResourceTab }),
  },
}))

vi.mock('@/services/openResourceLink', () => ({
  expandCanvasForScope: (...args: unknown[]) => expandCanvasForScope(...args),
}))

import { openSharedSessionFileTab } from '../openSharedSessionFileTab'

describe('openSharedSessionFileTab ', () => {
  beforeEach(() => {
    openResourceTab.mockReset()
    expandCanvasForScope.mockReset()
  })

  it('opens the remote file in the current conversation tab scope', () => {
    const opened = openSharedSessionFileTab({
      tabScopeKey: 'im:conversation-1',
      sessionId: 'session-1',
      shareId: 'share-1',
      relativePath: 'artifacts/report 2026.pdf',
      title: 'report 2026.pdf',
    })

    expect(opened).toBe(true)
    expect(openResourceTab).toHaveBeenCalledWith('im:conversation-1', {
      type: 'shared_session_file',
      id: 'shared-session-file:session-1:share-1:artifacts%2Freport%202026.pdf',
      title: 'report 2026.pdf',
      meta: {
        shared_session_id: 'session-1',
        session_share_id: 'share-1',
        relative_path: 'artifacts/report 2026.pdf',
        filename: 'report 2026.pdf',
      },
    })
    expect(expandCanvasForScope).toHaveBeenCalledWith('im:conversation-1')
  })
})
