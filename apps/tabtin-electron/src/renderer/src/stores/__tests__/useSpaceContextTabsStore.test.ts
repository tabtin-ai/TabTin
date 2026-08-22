import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

import { useSpaceContextTabsStore } from '../useSpaceContextTabsStore'
import type { ContextItemRecord } from '../contextTabs/types'
import { buildContextTabsSignature } from '../workbenchRestoreSignature'
import { contextRegistry } from '@/components/context-space/registry/instance'

const SPACE = 'space-1'

function mkItem(type: string, id: string, extra?: Partial<ContextItemRecord>): ContextItemRecord {
  return { tabKey: `${type}:${id}`, type, id, ...extra }
}

function resetStore() {
  useSpaceContextTabsStore.setState({
    activeKeyBySpace: {},
    displayKeyBySpace: {},
    tabOrderBySpace: {},
    itemsBySpace: {},
    explicitCloseRevisionByScope: {},
    explicitClosedTabKeysByScope: {},
    lastActiveSubagentByParentSession: {},
  })
}

function getState() {
  return useSpaceContextTabsStore.getState()
}

function seedTabs(...items: ContextItemRecord[]) {
  const store = getState()
  items.forEach(item => {
    store.openResourceTab(SPACE, { type: item.type, id: item.id, title: item.title, meta: item.meta })
  })
}

beforeEach(() => {
  resetStore()
})

// ---------------------------------------------------------------------------
// openResourceTab
// ---------------------------------------------------------------------------

describe('openResourceTab', () => {
  it('共享会话沿普通 conversation scope 保存并恢复各自的标签状态', () => {
    const sharedConversationA = 'conversation:shared-session-a'
    const sharedConversationB = 'conversation:shared-session-b'

    getState().openResourceTab(sharedConversationA, {
      type: 'tabdoc',
      id: 'response-a.docx',
      title: '响应产物 A',
    })
    getState().openResourceTab(sharedConversationB, {
      type: 'tabweb',
      id: 'https://example.com/result-b',
      title: '响应链接 B',
    })

    const state = getState()
    expect(state.tabOrderBySpace[sharedConversationA]).toEqual(['tabdoc:response-a.docx'])
    expect(state.activeKeyBySpace[sharedConversationA]).toBe('tabdoc:response-a.docx')
    expect(state.tabOrderBySpace[sharedConversationB]).toEqual([
      'tabweb:https://example.com/result-b',
    ])
    expect(state.activeKeyBySpace[sharedConversationB]).toBe(
      'tabweb:https://example.com/result-b',
    )
  })

  it('打开新标签 → 添加到 tabOrder + items + 设为 activeKey', () => {
    getState().openResourceTab(SPACE, { type: 'tabdata', id: 't1' })

    const s = getState()
    expect(s.tabOrderBySpace[SPACE]).toContain('tabdata:t1')
    expect(s.itemsBySpace[SPACE]?.['tabdata:t1']).toBeDefined()
    expect(s.activeKeyBySpace[SPACE]).toBe('tabdata:t1')
  })

  it('打开已存在标签 → 不重复添加到 tabOrder', () => {
    getState().openResourceTab(SPACE, { type: 'tabdata', id: 't1' })
    getState().openResourceTab(SPACE, { type: 'tabdata', id: 't1' })

    expect(getState().tabOrderBySpace[SPACE]).toHaveLength(1)
  })

  it('静默刷新已存在本地文件 tab → 更新 meta 但不抢当前 activeKey', () => {
    getState().openResourceTab(SPACE, {
      type: 'file',
      id: 'artifacts/report.xlsx',
      title: 'report.xlsx',
      meta: {
        artifact_kind: 'local_file',
        relative_path: 'artifacts/report.xlsx',
        local_file_refresh_token: 'v1',
      },
    })
    getState().openResourceTab(SPACE, { type: 'tabdata', id: 't1' })

    getState().openResourceTab(SPACE, {
      type: 'file',
      id: 'artifacts/report.xlsx',
      title: 'report.xlsx',
      meta: {
        artifact_kind: 'local_file',
        relative_path: 'artifacts/report.xlsx',
        local_file_refresh_token: 'v2',
      },
      silent: true,
    })

    const s = getState()
    expect(s.tabOrderBySpace[SPACE].filter(key => key === 'file:artifacts/report.xlsx')).toHaveLength(1)
    expect(s.activeKeyBySpace[SPACE]).toBe('tabdata:t1')
    expect(s.itemsBySpace[SPACE]?.['file:artifacts/report.xlsx']?.meta?.local_file_refresh_token).toBe('v2')
  })

  it('再次打开已存在本地文件 tab（非 silent）→ 切到该 tab 并刷新 meta', () => {
    getState().openResourceTab(SPACE, {
      type: 'file',
      id: 'artifacts/report.xlsx',
      title: 'report.xlsx',
      meta: {
        artifact_kind: 'local_file',
        relative_path: 'artifacts/report.xlsx',
        local_file_refresh_token: 'v1',
      },
    })
    getState().openResourceTab(SPACE, { type: 'tabdata', id: 't1' })
    expect(getState().activeKeyBySpace[SPACE]).toBe('tabdata:t1')

    getState().openResourceTab(SPACE, {
      type: 'file',
      id: 'artifacts/report.xlsx',
      title: 'report.xlsx',
      meta: {
        artifact_kind: 'local_file',
        relative_path: 'artifacts/report.xlsx',
        local_file_refresh_token: 'v2',
      },
    })

    const s = getState()
    expect(s.tabOrderBySpace[SPACE].filter(key => key === 'file:artifacts/report.xlsx')).toHaveLength(1)
    expect(s.activeKeyBySpace[SPACE]).toBe('file:artifacts/report.xlsx')
    expect(s.itemsBySpace[SPACE]?.['file:artifacts/report.xlsx']?.meta?.local_file_refresh_token).toBe('v2')
  })

  it('非法 tabKey（空 id） → 不添加', () => {
    getState().openResourceTab(SPACE, { type: 'tabdata', id: '' })

    const s = getState()
    expect(s.tabOrderBySpace[SPACE]).toBeUndefined()
  })

  it('新标签插入到 activeKey 之后', () => {
    getState().openResourceTab(SPACE, { type: 'tabdata', id: 't1' })
    getState().openResourceTab(SPACE, { type: 'tabdata', id: 't2' })
    getState().openResourceTab(SPACE, { type: 'tabweb', id: 'v1' })

    const order = getState().tabOrderBySpace[SPACE]
    const t2Idx = order.indexOf('tabdata:t2')
    const v1Idx = order.indexOf('tabweb:v1')
    expect(v1Idx).toBe(t2Idx + 1)
  })

  it('tabweb 类型 → displayKey 同步更新', () => {
    getState().openResourceTab(SPACE, { type: 'tabweb', id: 'v1' })

    expect(getState().displayKeyBySpace[SPACE]).toBe('tabweb:v1')
  })

  it('非 tabweb 类型 → displayKey 不设置', () => {
    getState().openResourceTab(SPACE, { type: 'tabdata', id: 't1' })

    expect(getState().displayKeyBySpace[SPACE]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// closeTab
// ---------------------------------------------------------------------------

describe('closeTab', () => {
  it('关闭非活跃标签 → activeKey 不变', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'))
    getState().closeTab(SPACE, 'tabdata:t1')

    const s = getState()
    expect(s.tabOrderBySpace[SPACE]).not.toContain('tabdata:t1')
    expect(s.itemsBySpace[SPACE]?.['tabdata:t1']).toBeUndefined()
    expect(s.activeKeyBySpace[SPACE]).toBe('tabdata:t2')
  })

  it('关闭当前活跃标签 → activeKey 回退到相邻标签', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'), mkItem('tabdata', 't3'))
    // activeKey 是 t3（最后打开的）
    getState().setActiveKey(SPACE, 'tabdata:t2')
    getState().closeTab(SPACE, 'tabdata:t2')

    const s = getState()
    expect(s.tabOrderBySpace[SPACE]).not.toContain('tabdata:t2')
    expect(s.activeKeyBySpace[SPACE]).toBe('tabdata:t3')
  })

  it('显式关闭最后一个标签 → activeKey 为 null，并记录关闭动作', () => {
    seedTabs(mkItem('tabdata', 't1'))
    getState().closeExplicitTab!(SPACE, 'tabdata:t1')

    expect(getState().activeKeyBySpace[SPACE]).toBeNull()
    expect(getState().explicitCloseRevisionByScope[SPACE]).toBe(1)
  })

  /**
   * Task 3 锁定：对话 scope 关光真实标签后，store 侧「回 home」的契约是 activeKey=null
   *（不是字面量 'home'）。下游 useActiveKeyGuard 会把 null 派生为 activeTabType='home'，
   * SpaceContextArea 再渲染 DesktopHomePane variant='task-workbench'。
   */
  it('非显式的 tab 清理不记录关闭意图', () => {
    seedTabs(mkItem('tabdata', 't1'))
    getState().closeTab(SPACE, 'tabdata:t1')

    expect(getState().explicitCloseRevisionByScope[SPACE]).toBeUndefined()
  })

  it('source-driven close 可单独记录显式关闭意图', () => {
    getState().recordExplicitTabClose(SPACE)

    expect(getState().explicitCloseRevisionByScope[SPACE]).toBe(1)
  })

  it('关闭最后一个真实标签后 activeKey 回落 home（null 契约）', () => {
    const conversationScope = 'conversation:s1'
    getState().openTableTab(conversationScope, 'tbl_1', true)
    const tabKey = getState().tabOrderBySpace[conversationScope][0]
    expect(tabKey).toBe('tabdata:tbl_1')
    getState().closeTab(conversationScope, tabKey)
    // 简报草稿曾写 toBe('home')；实际 SSoT 用 null 表示虚拟 home
    expect(getState().getActiveKey(conversationScope)).toBeNull()
    expect(getState().tabOrderBySpace[conversationScope]).toEqual([])
  })

  it('关闭不存在的标签 → 状态不变且不记录关闭动作', () => {
    seedTabs(mkItem('tabdata', 't1'))
    const before = getState()
    getState().closeTab(SPACE, 'tabdata:nonexistent')

    const after = getState()
    expect(after.tabOrderBySpace[SPACE]).toEqual(before.tabOrderBySpace[SPACE])
    expect(after.explicitCloseRevisionByScope[SPACE]).toBeUndefined()
  })

  it('指定 fallbackActiveKey → 使用指定值', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'))
    getState().setActiveKey(SPACE, 'tabdata:t2')
    getState().closeTab(SPACE, 'tabdata:t2', 'tabdata:t1')

    expect(getState().activeKeyBySpace[SPACE]).toBe('tabdata:t1')
  })

  it('关闭首个活跃标签 → 激活第二个', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'))
    getState().setActiveKey(SPACE, 'tabdata:t1')
    getState().closeTab(SPACE, 'tabdata:t1')

    expect(getState().activeKeyBySpace[SPACE]).toBe('tabdata:t2')
  })

  it('显式批量关闭最后一组标签 → 记录关闭动作', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'))
    getState().batchCloseExplicitTabs!(SPACE, ['tabdata:t1', 'tabdata:t2'])

    expect(getState().tabOrderBySpace[SPACE]).toEqual([])
    expect(getState().explicitCloseRevisionByScope[SPACE]).toBe(1)
  })

  it('个人组织切到其他会话再返回，已关闭标签不复活', () => {
    const firstConversation = 'conversation:personal-session-1'
    const secondConversation = 'conversation:personal-session-2'
    const store = getState()

    store.openResourceTab(firstConversation, { type: 'tabdoc', id: 'doc-1' })
    store.openResourceTab(secondConversation, { type: 'tabdoc', id: 'doc-2' })
    store.closeExplicitTab!(firstConversation, 'tabdoc:doc-1')

    // 模拟前台切到另一个会话，再读回第一个会话的持久化标签桶。
    store.setActiveKey(secondConversation, 'tabdoc:doc-2')
    expect(getState().tabOrderBySpace[firstConversation]).toEqual([])
    expect(getState().itemsBySpace[firstConversation]).toEqual({})
    expect(getState().activeKeyBySpace[firstConversation]).toBeNull()
  })
})

describe('closeResourceTabEverywhere', () => {
  it('资源删除后清理所有 scope 中的对应标签并保留其他标签', () => {
    const desktopScope = 'desktop:organization:org-1:user:user-1'
    const conversationScope = 'conversation:session-1'
    const store = getState()

    store.openResourceTab(SPACE, { type: 'tabdoc', id: 'doc-1', title: '待删除文档' })
    store.openResourceTab(desktopScope, { type: 'tabdoc', id: 'doc-1', title: '待删除文档' })
    store.openResourceTab(desktopScope, { type: 'tabdoc', id: 'doc-2', title: '保留文档' })
    store.openResourceTab(conversationScope, { type: 'tabdoc', id: 'doc-1', title: '待删除文档' })

    store.closeResourceTabEverywhere('tabdoc', 'doc-1')

    const state = getState()
    expect(state.itemsBySpace[SPACE]?.['tabdoc:doc-1']).toBeUndefined()
    expect(state.itemsBySpace[desktopScope]?.['tabdoc:doc-1']).toBeUndefined()
    expect(state.itemsBySpace[conversationScope]?.['tabdoc:doc-1']).toBeUndefined()
    expect(state.itemsBySpace[desktopScope]?.['tabdoc:doc-2']).toBeDefined()
    expect(state.tabOrderBySpace[desktopScope]).toEqual(['tabdoc:doc-2'])
    expect(state.activeKeyBySpace[SPACE]).toBeNull()
    expect(state.activeKeyBySpace[desktopScope]).toBe('tabdoc:doc-2')
    expect(state.activeKeyBySpace[conversationScope]).toBeNull()
  })

  it('删除当前标签时不回退到可能属于其他上下文的隐藏标签', () => {
    const conversationScope = 'conversation:session-1'
    const store = getState()
    store.openResourceTab(conversationScope, { type: 'subagent_session', id: 'hidden-run' })
    store.openResourceTab(conversationScope, { type: 'tabdoc', id: 'doc-1' })

    store.closeResourceTabEverywhere('tabdoc', 'doc-1')

    expect(getState().activeKeyBySpace[conversationScope]).toBeNull()
    expect(getState().itemsBySpace[conversationScope]?.['subagent_session:hidden-run']).toBeDefined()
  })

  it('删除画布中的当前标签时回到安全空态，由可见性守卫决定后续焦点', () => {
    const desktopScope = 'desktop:organization:org-1:user:user-1'
    const store = getState()
    store.openResourceTab(desktopScope, { type: 'tabdoc', id: 'doc-2' })
    store.openResourceTab(desktopScope, { type: 'tabdoc', id: 'doc-1' })

    store.closeResourceTabEverywhere('tabdoc', 'doc-1')

    expect(getState().activeKeyBySpace[desktopScope]).toBeNull()
    expect(getState().itemsBySpace[desktopScope]?.['tabdoc:doc-2']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// batchCloseTab
// ---------------------------------------------------------------------------

describe('batchCloseTab', () => {
  it('批量关闭 → 移除所有指定标签', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'), mkItem('tabdata', 't3'))
    getState().batchCloseTab(SPACE, ['tabdata:t1', 'tabdata:t2'])

    const s = getState()
    expect(s.tabOrderBySpace[SPACE]).toEqual(['tabdata:t3'])
    expect(s.itemsBySpace[SPACE]?.['tabdata:t1']).toBeUndefined()
    expect(s.itemsBySpace[SPACE]?.['tabdata:t2']).toBeUndefined()
  })

  it('批量关闭包含 activeKey → 回退到相邻标签', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'), mkItem('tabdata', 't3'))
    getState().setActiveKey(SPACE, 'tabdata:t2')
    getState().batchCloseTab(SPACE, ['tabdata:t2'])

    expect(getState().activeKeyBySpace[SPACE]).toBe('tabdata:t3')
  })

  it('批量关闭全部 → activeKey 为 null', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'))
    getState().batchCloseTab(SPACE, ['tabdata:t1', 'tabdata:t2'])

    expect(getState().activeKeyBySpace[SPACE]).toBeNull()
    expect(getState().tabOrderBySpace[SPACE]).toEqual([])
  })

  it('空列表 → 状态不变', () => {
    seedTabs(mkItem('tabdata', 't1'))
    const orderBefore = getState().tabOrderBySpace[SPACE]
    getState().batchCloseTab(SPACE, [])

    expect(getState().tabOrderBySpace[SPACE]).toBe(orderBefore)
  })
})

// ---------------------------------------------------------------------------
// removeItem
// ---------------------------------------------------------------------------

describe('removeItem', () => {
  it('移除 item → 联动清理 tabOrder + items', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'))
    getState().removeItem(SPACE, 'tabdata:t1')

    const s = getState()
    expect(s.tabOrderBySpace[SPACE]).not.toContain('tabdata:t1')
    expect(s.itemsBySpace[SPACE]?.['tabdata:t1']).toBeUndefined()
  })

  it('移除活跃 item → activeKey 回退', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'))
    getState().setActiveKey(SPACE, 'tabdata:t1')
    getState().removeItem(SPACE, 'tabdata:t1')

    expect(getState().activeKeyBySpace[SPACE]).toBe('tabdata:t2')
  })

  it('移除最后一个 item → activeKey 为 null', () => {
    seedTabs(mkItem('tabdata', 't1'))
    getState().removeItem(SPACE, 'tabdata:t1')

    expect(getState().activeKeyBySpace[SPACE]).toBeNull()
  })

  it('移除活跃 tabweb item → displayKey 清除', () => {
    seedTabs(mkItem('tabweb', 'v1'), mkItem('tabdata', 't1'))
    getState().setActiveKey(SPACE, 'tabweb:v1')
    expect(getState().displayKeyBySpace[SPACE]).toBe('tabweb:v1')

    getState().removeItem(SPACE, 'tabweb:v1')
    const dk = getState().displayKeyBySpace[SPACE]
    expect(dk === undefined || dk === null).toBe(true)
  })

  it('移除不存在的 item → 状态不变', () => {
    seedTabs(mkItem('tabdata', 't1'))
    const itemsBefore = getState().itemsBySpace[SPACE]
    getState().removeItem(SPACE, 'tabdata:nonexistent')

    expect(getState().itemsBySpace[SPACE]).toBe(itemsBefore)
  })
})

// ---------------------------------------------------------------------------
// replaceTabKey
// ---------------------------------------------------------------------------

describe('replaceTabKey', () => {
  it('替换 tabKey → tabOrder/items/activeKey 联动更新', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'))
    getState().setActiveKey(SPACE, 'tabdata:t1')
    getState().replaceTabKey(SPACE, 'tabdata:t1', 'tabdata:t1-new', 't1-new')

    const s = getState()
    expect(s.tabOrderBySpace[SPACE]).toContain('tabdata:t1-new')
    expect(s.tabOrderBySpace[SPACE]).not.toContain('tabdata:t1')
    expect(s.itemsBySpace[SPACE]?.['tabdata:t1-new']).toBeDefined()
    expect(s.itemsBySpace[SPACE]?.['tabdata:t1']).toBeUndefined()
    expect(s.activeKeyBySpace[SPACE]).toBe('tabdata:t1-new')
  })

  it('originTabKey 记录', () => {
    seedTabs(mkItem('tabdata', 't1'))
    getState().replaceTabKey(SPACE, 'tabdata:t1', 'tabdata:t2', 't2')

    const item = getState().itemsBySpace[SPACE]?.['tabdata:t2']
    expect(item?.originTabKey).toBe('tabdata:t1')
  })

  it('替换非活跃标签 → activeKey 不变', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'))
    getState().setActiveKey(SPACE, 'tabdata:t2')
    getState().replaceTabKey(SPACE, 'tabdata:t1', 'tabdata:t1-new', 't1-new')

    expect(getState().activeKeyBySpace[SPACE]).toBe('tabdata:t2')
  })

  it('传入业务 space 时仍能替换实际 desktop scope 里的临时 tab', () => {
    const desktopScope = 'desktop:organization:w1:user:u1'
    getState().openResourceTab(desktopScope, {
      type: 'tabslide',
      id: 'new-1',
      title: '未命名演示文稿',
    })

    getState().replaceTabKey(SPACE, 'tabslide:new-1', 'tabslide:slide-1', 'slide-1')

    const s = getState()
    expect(s.tabOrderBySpace[desktopScope]).toEqual(['tabslide:slide-1'])
    expect(s.itemsBySpace[desktopScope]?.['tabslide:new-1']).toBeUndefined()
    expect(s.itemsBySpace[desktopScope]?.['tabslide:slide-1']).toEqual(expect.objectContaining({
      id: 'slide-1',
      tabKey: 'tabslide:slide-1',
      title: '未命名演示文稿',
      originTabKey: 'tabslide:new-1',
    }))
    expect(s.activeKeyBySpace[desktopScope]).toBe('tabslide:slide-1')
  })

  it('替换为相同 key → 无操作', () => {
    seedTabs(mkItem('tabdata', 't1'))
    const orderBefore = getState().tabOrderBySpace[SPACE]
    getState().replaceTabKey(SPACE, 'tabdata:t1', 'tabdata:t1', 't1')

    expect(getState().tabOrderBySpace[SPACE]).toBe(orderBefore)
  })

  it('连续替换保留最初的 originTabKey', () => {
    seedTabs(mkItem('tabdata', 't1'))
    getState().replaceTabKey(SPACE, 'tabdata:t1', 'tabdata:t2', 't2')
    getState().replaceTabKey(SPACE, 'tabdata:t2', 'tabdata:t3', 't3')

    const item = getState().itemsBySpace[SPACE]?.['tabdata:t3']
    expect(item?.originTabKey).toBe('tabdata:t1')
  })
})

// ---------------------------------------------------------------------------
// syncItemsByType
// ---------------------------------------------------------------------------

describe('syncItemsByType', () => {
  it('shallowEqual 去重 → 相同数据不更新', () => {
    const item = mkItem('tabdata', 't1', { title: 'Table 1' })
    getState().openResourceTab(SPACE, { type: 'tabdata', id: 't1', title: 'Table 1' })
    const itemsBefore = getState().itemsBySpace
    getState().syncItemsByType(SPACE, 'tabdata', [item])

    expect(getState().itemsBySpace).toBe(itemsBefore)
  })

  it('新增 item → 更新', () => {
    seedTabs(mkItem('tabdata', 't1'))
    const newItem = mkItem('tabdata', 't2', { title: 'New' })
    getState().syncItemsByType(SPACE, 'tabdata', [mkItem('tabdata', 't1'), newItem])

    expect(getState().itemsBySpace[SPACE]?.['tabdata:t2']).toBeDefined()
  })

  it('删除不再存在的 item', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'))
    getState().syncItemsByType(SPACE, 'tabdata', [mkItem('tabdata', 't1')])

    expect(getState().itemsBySpace[SPACE]?.['tabdata:t2']).toBeUndefined()
  })

  it('保留 meta.discarded 的 item 不被删除', () => {
    seedTabs(mkItem('tabdata', 't1'))
    getState().upsertItems(SPACE, [
      mkItem('tabdata', 't1', { meta: { discarded: true } }),
    ])
    getState().syncItemsByType(SPACE, 'tabdata', [])

    expect(getState().itemsBySpace[SPACE]?.['tabdata:t1']).toBeDefined()
  })

  it('不影响其他类型的 items', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabweb', 'v1'))
    getState().syncItemsByType(SPACE, 'tabdata', [])

    expect(getState().itemsBySpace[SPACE]?.['tabweb:v1']).toBeDefined()
  })

  it('保留已有 originTabKey', () => {
    seedTabs(mkItem('tabdata', 't1'))
    getState().replaceTabKey(SPACE, 'tabdata:t1', 'tabdata:t2', 't2')
    const updatedItem = mkItem('tabdata', 't2', { title: 'Updated' })
    getState().syncItemsByType(SPACE, 'tabdata', [updatedItem])

    expect(getState().itemsBySpace[SPACE]?.['tabdata:t2']?.originTabKey).toBe('tabdata:t1')
  })
})

// ---------------------------------------------------------------------------
// 其他 actions
// ---------------------------------------------------------------------------

describe('setActiveKey', () => {
  it('设置合法 key', () => {
    seedTabs(mkItem('tabdata', 't1'))
    getState().setActiveKey(SPACE, 'tabdata:t1')

    expect(getState().activeKeyBySpace[SPACE]).toBe('tabdata:t1')
  })

  it('非法 key → 设为 null', () => {
    seedTabs(mkItem('tabdata', 't1'))
    getState().setActiveKey(SPACE, 'badkey')

    expect(getState().activeKeyBySpace[SPACE]).toBeNull()
  })
})

describe('syncOpenResourceTabTitle', () => {
  it('资源重命名后同步已打开 tab 的标题', () => {
    seedTabs(mkItem('tabdata', 't1', { title: '旧表名' }))

    getState().syncOpenResourceTabTitle({
      type: 'tabdata',
      id: 't1',
      title: '新表名',
      spaceId: SPACE,
    })

    expect(getState().itemsBySpace[SPACE]?.['tabdata:t1']?.title).toBe('新表名')
  })

  it('不更新其他 space 中同资源的 tab', () => {
    seedTabs(mkItem('tabdata', 't1', { title: '旧表名' }))
    getState().openResourceTab('space-2', { type: 'tabdata', id: 't1', title: '另一个旧名' })

    getState().syncOpenResourceTabTitle({
      type: 'tabdata',
      id: 't1',
      title: '新表名',
      spaceId: SPACE,
    })

    expect(getState().itemsBySpace[SPACE]?.['tabdata:t1']?.title).toBe('新表名')
    expect(getState().itemsBySpace['space-2']?.['tabdata:t1']?.title).toBe('另一个旧名')
  })

  it('允许将已打开 tab 的标题同步为空字符串', () => {
    seedTabs(mkItem('tabdata', 't1', { title: '旧表名' }))

    getState().syncOpenResourceTabTitle({
      type: 'tabdata',
      id: 't1',
      title: '',
      spaceId: SPACE,
    })

    expect(getState().itemsBySpace[SPACE]?.['tabdata:t1']?.title).toBe('')
  })

  it('未指定 spaceId 时同步所有 scope 中同资源的 tab 标题', () => {
    const desktopScope = 'desktop:organization:w1:user:u1'
    getState().openResourceTab(SPACE, { type: 'tabslide', id: 'slide-1', title: '旧标题' })
    getState().openResourceTab(desktopScope, { type: 'tabslide', id: 'slide-1', title: '旧标题' })

    getState().syncOpenResourceTabTitle({
      type: 'tabslide',
      id: 'slide-1',
      title: '新标题',
    })

    expect(getState().itemsBySpace[SPACE]?.['tabslide:slide-1']?.title).toBe('新标题')
    expect(getState().itemsBySpace[desktopScope]?.['tabslide:slide-1']?.title).toBe('新标题')
  })
})

describe('syncOpenResourceTabIcon', () => {
  it('资源改 icon 后同步已打开 tab 的 meta.icon', () => {
    seedTabs(mkItem('tabdoc', 'doc-1', { title: 'AAA', meta: { spaceId: SPACE } }))

    getState().syncOpenResourceTabIcon({
      type: 'tabdoc',
      id: 'doc-1',
      icon: '📋',
      spaceId: SPACE,
    })

    expect(getState().itemsBySpace[SPACE]?.['tabdoc:doc-1']?.meta?.icon).toBe('📋')
  })

  it('允许清空已打开 tab 的 icon', () => {
    seedTabs(mkItem('tabdoc', 'doc-1', { title: 'AAA', meta: { spaceId: SPACE, icon: '📋' } }))

    getState().syncOpenResourceTabIcon({
      type: 'tabdoc',
      id: 'doc-1',
      icon: '',
      spaceId: SPACE,
    })

    expect(getState().itemsBySpace[SPACE]?.['tabdoc:doc-1']?.meta?.icon).toBeUndefined()
  })

  it('即使传入 spaceId，也会同步 desktop scope 里已打开的同资源 tab', () => {
    const desktopScope = 'desktop:organization:w1:user:u1'
    seedTabs(mkItem('tabdoc', 'doc-1', { title: 'AAA', meta: { spaceId: SPACE } }))
    getState().openResourceTab(desktopScope, {
      type: 'tabdoc',
      id: 'doc-1',
      title: 'AAA',
      meta: { spaceId: SPACE },
    })

    getState().syncOpenResourceTabIcon({
      type: 'tabdoc',
      id: 'doc-1',
      icon: '⭐',
      spaceId: SPACE,
    })

    expect(getState().itemsBySpace[SPACE]?.['tabdoc:doc-1']?.meta?.icon).toBe('⭐')
    expect(getState().itemsBySpace[desktopScope]?.['tabdoc:doc-1']?.meta?.icon).toBe('⭐')
  })
})

describe('applyRestoreDecision', () => {
  it('baseSignature 匹配时一次性写入 order/items/active/display', () => {
    // 直接 seed，避免 openResourceTab 留下 user navIntent（ 会挡住 restore 改 active）
    useSpaceContextTabsStore.setState({
      tabOrderBySpace: { [SPACE]: ['tabdata:t1'] },
      itemsBySpace: { [SPACE]: { 'tabdata:t1': mkItem('tabdata', 't1') } },
      activeKeyBySpace: { [SPACE]: 'tabdata:t1' },
      displayKeyBySpace: {},
    })
    const baseSignature = buildContextTabsSignature({
      activeKey: getState().activeKeyBySpace[SPACE] ?? null,
      displayKey: getState().displayKeyBySpace[SPACE] ?? null,
      tabOrder: getState().tabOrderBySpace[SPACE] ?? [],
      items: getState().itemsBySpace[SPACE] ?? {},
    })

    const applied = getState().applyRestoreDecision(SPACE, {
      tabOrder: ['tabweb:v1'],
      items: { 'tabweb:v1': mkItem('tabweb', 'v1') },
      activeKey: 'tabweb:v1',
      displayKey: 'tabweb:v1',
    }, baseSignature)

    expect(applied).toBe(true)
    expect(getState().tabOrderBySpace[SPACE]).toEqual(['tabweb:v1'])
    expect(getState().itemsBySpace[SPACE]).toEqual({ 'tabweb:v1': mkItem('tabweb', 'v1') })
    expect(getState().activeKeyBySpace[SPACE]).toBe('tabweb:v1')
    expect(getState().displayKeyBySpace[SPACE]).toBe('tabweb:v1')
  })

  it('baseSignature 不匹配时丢弃旧 decision，避免覆盖用户交互', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'))
    const baseSignature = buildContextTabsSignature({
      activeKey: getState().activeKeyBySpace[SPACE] ?? null,
      displayKey: getState().displayKeyBySpace[SPACE] ?? null,
      tabOrder: getState().tabOrderBySpace[SPACE] ?? [],
      items: getState().itemsBySpace[SPACE] ?? {},
    })

    getState().setActiveKey(SPACE, 'tabdata:t1')
    const applied = getState().applyRestoreDecision(SPACE, {
      tabOrder: ['tabdata:t2'],
      items: { 'tabdata:t2': mkItem('tabdata', 't2') },
      activeKey: 'tabdata:t2',
      displayKey: null,
    }, baseSignature)

    expect(applied).toBe(false)
    expect(getState().activeKeyBySpace[SPACE]).toBe('tabdata:t1')
    expect(getState().tabOrderBySpace[SPACE]).toEqual(['tabdata:t1', 'tabdata:t2'])
  })

  it('用户 openHome（activeKey=null）时 restore 不得写回 first_restorable_tab', () => {
    seedTabs(mkItem('tabdoc', 'd1'), mkItem('tabdata', 't2'))
    getState().setActiveKey(SPACE, null, { writer: 'user', reason: 'openHome' })
    expect(getState().activeKeyBySpace[SPACE] ?? null).toBeNull()

    const baseSignature = buildContextTabsSignature({
      activeKey: getState().activeKeyBySpace[SPACE] ?? null,
      displayKey: getState().displayKeyBySpace[SPACE] ?? null,
      tabOrder: getState().tabOrderBySpace[SPACE] ?? [],
      items: getState().itemsBySpace[SPACE] ?? {},
    })
    const order = getState().tabOrderBySpace[SPACE] ?? []
    const items = getState().itemsBySpace[SPACE] ?? {}

    const applied = getState().applyRestoreDecision(SPACE, {
      tabOrder: order,
      items,
      activeKey: 'tabdoc:d1',
      displayKey: null,
    }, baseSignature)

    expect(applied).toBe(true)
    expect(getState().activeKeyBySpace[SPACE] ?? null).toBeNull()
  })
})

describe('clearSpaceTabs', () => {
  it('清除指定 space 的全部数据', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabdata', 't2'))
    getState().clearSpaceTabs(SPACE)

    const s = getState()
    expect(s.tabOrderBySpace[SPACE]).toBeUndefined()
    expect(s.itemsBySpace[SPACE]).toBeUndefined()
    expect(s.activeKeyBySpace[SPACE]).toBeUndefined()
  })
})

describe('workspace scope adapter', () => {
  const DESKTOP_SCOPE = 'desktop:organization:wt-1:user:user-1'
  const CONVERSATION_SCOPE = 'conversation:session-1'

  it('首次进入 shared desktop scope 时从当前 legacy Space 复制标签组', () => {
    getState().openResourceTab(SPACE, { type: 'tabdata', id: 't1', title: 'Table 1' })
    getState().openResourceTab(SPACE, { type: 'tabweb', id: 'view-1', title: 'Web 1' })

    const copied = getState().ensureScopeInitializedFromLegacy(DESKTOP_SCOPE, SPACE)

    expect(copied).toBe(true)
    expect(getState().tabOrderBySpace[DESKTOP_SCOPE]).toEqual(getState().tabOrderBySpace[SPACE])
    expect(getState().itemsBySpace[DESKTOP_SCOPE]).toEqual(getState().itemsBySpace[SPACE])
    expect(getState().activeKeyBySpace[DESKTOP_SCOPE]).toBe(getState().activeKeyBySpace[SPACE])
  })

  it('desktop scope 已有数据时不会被 legacy Space 覆盖', () => {
    getState().openResourceTab(DESKTOP_SCOPE, { type: 'tabdata', id: 'desktop-table' })
    getState().openResourceTab(SPACE, { type: 'tabdata', id: 'legacy-table' })

    const copied = getState().ensureScopeInitializedFromLegacy(DESKTOP_SCOPE, SPACE)

    expect(copied).toBe(false)
    expect(getState().tabOrderBySpace[DESKTOP_SCOPE]).toEqual(['tabdata:desktop-table'])
  })

  it('#7706 rehomeScopeTabs：目标为空时整组迁走并清空源', () => {
    const draft = 'conversation:draft:space-a'
    const formal = 'conversation:session-1'
    getState().openResourceTab(draft, { type: 'tabdata', id: 'nasdaq', title: '纳斯达克指数行情' })
    getState().openResourceTab(draft, { type: 'tabdoc', id: 'doc-1', title: '笔记' })

    const moved = getState().rehomeScopeTabs(draft, formal)

    expect(moved).toBe(true)
    expect(getState().tabOrderBySpace[formal]).toEqual([
      'tabdata:nasdaq',
      'tabdoc:doc-1',
    ])
    expect(getState().activeKeyBySpace[formal]).toBe('tabdoc:doc-1')
    expect(getState().tabOrderBySpace[draft]).toBeUndefined()
    expect(getState().itemsBySpace[draft]).toBeUndefined()
  })

  it('#7706 rehomeScopeTabs：目标已有数据时合并源标签，不清掉目标也不丢源', () => {
    const draft = 'conversation:draft:space-a'
    const formal = 'conversation:session-1'
    // 正式 scope 被竞态抢先写入一条（ensure 旧逻辑会因此 skip copy）
    getState().openResourceTab(formal, {
      type: 'tabdata',
      id: 'nasdaq',
      title: '纳斯达克指数行情',
    })
    getState().openResourceTab(draft, {
      type: 'tabdata',
      id: 'nasdaq',
      title: '纳斯达克指数行情',
    })
    getState().openResourceTab(draft, { type: 'tabdoc', id: 'keep-me', title: '应保留' })

    const moved = getState().rehomeScopeTabs(draft, formal)

    expect(moved).toBe(true)
    expect(getState().tabOrderBySpace[formal]).toEqual([
      'tabdata:nasdaq',
      'tabdoc:keep-me',
    ])
    expect(getState().itemsBySpace[formal]?.['tabdoc:keep-me']?.title).toBe('应保留')
    expect(getState().activeKeyBySpace[formal]).toBe('tabdata:nasdaq')
    expect(getState().hasScopeData(draft)).toBe(false)
  })

  it('#7706 ensure+clear 旧组合会丢标签；rehomeScopeTabs 不会', () => {
    const draft = 'conversation:draft:space-a'
    const formal = 'conversation:session-1'
    getState().openResourceTab(formal, { type: 'tabdata', id: 'race-open' })
    getState().openResourceTab(draft, { type: 'tabdoc', id: 'draft-only', title: '草稿独有' })

    // 复现旧 bug：目标已有数据 → ensure skip → clear 源 → 草稿独有标签永久丢失
    expect(getState().ensureScopeInitializedFromLegacy(formal, draft)).toBe(false)
    getState().clearSpaceTabs(draft)
    expect(getState().tabOrderBySpace[formal]).toEqual(['tabdata:race-open'])
    expect(getState().itemsBySpace[formal]?.['tabdoc:draft-only']).toBeUndefined()

    resetStore()
    getState().openResourceTab(formal, { type: 'tabdata', id: 'race-open' })
    getState().openResourceTab(draft, { type: 'tabdoc', id: 'draft-only', title: '草稿独有' })
    getState().rehomeScopeTabs(draft, formal)
    expect(getState().tabOrderBySpace[formal]).toEqual([
      'tabdata:race-open',
      'tabdoc:draft-only',
    ])
  })

  it('conversation scope 不调用迁移时保持空白标签组', () => {
    getState().openResourceTab(SPACE, { type: 'tabdata', id: 'legacy-table' })

    expect(getState().hasScopeData(CONVERSATION_SCOPE)).toBe(false)
    expect(getState().tabOrderBySpace[CONVERSATION_SCOPE]).toBeUndefined()
    expect(getState().itemsBySpace[CONVERSATION_SCOPE]).toBeUndefined()
  })

  it('purgeStaleEntries 保留 desktop/conversation workspace scopes', () => {
    getState().openResourceTab(DESKTOP_SCOPE, { type: 'tabdata', id: 'desktop-table' })
    getState().openResourceTab(CONVERSATION_SCOPE, { type: 'tabdata', id: 'conversation-table' })
    getState().openResourceTab('deleted-space', { type: 'tabdata', id: 'old-table' })

    getState().purgeStaleEntries(new Set([SPACE]))

    expect(getState().tabOrderBySpace[DESKTOP_SCOPE]).toEqual(['tabdata:desktop-table'])
    expect(getState().tabOrderBySpace[CONVERSATION_SCOPE]).toEqual(['tabdata:conversation-table'])
    expect(getState().tabOrderBySpace['deleted-space']).toBeUndefined()
  })

  it('purgeStaleEntries 保留 cloud-docs 域标签桶', () => {
    const cloudDocsScope = 'cloud-docs:organization:org-1:user:user-1'
    getState().openResourceTab(cloudDocsScope, { type: 'tabdata', id: 'cloud-table' })
    getState().openResourceTab(cloudDocsScope, { type: 'tabdoc', id: 'cloud-doc' })
    getState().openResourceTab('deleted-space', { type: 'tabdata', id: 'old-table' })

    getState().purgeStaleEntries(new Set([SPACE]))

    expect(getState().tabOrderBySpace[cloudDocsScope]).toEqual([
      'tabdata:cloud-table',
      'tabdoc:cloud-doc',
    ])
    expect(getState().tabOrderBySpace['deleted-space']).toBeUndefined()
  })
})

describe('findSpaceByTabKey', () => {
  it('找到包含该 tabKey 的 space', () => {
    seedTabs(mkItem('tabdata', 't1'))

    expect(getState().findSpaceByTabKey('tabdata:t1')).toBe(SPACE)
  })

  it('未找到 → null', () => {
    expect(getState().findSpaceByTabKey('tabdata:nonexist')).toBeNull()
  })

  it('重复 tabKey 时优先返回 active 命中的 scope，而非 last-write-wins', () => {
    const tabKey = 'tabdata:shared'
    const desktop = 'desktop:organization:org-1:user:u1'
    useSpaceContextTabsStore.setState({
      tabOrderBySpace: {
        [SPACE]: [tabKey],
        [desktop]: [tabKey, 'tabdata:other'],
      },
      activeKeyBySpace: {
        [SPACE]: tabKey,
        [desktop]: 'tabdata:other',
      },
      displayKeyBySpace: {
        [SPACE]: tabKey,
        [desktop]: 'tabdata:other',
      },
      itemsBySpace: {},
    })

    expect(getState().findSpaceByTabKey(tabKey)).toBe(SPACE)
  })

  it('重复 tabKey 均未 active 时按 desktop > conversation > legacy 回退', () => {
    const tabKey = 'tabdata:shared'
    const desktop = 'desktop:organization:org-1:user:u1'
    const conversation = 'conversation:session-9'
    useSpaceContextTabsStore.setState({
      tabOrderBySpace: {
        [SPACE]: [tabKey],
        [conversation]: [tabKey],
        [desktop]: [tabKey],
      },
      activeKeyBySpace: {
        [SPACE]: 'tabdata:other',
        [conversation]: 'tabdata:other',
        [desktop]: 'tabdata:other',
      },
      displayKeyBySpace: {},
      itemsBySpace: {},
    })

    expect(getState().findSpaceByTabKey(tabKey)).toBe(desktop)
  })
})

describe('getOpenTableTabs', () => {
  it('返回 tabdata 类型的 id 列表', () => {
    seedTabs(mkItem('tabdata', 't1'), mkItem('tabweb', 'v1'), mkItem('tabdata', 't2'))

    const ids = getState().getOpenTableTabs(SPACE)
    expect(ids).toEqual(['t1', 't2'])
  })

  it('空 space → 返回空数组', () => {
    expect(getState().getOpenTableTabs('no-space')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// syncTabOrder persistOnly 纪律
// ---------------------------------------------------------------------------

describe('syncTabOrder persistOnly', () => {
  let prefixesSpy: ReturnType<typeof vi.spyOn> | undefined

  beforeEach(() => {
    prefixesSpy = vi
      .spyOn(contextRegistry, 'getPersistedOnlyPrefixes')
      .mockReturnValue(['tabdoc:', 'file:'])
  })

  afterEach(() => {
    prefixesSpy?.mockRestore()
  })

  it('空 sync + items 仍有 tabdoc → order 保留', () => {
    useSpaceContextTabsStore.setState({
      tabOrderBySpace: { [SPACE]: ['tabdoc:d1', 'tabweb:v1'] },
      itemsBySpace: {
        [SPACE]: {
          'tabdoc:d1': mkItem('tabdoc', 'd1'),
          'tabweb:v1': mkItem('tabweb', 'v1'),
        },
      },
      activeKeyBySpace: { [SPACE]: 'tabdoc:d1' },
      displayKeyBySpace: {},
    })

    getState().syncTabOrder(SPACE, [])

    expect(getState().tabOrderBySpace[SPACE]).toEqual(['tabdoc:d1'])
  })

  it('order 已空但 items 仍有 tabdoc → 从 items 回补', () => {
    useSpaceContextTabsStore.setState({
      tabOrderBySpace: { [SPACE]: [] },
      itemsBySpace: {
        [SPACE]: {
          'tabdoc:d1': mkItem('tabdoc', 'd1'),
        },
      },
      activeKeyBySpace: {},
      displayKeyBySpace: {},
    })

    getState().syncTabOrder(SPACE, [])

    expect(getState().tabOrderBySpace[SPACE]).toEqual(['tabdoc:d1'])
  })

  it('closeTab 后再空 sync → 该 persistOnly 可删', () => {
    getState().openResourceTab(SPACE, { type: 'tabdoc', id: 'd1', title: 'Doc' })
    expect(getState().tabOrderBySpace[SPACE]).toContain('tabdoc:d1')

    getState().closeTab(SPACE, 'tabdoc:d1')
    getState().syncTabOrder(SPACE, [])

    expect(getState().tabOrderBySpace[SPACE] ?? []).not.toContain('tabdoc:d1')
    expect(getState().itemsBySpace[SPACE]?.['tabdoc:d1']).toBeUndefined()
  })

  it('显式关闭后迟到的同步快照不得恢复 persistOnly 标签', () => {
    const tabKey = 'file:artifacts/report.pptx'
    getState().openResourceTab(SPACE, {
      type: 'file',
      id: 'artifacts/report.pptx',
      title: 'report.pptx',
    })

    getState().closeExplicitTab(SPACE, tabKey)
    // 模拟关闭前一帧捕获的 currentTabKeys 在会话切换时迟到提交。
    getState().syncTabOrder(SPACE, [tabKey])

    expect(getState().tabOrderBySpace[SPACE] ?? []).not.toContain(tabKey)
    expect(getState().itemsBySpace[SPACE]?.[tabKey]).toBeUndefined()

    getState().openResourceTab(SPACE, {
      type: 'file',
      id: 'artifacts/report.pptx',
      title: 'report.pptx',
    })
    expect(getState().tabOrderBySpace[SPACE]).toContain(tabKey)
  })
})
