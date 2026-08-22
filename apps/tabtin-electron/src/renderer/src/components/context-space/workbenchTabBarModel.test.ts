import { describe, expect, it } from 'vitest'

import type { ContextItem } from './registry/types'
import { buildWorkbenchTabBarModel } from './workbenchTabBarModel'

const desktopItem: ContextItem = {
  type: 'desktop_home',
  id: 'current',
  tabKey: 'desktop_home:current',
  title: '桌面',
}

const appHomeItem: ContextItem = {
  type: 'apphome',
  id: 'tabdata',
  tabKey: 'apphome:tabdata',
  title: '多维表',
}

const tableItem: ContextItem = {
  type: 'tabdata',
  id: 'table-1',
  tabKey: 'tabdata:table-1',
  title: '项目库',
}

const documentItem: ContextItem = {
  type: 'tabdoc',
  id: 'document-1',
  tabKey: 'tabdoc:document-1',
  title: '项目说明',
}

describe('buildWorkbenchTabBarModel', () => {
  it('桌面模式固定显示工作台首页', () => {
    const model = buildWorkbenchTabBarModel({
      visibleItems: [desktopItem],
      sidebarMode: 'desktop',
      isImConversationScope: false,
      activeTabType: 'desktop_home',
    })

    expect(model.showHome).toBe(true)
    expect(model.isHomeActive).toBe(true)
    expect(model.shouldRender).toBe(true)
  })

  it('应用主页和具体资源都铺成独立横向标签', () => {
    const model = buildWorkbenchTabBarModel({
      visibleItems: [desktopItem, appHomeItem, tableItem, documentItem],
      sidebarMode: 'desktop',
      isImConversationScope: false,
      activeTabType: 'apphome',
    })

    expect(model.isHomeActive).toBe(false)
    expect(model.items.map(item => item.tabKey)).toEqual([
      'apphome:tabdata',
      'tabdata:table-1',
      'tabdoc:document-1',
    ])
  })

  it('对话模式也钉工作台首页，并与资源标签并存', () => {
    const model = buildWorkbenchTabBarModel({
      visibleItems: [tableItem],
      sidebarMode: 'conversations',
      isImConversationScope: false,
      activeTabType: 'tabdata',
    })

    expect(model.showHome).toBe(true)
    expect(model.isHomeActive).toBe(false)
    expect(model.items).toEqual([tableItem])
    expect(model.shouldRender).toBe(true)
  })

  it('对话模式停在工作台时 isHomeActive', () => {
    const model = buildWorkbenchTabBarModel({
      visibleItems: [tableItem],
      sidebarMode: 'conversations',
      isImConversationScope: false,
      activeTabType: 'home',
    })

    expect(model.showHome).toBe(true)
    expect(model.isHomeActive).toBe(true)
  })

  it('IM 会话不新增工作台首页，但保留真实资源标签', () => {
    const model = buildWorkbenchTabBarModel({
      visibleItems: [tableItem],
      sidebarMode: 'conversations',
      isImConversationScope: true,
      activeTabType: 'tabdata',
    })

    expect(model.showHome).toBe(false)
    expect(model.homeClosable).toBe(false)
    expect(model.items).toEqual([tableItem])
    expect(model.shouldRender).toBe(true)
  })

  it('共享会话不新增工作台首页，但保留真实资源标签', () => {
    const model = buildWorkbenchTabBarModel({
      visibleItems: [tableItem],
      sidebarMode: 'conversations',
      isImConversationScope: false,
      isSharedSessionScope: true,
      activeTabType: 'home',
    })

    expect(model.showHome).toBe(false)
    expect(model.homeClosable).toBe(false)
    expect(model.items).toEqual([tableItem])
    expect(model.shouldRender).toBe(true)
  })

  it('任务会话只剩工作台时可关闭（切对话聚焦）', () => {
    const model = buildWorkbenchTabBarModel({
      visibleItems: [desktopItem],
      sidebarMode: 'conversations',
      isImConversationScope: false,
      activeTabType: 'home',
      canCollapseHomeToChatFocus: true,
    })

    expect(model.showHome).toBe(true)
    expect(model.items).toEqual([])
    expect(model.homeClosable).toBe(true)
  })

  it('仍有资源标签时工作台不可关', () => {
    const model = buildWorkbenchTabBarModel({
      visibleItems: [tableItem],
      sidebarMode: 'conversations',
      isImConversationScope: false,
      activeTabType: 'home',
      canCollapseHomeToChatFocus: true,
    })

    expect(model.homeClosable).toBe(false)
  })

  it('桌面模式即使只剩工作台也不可关', () => {
    const model = buildWorkbenchTabBarModel({
      visibleItems: [],
      sidebarMode: 'desktop',
      isImConversationScope: false,
      activeTabType: 'home',
      canCollapseHomeToChatFocus: false,
    })

    expect(model.homeClosable).toBe(false)
  })
})
