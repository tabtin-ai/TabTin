/**
 * policies.subagentSession.test.ts — PRD §4.13 / 红线 #2 + #11 回归
 *
 * 锁定 classifyRestoreTab 对 subagent_session 分支的决策：
 *   1. meta.parentSessionId 缺失 → stale (subagent_meta_missing)
 *   2. chat sessions 未 hydrate → unknown (sessions_not_hydrated)，避免冷启动期误删
 *   3. parent session 存在 → valid (subagent_session_valid)
 *   4. parent session 不存在（已删）→ stale (parent_session_deleted)
 *
 * Mock useChatStore 的 getState：getSessionById / sessionsHydrated 由测试方控制。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const chatStoreState = {
  sessionsHydrated: true,
  getSessionById: vi.fn(),
}

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: { getState: () => chatStoreState },
}))

import { classifyRestoreTab, requiresChatSessionIndex } from '../policies'
import type { WorkbenchRestoreInput } from '../types'

function makeInput(overrides: Partial<WorkbenchRestoreInput> = {}): WorkbenchRestoreInput {
  return {
    spaceId: 'sp',
    tabOrder: [],
    itemsByTabKey: {},
    activeKey: null,
    displayKey: null,
    lastActiveSurface: 'real_tab',
    canvasGroups: [],
    browser: {
      items: [],
      viewList: [],
      activeViewId: null,
      persistedSeeds: [],
      recentlyClosedViewIds: new Set(),
      coldStartPending: false,
    },
    table: { items: [], isLoading: false, hasError: false },
    terminal: { items: [], sessionIds: [], splitSubPaneSessionIds: new Set(), hydrated: true },
    apps: {
      ready: true,
      isAppEnabled: () => true,
      getAppId: () => undefined,
      requireResourceMembership: () => false,
    },
    resourceMembership: { byType: {}, loaded: true },
    readiness: {
      contextTabsHydrated: true,
      canvasLayoutHydrated: true,
      crawlTabsHydrated: true,
      terminalSessionsHydrated: true,
      browserColdStartPending: false,
    },
    ...overrides,
  } as WorkbenchRestoreInput
}

afterEach(() => {
  chatStoreState.sessionsHydrated = true
  chatStoreState.getSessionById.mockReset()
})

describe('requiresChatSessionIndex', () => {
  it('普通 IM 资源标签不依赖 Agent 会话索引', () => {
    expect(requiresChatSessionIndex([
      { type: 'tabdata' },
      { type: 'tabdoc' },
    ])).toBe(false)
  })

  it('存在子 Agent 标签时等待 Agent 会话索引', () => {
    expect(requiresChatSessionIndex([
      { type: 'tabdata' },
      { type: 'subagent_session' },
    ])).toBe(true)
  })
})

describe('classifyRestoreTab → subagent_session 分支', () => {
  it('meta.parentSessionId 缺失 → stale (subagent_meta_missing)', () => {
    const tabKey = 'subagent_session:run-orphan'
    const input = makeInput({
      itemsByTabKey: {
        [tabKey]: {
          tabKey,
          type: 'subagent_session',
          id: 'run-orphan',
          // 没 meta
        },
      },
    })

    const status = classifyRestoreTab(input, tabKey)
    expect(status.kind).toBe('stale')
    expect(status.reason).toBe('subagent_meta_missing')
  })

  it('sessions 未 hydrate → unknown (sessions_not_hydrated)，不返回 stale', () => {
    chatStoreState.sessionsHydrated = false
    chatStoreState.getSessionById.mockReturnValue(undefined)

    const tabKey = 'subagent_session:run-1'
    const input = makeInput({
      itemsByTabKey: {
        [tabKey]: {
          tabKey,
          type: 'subagent_session',
          id: 'run-1',
          meta: { kind: 'subagent_session', parentSessionId: 'sess-a' },
        },
      },
    })

    const status = classifyRestoreTab(input, tabKey)
    expect(status.kind).toBe('unknown')
    expect(status.reason).toBe('sessions_not_hydrated')
  })

  it('parent session 存在 → valid (subagent_session_valid)', () => {
    chatStoreState.sessionsHydrated = true
    chatStoreState.getSessionById.mockReturnValue({ id: 'sess-a', space_id: 'sp' })

    const tabKey = 'subagent_session:run-1'
    const input = makeInput({
      itemsByTabKey: {
        [tabKey]: {
          tabKey,
          type: 'subagent_session',
          id: 'run-1',
          meta: { kind: 'subagent_session', parentSessionId: 'sess-a' },
        },
      },
    })

    const status = classifyRestoreTab(input, tabKey)
    expect(status.kind).toBe('valid')
    expect(status.reason).toBe('subagent_session_valid')
  })

  it('parent session 不存在（已删）→ stale (parent_session_deleted)', () => {
    chatStoreState.sessionsHydrated = true
    chatStoreState.getSessionById.mockReturnValue(undefined)

    const tabKey = 'subagent_session:run-2'
    const input = makeInput({
      itemsByTabKey: {
        [tabKey]: {
          tabKey,
          type: 'subagent_session',
          id: 'run-2',
          meta: { kind: 'subagent_session', parentSessionId: 'sess-gone' },
        },
      },
    })

    const status = classifyRestoreTab(input, tabKey)
    expect(status.kind).toBe('stale')
    expect(status.reason).toBe('parent_session_deleted')
  })
})

describe('classifyRestoreTab → foreignShared tabdata 分支', () => {
  it('外部分享表格不按当前 Space 资源索引判 stale', () => {
    const tabKey = 'tabdata:shared-table'
    const input = makeInput({
      itemsByTabKey: {
        [tabKey]: {
          tabKey,
          type: 'tabdata',
          id: 'shared-table',
          meta: {
            foreignShared: true,
            spaceId: 'owner-bot-space',
            organizationId: 'organization-1',
          },
        },
      },
      apps: {
        ...makeInput().apps,
        requireResourceMembership: type => type === 'tabdata',
      },
      resourceMembership: {
        loaded: true,
        byType: { tabdata: new Set(['local-table']) },
      },
    })

    const status = classifyRestoreTab(input, tabKey)
    expect(status.kind).toBe('valid')
    expect(status.reason).toBe('foreign_shared_resource')
  })

  it('普通表格仍会在当前 Space 资源索引缺失时判 stale', () => {
    const tabKey = 'tabdata:missing-table'
    const input = makeInput({
      itemsByTabKey: {
        [tabKey]: {
          tabKey,
          type: 'tabdata',
          id: 'missing-table',
        },
      },
      apps: {
        ...makeInput().apps,
        requireResourceMembership: type => type === 'tabdata',
      },
      resourceMembership: {
        loaded: true,
        byType: { tabdata: new Set(['local-table']) },
      },
    })

    const status = classifyRestoreTab(input, tabKey)
    expect(status.kind).toBe('stale')
    expect(status.reason).toBe('table_resource_missing')
  })
})
