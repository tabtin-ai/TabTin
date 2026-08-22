import { describe, expect, it } from 'vitest'

import { resolveChatContextDisplay } from '../resolveChatContextDisplay'

const t = ((key: string) => {
  const labels: Record<string, string> = {
    'panel.contextAgent': 'Agent',
    'panel.contextTable': 'TabData',
    'panel.contextWeb': '网页',
    'panel.contextNewWebTab': '新标签',
  }
  return labels[key] ?? key
}) as Parameters<typeof resolveChatContextDisplay>[0]['t']

const baseInput = {
  activeContextKey: null,
  activeContextType: null,
  activeTable: null,
  activeAppMeta: null,
  activeTabTitle: null,
  activeTabMeta: null,
  spaceName: 'Research Space',
  t,
}

describe('resolveChatContextDisplay', () => {
  it('无 active tab 时显示 Agent 与 Space 名', () => {
    expect(resolveChatContextDisplay(baseInput)).toEqual({
      icon: '📍',
      label: 'Agent',
      name: 'Research Space',
      type: 'chat',
    })
  })

  it('TabData 显示表名', () => {
    expect(resolveChatContextDisplay({
      ...baseInput,
      activeContextKey: 'tabdata:tbl-1',
      activeContextType: 'tabdata',
      activeTable: { name: '36氪项目库' },
    })).toEqual({
      icon: '📍',
      label: 'TabData',
      name: '36氪项目库',
      type: 'chat',
    })
  })

  it('TabDoc 显示文档标题', () => {
    expect(resolveChatContextDisplay({
      ...baseInput,
      activeContextKey: 'tabdoc:doc-1',
      activeContextType: 'tabdoc',
      activeAppMeta: { current_doc_id: 'doc-1', current_doc_title: '需求 spec' },
    })).toMatchObject({
      label: '文档',
      name: '需求 spec',
    })
  })

  it('Browser 显示网页标题并带浏览器图标', () => {
    expect(resolveChatContextDisplay({
      ...baseInput,
      activeContextKey: 'tabweb:view-1',
      activeContextType: 'tabweb',
      activeAppMeta: {
        current_browser_title: 'GitHub',
        current_browser_url: 'https://github.com',
      },
    })).toEqual({
      icon: '🌐',
      label: '网页',
      name: 'GitHub',
      type: 'chat',
    })
  })

  it('Browser 标题缺失时回退到新标签，不显示 URL', () => {
    expect(resolveChatContextDisplay({
      ...baseInput,
      activeContextKey: 'tabweb:view-1',
      activeContextType: 'tabweb',
      activeAppMeta: { current_browser_url: 'https://example.com' },
    })).toMatchObject({
      name: '新标签',
    })
  })

  it('Browser 标题为 URL 时忽略并回退到新标签', () => {
    expect(resolveChatContextDisplay({
      ...baseInput,
      activeContextKey: 'tabweb:view-1',
      activeContextType: 'tabweb',
      activeAppMeta: {
        current_browser_title: 'https://accounts.feishu.cn/login',
        current_browser_url: 'https://accounts.feishu.cn/login',
      },
    })).toMatchObject({
      name: '新标签',
    })
  })

  it('activeAppMeta 无标题时回退 tab store title', () => {
    expect(resolveChatContextDisplay({
      ...baseInput,
      activeContextKey: 'tabdoc:doc-2',
      activeContextType: 'tabdoc',
      activeTabTitle: 'Deep link 文档',
    })).toMatchObject({
      label: '文档',
      name: 'Deep link 文档',
    })
  })

  it('Terminal 显示 cwd', () => {
    expect(resolveChatContextDisplay({
      ...baseInput,
      activeContextKey: 'terminal:term-1',
      activeContextType: 'terminal',
      activeTabTitle: 'Terminal',
      activeAppMeta: { current_terminal_cwd: '/Users/dev/project' },
    })).toMatchObject({
      label: '终端',
      name: '/Users/dev/project',
    })
  })

  it('目录上下文优先显示当前文件，关闭预览后回退目录名', () => {
    expect(resolveChatContextDisplay({
      ...baseInput,
      activeContextKey: 'tabfolder:folder-1',
      activeContextType: 'tabfolder',
      activeAppMeta: {
        current_folder_path: 'C:\\workspace\\project',
        current_file_path: 'C:\\workspace\\project\\src\\index.ts',
      },
    })).toMatchObject({
      label: '目录',
      name: 'C:\\workspace\\project\\src\\index.ts',
    })

    expect(resolveChatContextDisplay({
      ...baseInput,
      activeContextKey: 'tabfolder:folder-1',
      activeContextType: 'tabfolder',
      activeAppMeta: {
        current_folder_path: 'C:\\workspace\\project',
        current_file_path: null,
      },
    })).toMatchObject({
      name: 'project',
    })
  })
})
