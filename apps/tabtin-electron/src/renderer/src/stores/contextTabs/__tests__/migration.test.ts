import { describe, expect, it } from 'vitest'
import { migrateContextTabsState } from '../migration'

describe('migrateContextTabsState', () => {
  describe('v0 → v1', () => {
    it('属性重命名：*ByProject → *BySpace', () => {
      const v0: Record<string, any> = {
        activeKeyByProject: { sp1: 'tabdata:t1' },
        displayKeyByProject: { sp1: null },
        tabOrderByProject: { sp1: ['tabdata:t1'] },
        itemsByProject: { sp1: { 'tabdata:t1': { tabKey: 'tabdata:t1', type: 'tabdata', id: 't1' } } },
      }

      const result = migrateContextTabsState<Record<string, any>>(v0, 0)
      expect(result.activeKeyBySpace).toBeDefined()
      expect(result.displayKeyBySpace).toBeDefined()
      expect(result.tabOrderBySpace).toBeDefined()
      expect(result.itemsBySpace).toBeDefined()
      expect(result.activeKeyByProject).toBeUndefined()
    })

    it('不覆盖已有 *BySpace 数据', () => {
      const v0: Record<string, any> = {
        activeKeyByProject: { sp1: 'tabdata:old' },
        activeKeyBySpace: { sp1: 'tabdata:new' },
        tabOrderBySpace: { sp1: ['tabdata:new'] },
        itemsBySpace: {},
      }

      const result = migrateContextTabsState<Record<string, any>>(v0, 0)
      expect(result.activeKeyBySpace.sp1).toBe('tabdata:new')
    })

    it('tabKey 前缀迁移：table: → tabdata:', () => {
      const v0: Record<string, any> = {
        tabOrderBySpace: { sp1: ['table:t1'] },
        activeKeyBySpace: { sp1: 'table:t1' },
        itemsBySpace: {
          sp1: {
            'table:t1': { tabKey: 'table:t1', type: 'table', id: 't1' },
          },
        },
      }

      const result = migrateContextTabsState<Record<string, any>>(v0, 0)
      expect(result.tabOrderBySpace.sp1).toEqual(['tabdata:t1'])
      expect(result.activeKeyBySpace.sp1).toBe('tabdata:t1')
      expect(result.itemsBySpace.sp1['tabdata:t1']).toBeDefined()
      expect(result.itemsBySpace.sp1['tabdata:t1'].type).toBe('tabdata')
    })

    it('tabKey 前缀迁移：app-tabdoc: → tabdoc:', () => {
      const v0: Record<string, any> = {
        tabOrderBySpace: { sp1: ['app-tabdoc:doc1'] },
        itemsBySpace: {
          sp1: {
            'app-tabdoc:doc1': { tabKey: 'app-tabdoc:doc1', type: 'app-tabdoc', id: 'doc1' },
          },
        },
      }

      const result = migrateContextTabsState<Record<string, any>>(v0, 0)
      expect(result.tabOrderBySpace.sp1).toEqual(['tabdoc:doc1'])
      expect(result.itemsBySpace.sp1['tabdoc:doc1'].type).toBe('tabdoc')
    })

    it('tabKey 前缀迁移：ppt: → tabslide:', () => {
      const v0: Record<string, any> = {
        tabOrderBySpace: { sp1: ['ppt:s1'] },
        itemsBySpace: {
          sp1: {
            'ppt:s1': { tabKey: 'ppt:s1', type: 'ppt', id: 's1' },
          },
        },
      }

      const result = migrateContextTabsState<Record<string, any>>(v0, 0)
      expect(result.tabOrderBySpace.sp1).toEqual(['tabslide:s1'])
      expect(result.itemsBySpace.sp1['tabslide:s1'].type).toBe('tabslide')
    })

    it('精确 key 迁移：tabdoc:tabdoc → tabdoc:home', () => {
      const v0: Record<string, any> = {
        tabOrderBySpace: { sp1: ['app-tabdoc:tabdoc'] },
        itemsBySpace: {
          sp1: {
            'app-tabdoc:tabdoc': { tabKey: 'app-tabdoc:tabdoc', type: 'app-tabdoc', id: 'tabdoc' },
          },
        },
      }

      const result = migrateContextTabsState<Record<string, any>>(v0, 0)
      expect(result.tabOrderBySpace.sp1).toEqual(['tabdoc:home'])
    })

    it('legacy openTableTabsByProject → 合并到 tabOrderBySpace', () => {
      const v0: Record<string, any> = {
        openTableTabsByProject: {
          sp1: ['tbl-1', 'tbl-2'],
        },
        tabOrderBySpace: { sp1: ['tabdata:existing'] },
      }

      const result = migrateContextTabsState<Record<string, any>>(v0, 0)
      expect(result.tabOrderBySpace.sp1).toContain('tabdata:existing')
      expect(result.tabOrderBySpace.sp1).toContain('tabdata:tbl-1')
      expect(result.tabOrderBySpace.sp1).toContain('tabdata:tbl-2')
      expect(result.openTableTabsByProject).toBeUndefined()
    })

    it('legacy activeTabByProject → 合并到 activeKeyBySpace', () => {
      const v0: Record<string, any> = {
        activeTabByProject: {
          sp1: { type: 'tabweb', viewId: 'view-99' },
        },
      }

      const result = migrateContextTabsState<Record<string, any>>(v0, 0)
      expect(result.activeKeyBySpace.sp1).toBe('tabweb:view-99')
      expect(result.activeTabByProject).toBeUndefined()
    })

    it('legacy activeTabByProject 不覆盖已有 activeKeyBySpace', () => {
      const v0: Record<string, any> = {
        activeTabByProject: {
          sp1: { type: 'tabweb', viewId: 'old-view' },
        },
        activeKeyBySpace: { sp1: 'tabdata:keep-me' },
      }

      const result = migrateContextTabsState<Record<string, any>>(v0, 0)
      expect(result.activeKeyBySpace.sp1).toBe('tabdata:keep-me')
    })

    it('不改变不需要迁移的 tabKey', () => {
      const v0: Record<string, any> = {
        tabOrderBySpace: { sp1: ['tabdata:t1', 'tabweb:v1'] },
        activeKeyBySpace: { sp1: 'tabweb:v1' },
        itemsBySpace: {
          sp1: {
            'tabdata:t1': { tabKey: 'tabdata:t1', type: 'tabdata', id: 't1' },
            'tabweb:v1': { tabKey: 'tabweb:v1', type: 'tabweb', id: 'v1' },
          },
        },
      }

      const result = migrateContextTabsState<Record<string, any>>(v0, 0)
      expect(result.tabOrderBySpace.sp1).toEqual(['tabdata:t1', 'tabweb:v1'])
      expect(result.activeKeyBySpace.sp1).toBe('tabweb:v1')
    })
  })

  it('version >= 1 → 不执行 v0→v1 迁移', () => {
    const input: Record<string, any> = {
      activeKeyByProject: { sp1: 'tabdata:t1' },
    }

    const result = migrateContextTabsState<Record<string, any>>(input, 1)
    expect(result.activeKeyByProject).toBeDefined()
  })

  it('null/undefined 输入 → 不崩溃', () => {
    expect(() => migrateContextTabsState(null, 0)).not.toThrow()
    expect(() => migrateContextTabsState(undefined, 0)).not.toThrow()
  })
})
