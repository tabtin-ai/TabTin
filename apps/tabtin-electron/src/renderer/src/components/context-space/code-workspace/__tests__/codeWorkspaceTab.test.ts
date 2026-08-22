import { beforeEach, describe, expect, it, vi } from 'vitest'

const openResourceTab = vi.fn()
const closeTab = vi.fn()
const setPendingSidebarTab = vi.fn()
const activeKeyBySpace: Record<string, string | null> = {
  'conversation:s1': null,
}
const itemsBySpace: Record<string, Record<string, unknown>> = {
  'conversation:s1': {
    'tabchanges:old': {
      type: 'tabchanges',
      tabKey: 'tabchanges:old',
      meta: { path: '/repo/old', sessionId: 's1' },
    },
  },
}

vi.mock('../../registry', () => ({
  contextRegistry: {
    buildTabKey: (type: string, id: string) => `${type}:${id}`,
  },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openResourceTab,
      itemsBySpace,
      closeTab,
      activeKeyBySpace,
    }),
  },
}))

vi.mock('@components/tabcode/hooks/useTabCodeStore', () => ({
  normalizeTabCodeRootKey: (p: string) => p,
  useTabCodeStore: {
    getState: () => ({
      setPendingSidebarTab,
      consumePendingSidebarTab: vi.fn(),
    }),
  },
}))

vi.mock('../../workspaceExecutionRootApp', () => ({
  encodeTabCodeResourceId: (path: string) => `id:${path}`,
}))

import {
  buildCodeChangesTabKey,
  openCodeChangesTab,
  openTabCodeGitPanel,
  redirectCodeChangesTabsToRoot,
  silentlyRebindSessionTabCodeRoot,
} from '../codeWorkspaceTab'

describe('codeWorkspaceTab', () => {
  beforeEach(() => {
    openResourceTab.mockClear()
    closeTab.mockClear()
    setPendingSidebarTab.mockClear()
    activeKeyBySpace['conversation:s1'] = null
    itemsBySpace['conversation:s1'] = {
      'tabchanges:old': {
        type: 'tabchanges',
        tabKey: 'tabchanges:old',
        meta: { path: '/repo/old', sessionId: 's1' },
      },
    }
  })

  it('builds a path-based Changes tab key', () => {
    const key = buildCodeChangesTabKey('/tmp/project')
    expect(key.startsWith('tabchanges:')).toBe(true)
  })

  it('opens Changes with meta.path bound to session code root', () => {
    openCodeChangesTab({
      tabScopeKey: 'conversation:s1',
      spaceId: 'space-1',
      rootPath: '/repo/wt',
      sessionId: 's1',
      initialView: 'agent',
    })
    expect(openResourceTab).toHaveBeenCalledWith(
      'conversation:s1',
      expect.objectContaining({
        type: 'tabchanges',
        meta: expect.objectContaining({
          path: '/repo/wt',
          sessionId: 's1',
          initialView: 'agent',
        }),
      }),
    )
  })

  it('defaults Changes to the latest Agent turn view', () => {
    openCodeChangesTab({
      tabScopeKey: 'conversation:s1',
      spaceId: 'space-1',
      rootPath: '/repo/wt',
      sessionId: 's1',
    })
    expect(openResourceTab).toHaveBeenCalledWith(
      'conversation:s1',
      expect.objectContaining({
        meta: expect.objectContaining({
          initialView: 'agent',
        }),
      }),
    )
  })

  it('records a new Agent-view intent when reopening Changes from the workbench', () => {
    openCodeChangesTab({
      tabScopeKey: 'conversation:s1',
      spaceId: 'space-1',
      rootPath: '/repo/wt',
      sessionId: 's1',
      agentTurnEndMessageId: 'assistant-1',
      focusView: 'agent',
    })

    expect(openResourceTab).toHaveBeenCalledWith(
      'conversation:s1',
      expect.objectContaining({
        meta: expect.objectContaining({
          agentTurnEndMessageId: 'assistant-1',
          requestedView: 'agent',
          viewIntentId: expect.any(String),
        }),
      }),
    )
  })

  it('records a file focus intent when opening Changes from a review card', () => {
    openCodeChangesTab({
      tabScopeKey: 'conversation:s1',
      spaceId: 'space-1',
      rootPath: '/repo/wt',
      sessionId: 's1',
      agentTurnEndMessageId: 'assistant-1',
      focusView: 'agent',
      focusRelativePath: 'src/one.ts',
    })

    expect(openResourceTab).toHaveBeenCalledWith(
      'conversation:s1',
      expect.objectContaining({
        meta: expect.objectContaining({
          requestedView: 'agent',
          requestedRelativePath: 'src/one.ts',
          viewIntentId: expect.any(String),
        }),
      }),
    )
  })

  it('records a current-changes intent when opening from TabCode', () => {
    openCodeChangesTab({
      tabScopeKey: 'conversation:s1',
      spaceId: 'space-1',
      rootPath: '/repo/wt',
      sessionId: 's1',
      initialView: 'uncommitted',
      focusView: 'uncommitted',
    })

    expect(openResourceTab).toHaveBeenCalledWith(
      'conversation:s1',
      expect.objectContaining({
        meta: expect.objectContaining({
          initialView: 'uncommitted',
          requestedView: 'uncommitted',
          viewIntentId: expect.any(String),
        }),
      }),
    )
  })

  it('requests TabCode git sidebar when opening commit/push', () => {
    openTabCodeGitPanel({
      tabScopeKey: 'conversation:s1',
      rootPath: '/repo/wt',
    })
    expect(setPendingSidebarTab).toHaveBeenCalledWith('/repo/wt', 'git')
    expect(openResourceTab).toHaveBeenCalledWith(
      'conversation:s1',
      expect.objectContaining({
        type: 'tabcode',
        meta: expect.objectContaining({
          path: '/repo/wt',
          initialSidebarTab: 'git',
        }),
      }),
    )
  })

  it('redirects open Changes tabs to the next root', () => {
    redirectCodeChangesTabsToRoot({
      tabScopeKey: 'conversation:s1',
      spaceId: 'space-1',
      nextRootPath: '/repo/new',
      sessionId: 's1',
    })

    expect(closeTab).toHaveBeenCalledWith('conversation:s1', 'tabchanges:old')
    expect(openResourceTab).toHaveBeenCalledWith(
      'conversation:s1',
      expect.objectContaining({
        type: 'tabchanges',
        meta: expect.objectContaining({ path: '/repo/new' }),
      }),
    )
  })

  it('静默重定向 Changes 时只关旧标签、不重开', () => {
    redirectCodeChangesTabsToRoot({
      tabScopeKey: 'conversation:s1',
      spaceId: 'space-1',
      nextRootPath: '/repo/new',
      sessionId: 's1',
      reopenIfAnyWereOpen: false,
    })

    expect(closeTab).toHaveBeenCalledWith('conversation:s1', 'tabchanges:old')
    expect(openResourceTab).not.toHaveBeenCalled()
  })

  it('does not close Changes owned by another session in the same scope', () => {
    itemsBySpace['conversation:s1'] = {
      'tabchanges:target': {
        type: 'tabchanges',
        tabKey: 'tabchanges:target',
        meta: { path: '/repo/old', sessionId: 's1' },
      },
      'tabchanges:other': {
        type: 'tabchanges',
        tabKey: 'tabchanges:other',
        meta: { path: '/repo/other', sessionId: 's2' },
      },
    }

    redirectCodeChangesTabsToRoot({
      tabScopeKey: 'conversation:s1',
      spaceId: 'space-1',
      nextRootPath: '/repo/new',
      sessionId: 's1',
    })

    expect(closeTab).toHaveBeenCalledWith('conversation:s1', 'tabchanges:target')
    expect(closeTab).not.toHaveBeenCalledWith('conversation:s1', 'tabchanges:other')
  })

  it('静默把旧会话根 TabCode 切到新根，不影响其他项目', () => {
    itemsBySpace['conversation:s1'] = {
      'tabcode:id:/repo/old': {
        type: 'tabcode',
        tabKey: 'tabcode:id:/repo/old',
        meta: { path: '/repo/old' },
      },
      'tabcode:id:/other/project': {
        type: 'tabcode',
        tabKey: 'tabcode:id:/other/project',
        meta: { path: '/other/project' },
      },
    }
    activeKeyBySpace['conversation:s1'] = 'tabdoc:1'

    silentlyRebindSessionTabCodeRoot({
      tabScopeKey: 'conversation:s1',
      previousRootPath: '/repo/old',
      nextRootPath: '/repo/new',
      spaceId: 'space-1',
    })

    expect(openResourceTab).toHaveBeenCalledWith(
      'conversation:s1',
      expect.objectContaining({
        type: 'tabcode',
        id: 'id:/repo/new',
        title: 'new',
        silent: true,
        meta: expect.objectContaining({ path: '/repo/new' }),
      }),
    )
    expect(closeTab).toHaveBeenCalledWith(
      'conversation:s1',
      'tabcode:id:/repo/old',
      undefined,
    )
    expect(closeTab).not.toHaveBeenCalledWith(
      'conversation:s1',
      'tabcode:id:/other/project',
      expect.anything(),
    )
  })

  it('旧会话根 TabCode 为 active 时关旧并 fallback 到新根', () => {
    itemsBySpace['conversation:s1'] = {
      'tabcode:id:/repo/old': {
        type: 'tabcode',
        tabKey: 'tabcode:id:/repo/old',
        meta: { path: '/repo/old' },
      },
    }
    activeKeyBySpace['conversation:s1'] = 'tabcode:id:/repo/old'

    silentlyRebindSessionTabCodeRoot({
      tabScopeKey: 'conversation:s1',
      previousRootPath: '/repo/old',
      nextRootPath: '/repo/new',
    })

    expect(closeTab).toHaveBeenCalledWith(
      'conversation:s1',
      'tabcode:id:/repo/old',
      'tabcode:id:/repo/new',
    )
  })

  it('无旧会话根 TabCode 时不做任何标签操作', () => {
    itemsBySpace['conversation:s1'] = {
      'tabcode:id:/other/project': {
        type: 'tabcode',
        tabKey: 'tabcode:id:/other/project',
        meta: { path: '/other/project' },
      },
    }

    silentlyRebindSessionTabCodeRoot({
      tabScopeKey: 'conversation:s1',
      previousRootPath: '/repo/old',
      nextRootPath: '/repo/new',
    })

    expect(openResourceTab).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('新根 TabCode 已存在时复用并关闭旧根，不重复留下旧标签', () => {
    itemsBySpace['conversation:s1'] = {
      'tabcode:id:/repo/old': {
        type: 'tabcode',
        tabKey: 'tabcode:id:/repo/old',
        meta: { path: '/repo/old' },
      },
      'tabcode:id:/repo/new': {
        type: 'tabcode',
        tabKey: 'tabcode:id:/repo/new',
        meta: { path: '/repo/new' },
      },
    }
    activeKeyBySpace['conversation:s1'] = 'tabcode:id:/repo/old'

    silentlyRebindSessionTabCodeRoot({
      tabScopeKey: 'conversation:s1',
      previousRootPath: '/repo/old',
      nextRootPath: '/repo/new',
    })

    expect(openResourceTab).toHaveBeenCalledWith(
      'conversation:s1',
      expect.objectContaining({
        type: 'tabcode',
        id: 'id:/repo/new',
        silent: true,
      }),
    )
    expect(closeTab).toHaveBeenCalledWith(
      'conversation:s1',
      'tabcode:id:/repo/old',
      'tabcode:id:/repo/new',
    )
    expect(closeTab).not.toHaveBeenCalledWith(
      'conversation:s1',
      'tabcode:id:/repo/new',
      expect.anything(),
    )
  })
})
