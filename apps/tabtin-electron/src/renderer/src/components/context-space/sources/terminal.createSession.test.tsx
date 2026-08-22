import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import {
  createTerminalSessionInScope,
  openTerminalTabInScope,
  useTerminalContextSource,
  useTerminalSessionStore,
} from './terminal'

vi.mock('@/i18n', () => ({
  default: { t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? '终端' },
}))

function resetContextTabsStore() {
  useSpaceContextTabsStore.setState({
    activeKeyBySpace: {},
    displayKeyBySpace: {},
    tabOrderBySpace: {},
    itemsBySpace: {},
    lastActiveSubagentByParentSession: {},
  })
}

function resetTerminalStore() {
  useTerminalSessionStore.setState({
    sessionsBySpace: {},
  })
}

describe('useTerminalContextSource.createSession', () => {
  beforeEach(() => {
    resetContextTabsStore()
    resetTerminalStore()
  })

  it('创建 session 时同步打开并激活 terminal tab，避免 activeKey 先于 tabOrder', () => {
    const tabScopeKey = 'desktop:organization:wt-1:user:u-1'
    const { result } = renderHook(() =>
      useTerminalContextSource({ spaceId: 'space-1', tabScopeKey }),
    )

    let tabKey = ''
    act(() => {
      tabKey = result.current.createSession('My Terminal').tabKey
    })

    const tabs = useSpaceContextTabsStore.getState()
    expect(tabs.tabOrderBySpace[tabScopeKey]).toContain(tabKey)
    expect(tabs.itemsBySpace[tabScopeKey]?.[tabKey]).toMatchObject({
      type: 'terminal',
      title: 'My Terminal',
    })
    expect(tabs.activeKeyBySpace[tabScopeKey]).toBe(tabKey)
  })

  it('共享创建入口可供聊天入口复用，同步 materialize session 与 tab', () => {
    const storageKey = 'conversation:session-1'

    const { tabKey, sessionId } = createTerminalSessionInScope({
      spaceId: 'space-1',
      storageKey,
      title: 'Chat Terminal',
    })

    const terminalStore = useTerminalSessionStore.getState()
    const tabs = useSpaceContextTabsStore.getState()
    expect(terminalStore.sessionsBySpace[storageKey]?.some(session => session.id === sessionId)).toBe(true)
    expect(tabs.tabOrderBySpace[storageKey]).toContain(tabKey)
    expect(tabs.itemsBySpace[storageKey]?.[tabKey]).toMatchObject({
      type: 'terminal',
      title: 'Chat Terminal',
    })
    expect(tabs.activeKeyBySpace[storageKey]).toBe(tabKey)
  })

  it('打开已有 session 时通过 openResourceTab 同步写入 tabOrder 与 activeKey', () => {
    const storageKey = 'desktop:organization:wt-1:user:u-1'
    useTerminalSessionStore.getState().addSpaceSession(storageKey, 'terminal-existing', 'Existing Terminal')

    const { tabKey } = openTerminalTabInScope(storageKey, 'terminal-existing')

    const tabs = useSpaceContextTabsStore.getState()
    expect(tabs.tabOrderBySpace[storageKey]).toContain(tabKey)
    expect(tabs.itemsBySpace[storageKey]?.[tabKey]).toMatchObject({
      type: 'terminal',
      title: 'Existing Terminal',
    })
    expect(tabs.activeKeyBySpace[storageKey]).toBe(tabKey)
  })
})
