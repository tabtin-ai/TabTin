import { afterEach, describe, expect, it } from 'vitest'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import {
  registerTabDocDirtySource,
  _resetTabDocDirtyRegistry,
} from '../tabdocDirtyRegistry'
import { listScopesForTabKey } from '../tabdocScopeClaim'
import { dedupePersistedTabDocScopes } from '../tabdocScopeDedupe'

const TAB_KEY = 'tabdoc:doc-dup'

function seedScopes(scopes: string[], activeIn: string[] = []) {
  const tabOrderBySpace: Record<string, string[]> = {}
  const itemsBySpace: Record<string, Record<string, unknown>> = {}
  const activeKeyBySpace: Record<string, string | null> = {}
  for (const scope of scopes) {
    tabOrderBySpace[scope] = [TAB_KEY]
    itemsBySpace[scope] = {
      [TAB_KEY]: { tabKey: TAB_KEY, type: 'tabdoc', id: 'doc-dup', title: 'Dup', meta: {} },
    }
    activeKeyBySpace[scope] = activeIn.includes(scope) ? TAB_KEY : null
  }
  useSpaceContextTabsStore.setState({
    tabOrderBySpace,
    itemsBySpace,
    activeKeyBySpace,
    displayKeyBySpace: {},
    lastActiveSubagentByParentSession: {},
  })
}

describe('dedupePersistedTabDocScopes', () => {
  afterEach(() => {
    _resetTabDocDirtyRegistry()
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
      lastActiveSubagentByParentSession: {},
    })
  })

  it('唯一 active scope 作为 winner', () => {
    seedScopes(['cloud-docs:org:u', 'im:conv-1'], ['im:conv-1'])
    const result = dedupePersistedTabDocScopes({ foregroundScopeKey: 'cloud-docs:org:u' })
    expect(result.deduped).toEqual([
      { tabKey: TAB_KEY, winner: 'im:conv-1', closed: ['cloud-docs:org:u'] },
    ])
    expect(listScopesForTabKey(TAB_KEY, useSpaceContextTabsStore.getState())).toEqual(['im:conv-1'])
  })

  it('无唯一 active 时用 foreground workspaceContext.key', () => {
    seedScopes(['cloud-docs:org:u', 'im:conv-1'], [])
    const result = dedupePersistedTabDocScopes({ foregroundScopeKey: 'cloud-docs:org:u' })
    expect(result.deduped[0]?.winner).toBe('cloud-docs:org:u')
    expect(listScopesForTabKey(TAB_KEY, useSpaceContextTabsStore.getState())).toEqual([
      'cloud-docs:org:u',
    ])
  })

  it('两端同时 active 且 foreground 不在其中 → 跳过', () => {
    seedScopes(['cloud-docs:org:u', 'im:conv-1'], ['cloud-docs:org:u', 'im:conv-1'])
    const result = dedupePersistedTabDocScopes({
      foregroundScopeKey: 'desktop:organization:org:user:u',
    })
    expect(result.deduped).toEqual([])
    expect(result.skipped[0]?.reason).toBe('ambiguous')
    expect(listScopesForTabKey(TAB_KEY, useSpaceContextTabsStore.getState()).sort()).toEqual(
      ['cloud-docs:org:u', 'im:conv-1'].sort(),
    )
  })

  it('dirty 时跳过且不改桶', () => {
    seedScopes(['cloud-docs:org:u', 'im:conv-1'], ['cloud-docs:org:u'])
    registerTabDocDirtySource(
      'doc-dup',
      () => ({
        saveState: 'dirty',
        isDirty: true,
        isCollaborating: false,
        title: 'Dup',
      }),
      async () => true,
    )
    const result = dedupePersistedTabDocScopes({ foregroundScopeKey: 'cloud-docs:org:u' })
    expect(result.skipped[0]?.reason).toBe('dirty')
    expect(listScopesForTabKey(TAB_KEY, useSpaceContextTabsStore.getState()).sort()).toEqual(
      ['cloud-docs:org:u', 'im:conv-1'].sort(),
    )
  })
})
