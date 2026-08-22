/**
 * useContextTabsLogic.handleAddToChat 行为测试
 *
 * 覆盖三条核心分支：
 *   1. buildContextAttachment 返回 null → toast 报错且不 emit
 *   2. activeScopeId 为空 → toast 报错且不 emit
 *   3. 成功路径 → emit 并附带正确的 type/resourceId/tabType/label/meta
 *
 * handleAddToChat 是 hook 内部 callback，不直接对外暴露。我们通过模拟
 * 用户右键 → 点击「添加到对话」菜单项的方式触发它：
 *   - mock `@/utils/nativeMenu` 捕获 openNativeContextMenu 的 menuItems
 *   - 调用 hook 返回的 handleTabContextMenu 触发 menu 构建
 *   - 从 menuItems 中找到 id='add-to-chat' 的项并执行 onClick
 *
 * 这条触发路径正是生产环境真实链路（产品 → useContextTabsLogic → 菜单），
 * 比单测内部 callback 更接近真用户行为。
 */
import React from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextItem, ContextTabKey } from '@components/context-space/registry'

// ── Hoisted mocks ────────────────────────────────────────────────────────

const {
  mockToast,
  mockEmitContextInject,
  mockOpenNativeContextMenu,
  mockBuildContextAttachment,
  mockCanAttachToChat,
  mockGetTabLabel,
  mockGetTabIcon,
  mockIsClosable,
  mockParseTabKey,
  mockBuildTabKey,
  mockGetHandler,
  mockContextInjectionState,
} = vi.hoisted(() => ({
  mockToast: vi.fn(),
  mockEmitContextInject: vi.fn(),
  mockOpenNativeContextMenu: vi.fn(() => () => {}),
  mockBuildContextAttachment: vi.fn(),
  mockCanAttachToChat: vi.fn(),
  mockGetTabLabel: vi.fn((item: { title?: string }) => item.title || ''),
  mockGetTabIcon: vi.fn(() => null),
  mockIsClosable: vi.fn(() => true),
  mockParseTabKey: vi.fn((key: string) => {
    const i = key.indexOf(':')
    if (i <= 0) return null
    return { type: key.slice(0, i), id: key.slice(i + 1) }
  }),
  mockBuildTabKey: vi.fn((type: string, id: string) => `${type}:${id}`),
  mockGetHandler: vi.fn(() => undefined),
  mockContextInjectionState: { activeScopeId: 'session-active' as string | null },
}))

// setup.ts 默认 react-i18next mock 不处理 defaultValue，这里覆盖以便断言中文文案。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string } | string) => {
      if (typeof options === 'string') return options
      if (options && typeof options.defaultValue === 'string') return options.defaultValue
      return key
    },
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('@tabtin/app-shell', () => ({
  ZIndex: { global: 1 },
  cn: (...inputs: Array<string | false | null | undefined>) => inputs.filter(Boolean).join(' '),
  registerResetAction: () => () => {},
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: mockToast,
}))

const mockVirtualModule = vi.mock as unknown as (
  path: string,
  factory: () => unknown,
  options: { virtual: boolean },
) => void
mockVirtualModule('@tabtin/shared', () => ({
  createMigratingStorage: (storage: Storage) => storage,
  withPersistSafety: (options: unknown) => options,
}), { virtual: true })

vi.mock('@/utils/nativeMenu', () => ({
  openNativeContextMenu: mockOpenNativeContextMenu,
  menuSeparator: () => ({ id: 'sep', type: 'separator' as const }),
}))

vi.mock('@components/chat/context/useContextInjection', () => ({
  emitContextInject: mockEmitContextInject,
}))

vi.mock('@/stores/useContextInjectionStore', () => ({
  useContextInjectionStore: Object.assign(
    () => ({}),
    { getState: () => mockContextInjectionState },
  ),
}))

vi.mock('@stores/useClosedTabsStore', () => ({
  useClosedTabsStore: Object.assign(
    () => ({}),
    { getState: () => ({ stack: [] }) },
  ),
}))

vi.mock('@stores/useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: (selector: (state: { setActivePane: () => void; removeGroup: () => void }) => unknown) =>
    selector({ setActivePane: vi.fn(), removeGroup: vi.fn() }),
}))

vi.mock('@/stores/useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: (selector: (state: { setActivePane: () => void; removeGroup: () => void }) => unknown) =>
    selector({ setActivePane: vi.fn(), removeGroup: vi.fn() }),
}))

// ── Helpers ──────────────────────────────────────────────────────────────

function makeItem(overrides?: Partial<{ type: string; id: string; tabKey: ContextTabKey; title?: string }>): ContextItem {
  const type = overrides?.type ?? 'tabweb'
  const id = overrides?.id ?? 'tab-1'
  return {
    type,
    id,
    tabKey: overrides?.tabKey ?? (`${type}:${id}` as ContextTabKey),
    title: overrides?.title ?? 'Sample Tab',
  }
}

function makeRegistry(): import('@components/context-space/registry').ContextRegistry {
  // 用 plain object cast 成 ContextRegistry 类型 —— 我们只用 useContextTabsLogic
  // 实际访问的方法（buildContextAttachment / canAttachToChat / 标签和 tabKey 工具）
  return {
    buildContextAttachment: mockBuildContextAttachment,
    canAttachToChat: mockCanAttachToChat,
    getTabLabel: mockGetTabLabel,
    getTabIcon: mockGetTabIcon,
    isClosable: mockIsClosable,
    parseTabKey: mockParseTabKey,
    buildTabKey: mockBuildTabKey,
    getHandler: mockGetHandler,
  } as unknown as import('@components/context-space/registry').ContextRegistry
}

/**
 * 触发 handleTabContextMenu，返回最近一次构建的 menuItems。
 * useContextTabsLogic 的菜单 id 'add-to-chat' 是测试唯一锁定的契约点。
 */
async function openContextMenuAndGetItems(
  hookResult: ReturnType<typeof renderHook<ReturnType<typeof import('../useContextTabsLogic').useContextTabsLogic>, { items: ReturnType<typeof makeItem>[]; registry: ReturnType<typeof makeRegistry> }>>['result'],
  item: ReturnType<typeof makeItem>,
) {
  await act(async () => {
    hookResult.current.handleTabContextMenu(
      {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 0,
        clientY: 0,
      } as unknown as React.MouseEvent,
      item,
    )
  })
  expect(mockOpenNativeContextMenu).toHaveBeenCalled()
  const lastCall = (mockOpenNativeContextMenu.mock.calls as unknown as Array<[unknown]>).at(-1)
  return (lastCall?.[0] ?? []) as Array<{
    id: string
    enabled?: boolean
    onClick?: () => void
  }>
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('useContextTabsLogic.handleAddToChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockContextInjectionState.activeScopeId = 'session-active'
    mockCanAttachToChat.mockReturnValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('buildContextAttachment 返回 null 时弹错误 toast 且不调用 emitContextInject', async () => {
    mockBuildContextAttachment.mockReturnValue(null)

    const item = makeItem({ type: 'tabweb', id: 'tab-x' })
    const { useContextTabsLogic } = await import('../useContextTabsLogic')
    const { result } = renderHook(() =>
      useContextTabsLogic({
        items: [item],
        registry: makeRegistry(),
        onSelectHome: vi.fn(),
        onSelectItem: vi.fn(),
        onCloseItem: vi.fn(),
      }),
    )

    const menuItems = await openContextMenuAndGetItems(result, item)
    const addToChat = menuItems.find(m => m.id === 'add-to-chat')
    expect(addToChat).toBeDefined()

    await act(async () => {
      addToChat!.onClick?.()
    })

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '当前标签不支持加入对话',
        variant: 'destructive',
      }),
    )
    expect(mockEmitContextInject).not.toHaveBeenCalled()
  })

  it('activeScopeId 为空时弹错误 toast 且不调用 emitContextInject', async () => {
    mockBuildContextAttachment.mockReturnValue({
      refType: 'webpage',
      resourceId: 'https://example.com',
      label: 'Example',
      meta: { pageTitle: 'Example' },
    })
    mockContextInjectionState.activeScopeId = null

    const item = makeItem({ type: 'tabweb', id: 'tab-y' })
    const { useContextTabsLogic } = await import('../useContextTabsLogic')
    const { result } = renderHook(() =>
      useContextTabsLogic({
        items: [item],
        registry: makeRegistry(),
        onSelectHome: vi.fn(),
        onSelectItem: vi.fn(),
        onCloseItem: vi.fn(),
      }),
    )

    const menuItems = await openContextMenuAndGetItems(result, item)
    const addToChat = menuItems.find(m => m.id === 'add-to-chat')!
    await act(async () => {
      addToChat.onClick?.()
    })

    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '请先打开对话窗口',
        variant: 'destructive',
      }),
    )
    expect(mockEmitContextInject).not.toHaveBeenCalled()
  })

  it('成功路径：emitContextInject 收到正确的 type / resourceId / tabType / label / meta', async () => {
    mockBuildContextAttachment.mockReturnValue({
      refType: 'webpage',
      resourceId: 'https://google.com',
      label: 'Google',
      meta: { pageTitle: 'Google', favicon: 'https://google.com/favicon.ico' },
    })

    const item = makeItem({ type: 'tabweb', id: 'tab-z', title: 'Google' })
    const { useContextTabsLogic } = await import('../useContextTabsLogic')
    const { result } = renderHook(() =>
      useContextTabsLogic({
        items: [item],
        registry: makeRegistry(),
        onSelectHome: vi.fn(),
        onSelectItem: vi.fn(),
        onCloseItem: vi.fn(),
      }),
    )

    const menuItems = await openContextMenuAndGetItems(result, item)
    const addToChat = menuItems.find(m => m.id === 'add-to-chat')!
    await act(async () => {
      addToChat.onClick?.()
    })

    expect(mockEmitContextInject).toHaveBeenCalledTimes(1)
    expect(mockEmitContextInject).toHaveBeenCalledWith({
      type: 'webpage',
      resourceId: 'https://google.com',
      label: 'Google',
      tabType: 'tabweb',
      meta: { pageTitle: 'Google', favicon: 'https://google.com/favicon.ico' },
    })
    // 成功路径也会弹 success toast，确保 toast 被触发但不是 destructive
    const lastToast = mockToast.mock.calls.at(-1)?.[0]
    expect(lastToast?.variant).not.toBe('destructive')
  })

  it('canAttachToChat=false 时菜单项 disable，不触发 handleAddToChat', async () => {
    // 业务保护：handler 未声明 attachToChat 的 tab，菜单项应该 disabled。
    // 即使 disabled 项在某些 IPC 实现上可能仍能 click（取决于宿主），useContextTabsLogic
    // 对该 case 的契约是 menuItem.enabled === false。
    mockCanAttachToChat.mockReturnValue(false)
    mockBuildContextAttachment.mockReturnValue(null)

    const item = makeItem({ type: 'tabmail', id: 'm-1' })
    const { useContextTabsLogic } = await import('../useContextTabsLogic')
    const { result } = renderHook(() =>
      useContextTabsLogic({
        items: [item],
        registry: makeRegistry(),
        onSelectHome: vi.fn(),
        onSelectItem: vi.fn(),
        onCloseItem: vi.fn(),
      }),
    )

    const menuItems = await openContextMenuAndGetItems(result, item)
    const addToChat = menuItems.find(m => m.id === 'add-to-chat')!
    expect(addToChat.enabled).toBe(false)
  })
})

describe('useContextTabsLogic grouped tab lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('用 allItems 激活不在 visible items 里的分屏 pane tab', async () => {
    const visibleItem = makeItem({ type: 'tabdoc', id: 'doc-1', title: 'Doc' })
    const groupedItem = makeItem({ type: 'tabweb', id: 'view-1', title: 'Grouped Web' })
    const onSelectItem = vi.fn()

    const { useContextTabsLogic } = await import('../useContextTabsLogic')
    const { result } = renderHook(() =>
      useContextTabsLogic({
        items: [visibleItem],
        allItems: [visibleItem, groupedItem],
        registry: makeRegistry(),
        onSelectHome: vi.fn(),
        onSelectItem,
        onCloseItem: vi.fn(),
      }),
    )

    act(() => {
      result.current.activateTabKey(groupedItem.tabKey)
    })

    expect(onSelectItem).toHaveBeenCalledWith(groupedItem)
    expect(result.current.getLabelForTabKey(groupedItem.tabKey)).toBe('Grouped Web')
  })
})
