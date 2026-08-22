import { beforeEach, describe, expect, it } from 'vitest'
import { useTerminalSessionStore } from './terminal'
import { useTerminalSplitStore } from '@/stores/useTerminalSplitStore'

describe('Terminal scope rehome', () => {
  beforeEach(() => {
    useTerminalSessionStore.setState({ sessionsBySpace: {} })
    useTerminalSplitStore.setState({ layouts: {} })
  })

  it('把 draft 用户终端及分屏布局迁到正式 session scope', () => {
    useTerminalSessionStore.setState({
      sessionsBySpace: {
        'conversation:draft:space-1': [
          { id: 'terminal-root', spaceId: 'conversation:draft:space-1', title: 'Shell', createdAt: 1, source: 'user', status: 'active', cwd: '/workspace', executionSpaceId: 'space-1' },
          { id: 'terminal-child', spaceId: 'conversation:draft:space-1', title: 'Shell 2', createdAt: 2, source: 'user', status: 'active', cwd: '/workspace', executionSpaceId: 'space-1' },
        ],
      },
    })
    useTerminalSplitStore.setState({
      layouts: {
        'terminal-root': {
          rootSessionId: 'terminal-root', spaceId: 'conversation:draft:space-1',
          layout: { type: 'split', direction: 'horizontal', sizes: [50, 50], children: [{ type: 'leaf', paneId: 'p1' }, { type: 'leaf', paneId: 'p2' }] },
          panes: { p1: { id: 'p1', sessionId: 'terminal-root' }, p2: { id: 'p2', sessionId: 'terminal-child' } },
          activePaneId: 'p2', maximizedPaneId: 'p2',
        },
      },
    })

    expect(useTerminalSessionStore.getState().rehomeScopeSessions('conversation:draft:space-1', 'conversation:session-1')).toBe(2)
    expect(useTerminalSplitStore.getState().rehomeScopeLayouts('conversation:draft:space-1', 'conversation:session-1')).toBe(1)
    expect(useTerminalSessionStore.getState().sessionsBySpace['conversation:draft:space-1']).toBeUndefined()
    expect(useTerminalSessionStore.getState().sessionsBySpace['conversation:session-1'][0]).toMatchObject({ id: 'terminal-root', spaceId: 'conversation:session-1', cwd: '/workspace', executionSpaceId: 'space-1' })
    expect(useTerminalSplitStore.getState().layouts['terminal-root']).toMatchObject({ spaceId: 'conversation:session-1', activePaneId: 'p2', maximizedPaneId: 'p2' })
  })

  it('target bucket 同 ID session 优先且 source bucket 被移除', () => {
    useTerminalSessionStore.setState({
      sessionsBySpace: {
        'conversation:draft:space-1': [
          { id: 'terminal-1', spaceId: 'conversation:draft:space-1', title: 'draft title', createdAt: 1, source: 'user', status: 'active' },
          { id: 'terminal-2', spaceId: 'conversation:draft:space-1', title: 'move me', createdAt: 2, source: 'user', status: 'active' },
        ],
        'conversation:session-1': [
          { id: 'terminal-1', spaceId: 'conversation:session-1', title: 'target title', createdAt: 3, source: 'user', status: 'active' },
        ],
      },
    })

    expect(useTerminalSessionStore.getState().rehomeScopeSessions('conversation:draft:space-1', 'conversation:session-1')).toBe(1)
    expect(useTerminalSessionStore.getState().sessionsBySpace['conversation:draft:space-1']).toBeUndefined()
    expect(useTerminalSessionStore.getState().sessionsBySpace['conversation:session-1']).toEqual([
      expect.objectContaining({ id: 'terminal-1', title: 'target title' }),
      expect.objectContaining({ id: 'terminal-2', title: 'move me', spaceId: 'conversation:session-1' }),
    ])
  })
})
