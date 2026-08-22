import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenOutcome } from '@tabtin/resource-router'

const { resourceRouterOpen, openProjectTaskDocumentPreview } = vi.hoisted(() => ({
  resourceRouterOpen: vi.fn(),
  openProjectTaskDocumentPreview: vi.fn(() => false),
}))

vi.mock('@tabtin/resource-router', () => ({
  parseResourcePointer: (href: string) => {
    const match = /^(?:tabtin|tabtin-preprod|tabtin-dev):\/\/resource\/([^/?#]+)\/([^?#]+)(?:\?([^#]*))?/.exec(href)
    if (!match) {
      const url = new URL(href)
      return {
        scheme: url.protocol.slice(0, -1),
        type: null,
        id: href,
        raw: href,
        hint: null,
      }
    }
    const params = new URLSearchParams(match?.[3] ?? '')
    return {
      scheme: 'tabtin',
      type: match ? decodeURIComponent(match[1]!) : 'file',
      id: match ? decodeURIComponent(match[2]!) : href,
      raw: href,
      hint: params.get('hint'),
      meta: Object.fromEntries(params.entries()),
    }
  },
}))

vi.mock('@/services/resourceRouter', () => ({
  resourceRouter: {
    open: (...args: unknown[]) => resourceRouterOpen(...args),
  },
}))

vi.mock('@/services/openProjectTaskDocumentPreview', () => ({
  openProjectTaskDocumentPreview: (...args: unknown[]) =>
    openProjectTaskDocumentPreview(...args),
}))

let selectedSpaceId: string | null = 'space-1'

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      selectedSpace: selectedSpaceId ? { id: selectedSpaceId } : null,
    }),
  },
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      draftExecutionSpaceIdByWorkspaceKey: {},
      getSessionById: () => null,
    }),
  },
}))

const setCanvasCollapsedForScope = vi.fn()
const toast = vi.fn()

vi.mock('@/stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: {
    getState: () => ({ setCanvasCollapsedForScope }),
  },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: (...args: unknown[]) => toast(...args),
}))

vi.mock('@/utils/logger', () => {
  const stub = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  return {
    createLogger: () => stub,
    logger: stub,
  }
})

vi.mock('@/components/chat/subagent/openSubagentTab', () => ({
  resolveBrowserOpenTabScopeKey: (spaceId: string, tabScopeKey?: string | null) =>
    (tabScopeKey && String(tabScopeKey).trim()) || `desktop:fg:${spaceId}`,
}))

const openResourcePreview = vi.fn(() => true)

vi.mock('@/components/chat/preview/useResourcePreviewStore', () => ({
  useResourcePreviewStore: {
    getState: () => ({
      open: (...args: unknown[]) => (openResourcePreview as (...items: unknown[]) => unknown)(...args),
    }),
  },
}))

vi.mock('@/components/chat/context/ResourceLinkContextMenu', () => ({
  showResourceLinkContextMenu: vi.fn(),
}))

import { showResourceLinkContextMenu } from '@/components/chat/context/ResourceLinkContextMenu'
import {
  expandCanvasAfterInSpaceOpen,
  expandCanvasForScope,
  handleResourceLinkClick,
  handleResourceLinkContextMenu,
  openResourceUrlInSpace,
} from '@/services/openResourceLink'

const IN_SPACE_OPENED: OpenOutcome = {
  outcome: 'in_space_opened',
  carrierAppId: 'tabdoc',
  resolveSource: 'manifest_default',
  durationMs: 1,
}

describe('expandCanvasForScope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('有 tabScopeKey 时展开画布', () => {
    expandCanvasForScope('conversation:session-1')
    expect(setCanvasCollapsedForScope).toHaveBeenCalledWith('conversation:session-1', false)
  })

  it('无 tabScopeKey 时不展开', () => {
    expandCanvasForScope(null)
    expect(setCanvasCollapsedForScope).not.toHaveBeenCalled()
  })
})

describe('expandCanvasAfterInSpaceOpen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('in_space_opened + tabScopeKey 时展开画布', () => {
    expandCanvasAfterInSpaceOpen('conversation:session-1', IN_SPACE_OPENED)
    expect(setCanvasCollapsedForScope).toHaveBeenCalledWith('conversation:session-1', false)
  })

  it('无 tabScopeKey 时不展开', () => {
    expandCanvasAfterInSpaceOpen(null, IN_SPACE_OPENED)
    expect(setCanvasCollapsedForScope).not.toHaveBeenCalled()
  })

  it('outcome 非 in_space_opened 时不展开', () => {
    expandCanvasAfterInSpaceOpen('conversation:session-1', {
      outcome: 'error',
      carrierAppId: null,
      resolveSource: 'system_fallback',
      errorMessage: 'fail',
      durationMs: 1,
    })
    expect(setCanvasCollapsedForScope).not.toHaveBeenCalled()
  })
})

describe('openResourceUrlInSpace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectedSpaceId = 'space-1'
    openProjectTaskDocumentPreview.mockReturnValue(false)
    resourceRouterOpen.mockResolvedValue(IN_SPACE_OPENED)
    openResourcePreview.mockReturnValue(true)
  })

  it('https xlsx 直链打开预览 Modal，不进 tabweb', async () => {
    const href = 'https://assets.example.com/tabfiles/uploads/a.xlsx'
    const outcome = await openResourceUrlInSpace(href, 'conversation:session-1')

    expect(openResourcePreview).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'xlsx',
        url: href,
        name: 'a.xlsx',
      }),
    ], 0)
    expect(resourceRouterOpen).not.toHaveBeenCalled()
    expect(setCanvasCollapsedForScope).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({
      outcome: 'in_space_opened',
      carrierAppId: 'chat-preview',
    })
  })

  it('无扩展名 URL 可通过 OpenIntentHints 打开预览 Modal', async () => {
    const href = 'https://assets.example.com/object'
    const openIntentHints = {
      filename: 'report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      assetId: 'file-1',
    }

    const outcome = await openResourceUrlInSpace(
      href,
      'conversation:session-1',
      { openIntentHints },
    )

    expect(openResourcePreview).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'xlsx',
        url: href,
        name: 'report.xlsx',
        fileId: 'file-1',
      }),
    ], 0)
    expect(resourceRouterOpen).not.toHaveBeenCalled()
    expect(setCanvasCollapsedForScope).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({
      outcome: 'in_space_opened',
      carrierAppId: 'chat-preview',
    })
  })

  it('html 网页 URL 仍走 ResourceRouter / BrowserView', async () => {
    const href = 'https://example.com/report'
    await openResourceUrlInSpace(href, 'conversation:session-1')

    expect(openResourcePreview).not.toHaveBeenCalled()
    expect(resourceRouterOpen).toHaveBeenCalled()
  })

  it('Project Task 双宿主文档预览命中时不走 ResourceRouter / openTeamSpaceTabdoc', async () => {
    openProjectTaskDocumentPreview.mockReturnValue(true)
    const href = 'tabtin://resource/document/doc_1?hint=tabdoc'
    const outcome = await openResourceUrlInSpace(href, 'conversation:session-1')

    expect(openProjectTaskDocumentPreview).toHaveBeenCalledWith({
      resourceType: 'document',
      resourceId: 'doc_1',
      tabScopeKey: 'conversation:session-1',
    })
    expect(resourceRouterOpen).not.toHaveBeenCalled()
    expect(outcome).toEqual({
      outcome: 'in_space_opened',
      carrierAppId: 'tabdoc',
      resolveSource: 'manifest_default',
    })
    expect(setCanvasCollapsedForScope).not.toHaveBeenCalled()
  })

  it('成功在 Space 内打开后自动展开画布', async () => {
    const href = 'tabtin://resource/document/doc_1?hint=tabdoc'
    await openResourceUrlInSpace(href, 'conversation:session-1')

    expect(resourceRouterOpen).toHaveBeenCalled()
    expect(setCanvasCollapsedForScope).toHaveBeenCalledWith('conversation:session-1', false)
  })

  it('ResourceRouter 入口把 OpenIntentHints 写入 pointer meta', async () => {
    const href = 'tabtin://resource/file/file_1?hint=tabfiles&title=Signed'
    const hints = {
      filename: 'report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      assetId: 'file_1',
    }

    await openResourceUrlInSpace(href, 'conversation:session-1', { openIntentHints: hints })

    expect(resourceRouterOpen).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({
        meta: expect.objectContaining({
          title: 'Signed',
          openIntentHints: hints,
        }),
      }),
      expect.anything(),
    )
  })

  it('未传 tabScopeKey 时按前台 scope 展开画布', async () => {
    const href = 'tabtin://resource/document/doc_1?hint=tabdoc'
    await openResourceUrlInSpace(href)

    expect(resourceRouterOpen).toHaveBeenCalledWith(
      'space-1',
      expect.anything(),
      expect.objectContaining({ tabScopeKey: 'desktop:fg:space-1' }),
    )
    expect(setCanvasCollapsedForScope).toHaveBeenCalledWith('desktop:fg:space-1', false)
  })

  it('无 Space 的 IM 会话仍在内部打开 tabtin 文件资源', async () => {
    selectedSpaceId = null
    const href = 'tabtin://resource/file/artifacts%2Freport.xlsx?hint=tabfiles'

    await openResourceUrlInSpace(href, 'im:conversation-1')

    expect(resourceRouterOpen).toHaveBeenCalledWith(
      '',
      expect.objectContaining({ raw: href, scheme: 'tabtin', type: 'file' }),
      expect.objectContaining({
        triggerSource: 'window_open_fallback',
        tabScopeKey: 'im:conversation-1',
      }),
    )
    expect(resourceRouterOpen).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ modifierExternal: true }),
    )
    expect(setCanvasCollapsedForScope).toHaveBeenCalledWith('im:conversation-1', false)
  })

  it('无 Space 的 IM 会话仍在内部打开 tabtin-preprod 文件资源', async () => {
    selectedSpaceId = null
    const href = 'tabtin-preprod://resource/file/artifacts%2Freport.xlsx?hint=tabfiles'

    await openResourceUrlInSpace(href, 'im:conversation-1')

    expect(resourceRouterOpen).toHaveBeenCalledWith(
      '',
      expect.objectContaining({ raw: href, scheme: 'tabtin', type: 'file' }),
      expect.objectContaining({
        triggerSource: 'window_open_fallback',
        tabScopeKey: 'im:conversation-1',
      }),
    )
    expect(resourceRouterOpen).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ modifierExternal: true }),
    )
  })

  it('Markdown 少写 https 的 www. 外链归一化后再打开', async () => {
    selectedSpaceId = null
    await openResourceUrlInSpace('www.baidu.com', 'im:conversation-1')

    expect(resourceRouterOpen).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        scheme: 'https',
        raw: 'https://www.baidu.com',
      }),
      expect.objectContaining({
        triggerSource: 'window_open_fallback',
        modifierExternal: true,
      }),
    )
  })

  it.each([
    'https://example.com/report',
    'mailto:hello@example.com',
  ])('无 Space 时外链 %s 仍走既有系统外开通道', async (href) => {
    selectedSpaceId = null

    await openResourceUrlInSpace(href, 'im:conversation-1')

    expect(resourceRouterOpen).toHaveBeenCalledWith(
      '',
      expect.anything(),
      expect.objectContaining({
        triggerSource: 'window_open_fallback',
        modifierExternal: true,
      }),
    )
  })

  it('失败默认弹 toast', async () => {
    resourceRouterOpen.mockResolvedValue({
      outcome: 'error',
      carrierAppId: null,
      resolveSource: 'system_fallback',
      errorMessage: 'boom',
      durationMs: 1,
    })
    await openResourceUrlInSpace('tabtin://resource/document/doc_1?hint=tabdoc')
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: '无法打开链接',
      description: 'boom',
    }))
  })

  it('suppressErrorToast 时失败不弹 toast', async () => {
    resourceRouterOpen.mockResolvedValue({
      outcome: 'error',
      carrierAppId: null,
      resolveSource: 'system_fallback',
      errorMessage: 'boom',
      durationMs: 1,
    })
    await openResourceUrlInSpace(
      'tabtin://resource/document/doc_1?hint=tabdoc',
      'conversation:session-1',
      { suppressErrorToast: true },
    )
    expect(toast).not.toHaveBeenCalled()
  })
})

describe('handleResourceLinkClick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openResourcePreview.mockReturnValue(true)
    resourceRouterOpen.mockResolvedValue(IN_SPACE_OPENED)
  })

  it('IM/Markdown 同源：xlsx URL 普通点击进预览 Modal', () => {
    const preventDefault = vi.fn()
    handleResourceLinkClick(
      { preventDefault, metaKey: false, ctrlKey: false } as never,
      'https://cdn.example.com/sheet.xls',
      'conversation:session-1',
    )

    expect(preventDefault).toHaveBeenCalled()
    expect(openResourcePreview).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'xlsx', name: 'sheet.xls' }),
    ], 0)
    expect(resourceRouterOpen).not.toHaveBeenCalled()
  })

  it('⌘+click 不拦截，仍走系统应用逃生通道', () => {
    handleResourceLinkClick(
      { preventDefault: vi.fn(), metaKey: true, ctrlKey: false } as never,
      'https://cdn.example.com/sheet.xlsx',
      'conversation:session-1',
    )

    expect(openResourcePreview).not.toHaveBeenCalled()
    expect(resourceRouterOpen).toHaveBeenCalledWith(
      'space-1',
      expect.anything(),
      expect.objectContaining({ modifierExternal: true }),
    )
  })

  it('www. 外链补 https 后再派发', () => {
    handleResourceLinkClick(
      { preventDefault: vi.fn(), metaKey: false, ctrlKey: false } as never,
      'www.baidu.com',
      'conversation:session-1',
    )

    expect(resourceRouterOpen).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({
        scheme: 'https',
        raw: 'https://www.baidu.com',
      }),
      expect.objectContaining({ triggerSource: 'window_open_fallback' }),
    )
  })
})

describe('handleResourceLinkContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('右键菜单复制/外开使用补了 https 的地址', () => {
    handleResourceLinkContextMenu(
      { preventDefault: vi.fn(), clientX: 12, clientY: 34 } as never,
      'www.baidu.com',
      'im:conversation-1',
    )

    expect(showResourceLinkContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'https://www.baidu.com',
        pointer: expect.objectContaining({
          scheme: 'https',
          raw: 'https://www.baidu.com',
        }),
      }),
    )
  })
})
