import { describe, expect, it } from 'vitest'
import type { ContextItemRecord } from '@stores/useSpaceContextTabsStore'
import {
  CLOUD_DOCS_HOME_TAB_KEY,
  buildCloudDocsResourceTabKey,
  isCloudDocsDockTabKey,
  resolveCloudDocsCloseFallback,
  selectCloudDocsDockTabs,
  selectCloudDocsOpenResourceTabKeys,
} from '../cloudDocsOpenTabs'

function makeItem(overrides: Partial<ContextItemRecord>): ContextItemRecord {
  return {
    tabKey: 'tabdoc:doc-1',
    type: 'tabdoc',
    id: 'doc-1',
    title: '未命名文档',
    meta: null,
    ...overrides,
  }
}

describe('cloudDocsOpenTabs', () => {
  it('recognizes cloud-docs dock tab keys', () => {
    expect(isCloudDocsDockTabKey(CLOUD_DOCS_HOME_TAB_KEY)).toBe(true)
    expect(isCloudDocsDockTabKey('tabdoc:doc-1')).toBe(true)
    expect(isCloudDocsDockTabKey('tabdata:table-1')).toBe(true)
    expect(isCloudDocsDockTabKey('file:file-1')).toBe(true)
    // ：防御性也认后端 item_type 'tabfiles:' 前缀
    expect(isCloudDocsDockTabKey('tabfiles:file-1')).toBe(true)
    expect(isCloudDocsDockTabKey('tabweb:view-1')).toBe(true)
    expect(isCloudDocsDockTabKey('desktop:')).toBe(false)
    expect(isCloudDocsDockTabKey('tabfolder:folder-1')).toBe(false)
  })

  it('builds file dock tabs and normalizes legacy tabfiles: prefix', () => {
    const tabs = selectCloudDocsDockTabs({
      tabOrder: [CLOUD_DOCS_HOME_TAB_KEY, 'file:file-1'],
      itemsByKey: {
        [CLOUD_DOCS_HOME_TAB_KEY]: makeItem({
          tabKey: CLOUD_DOCS_HOME_TAB_KEY,
          type: 'apphome',
          id: 'cloud-resources',
          title: '云文档',
        }),
        'file:file-1': makeItem({
          tabKey: 'file:file-1',
          type: 'file',
          id: 'file-1',
          title: '报告.pdf',
        }),
      },
    })
    expect(tabs.map(tab => tab.tabKey)).toEqual([CLOUD_DOCS_HOME_TAB_KEY, 'file:file-1'])
    expect(tabs[1]?.kind).toBe('file')
    expect(tabs[1]?.closable).toBe(true)
  })

  it('pins home tab first and filters non cloud-docs tabs', () => {
    const tabs = selectCloudDocsDockTabs({
      tabOrder: [
        'tabdoc:doc-1',
        CLOUD_DOCS_HOME_TAB_KEY,
        'tabdata:table-1',
        'tabweb:view-1',
      ],
      itemsByKey: {
        [CLOUD_DOCS_HOME_TAB_KEY]: makeItem({
          tabKey: CLOUD_DOCS_HOME_TAB_KEY,
          type: 'apphome',
          id: 'cloud-resources',
          title: '云文档',
        }),
        'tabdoc:doc-1': makeItem({ tabKey: 'tabdoc:doc-1', title: '文档 A' }),
        'tabdata:table-1': makeItem({
          tabKey: 'tabdata:table-1',
          type: 'tabdata',
          id: 'table-1',
          title: '表格 B',
        }),
        'tabweb:view-1': makeItem({
          tabKey: 'tabweb:view-1',
          type: 'tabweb',
          id: 'view-1',
          title: 'Demo HTML',
        }),
      },
    })

    expect(tabs.map(tab => tab.tabKey)).toEqual([
      CLOUD_DOCS_HOME_TAB_KEY,
      'tabdoc:doc-1',
      'tabdata:table-1',
      'tabweb:view-1',
    ])
    expect(tabs[0]?.closable).toBe(false)
    expect(tabs[1]?.closable).toBe(true)
  })

  it('builds resource tab keys for dock highlight', () => {
    expect(buildCloudDocsResourceTabKey({ itemType: 'tabdoc', resourceId: 'doc-1' })).toBe('tabdoc:doc-1')
    expect(buildCloudDocsResourceTabKey({ itemType: 'file', resourceId: 'file-1' })).toBe('file:file-1')
    // ：后端 item_type 'tabfiles' 归一化为前端 'file'
    expect(buildCloudDocsResourceTabKey({ itemType: 'tabfiles', resourceId: 'file-1' })).toBe('file:file-1')
    expect(buildCloudDocsResourceTabKey({ itemType: 'tabfolder', resourceId: 'f-1' })).toBeNull()
  })

  it('collects open resource tab keys from dock tabs', () => {
    const keys = selectCloudDocsOpenResourceTabKeys({
      tabOrder: [CLOUD_DOCS_HOME_TAB_KEY, 'tabdoc:doc-1', 'tabdata:table-1'],
      itemsByKey: {
        [CLOUD_DOCS_HOME_TAB_KEY]: makeItem({
          tabKey: CLOUD_DOCS_HOME_TAB_KEY,
          type: 'apphome',
          id: 'cloud-resources',
        }),
        'tabdoc:doc-1': makeItem({ tabKey: 'tabdoc:doc-1' }),
        'tabdata:table-1': makeItem({
          tabKey: 'tabdata:table-1',
          type: 'tabdata',
          id: 'table-1',
        }),
      },
    })
    expect([...keys]).toEqual(['tabdoc:doc-1', 'tabdata:table-1'])
  })

  it('resolves close fallback to neighbor then home', () => {
    const dockTabs = selectCloudDocsDockTabs({
      tabOrder: [CLOUD_DOCS_HOME_TAB_KEY, 'tabdoc:doc-1', 'tabdata:table-1'],
      itemsByKey: {
        [CLOUD_DOCS_HOME_TAB_KEY]: makeItem({
          tabKey: CLOUD_DOCS_HOME_TAB_KEY,
          type: 'apphome',
          id: 'cloud-resources',
          title: '云文档',
        }),
        'tabdoc:doc-1': makeItem({ tabKey: 'tabdoc:doc-1' }),
        'tabdata:table-1': makeItem({
          tabKey: 'tabdata:table-1',
          type: 'tabdata',
          id: 'table-1',
        }),
      },
    })

    expect(resolveCloudDocsCloseFallback(dockTabs, 'tabdoc:doc-1')).toBe(CLOUD_DOCS_HOME_TAB_KEY)
    expect(resolveCloudDocsCloseFallback(dockTabs, 'tabdata:table-1')).toBe('tabdoc:doc-1')
    expect(resolveCloudDocsCloseFallback(dockTabs, CLOUD_DOCS_HOME_TAB_KEY)).toBe('tabdoc:doc-1')
  })

  it('falls back to resource id when tab title is missing (dock display bug surface)', () => {
    const tabs = selectCloudDocsDockTabs({
      tabOrder: ['tabdata:b5478d63-2df9-40db-a277-f32ec82377d3'],
      itemsByKey: {
        'tabdata:b5478d63-2df9-40db-a277-f32ec82377d3': makeItem({
          tabKey: 'tabdata:b5478d63-2df9-40db-a277-f32ec82377d3',
          type: 'tabdata',
          id: 'b5478d63-2df9-40db-a277-f32ec82377d3',
          title: undefined,
        }),
      },
    })
    expect(tabs[0]?.title).toBe('b5478d63-2df9-40db-a277-f32ec82377d3')
  })

  it('prefers stored title over resource id', () => {
    const tabs = selectCloudDocsDockTabs({
      tabOrder: ['tabdata:table-1'],
      itemsByKey: {
        'tabdata:table-1': makeItem({
          tabKey: 'tabdata:table-1',
          type: 'tabdata',
          id: 'table-1',
          title: '荷塘表格',
        }),
      },
    })
    expect(tabs[0]?.title).toBe('荷塘表格')
  })
})
