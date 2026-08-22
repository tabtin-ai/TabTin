import { describe, expect, it, beforeEach } from 'vitest'
import { getOrganizationTabManager } from './OrganizationTabManager'

describe('OrganizationTabManager.clearTab', () => {
  const wtm = getOrganizationTabManager()

  beforeEach(() => {
    wtm.clear()
  })

  it('清除 Tab 下所有 View 的映射、反向索引和元数据', () => {
    const tabId = 'tab-cleartest-1'
    wtm.registerView(tabId, 'v-1', { title: 'Page 1', url: 'https://a.com', createdAt: 1 })
    wtm.registerView(tabId, 'v-2', { title: 'Page 2', url: 'https://b.com', createdAt: 2 })

    expect(wtm.isOrganizationTab(tabId)).toBe(true)
    expect(wtm.getTabByView('v-1')).toBe(tabId)
    expect(wtm.getTabByView('v-2')).toBe(tabId)

    const removed = wtm.clearTab(tabId)

    expect(removed).toHaveLength(2)
    expect(removed).toContain('v-1')
    expect(removed).toContain('v-2')

    expect(wtm.isOrganizationTab(tabId)).toBe(false)
    expect(wtm.getTabByView('v-1')).toBeNull()
    expect(wtm.getTabByView('v-2')).toBeNull()
    expect(wtm.getViewMetadata('v-1')).toBeNull()
    expect(wtm.getViewMetadata('v-2')).toBeNull()
    expect(wtm.getViewsByTab(tabId)).toEqual([])
  })

  it('clearTab 对不存在的 Tab 返回空数组、不报错', () => {
    const removed = wtm.clearTab('tab-nonexistent')
    expect(removed).toEqual([])
  })

  it('clearTab 不影响其他 Tab 的 View', () => {
    const tab1 = 'tab-a'
    const tab2 = 'tab-b'
    wtm.registerView(tab1, 'v-a1', { title: 'A1', url: 'https://a.com', createdAt: 1 })
    wtm.registerView(tab2, 'v-b1', { title: 'B1', url: 'https://b.com', createdAt: 2 })

    wtm.clearTab(tab1)

    expect(wtm.isOrganizationTab(tab1)).toBe(false)
    expect(wtm.isOrganizationTab(tab2)).toBe(true)
    expect(wtm.getTabByView('v-b1')).toBe(tab2)
  })

  it('clearTab 后重新 registerView 能正常工作', () => {
    const tabId = 'tab-reuse'
    wtm.registerView(tabId, 'v-old', { title: 'Old', url: 'https://old.com', createdAt: 1 })
    wtm.clearTab(tabId)

    const success = wtm.registerView(tabId, 'v-new', { title: 'New', url: 'https://new.com', createdAt: 2 })
    expect(success).toBe(true)
    expect(wtm.getTabByView('v-new')).toBe(tabId)
    expect(wtm.isOrganizationTab(tabId)).toBe(true)
  })
})
