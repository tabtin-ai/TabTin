import React from 'react'
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedSearchResponse, FtsSearchResultItem } from '@tabtin/app-shell'

// ── 模块顶层 mock：必须在被测组件 import 前注册 ──
const { mockUnifiedSearch, mockActivateConversation, mockActivateSpace, mockEnterChatSession, mockDispatchSelect, mockIsKnownType, mockOrganizationState } =
  vi.hoisted(() => ({
    mockUnifiedSearch: vi.fn(),
    mockActivateConversation: vi.fn(() => true),
    mockActivateSpace: vi.fn(() => true),
    mockEnterChatSession: vi.fn().mockResolvedValue(1),
    mockDispatchSelect: vi.fn(() => true),
    mockIsKnownType: vi.fn(() => true),
    mockOrganizationState: { selectedOrganization: { id: 'organization-1' } as { id: string } | null },
  }))

vi.mock('@tabtin/app-shell', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/app-shell')>('@tabtin/app-shell')
  return {
    ...actual,
    unifiedSearch: mockUnifiedSearch,
    useSpaceListStore: {
      getState: () => ({
        activateConversation: mockActivateConversation,
        activateSpace: mockActivateSpace,
      }),
    },
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValueOrOptions?: unknown) => {
      if (typeof defaultValueOrOptions === 'string') return defaultValueOrOptions
      if (defaultValueOrOptions && typeof defaultValueOrOptions === 'object' && 'defaultValue' in (defaultValueOrOptions as Record<string, unknown>)) {
        return (defaultValueOrOptions as Record<string, string>).defaultValue
      }
      return _key
    },
  }),
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  // 极简 Popover stub：active 时直接渲染 children；不挂 portal、不做定位
  Popover: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    <div data-testid="popover" data-open={open ? 'true' : 'false'}>{children}</div>
  ),
  PopoverAnchor: () => null,
  PopoverContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="popover-content" className={className}>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/ui', () => ({
  OPAQUE_OVERLAY_SURFACE_CLASS: 'opaque-overlay-surface',
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  Skeleton: ({ className, width, height }: { className?: string; width?: string | number; height?: string | number }) => (
    <div className={className} style={{ width, height }} />
  ),
}))

vi.mock('@/services/chatSessionNavigation', () => ({
  enterChatSession: mockEnterChatSession,
  isLatestEnter: () => true,
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: Object.assign(
    (selector: (state: typeof mockOrganizationState) => unknown) => selector(mockOrganizationState),
    { getState: () => mockOrganizationState },
  ),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } | null }) => unknown) =>
    selector({ user: { id: 'me-user-id' } }),
}))

// 共享的 SpaceStore mock 状态：测试里可以 setMockSpaceStoreState() 覆盖
const mockSpaceStoreState = {
  selectedSpace: null as { id: string } | null,
  spaces: [] as Array<{
    id: string
    type: string
    is_archived: boolean
    name: string
    icon?: string | null
    execution_agent_id?: string | null
    agent_id?: string | null
  }>,
  agentCache: {} as Record<string, { id: string; name: string }>,
}

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (state: typeof mockSpaceStoreState) => unknown) => selector(mockSpaceStoreState),
    { getState: () => mockSpaceStoreState },
  ),
}))

const tabsState = {
  tabOrderBySpace: {} as Record<string, string[]>,
  itemsBySpace: {} as Record<string, Record<string, unknown>>,
  setActiveKey: vi.fn(),
}
vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: Object.assign(
    (selector: (state: typeof tabsState) => unknown) => selector(tabsState),
    { getState: () => tabsState },
  ),
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: { getState: () => ({ getSpaceCrawlspace: () => null }) },
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: (spaceId: string) => spaceId,
}))

vi.mock('@components/context-space/registry', () => ({
  contextRegistry: {
    getDisplayEmoji: () => '📄',
    getDisplayLabel: (t: string) => t,
    getTabIcon: () => null,
    dispatchSelect: mockDispatchSelect,
    isKnownType: mockIsKnownType,
    normalizeBackendType: (t: string) => (t === 'document' ? 'tabdoc' : t),
  },
}))

import { GlobalSearch } from './GlobalSearch'

function makeMessageHit(overrides: Partial<FtsSearchResultItem> = {}): FtsSearchResultItem {
  return {
    id: 'msg-1',
    type: 'message',
    title: '性能优化讨论',
    snippet: '可以用 <em>二分查找</em> 替代线性扫描',
    highlight: { content: ['可以用 <em>二分查找</em> 替代线性扫描'], session_title: ['<em>性能</em>优化讨论'] },
    creator_type: 'agent',
    creator_id: 'agent-codebot',
    creator_name: 'CodeBot',
    creator_avatar: '🤖',
    space_id: 'space-1',
    space_name: '代码助手',
    session_id: 'sess-1',
    session_title: '性能优化讨论',
    score: 12,
    rrf_score: 0.95,
    created_at: '2026-04-16T10:00:00Z',
    metadata: {},
    ...overrides,
  }
}

function makeResourceHit(overrides: Partial<FtsSearchResultItem> = {}): FtsSearchResultItem {
  return {
    id: 'resource-row-1',
    type: 'resource',
    title: '设计文档',
    snippet: '文档预览',
    highlight: { title: ['<em>设计</em>文档'], preview: ['文档预览'] },
    creator_type: 'user',
    creator_id: 'me-user-id',
    creator_name: 'Jin',
    creator_avatar: null,
    space_id: 'space-1',
    space_name: '产品空间',
    session_id: null,
    session_title: null,
    resource_id: 'doc-1',
    score: 10,
    rrf_score: 0.9,
    created_at: '2026-04-16T10:00:00Z',
    metadata: { item_type: 'document' },
    ...overrides,
  }
}

function makeResp(overrides: Partial<UnifiedSearchResponse> = {}): UnifiedSearchResponse {
  return {
    results: [],
    total: 0,
    facets: {},
    suggestions: [],
    took_ms: 50,
    search_mode: 'normal',
    degraded: false,
    degraded_reason: null,
    partial_indices: [],
    ...overrides,
  }
}

describe('GlobalSearch (Wave 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // 重置共享 mock state（HIGH-1 测试可能修改 spaces）
    mockOrganizationState.selectedOrganization = { id: 'organization-1' }
    mockSpaceStoreState.selectedSpace = null
    mockSpaceStoreState.spaces = []
    mockSpaceStoreState.agentCache = {}
    mockDispatchSelect.mockReturnValue(true)
    mockIsKnownType.mockReturnValue(true)
  })
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    localStorage.clear()
  })

  it('IME composing 期间不触发搜索；compositionEnd 才触发一次', async () => {
    mockUnifiedSearch.mockResolvedValue(makeResp())
    render(<GlobalSearch open onClose={vi.fn()} />)
    const input = screen.getByRole('combobox')

    // 模拟中文 IME：start → 输入"性"和"能"两次中间态 → end
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '性' } })
    fireEvent.change(input, { target: { value: '性能' } })

    // 防抖窗口走完，因仍在 composing，绝不应该已发请求
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(mockUnifiedSearch).not.toHaveBeenCalled()

    fireEvent.compositionEnd(input, { target: { value: '性能' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(mockUnifiedSearch).toHaveBeenCalledTimes(1)
    expect(mockUnifiedSearch).toHaveBeenCalledWith(
      expect.objectContaining({ q: '性能', organization_id: 'organization-1' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('overlay 子窗口 store 无当前团队时使用宿主传入的 organizationId 搜索', async () => {
    mockOrganizationState.selectedOrganization = null
    mockUnifiedSearch.mockResolvedValue(makeResp())

    render(<GlobalSearch open organizationId="organization-from-main" onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '螺蛳粉' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(mockUnifiedSearch).toHaveBeenCalledWith(
      expect.objectContaining({ q: '螺蛳粉', organization_id: 'organization-from-main' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('防抖：连续输入只发一次最终请求；旧请求被 AbortController 取消', async () => {
    mockUnifiedSearch.mockResolvedValue(makeResp())
    render(<GlobalSearch open onClose={vi.fn()} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'a' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    fireEvent.change(input, { target: { value: 'ab' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    fireEvent.change(input, { target: { value: 'abc' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    // 防抖期间只应该有"最终一次"调用（前面被 cleanup 阻断）
    expect(mockUnifiedSearch).toHaveBeenCalledTimes(1)
    expect(mockUnifiedSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'abc' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('降级 banner：partial_failure + partial_indices 显示具体失败索引中文文案', async () => {
    mockUnifiedSearch.mockResolvedValue(
      makeResp({
        results: [],
        degraded: true,
        degraded_reason: 'partial_failure',
        partial_indices: ['messages'],
      }),
    )
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'foo' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('消息搜索')
    })
  })

  it('降级 banner：opensearch_unavailable 命中独立文案', async () => {
    mockUnifiedSearch.mockResolvedValue(
      makeResp({ results: [], degraded: true, degraded_reason: 'opensearch_unavailable' }),
    )
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'x' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('搜索服务降级中')
    })
  })

  it('消息卡片渲染 + 高亮 mark + 点击触发 enterChatSession (含 messageId/highlightTerms)', async () => {
    mockUnifiedSearch.mockResolvedValue(
      makeResp({
        results: [makeMessageHit()],
        total: 1,
        facets: { messages: 1 },
      }),
    )
    const onClose = vi.fn()
    render(<GlobalSearch open onClose={onClose} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '性能' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    // 卡片标题命中并被 SafeHighlight 包成 <mark>
    await waitFor(() => {
      const marks = document.querySelectorAll('mark')
      expect(marks.length).toBeGreaterThan(0)
    })

    // 点击卡片
    const card = screen.getByRole('option', { name: /消息/ })
    fireEvent.click(card)

    await waitFor(() => {
      expect(mockEnterChatSession).toHaveBeenCalledWith(
        'space-1',
        'sess-1',
        expect.objectContaining({
          messageId: 'msg-1',
          highlightMessage: true,
          highlightTerms: ['性能'],
          loadContextWindow: 20,
        }),
      )
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('资源卡片：点击文档结果时派发归一化后的 tabdoc item', async () => {
    mockUnifiedSearch.mockResolvedValue(
      makeResp({
        results: [makeResourceHit()],
        total: 1,
        facets: { resources: 1 },
      }),
    )
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '设计' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    const docOption = await screen.findByRole('option', { name: /设计文档/ })
    fireEvent.click(docOption)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    await waitFor(() => {
      expect(mockActivateSpace).toHaveBeenCalledWith('space-1')
      expect(mockDispatchSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tabdoc',
          id: 'doc-1',
          tabKey: 'tabdoc:doc-1',
          title: '设计文档',
        }),
        expect.objectContaining({ spaceId: 'space-1', tabScopeKey: 'space-1' }),
      )
    })
  })

  it('资源卡片：生产态 tabdoc item_type 直接派发 tabdoc item', async () => {
    mockUnifiedSearch.mockResolvedValue(
      makeResp({
        results: [makeResourceHit({
          metadata: { item_type: 'tabdoc' },
        })],
        total: 1,
        facets: { resources: 1 },
      }),
    )
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '设计' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    const docOption = await screen.findByRole('option', { name: /设计文档/ })
    fireEvent.click(docOption)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    await waitFor(() => {
      expect(mockDispatchSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tabdoc',
          id: 'doc-1',
          tabKey: 'tabdoc:doc-1',
        }),
        expect.objectContaining({ spaceId: 'space-1', tabScopeKey: 'space-1' }),
      )
    })
  })

  it('资源卡片：未知资源类型给出反馈且不切换 Space', async () => {
    mockIsKnownType.mockReturnValueOnce(false)
    mockUnifiedSearch.mockResolvedValue(
      makeResp({
        results: [makeResourceHit({
          resource_id: 'unknown-1',
          metadata: { item_type: 'unknown-resource' },
        })],
        total: 1,
        facets: { resources: 1 },
      }),
    )
    const { toast } = await import('@tabtin/smartsheet-ui/toast')
    const errSpy = vi.spyOn(toast, 'error').mockImplementation(() => '')
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '未知' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    const unknownOption = await screen.findByRole('option', { name: /设计文档/ })
    fireEvent.click(unknownOption)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    await waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('暂不支持'))
      expect(mockActivateSpace).not.toHaveBeenCalled()
      expect(mockDispatchSelect).not.toHaveBeenCalled()
    })
    errSpy.mockRestore()
  })

  it('资源卡片：缺少 item_type 时给出反馈且不切换 Space', async () => {
    mockUnifiedSearch.mockResolvedValue(
      makeResp({
        results: [makeResourceHit({
          resource_id: 'missing-type-1',
          metadata: {},
        })],
        total: 1,
        facets: { resources: 1 },
      }),
    )
    const { toast } = await import('@tabtin/smartsheet-ui/toast')
    const errSpy = vi.spyOn(toast, 'error').mockImplementation(() => '')
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '缺类型' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    const missingTypeOption = await screen.findByRole('option', { name: /设计文档/ })
    fireEvent.click(missingTypeOption)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    await waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('缺少类型信息'))
      expect(mockActivateSpace).not.toHaveBeenCalled()
      expect(mockDispatchSelect).not.toHaveBeenCalled()
    })
    errSpy.mockRestore()
  })

  it('IM 卡片：点击走 useSpaceListStore.activateConversation（W2-2）', async () => {
    mockUnifiedSearch.mockResolvedValue(
      makeResp({
        results: [
          {
            ...makeMessageHit(),
            id: 'im-1',
            type: 'im',
            title: 'GroupChat',
            session_id: 'conv-1', // im 时是 conversation_id
            highlight: {},
          },
        ],
        total: 1,
        facets: { im: 1 },
      }),
    )
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'group' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    await waitFor(() => screen.getByRole('option', { name: /IM/ }))
    fireEvent.click(screen.getByRole('option', { name: /IM/ }))

    await waitFor(() => {
      expect(mockActivateConversation).toHaveBeenCalledWith('conv-1')
    })
    expect(mockEnterChatSession).not.toHaveBeenCalled()
  })

  it('XSS：highlight 含 <script> 不会执行也不会插入真 script DOM', async () => {
    mockUnifiedSearch.mockResolvedValue(
      makeResp({
        results: [
          {
            ...makeMessageHit(),
            id: 'xss-1',
            snippet: '前缀 <script>window.__xss=1</script> <em>safe</em>',
            highlight: { content: ['前缀 <script>window.__xss=1</script> <em>safe</em>'] },
          },
        ],
        total: 1,
        facets: { messages: 1 },
      }),
    )
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'safe' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    await waitFor(() => screen.getByText(/safe/))

    expect(document.querySelector('script')).toBeNull()
    expect((globalThis as unknown as { __xss?: number }).__xss).toBeUndefined()
  })

  it('空态：未输入关键词时显示历史 + 提示', async () => {
    localStorage.setItem('tabtin:search-history', JSON.stringify(['上一次搜的', '另一条']))
    render(<GlobalSearch open onClose={vi.fn()} />)
    expect(screen.getByText(/搜索消息、文档、表格/)).toBeTruthy()
    expect(screen.getByText('上一次搜的')).toBeTruthy()
    expect(screen.getByText('另一条')).toBeTruthy()
  })

  it('空结果：suggestions 渲染为可点击词条', async () => {
    mockUnifiedSearch.mockResolvedValue(
      makeResp({ results: [], total: 0, suggestions: ['性能', '缓存'] }),
    )
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'xxx' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    await waitFor(() => screen.getByText(/未找到关于/))
    expect(screen.getByText('性能')).toBeTruthy()
    expect(screen.getByText('缓存')).toBeTruthy()
  })

  it('Loading 分级：未到 500ms 不显示 skeleton；超过显示', async () => {
    let resolvePromise: ((value: UnifiedSearchResponse) => void) | undefined
    mockUnifiedSearch.mockImplementation(
      () => new Promise<UnifiedSearchResponse>((res) => { resolvePromise = res }),
    )
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '慢查询' } })

    // 推进到防抖刚结束 + 200ms 弹性，仍未到 500ms skeleton 阈值
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(document.querySelector('[aria-label="loading"]')).toBeNull()

    // 推到 500ms 后 → 出现 skeleton
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(document.querySelector('[aria-label="loading"]')).not.toBeNull()

    await act(async () => {
      resolvePromise?.(makeResp())
    })
  })

  it('IM 卡片：activateConversation 失败时 toast 错误（B1 用户修复）', async () => {
    mockActivateConversation.mockReturnValueOnce(false)
    mockUnifiedSearch.mockResolvedValue(
      makeResp({
        results: [
          {
            ...makeMessageHit(),
            id: 'im-deleted',
            type: 'im',
            title: 'GoneChat',
            session_id: 'conv-deleted',
            highlight: {},
          },
        ],
        total: 1,
        facets: { im: 1 },
      }),
    )
    const { toast } = await import('@tabtin/smartsheet-ui/toast')
    const errSpy = vi.spyOn(toast, 'error').mockImplementation(() => '')
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gone' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    await waitFor(() => screen.getByRole('option', { name: /IM/ }))
    fireEvent.click(screen.getByRole('option', { name: /IM/ }))
    await waitFor(() => {
      expect(mockActivateConversation).toHaveBeenCalledWith('conv-deleted')
      expect(errSpy).toHaveBeenCalled()
    })
    errSpy.mockRestore()
  })

  it('键盘 ↑↓ Enter 列表导航（H7 产品修复）', async () => {
    mockUnifiedSearch.mockResolvedValue(
      makeResp({
        results: [
          makeMessageHit({ id: 'msg-a', session_id: 'sess-a', title: 'A' }),
          makeMessageHit({ id: 'msg-b', session_id: 'sess-b', title: 'B' }),
          makeMessageHit({ id: 'msg-c', session_id: 'sess-c', title: 'C' }),
        ],
        total: 3,
        facets: { messages: 3 },
      }),
    )
    render(<GlobalSearch open onClose={vi.fn()} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'msg' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3))
    // 按 ↓ 两次后选中第 3 个；按 Enter 触发跳转
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(mockEnterChatSession).toHaveBeenCalledWith(
        'space-1',
        'sess-c',
        expect.objectContaining({ messageId: 'msg-c' }),
      )
    })
  })

  it('"全部" Tab 下 facets 显示在 Tab 上', async () => {
    mockUnifiedSearch.mockResolvedValue(
      makeResp({
        results: [makeMessageHit()],
        total: 8,
        facets: { messages: 5, resources: 3 },
      }),
    )
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'foo' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    // 类型 Tab 行用 aria-label="类型筛选"，creator filter 行用"创建者筛选"，
    // 必须用 within 把 selector 限定到类型 Tab 行避免命中 creator filter 的 tab
    const typeTabRow = await screen.findByRole('tablist', { name: /类型筛选/ })

    const { within } = await import('@testing-library/react')
    const messageTab = within(typeTabRow).getByRole('tab', { name: /消息/ })
    expect(messageTab.textContent).toContain('5')
    const resourceTab = within(typeTabRow).getByRole('tab', { name: /资源/ })
    expect(resourceTab.textContent).toContain('3')
  })

  // ── HIGH-1（R3-02）：@/#/in: Picker 触发与选中（PRD 3.11） ──

  it('HIGH-1：输入 "@" 触发 Agent Picker 渲染', async () => {
    mockSpaceStoreState.spaces = [
      { id: 'sp-bot-1', type: 'workspace', is_archived: false, name: 'CodeBot', icon: null, execution_agent_id: 'agent-cb', organization_id: 'organization-1' },
    ]
    mockSpaceStoreState.agentCache = { 'agent-cb': { id: 'agent-cb', name: 'CodeBot' } }
    mockUnifiedSearch.mockResolvedValue(makeResp())
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '@' } })
    await waitFor(() => screen.getByTestId('scope-picker-agent-list'))
    expect(screen.getByText('CodeBot')).toBeTruthy()
    // 输入 @ 时不应该触发搜索（picker 模式不发请求）
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(mockUnifiedSearch).not.toHaveBeenCalled()
  })

  it('HIGH-1：输入 "#" 触发 Type Picker 渲染', async () => {
    mockUnifiedSearch.mockResolvedValue(makeResp())
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '#' } })
    await waitFor(() => screen.getByTestId('scope-picker-type-list'))
    // type picker 至少应有"消息"等 6 类
    const list = screen.getByTestId('scope-picker-type-list')
    expect(list.textContent).toContain('message')
  })

  it('HIGH-1：输入 "in:" 触发 Space Picker 渲染', async () => {
    mockSpaceStoreState.spaces = [
      { id: 'sp-1', type: 'team', is_archived: false, name: '工作台', icon: null, organization_id: 'organization-1' },
    ]
    mockUnifiedSearch.mockResolvedValue(makeResp())
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'in:' } })
    await waitFor(() => screen.getByTestId('scope-picker-space-list'))
    expect(screen.getByText('工作台')).toBeTruthy()
  })

  it('HIGH-1：选中 Agent → 设置 scope 徽章 + 移除 @ 文本 + 后续搜索带 agent_id', async () => {
    mockSpaceStoreState.spaces = [
      { id: 'sp-bot-1', type: 'workspace', is_archived: false, name: 'CodeBot', icon: null, execution_agent_id: 'agent-cb', organization_id: 'organization-1' },
    ]
    mockSpaceStoreState.agentCache = { 'agent-cb': { id: 'agent-cb', name: 'CodeBot' } }
    mockUnifiedSearch.mockResolvedValue(makeResp())
    render(<GlobalSearch open onClose={vi.fn()} />)
    const input = screen.getByRole('combobox') as HTMLInputElement
    // 先输入关键词，再追加 @ 触发 picker
    fireEvent.change(input, { target: { value: '性能 @' } })
    await waitFor(() => screen.getByTestId('scope-picker-agent-list'))
    // 选中 CodeBot
    fireEvent.click(screen.getByText('CodeBot'))
    // 徽章出现
    await waitFor(() => screen.getByLabelText(/清除 Agent 筛选/))
    // 输入框文本被移除 @ → 只剩 "性能"
    expect(input.value.trim()).toBe('性能')
    // 防抖期后发起带 agent_id 的搜索
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(mockUnifiedSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: '性能', agent_id: 'agent-cb' }),
      expect.any(Object),
    )
  })

  it('HIGH-1：选中 Type → 切换 typeTab + 移除 # 文本', async () => {
    mockUnifiedSearch.mockResolvedValue(makeResp())
    render(<GlobalSearch open onClose={vi.fn()} />)
    const input = screen.getByRole('combobox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '#' } })
    await waitFor(() => screen.getByTestId('scope-picker-type-list'))
    // 选中"message"按钮（默认 emoji + label）
    const messageBtn = screen.getAllByRole('button').find(b => b.textContent?.trim().endsWith('message'))
    expect(messageBtn).toBeTruthy()
    fireEvent.click(messageBtn!)
    // # 被移除
    expect(input.value).toBe('')
    // 类型 Tab 切到"消息"（aria-selected）
    const tabList = await screen.findByRole('tablist', { name: /类型筛选/ })
    const { within } = await import('@testing-library/react')
    const messageTab = within(tabList).getByRole('tab', { name: /消息/ })
    expect(messageTab.getAttribute('aria-selected')).toBe('true')
  })

  it('HIGH-1：选中 Space → 设置 Space 徽章 + 移除 in: 文本 + 后续搜索带 space_id', async () => {
    mockSpaceStoreState.spaces = [
      { id: 'sp-1', type: 'team', is_archived: false, name: '工作台', icon: null, organization_id: 'organization-1' },
    ]
    mockUnifiedSearch.mockResolvedValue(makeResp())
    render(<GlobalSearch open onClose={vi.fn()} />)
    const input = screen.getByRole('combobox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '性能 in:' } })
    await waitFor(() => screen.getByTestId('scope-picker-space-list'))
    fireEvent.click(screen.getByText('工作台'))
    await waitFor(() => screen.getByLabelText(/清除 Space 收窄/))
    expect(input.value.trim()).toBe('性能')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(mockUnifiedSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: '性能', space_id: 'sp-1' }),
      expect.any(Object),
    )
  })

  // ── HIGH-2（R3-04）：空态"最近打开"区块（PRD 3.7） ──

  it('HIGH-2：localStorage 无最近打开时不渲染该区块', () => {
    render(<GlobalSearch open onClose={vi.fn()} />)
    expect(screen.queryByTestId('recent-opened-section')).toBeNull()
  })

  it('HIGH-2：localStorage 有最近打开时渲染前 5 条', () => {
    const items = [
      { type: 'message', id: 'm1', title: 'Python 性能优化', spaceId: 'sp-1', sessionId: 'se-1', organizationId: 'organization-1', openedAt: Date.now() - 60_000 },
      { type: 'resource', id: 'r1', title: '会议纪要', spaceId: 'sp-1', resourceId: 'res-1', itemType: 'tabdoc', organizationId: 'organization-1', openedAt: Date.now() - 3_600_000 },
    ]
    localStorage.setItem('tabtin:recent-opened', JSON.stringify(items))
    render(<GlobalSearch open onClose={vi.fn()} />)
    const section = screen.getByTestId('recent-opened-section')
    expect(section.textContent).toContain('Python 性能优化')
    expect(section.textContent).toContain('会议纪要')
    expect(section.textContent).toMatch(/分钟前|小时前|刚刚/)
  })

  it('HIGH-2：点击"最近打开"消息项触发 enterChatSession', async () => {
    const items = [
      { type: 'message', id: 'm1', title: '某条消息', spaceId: 'sp-1', sessionId: 'se-1', organizationId: 'organization-1', openedAt: Date.now() - 60_000 },
    ]
    localStorage.setItem('tabtin:recent-opened', JSON.stringify(items))
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('某条消息'))
    await waitFor(() => {
      expect(mockEnterChatSession).toHaveBeenCalledWith('sp-1', 'se-1', expect.objectContaining({
        messageId: 'm1',
      }))
    })
  })

  it('HIGH-2：点击搜索结果后 localStorage 写入"最近打开"', async () => {
    mockUnifiedSearch.mockResolvedValue(
      makeResp({
        results: [makeMessageHit({ id: 'msg-write', title: '写入测试', session_id: 'sess-write' })],
        total: 1,
        facets: { messages: 1 },
      }),
    )
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '写入' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    await waitFor(() => screen.getByRole('option', { name: /消息/ }))
    fireEvent.click(screen.getByRole('option', { name: /消息/ }))
    const stored = JSON.parse(localStorage.getItem('tabtin:recent-opened') || '[]')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ type: 'message', id: 'msg-write' })
  })

  // ── HIGH-3（R3-08）：creator filter toggle（PRD 3.8.B） ──

  it('HIGH-3：toggle 切换 → creator_type 真传给 unifiedSearch', async () => {
    mockUnifiedSearch.mockResolvedValue(makeResp({
      results: [makeMessageHit()],
      total: 1,
      facets: { messages: 1 },
    }))
    render(<GlobalSearch open onClose={vi.fn()} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: '性能' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    // 默认 'any'：不应传 creator_type
    expect(mockUnifiedSearch).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ creator_type: expect.any(String) }),
      expect.any(Object),
    )
    // 切换到"只看 Agent"
    const filterRow = screen.getByRole('tablist', { name: /创建者筛选/ })
    const { within } = await import('@testing-library/react')
    fireEvent.click(within(filterRow).getByText('只看 Agent 的'))
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(mockUnifiedSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ creator_type: 'agent' }),
      expect.any(Object),
    )
  })

  it('HIGH-3：选 Agent / Space 类型 Tab 时 creator filter 隐藏', async () => {
    mockUnifiedSearch.mockResolvedValue(makeResp())
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '性能' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(screen.queryByRole('tablist', { name: /创建者筛选/ })).toBeTruthy()
    // 切到 Agent Tab
    const typeTabRow = screen.getByRole('tablist', { name: /类型筛选/ })
    const { within } = await import('@testing-library/react')
    fireEvent.click(within(typeTabRow).getByRole('tab', { name: /Agent/ }))
    expect(screen.queryByRole('tablist', { name: /创建者筛选/ })).toBeNull()
    // 切到 Space Tab
    fireEvent.click(within(typeTabRow).getByRole('tab', { name: /Space/ }))
    expect(screen.queryByRole('tablist', { name: /创建者筛选/ })).toBeNull()
  })

  it('HIGH-3：在资源/备忘录/IM Tab 选"只看 Agent" → 显示 R2-11 提示', async () => {
    mockUnifiedSearch.mockResolvedValue(makeResp())
    render(<GlobalSearch open onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '性能' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    const typeTabRow = screen.getByRole('tablist', { name: /类型筛选/ })
    const { within } = await import('@testing-library/react')
    fireEvent.click(within(typeTabRow).getByRole('tab', { name: /资源/ }))
    // creator filter 仍可见
    const filterRow = screen.getByRole('tablist', { name: /创建者筛选/ })
    fireEvent.click(within(filterRow).getByText('只看 Agent 的'))
    expect(screen.getByTestId('creator-filter-r2-11-hint').textContent).toContain('Agent 筛选仅对消息/Agent 类型精准生效')
    // 切回"所有" → 提示消失
    fireEvent.click(within(filterRow).getByText('所有'))
    expect(screen.queryByTestId('creator-filter-r2-11-hint')).toBeNull()
  })

  // ── ：右上角 / 左下角 ESC 提示改为真正可点击的关闭按钮 ──

  it('#787：点击「关闭」按钮触发 onClose（右上角 + 左下角各一处）', () => {
    const onClose = vi.fn()
    render(<GlobalSearch open onClose={onClose} />)
    // 两个关闭控件（右上角 ESC + 左下角 footer ESC 关闭）都暴露为 role=button + aria-label
    const closeButtons = screen.getAllByRole('button', { name: '关闭' })
    expect(closeButtons).toHaveLength(2)
    fireEvent.click(closeButtons[0])
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(closeButtons[1])
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
