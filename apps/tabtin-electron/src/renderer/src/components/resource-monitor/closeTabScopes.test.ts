import { describe, expect, it, vi } from 'vitest'
import { closeResourceMonitorTabScopes } from './closeTabScopes'

describe('closeResourceMonitorTabScopes', () => {
  it('只将标签全部关闭成功的会话标记为已清空', async () => {
    const closeTab = vi.fn(async ({ tabKey }: { tabKey: string }) => ({
      success: tabKey !== 'tabdoc:blocked',
    }))

    const result = await closeResourceMonitorTabScopes([
      {
        spaceId: 'space-1',
        scopeKey: 'conversation:closed',
        tabKeys: ['tabweb:one', 'tabdata:two'],
      },
      {
        spaceId: 'space-2',
        scopeKey: 'conversation:retained',
        tabKeys: ['tabdoc:blocked'],
      },
    ], closeTab)

    expect(result).toEqual({
      succeeded: 2,
      failed: 1,
      fullyClosedScopeKeys: ['conversation:closed'],
    })
  })
})
