import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'panel.contextAgent': 'Agent',
        'panel.contextTable': 'TabData',
        'panel.contextWeb': '网页',
        'panel.contextNewWebTab': '新标签',
      }
      return labels[key] ?? key
    },
  }),
}))

import { useCrawlTabStore } from '@/stores/useCrawlTabStore'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import {
  buildFocusedSurfaceContextKey,
  useFocusedSurfaceStore,
} from '@/stores/useFocusedSurfaceStore'
import { selectCrawlViewMetaDeps, useChatPanelContext } from '../useChatPanelContext'

function makeCrawlState(view: { viewId: string; url: string; title: string }) {
  return {
    crawlspaceContextCache: {
      'crawlspace-1': {
        activeViewId: view.viewId,
        viewList: [{
          ...view,
          createdAt: 1,
        }],
      },
    },
  } as unknown as Parameters<typeof selectCrawlViewMetaDeps>[0]
}

beforeEach(() => {
  useSpaceContextTabsStore.setState({
    activeKeyBySpace: {},
    displayKeyBySpace: {},
    tabOrderBySpace: {},
    itemsBySpace: {},
    lastActiveSubagentByParentSession: {},
  })
  useCrawlTabStore.setState({
    crawlspaceContextCache: {},
  })
  useFocusedSurfaceStore.setState({ byContextKey: {} })
})

describe('selectCrawlViewMetaDeps', () => {
  it('浏览器页面标题更新时改变订阅值，触发当前网页上下文重算', () => {
    const input = { activeContextType: 'tabweb', activeContextId: 'view-1' }
    const beforeTitle = selectCrawlViewMetaDeps(
      makeCrawlState({
        viewId: 'view-1',
        url: 'https://s.taobao.com/search?q=%E4%B8%89%E4%BD%93',
        title: '',
      }),
      input,
    )
    const afterTitle = selectCrawlViewMetaDeps(
      makeCrawlState({
        viewId: 'view-1',
        url: 'https://s.taobao.com/search?q=%E4%B8%89%E4%BD%93',
        title: '三体 - 淘宝搜索',
      }),
      input,
    )

    expect(beforeTitle).toBe('https://s.taobao.com/search?q=%E4%B8%89%E4%BD%93|')
    expect(afterTitle).toBe('https://s.taobao.com/search?q=%E4%B8%89%E4%BD%93|三体 - 淘宝搜索')
  })

  it('非浏览器上下文不订阅 crawl view 变化', () => {
    expect(selectCrawlViewMetaDeps(
      makeCrawlState({
        viewId: 'view-1',
        url: 'https://example.com',
        title: 'Example',
      }),
      { activeContextType: 'tabdoc', activeContextId: 'view-1' },
    )).toBe('')
  })
})

describe('useChatPanelContext', () => {
  it('当前文档重命名后立即刷新 composer 上下文名称', () => {
    const space = { id: 'space-1', name: 'Research Space', organization_id: 'wt-1' }
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: { 'space-1': 'tabdoc:doc-1' },
      displayKeyBySpace: { 'space-1': 'tabdoc:doc-1' },
      tabOrderBySpace: { 'space-1': ['tabdoc:doc-1'] },
      itemsBySpace: {
        'space-1': {
          'tabdoc:doc-1': {
            tabKey: 'tabdoc:doc-1',
            type: 'tabdoc',
            id: 'doc-1',
            title: '旧文档名',
          },
        },
      },
    })

    const { result } = renderHook(() => useChatPanelContext({
      selectedSpace: space,
      tables: [],
      variant: 'panel',
    }))

    expect(result.current.contextDisplay.name).toBe('旧文档名')

    act(() => {
      useSpaceContextTabsStore.getState().syncOpenResourceTabTitle({
        type: 'tabdoc',
        id: 'doc-1',
        title: '新文档名',
      })
    })

    expect(result.current.contextDisplay.name).toBe('新文档名')
  })

  it('同一浏览器 view 标题稍晚到达时，当前上下文从新标签刷新为网页标题', () => {
    const space = { id: 'space-1', name: 'Research Space', organization_id: 'wt-1' }
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: { 'space-1': 'tabweb:view-1' },
      displayKeyBySpace: { 'space-1': 'tabweb:view-1' },
      tabOrderBySpace: { 'space-1': ['tabweb:view-1'] },
      itemsBySpace: {
        'space-1': {
          'tabweb:view-1': {
            tabKey: 'tabweb:view-1',
            type: 'tabweb',
            id: 'view-1',
            title: '',
            meta: { url: 'https://s.taobao.com/search?q=%E4%B8%89%E4%BD%93' },
          },
        },
      },
    })
    useCrawlTabStore.setState(makeCrawlState({
      viewId: 'view-1',
      url: 'https://s.taobao.com/search?q=%E4%B8%89%E4%BD%93',
      title: '',
    }))

    const { result } = renderHook(() => useChatPanelContext({
      selectedSpace: space,
      tables: [],
      variant: 'panel',
    }))

    expect(result.current.contextDisplay.name).toBe('新标签')

    act(() => {
      useCrawlTabStore.setState(makeCrawlState({
        viewId: 'view-1',
        url: 'https://s.taobao.com/search?q=%E4%B8%89%E4%BD%93',
        title: '三体 - 淘宝搜索',
      }))
    })

    expect(result.current.contextDisplay.name).toBe('三体 - 淘宝搜索')
  })

  it('应用首页切换时，把 apphome 的 id 归一化为真实 App 类型', () => {
    const space = { id: 'space-1', name: 'Research Space', organization_id: 'wt-1' }
    const tabKey = 'apphome:space-2'
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: { 'space-1': tabKey },
      displayKeyBySpace: { 'space-1': tabKey },
      tabOrderBySpace: { 'space-1': [tabKey] },
      itemsBySpace: {
        'space-1': {
          [tabKey]: {
            tabKey,
            type: 'apphome',
            id: 'space-2',
            title: '多维表',
            meta: { appId: 'tabdata' },
          },
        },
      },
    })

    const { result } = renderHook(() => useChatPanelContext({
      selectedSpace: space,
      tables: [],
      variant: 'panel',
    }))

    expect(result.current.activeContextType).toBe('tabdata')
  })

  it('Agent 首页内嵌目录的文件焦点实时覆盖首页上下文', () => {
    const space = { id: 'space-1', name: 'Research Space', organization_id: 'wt-1' }
    const tabKey = 'apphome:orchestration'
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: { 'space-1': tabKey },
      displayKeyBySpace: { 'space-1': tabKey },
      tabOrderBySpace: { 'space-1': [tabKey] },
      itemsBySpace: {
        'space-1': {
          [tabKey]: {
            tabKey,
            type: 'apphome',
            id: 'orchestration',
            title: 'Research Space 的目录',
            meta: { appId: 'orchestration' },
          },
        },
      },
    })
    const focusKey = buildFocusedSurfaceContextKey('space-1', tabKey)!
    useFocusedSurfaceStore.getState().report(focusKey, 1, {
      appType: 'tabfolder',
      rootPath: '/workspace/project',
      focusedFilePath: '/workspace/project/src/index.ts',
    })

    const { result } = renderHook(() => useChatPanelContext({
      selectedSpace: space,
      tables: [],
      variant: 'panel',
    }))

    expect(result.current.activeContextType).toBe('tabfolder')
    expect(result.current.activeAppMeta).toMatchObject({
      current_folder_path: '/workspace/project',
      current_file_path: '/workspace/project/src/index.ts',
    })
    expect(result.current.contextDisplay).toMatchObject({
      label: '目录',
      name: '/workspace/project/src/index.ts',
    })
    expect(result.current.openTabs?.[0]).toMatchObject({
      type: 'tabfolder',
      title: 'src/index.ts',
      path: '/workspace/project/src/index.ts',
      active: true,
      app_key: 'tabfolder',
    })

    act(() => {
      useFocusedSurfaceStore.getState().report(focusKey, 1, {
        appType: 'tabfolder',
        rootPath: '/workspace/project',
        focusedFilePath: null,
      })
    })

    expect(result.current.activeAppMeta?.current_file_path).toBeNull()
    expect(result.current.contextDisplay.name).toBe('project')
  })
})
