import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  chatState,
  browserState,
  createSessionMock,
  sendMessageMock,
  setChatSidePanelCollapsedMock,
  setActiveKeyMock,
  logInfoMock,
  logWarnMock,
  requestAppCollaborationMock,
} = vi.hoisted(() => ({
  chatState: {
    currentSessionId: null as string | null,
    currentSessionIdBySpaceId: {} as Record<string, string>,
  },
  browserState: {
    activeKey: 'tabweb:view-1' as string | null,
    activeViewId: 'view-1' as string | null,
    views: [{
      viewId: 'view-1',
      title: '36Kr 项目列表',
      url: 'https://pitchhub.36kr.com/projects?sort=3',
      favicon: 'https://pitchhub.36kr.com/favicon.ico',
      createdAt: 1,
    }],
  },
  createSessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  setChatSidePanelCollapsedMock: vi.fn(),
  setActiveKeyMock: vi.fn(),
  logInfoMock: vi.fn(),
  logWarnMock: vi.fn(),
  requestAppCollaborationMock: vi.fn(),
}))

vi.mock('@/services/requestAppCollaboration', () => ({
  requestAppCollaboration: requestAppCollaborationMock,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  },
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: logInfoMock,
    warn: logWarnMock,
  }),
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({ selectedOrganization: { id: 'organization-1' } }),
  },
}))

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({ setChatSidePanelCollapsed: setChatSidePanelCollapsedMock }),
  },
}))

vi.mock('@/stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      getActiveKey: () => browserState.activeKey,
      setActiveKey: setActiveKeyMock,
    }),
  },
}))

vi.mock('@/stores/useCrawlTabStore', () => ({
  useCrawlTabStore: {
    getState: () => ({
      crawlspaceContextCache: {
        'crawlspace-1': {
          activeViewId: browserState.activeViewId,
          viewList: browserState.views,
        },
      },
      getSpaceCrawlspace: () => ({ id: 'crawlspace-1' }),
      getActiveCrawlspaceViewId: () => browserState.activeViewId,
      getCrawlspaceViews: () => browserState.views,
    }),
  },
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      ...chatState,
      createSession: createSessionMock,
      sendMessage: sendMessageMock,
    }),
  },
}))

import { requestAgentForBrowser } from './requestAgentForBrowser'

describe('requestAgentForBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatState.currentSessionId = null
    chatState.currentSessionIdBySpaceId = {}
    browserState.activeKey = 'tabweb:view-1'
    browserState.activeViewId = 'view-1'
    browserState.views = [{
      viewId: 'view-1',
      title: '36Kr 项目列表',
      url: 'https://pitchhub.36kr.com/projects?sort=3',
      favicon: 'https://pitchhub.36kr.com/favicon.ico',
      createdAt: 1,
    }]
    createSessionMock.mockImplementation(async (spaceId: string) => {
      chatState.currentSessionId = 'session-1'
      chatState.currentSessionIdBySpaceId[spaceId] = 'session-1'
    })
    sendMessageMock.mockResolvedValue(undefined)
  })

  it('发送浏览器 AI 任务时附带当前网页 context block', async () => {
    await requestAgentForBrowser(
      'space-1',
      '请你帮我把这个页面的内容采集到多维表格',
      { source: 'manual' },
    )

    expect(requestAppCollaborationMock).toHaveBeenCalledWith({
      sourceLabel: '浏览器',
      spaceId: 'space-1',
      prompt: '请你帮我把这个页面的内容采集到多维表格',
      contextBlocks: [{
        type: 'webpage',
        preview: '36Kr 项目列表',
        url: 'https://pitchhub.36kr.com/projects?sort=3',
        page_title: '36Kr 项目列表',
        tab_type: 'tabweb',
        favicon: 'https://pitchhub.36kr.com/favicon.ico',
      }],
    })
  })

  it('没有明确 active view 且存在多个网页时不猜测当前页', async () => {
    browserState.activeKey = null
    browserState.activeViewId = null
    browserState.views = [
      {
        viewId: 'view-1',
        title: '36Kr 项目列表',
        url: 'https://pitchhub.36kr.com/projects?sort=3',
        createdAt: 1,
      },
      {
        viewId: 'view-2',
        title: 'Example Domain',
        url: 'https://example.com',
        createdAt: 2,
      },
    ]

    await requestAgentForBrowser(
      'space-1',
      '请你帮我把这个页面的内容采集到多维表格',
      { source: 'manual' },
    )

    expect(requestAppCollaborationMock).toHaveBeenCalledWith({
      sourceLabel: '浏览器',
      spaceId: 'space-1',
      prompt: '请你帮我把这个页面的内容采集到多维表格',
      contextBlocks: undefined,
    })
  })
})
