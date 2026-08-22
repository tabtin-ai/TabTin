import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import {
  _resetTabDocCloseConfirm,
  settleTabDocCloseConfirm,
} from '../tabdocCloseConfirm'
import {
  registerTabDocDirtySource,
  _resetTabDocDirtyRegistry,
} from '../tabdocDirtyRegistry'
import {
  claimTabDocScope,
  listScopesForTabKey,
  migrateTabKeyToScope,
  tryClaimTabDocScopeSync,
} from '../tabdocScopeClaim'

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
}))

function seedDualScope(tabKey: string) {
  useSpaceContextTabsStore.setState({
    tabOrderBySpace: {
      'cloud-docs:org:u': [tabKey],
      'im:conv-1': [tabKey, 'apphome:tabdoc'],
    },
    itemsBySpace: {
      'cloud-docs:org:u': {
        [tabKey]: { tabKey, type: 'tabdoc', id: 'doc-1', title: 'Doc', meta: {} },
      },
      'im:conv-1': {
        [tabKey]: { tabKey, type: 'tabdoc', id: 'doc-1', title: 'Doc', meta: {} },
      },
    },
    activeKeyBySpace: {
      'cloud-docs:org:u': tabKey,
      'im:conv-1': tabKey,
    },
    displayKeyBySpace: {},
    lastActiveSubagentByParentSession: {},
  })
}

describe('tabdocScopeClaim', () => {
  afterEach(() => {
    _resetTabDocCloseConfirm()
    _resetTabDocDirtyRegistry()
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
      lastActiveSubagentByParentSession: {},
    })
  })

  it('listScopesForTabKey 收集 order/items/active 命中', () => {
    const tabKey = 'tabdoc:doc-1'
    seedDualScope(tabKey)
    const scopes = listScopesForTabKey(tabKey, useSpaceContextTabsStore.getState())
    expect(scopes.sort()).toEqual(['cloud-docs:org:u', 'im:conv-1'].sort())
  })

  it('未初始化 scope 桶时按空映射处理', () => {
    expect(listScopesForTabKey('tabdoc:doc-1', {})).toEqual([])
  })

  it('clean 路径 sync claim 关掉 foreign 桶', () => {
    const tabKey = 'tabdoc:doc-1'
    seedDualScope(tabKey)
    expect(tryClaimTabDocScopeSync(tabKey, 'cloud-docs:org:u')).toBe('claimed')
    const state = useSpaceContextTabsStore.getState()
    expect(listScopesForTabKey(tabKey, state)).toEqual(['cloud-docs:org:u'])
  })

  it('dirty cancel 不改变任何桶', async () => {
    const tabKey = 'tabdoc:doc-1'
    seedDualScope(tabKey)
    registerTabDocDirtySource(
      'doc-1',
      () => ({
        saveState: 'dirty',
        isDirty: true,
        isCollaborating: false,
        title: '脏文档',
      }),
      async () => true,
    )

    expect(tryClaimTabDocScopeSync(tabKey, 'im:conv-1')).toBe('needs-confirm')
    const promise = claimTabDocScope(tabKey, 'im:conv-1', { displayName: '脏文档' })
    settleTabDocCloseConfirm('cancel')
    await expect(promise).resolves.toBe('cancelled')

    const scopes = listScopesForTabKey(tabKey, useSpaceContextTabsStore.getState())
    expect(scopes.sort()).toEqual(['cloud-docs:org:u', 'im:conv-1'].sort())
  })

  it('dirty discard 迁移到目标桶', async () => {
    const tabKey = 'tabdoc:doc-1'
    seedDualScope(tabKey)
    registerTabDocDirtySource(
      'doc-1',
      () => ({
        saveState: 'dirty',
        isDirty: true,
        isCollaborating: false,
        title: '脏文档',
      }),
      async () => true,
    )

    const promise = claimTabDocScope(tabKey, 'im:conv-1')
    settleTabDocCloseConfirm('discard')
    await expect(promise).resolves.toBe('claimed')
    expect(listScopesForTabKey(tabKey, useSpaceContextTabsStore.getState())).toEqual(['im:conv-1'])
  })

  it('migrateTabKeyToScope 同步关闭 foreign', () => {
    const tabKey = 'tabdoc:doc-1'
    seedDualScope(tabKey)
    expect(migrateTabKeyToScope(tabKey, 'cloud-docs:org:u')).toEqual(['im:conv-1'])
  })
})
