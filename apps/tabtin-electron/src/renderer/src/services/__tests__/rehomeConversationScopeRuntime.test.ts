import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  rehomeScopedCrawlspace: vi.fn(),
  rehomeScopeSessions: vi.fn(),
  rehomeScopeLayouts: vi.fn(),
}))

vi.mock('@/stores/useCrawlTabStore', () => ({
  useCrawlTabStore: {
    getState: () => ({
      rehomeScopedCrawlspace: mocks.rehomeScopedCrawlspace,
    }),
  },
}))

vi.mock('@components/context-space/sources/terminal', () => ({
  useTerminalSessionStore: {
    getState: () => ({
      rehomeScopeSessions: mocks.rehomeScopeSessions,
    }),
  },
}))

vi.mock('@/stores/useTerminalSplitStore', () => ({
  useTerminalSplitStore: {
    getState: () => ({
      rehomeScopeLayouts: mocks.rehomeScopeLayouts,
    }),
  },
}))

import { rehomeConversationScopeRuntime } from '../rehomeConversationScopeRuntime'

describe('rehomeConversationScopeRuntime', () => {
  beforeEach(() => {
    mocks.calls.length = 0
    mocks.rehomeScopedCrawlspace.mockReset().mockImplementation(() => {
      mocks.calls.push('browser')
      return 'cs-draft'
    })
    mocks.rehomeScopeSessions.mockReset().mockImplementation(() => {
      mocks.calls.push('terminal-sessions')
      return 2
    })
    mocks.rehomeScopeLayouts.mockReset().mockImplementation(() => {
      mocks.calls.push('terminal-layouts')
      return 1
    })
  })

  it('按 Browser、Terminal sessions、Terminal layouts 的顺序迁移草稿运行现场', () => {
    expect(
      rehomeConversationScopeRuntime(
        'conversation:draft:space-1',
        'conversation:session-1',
      ),
    ).toEqual({
      crawlspaceId: 'cs-draft',
      terminalSessions: 2,
      terminalLayouts: 1,
    })
    expect(mocks.calls).toEqual([
      'browser',
      'terminal-sessions',
      'terminal-layouts',
    ])
  })

  it.each([
    [
      'desktop:organization:1:user:1',
      'conversation:session-1',
    ],
    [
      'conversation:draft:space-1',
      'conversation:draft:space-1',
    ],
  ])('忽略非草稿来源或相同 scope，不产生副作用', (fromScopeKey, toScopeKey) => {
    expect(rehomeConversationScopeRuntime(fromScopeKey, toScopeKey)).toEqual({
      crawlspaceId: null,
      terminalSessions: 0,
      terminalLayouts: 0,
    })
    expect(mocks.calls).toEqual([])
  })
})
