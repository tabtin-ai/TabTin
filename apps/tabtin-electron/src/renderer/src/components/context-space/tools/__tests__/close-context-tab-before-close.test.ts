/**
 * W2.5 T8 回归测试：close_context_tab MCP 工具 beforeClose 数据保护
 *
 * 背景：W2 T5 实装 tabdoc beforeClose 时只覆盖了 UI 路径（useCloseHandlers），
 * Agent 通过 close_context_tab 工具关闭 tab 时仍直接 dispatchClose，绕过保护链路。
 * 用户在人工关 dirty tabdoc 时会看到确认对话框，但 Agent 关同一个 tab 直接销毁数据。
 * 本测试套件锁定 tool 路径与 UI 路径行为完全一致：
 *
 *   1. 无 dirty 等价（dispatchBeforeClose 返回 true）→ 正常 dispatchClose + closeTab
 *   2. 用户主动取消（dispatchBeforeClose 返回 false）
 *      → 提前返回 `{ success: false, code: 'CLOSE_CANCELLED' }`
 *      → 不调用 dispatchClose / closeTab，tab 状态完全不变
 *   3. beforeClose 抛错（如对话框被销毁）
 *      → 返回 `{ success: false, code: 'BEFORE_CLOSE_ERROR' }`
 *      → 错误信息穿透到 Agent，**不静默吞掉**
 *   4. 既有契约保留：spaceId/tabKey 缺失、tabKey 无法解析时不调用 beforeClose
 *
 * 集成层面再验证 tabdoc 三选确认对话框的语义被正确转发到 tool 返回值。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'

// ── Mocks ────────────────────────────────────────────────────────

const mockDispatchBeforeClose = vi.fn()
const mockDispatchClose = vi.fn()
const mockGetAllHandlers = vi.fn(() => [])

vi.mock('../../registry', () => ({
  contextRegistry: {
    dispatchBeforeClose: (...args: unknown[]) => mockDispatchBeforeClose(...args),
    dispatchClose: (...args: unknown[]) => mockDispatchClose(...args),
    dispatchAfterClose: vi.fn(),
    parseTabKey: (key: string) => {
      const idx = key.indexOf(':')
      if (idx <= 0 || idx === key.length - 1) return null
      return { type: key.slice(0, idx), id: key.slice(idx + 1) }
    },
    buildTabKey: (type: string, id: string) => `${type}:${id}`,
    getAllHandlers: () => mockGetAllHandlers(),
    buildCanvasContent: () => null,
  },
}))

vi.mock('../../registry/resolveUtils', () => ({
  resolveTabItemCore: () => null,
}))

const mockSetActiveKey = vi.fn()
const mockCloseTab = vi.fn()
const mockClosePane = vi.fn()
const mockSetTabOrder = vi.fn()

type MutableTabsState = {
  tabOrderBySpace: Record<string, string[]>
  activeKeyBySpace: Record<string, string | null>
  itemsBySpace: Record<string, Record<string, unknown>>
}

const tabsState: MutableTabsState = {
  tabOrderBySpace: {},
  activeKeyBySpace: {},
  itemsBySpace: {},
}

const canvasState: { spaceGroups: Record<string, CanvasLayoutGroup[]> } = {
  spaceGroups: {},
}

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      tabOrderBySpace: tabsState.tabOrderBySpace,
      activeKeyBySpace: tabsState.activeKeyBySpace,
      itemsBySpace: tabsState.itemsBySpace,
      setActiveKey: mockSetActiveKey,
      setTabOrder: mockSetTabOrder,
      closeTab: mockCloseTab,
    }),
  },
}))

vi.mock('@stores/useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: {
    getState: () => ({
      spaceGroups: canvasState.spaceGroups,
      closePane: mockClosePane,
    }),
  },
}))

const mockCloseCrawlspaceView = vi.fn()
vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: {
    getState: () => ({
      tabs: [],
      crawlspaceContextCache: {},
      _recentlyClosedViewIds: new Set<string>(),
      getSpaceCrawlspace: () => null,
      closeCrawlspaceView: mockCloseCrawlspaceView,
      ensureSpaceCrawlspace: vi.fn(),
      ensureNamedCrawlspace: vi.fn(),
      getNamedCrawlspace: vi.fn(),
      getCrawlspaceViews: vi.fn(),
      purgeCrawlspaceData: vi.fn(),
      getSpaceSessionList: vi.fn(),
    }),
  },
}))

vi.mock('@/crawlspace/electron/crawlspace-context-client', () => ({
  crawlspaceContextClient: { setActiveView: vi.fn() },
}))

vi.mock('@/crawlspace/electron/crawl-view-client', () => ({
  crawlViewClient: { loadUrl: vi.fn() },
}))

vi.mock('@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter', () => ({
  createElectronIpcAdapter: () => ({ createView: vi.fn() }),
}))

vi.mock('../../utils/canvasLayout', () => ({
  findGroupForTabKey: () => null,
  EMPTY_CANVAS_GROUPS: [],
}))

vi.mock('../../utils/activeKeyFallback', () => ({
  computeFallbackTabKeyFromStore: () => null,
}))

// ── Subject under test ───────────────────────────────────────────

import { invokeCloseContextTab } from '../ContextSpaceToolHandler'

const SPACE = 'sp-1'
const TABKEY = 'tabdoc:doc-1'

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(tabsState.tabOrderBySpace)) delete tabsState.tabOrderBySpace[key]
  for (const key of Object.keys(tabsState.activeKeyBySpace)) delete tabsState.activeKeyBySpace[key]
  for (const key of Object.keys(tabsState.itemsBySpace)) delete tabsState.itemsBySpace[key]
  for (const key of Object.keys(canvasState.spaceGroups)) delete canvasState.spaceGroups[key]
  tabsState.tabOrderBySpace[SPACE] = [TABKEY]
  tabsState.activeKeyBySpace[SPACE] = TABKEY
  mockDispatchBeforeClose.mockResolvedValue(true)
  mockDispatchClose.mockResolvedValue({ hasHandler: true, needsClose: true })
})

// ── Spec ─────────────────────────────────────────────────────────

describe('closeContextTab · 通用 beforeClose 守门', () => {
  it('beforeClose 返回 true（无 dirty 等价场景）→ 正常 dispatchClose + closeTab', async () => {
    mockDispatchBeforeClose.mockResolvedValue(true)

    const result = await invokeCloseContextTab({ spaceId: SPACE, tabKey: TABKEY })

    expect(result.success).toBe(true)
    expect(mockDispatchBeforeClose).toHaveBeenCalledTimes(1)
    expect(mockDispatchClose).toHaveBeenCalledTimes(1)
    expect(mockCloseTab).toHaveBeenCalledTimes(1)
    expect(mockCloseTab).toHaveBeenCalledWith(SPACE, TABKEY, undefined)
  })

  it('beforeClose 返回 false（用户取消）→ 提前返回 CLOSE_CANCELLED，不调用 dispatchClose/closeTab', async () => {
    mockDispatchBeforeClose.mockResolvedValue(false)

    const result = await invokeCloseContextTab({ spaceId: SPACE, tabKey: TABKEY })

    expect(result).toMatchObject({
      success: false,
      code: 'CLOSE_CANCELLED',
    })
    // 错误文案要明确说明是"用户取消"，让 Agent 据此区分非异常路径
    expect((result as { error?: string }).error).toMatch(/cancel/i)
    expect(mockDispatchBeforeClose).toHaveBeenCalledTimes(1)
    expect(mockDispatchClose).not.toHaveBeenCalled()
    expect(mockCloseTab).not.toHaveBeenCalled()
    expect(mockSetActiveKey).not.toHaveBeenCalled()
    expect(mockClosePane).not.toHaveBeenCalled()
  })

  it('beforeClose 抛错 → 返回 BEFORE_CLOSE_ERROR，错误穿透不静默', async () => {
    mockDispatchBeforeClose.mockRejectedValue(new Error('confirm dialog destroyed'))

    const result = await invokeCloseContextTab({ spaceId: SPACE, tabKey: TABKEY })

    expect(result).toMatchObject({
      success: false,
      code: 'BEFORE_CLOSE_ERROR',
    })
    expect((result as { error?: string }).error).toMatch(/confirm dialog destroyed/)
    expect(mockDispatchClose).not.toHaveBeenCalled()
    expect(mockCloseTab).not.toHaveBeenCalled()
  })

  it('beforeClose 与 dispatchClose 收到同一个 contextItem 引用 + 同一个 toolCtx', async () => {
    mockDispatchBeforeClose.mockResolvedValue(true)

    await invokeCloseContextTab({ spaceId: SPACE, tabKey: TABKEY })

    const beforeArgs = mockDispatchBeforeClose.mock.calls[0]
    const closeArgs = mockDispatchClose.mock.calls[0]
    expect(beforeArgs?.[0]).toBe(closeArgs?.[0])
    expect(beforeArgs?.[1]).toBe(closeArgs?.[1])
  })

  it('保留既有契约：spaceId/tabKey 缺失 → 走原有错误返回，不调用 beforeClose', async () => {
    const result = await invokeCloseContextTab({ tabKey: TABKEY })

    expect(result.success).toBe(false)
    expect((result as { error?: string }).error).toMatch(/spaceId\/tabKey/i)
    expect(mockDispatchBeforeClose).not.toHaveBeenCalled()
  })

  it('保留既有契约：tabKey 无法解析时早 return，不调用 beforeClose', async () => {
    const result = await invokeCloseContextTab({ spaceId: SPACE, tabKey: 'bad-tab-key' })

    expect(result.success).toBe(false)
    expect((result as { error?: string }).error).toMatch(/invalid tabKey/i)
    expect(mockDispatchBeforeClose).not.toHaveBeenCalled()
  })
})

describe('closeContextTab · 与 tabdoc beforeClose 端到端语义对齐', () => {
  it('tabdoc 无 dirty → dispatchBeforeClose 返回 true → 正常关（与既有 tool 行为一致）', async () => {
    mockDispatchBeforeClose.mockResolvedValue(true)
    mockDispatchClose.mockResolvedValue({ hasHandler: true, needsClose: true })

    const result = await invokeCloseContextTab({ spaceId: SPACE, tabKey: TABKEY })

    expect(result.success).toBe(true)
    expect(mockDispatchBeforeClose).toHaveBeenCalledTimes(1)
    expect(mockCloseTab).toHaveBeenCalledTimes(1)
  })

  it('tabdoc 有 dirty + 用户在确认对话框中选"取消" → CLOSE_CANCELLED, tab 没被关', async () => {
    mockDispatchBeforeClose.mockImplementation(async () => {
      // 模拟 tabdocHandler.beforeClose：检测到 dirty 弹窗，用户 settle 'cancel'
      return false
    })

    const result = await invokeCloseContextTab({ spaceId: SPACE, tabKey: TABKEY })

    expect(result).toMatchObject({ success: false, code: 'CLOSE_CANCELLED' })
    expect(mockCloseTab).not.toHaveBeenCalled()
    // tab 状态完全不变
    expect(tabsState.tabOrderBySpace[SPACE]).toEqual([TABKEY])
    expect(tabsState.activeKeyBySpace[SPACE]).toBe(TABKEY)
  })

  it('tabdoc 有 dirty + 用户在确认对话框中选"放弃修改" → 正常关', async () => {
    mockDispatchBeforeClose.mockImplementation(async () => {
      // 模拟 tabdocHandler.beforeClose：检测到 dirty 弹窗，用户 settle 'discard'
      return true
    })
    mockDispatchClose.mockResolvedValue({ hasHandler: true, needsClose: true })

    const result = await invokeCloseContextTab({ spaceId: SPACE, tabKey: TABKEY })

    expect(result.success).toBe(true)
    expect(mockDispatchBeforeClose).toHaveBeenCalledTimes(1)
    expect(mockDispatchClose).toHaveBeenCalledTimes(1)
    expect(mockCloseTab).toHaveBeenCalledTimes(1)
  })

  it('tabdoc 有 dirty + 用户选"保存并关闭" + 保存失败 → CLOSE_CANCELLED（handler 内 toast 已提示）', async () => {
    // 这是 tabdocHandler.beforeClose 在 saver 失败时的真实分支：
    // beforeClose 内部已 toast，外层只收到 false，与"取消"路径合并到 CLOSE_CANCELLED
    mockDispatchBeforeClose.mockResolvedValue(false)

    const result = await invokeCloseContextTab({ spaceId: SPACE, tabKey: TABKEY })

    expect(result).toMatchObject({ success: false, code: 'CLOSE_CANCELLED' })
    expect(mockCloseTab).not.toHaveBeenCalled()
  })
})
