import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'

vi.mock('@components/context-space/sources/terminal', () => ({
  useTerminalSessionStore: {
    getState: () => ({
      getSessionEntry: () => null,
      sessionsBySpace: {},
    }),
  },
  killPtySession: vi.fn(),
}))

vi.mock('@stores/useClosedTabsStore', () => ({
  useClosedTabsStore: { getState: () => ({ push: vi.fn() }) },
}))

vi.mock('@stores/useTerminalSplitStore', () => ({
  useTerminalSplitStore: (selector: (state: { layouts: Record<string, unknown> }) => unknown) =>
    selector({ layouts: {} }),
}))

vi.mock('@stores/useTerminalPaneStatusStore', () => ({
  useTerminalPaneStatusStore: (selector: (state: {
    statuses: Record<string, unknown>
    getAggregatedStatus: () => 'idle'
  }) => unknown) =>
    selector({ statuses: {}, getAggregatedStatus: () => 'idle' }),
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  },
}))

import { terminalHandler } from '../terminal'

describe('terminalHandler.resolveTabItem', () => {
  it('store 缺失时保留 persisted meta.source（ Bug B fallback）', () => {
    const resolved = terminalHandler.resolveTabItem?.('agent-session-1', {
      spaceId: 'space-1',
      tabKey: 'terminal:agent-session-1',
      persistedItem: {
        title: 'Agent terminal',
        meta: {
          source: 'agent',
          status: 'closed',
          cwd: '/work',
        },
      },
    })

    expect(resolved?.meta).toEqual({
      status: 'closed',
      source: 'agent',
    })
  })
})

describe('terminalHandler.renderPane', () => {
  it('用户终端 closed 仍短路 session ended 空白页', () => {
    render(
      <>
        {terminalHandler.renderPane?.({
          type: 'terminal',
          id: 'user-session-1',
          tabKey: 'terminal:user-session-1',
          title: 'Terminal',
          meta: { source: 'user', status: 'closed' },
        }, { spaceId: 'space-1' })}
      </>,
    )

    expect(screen.getByText('This terminal session has ended.')).toBeTruthy()
  })

  it('agent 终端 closed 不走 session ended 短路（ Bug B）', () => {
    render(
      <>
        {terminalHandler.renderPane?.({
          type: 'terminal',
          id: 'agent-session-1',
          tabKey: 'terminal:agent-session-1',
          title: 'Agent terminal',
          meta: { source: 'agent', status: 'closed' },
        }, { spaceId: 'space-1' })}
      </>,
    )

    expect(screen.queryByText('This terminal session has ended.')).toBeNull()
  })

  it('meta 丢 source 但 id 为 agent- 前缀时同样放行（bugbot  兜底）', () => {
    render(
      <>
        {terminalHandler.renderPane?.({
          type: 'terminal',
          id: 'agent-space1-1234567890-ab',
          tabKey: 'terminal:agent-space1-1234567890-ab',
          title: 'Agent terminal',
          meta: { status: 'closed' },
        }, { spaceId: 'space-1' })}
      </>,
    )

    expect(screen.queryByText('This terminal session has ended.')).toBeNull()
  })
})
