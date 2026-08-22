/**
 * T2 回归测试：⌘1-⌘9 数字键切换到第 N 个 visible tab
 *
 * 验证：
 * 1. ⌘1..⌘8 切到对应位置的 visible tab
 * 2. ⌘9 切到最后一个 visible tab（Chrome / Arc / VSCode 惯例）
 * 3. visible tab 不足 N 个时静默无响应（不崩溃、不切换）
 * 4. DOM keydown 与 IPC 两条路径都能正确触发
 * 5. ⌘0 仍然是 zoom-reset（不被误识别为数字键切换）
 * 6. canvas group 内的子 pane 不参与数字键切换（visibleTabKeys 已过滤）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ContextItem } from '../../registry/types'
import { useContextSpaceShortcuts } from '../useContextSpaceShortcuts'

// ── Fixtures ──

const makeItem = (tabKey: string): ContextItem => {
  const [type, id = ''] = tabKey.split(':')
  return {
    type: type as ContextItem['type'],
    id,
    tabKey: tabKey as ContextItem['tabKey'],
  }
}

const buildItemsMap = (keys: string[]): Map<string, ContextItem> => {
  return new Map(keys.map(key => [key, makeItem(key)]))
}

interface HookHandlers {
  onSelectItem: ReturnType<typeof vi.fn>
  onCloseItem: ReturnType<typeof vi.fn>
  onRefreshItem: ReturnType<typeof vi.fn>
  onZoomItem: ReturnType<typeof vi.fn>
  onFindItem: ReturnType<typeof vi.fn>
}

const renderShortcutHook = (opts: {
  visibleTabKeys: string[]
  orderedTabKeys?: string[]
  activeTabKey?: string | null
  enabled?: boolean
}) => {
  const handlers: HookHandlers = {
    onSelectItem: vi.fn(),
    onCloseItem: vi.fn(),
    onRefreshItem: vi.fn(),
    onZoomItem: vi.fn(),
    onFindItem: vi.fn(),
  }
  const itemsByTabKey = buildItemsMap(opts.visibleTabKeys)
  const result = renderHook(() =>
    useContextSpaceShortcuts({
      enabled: opts.enabled ?? true,
      activeTabKey: opts.activeTabKey ?? opts.visibleTabKeys[0] ?? null,
      orderedTabKeys: opts.orderedTabKeys ?? opts.visibleTabKeys,
      visibleTabKeys: opts.visibleTabKeys,
      itemsByTabKey,
      onSelectItem: handlers.onSelectItem,
      onCloseItem: handlers.onCloseItem,
      onRefreshItem: handlers.onRefreshItem,
      onZoomItem: handlers.onZoomItem,
      onFindItem: handlers.onFindItem,
    }),
  )
  return { handlers, result, itemsByTabKey }
}

const dispatchCmdKey = (key: string, overrides: Partial<KeyboardEventInit> = {}) => {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  })
  document.dispatchEvent(event)
  return event
}

type WindowWithElectron = Window & typeof globalThis & { electron?: unknown }

const setElectronBridge = (value: unknown) => {
  ;(window as WindowWithElectron).electron = value
}

// ── DOM keydown 路径（浏览器 / 非 Electron 环境） ──

describe('useContextSpaceShortcuts · 数字键切换（DOM keydown 路径）', () => {
  let originalElectron: unknown

  beforeEach(() => {
    originalElectron = (window as WindowWithElectron).electron
    // 确保 DOM 监听器生效：移除 electron bridge（hasElectronShortcutBridge → false）
    setElectronBridge(undefined)
  })

  afterEach(() => {
    setElectronBridge(originalElectron)
  })

  it('⌘2 切到第 2 个 visible tab', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
    })

    dispatchCmdKey('2')

    expect(handlers.onSelectItem).toHaveBeenCalledTimes(1)
    expect(handlers.onSelectItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabweb:b' }),
    )
  })

  it('⌘9 切到最后一个 visible tab（即使只有 3 个 tab，也是第 3 个而非第 9 个）', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
    })

    dispatchCmdKey('9')

    expect(handlers.onSelectItem).toHaveBeenCalledTimes(1)
    expect(handlers.onSelectItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabweb:c' }),
    )
  })

  it('⌘9 在 tab 超过 9 个时仍然切到最后一个（绝非第 9 个）', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `tabweb:${i + 1}`)
    const { handlers } = renderShortcutHook({
      visibleTabKeys: keys,
      activeTabKey: keys[0],
    })

    dispatchCmdKey('9')

    expect(handlers.onSelectItem).toHaveBeenCalledTimes(1)
    expect(handlers.onSelectItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabweb:12' }),
    )
  })

  it('⌘5 在只有 3 个 visible tab 时静默无响应', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
    })

    dispatchCmdKey('5')

    expect(handlers.onSelectItem).not.toHaveBeenCalled()
  })

  it('⌘9 在没有任何 visible tab 时静默无响应（不崩溃）', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: [],
      activeTabKey: null,
    })

    expect(() => dispatchCmdKey('9')).not.toThrow()
    expect(handlers.onSelectItem).not.toHaveBeenCalled()
  })

  it('⌘0 仍然是 zoom-reset，不会被识别为数字键切换', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
    })

    dispatchCmdKey('0')

    expect(handlers.onSelectItem).not.toHaveBeenCalled()
    expect(handlers.onZoomItem).toHaveBeenCalledTimes(1)
    expect(handlers.onZoomItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabweb:a' }),
      'reset',
    )
  })

  it('Shift + ⌘1 不触发数字键切换（保留 shift 组合给未来扩展）', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
    })

    dispatchCmdKey('1', { shiftKey: true })

    expect(handlers.onSelectItem).not.toHaveBeenCalled()
  })

  it('Alt + ⌘1 不触发数字键切换', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
    })

    dispatchCmdKey('1', { altKey: true })

    expect(handlers.onSelectItem).not.toHaveBeenCalled()
  })

  it('canvas group 内 tab 不会通过数字键被直接选中（只基于 visibleTabKeys）', () => {
    // 模拟：orderedTabKeys 包含 group 内的子 tab（tabweb:inner），但 visibleTabKeys 不含
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b'],
      orderedTabKeys: ['tabweb:a', 'tabweb:inner', 'tabweb:b'],
      activeTabKey: 'tabweb:a',
    })

    dispatchCmdKey('2')

    expect(handlers.onSelectItem).toHaveBeenCalledTimes(1)
    // ⌘2 应该切到 visibleTabKeys[1] = 'tabweb:b'，而不是 orderedTabKeys[1] = 'tabweb:inner'
    expect(handlers.onSelectItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabweb:b' }),
    )
  })

  it('数字键切换会触发 event.preventDefault（避免浏览器默认行为）', () => {
    renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b'],
      activeTabKey: 'tabweb:a',
    })

    const event = dispatchCmdKey('2')

    expect(event.defaultPrevented).toBe(true)
  })

  it('Cmd+F 把 find 分发给当前活跃表格', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabdata:table-1'],
    })

    const event = dispatchCmdKey('f')

    expect(event.defaultPrevented).toBe(true)
    expect(handlers.onFindItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tabdata', id: 'table-1' }),
    )
  })

  it('enabled=false 时 DOM 监听器不响应数字键（hook 处于静默态）', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
      enabled: false,
    })

    dispatchCmdKey('2')

    expect(handlers.onSelectItem).not.toHaveBeenCalled()
  })

  it('组件卸载后 DOM 监听器被清理（不再响应键盘事件）', () => {
    const { handlers, result } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
    })

    result.unmount()
    dispatchCmdKey('2')

    expect(handlers.onSelectItem).not.toHaveBeenCalled()
  })
})

// ── IPC 路径（Electron 主进程转发） ──

describe('useContextSpaceShortcuts · 数字键切换（IPC 路径）', () => {
  let registeredHandlers: Array<(_event: unknown, payload: unknown) => void>
  let ipcRenderer: {
    on: ReturnType<typeof vi.fn>
  }
  let originalElectron: unknown

  beforeEach(() => {
    originalElectron = (window as WindowWithElectron).electron
    registeredHandlers = []
    ipcRenderer = {
      on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
        if (channel === 'context-space:shortcut') {
          registeredHandlers.push(handler)
        }
        return () => {
          const idx = registeredHandlers.indexOf(handler)
          if (idx >= 0) registeredHandlers.splice(idx, 1)
        }
      }),
    }
    setElectronBridge({ ipcRenderer })
  })

  afterEach(() => {
    setElectronBridge(originalElectron)
  })

  const emitIpc = (action: string) => {
    for (const handler of registeredHandlers) {
      handler({}, { action })
    }
  }

  it('收到 switch-tab-3 IPC 时切到第 3 个 visible tab', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c', 'tabweb:d'],
      activeTabKey: 'tabweb:a',
    })

    emitIpc('switch-tab-3')

    expect(handlers.onSelectItem).toHaveBeenCalledTimes(1)
    expect(handlers.onSelectItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabweb:c' }),
    )
  })

  it('收到 switch-tab-last IPC 时切到最后一个 visible tab', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
    })

    emitIpc('switch-tab-last')

    expect(handlers.onSelectItem).toHaveBeenCalledTimes(1)
    expect(handlers.onSelectItem).toHaveBeenCalledWith(
      expect.objectContaining({ tabKey: 'tabweb:c' }),
    )
  })

  it('收到 find IPC 时把请求分发给当前活跃表格', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabdata:table-1'],
    })

    emitIpc('find')

    expect(handlers.onFindItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tabdata', id: 'table-1' }),
    )
  })

  it('收到 switch-tab-5 但只有 3 个 visible tab 时静默无响应', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
    })

    emitIpc('switch-tab-5')

    expect(handlers.onSelectItem).not.toHaveBeenCalled()
  })

  it('启用 Electron bridge 时 DOM keydown 不触发数字键切换（避免双触发）', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
    })

    // 此场景下 bridge 已启用，DOM 监听器根本没注册
    dispatchCmdKey('2')

    expect(handlers.onSelectItem).not.toHaveBeenCalled()
  })

  it('enabled=false 时不订阅 IPC（不会响应主进程转发的数字键）', () => {
    const { handlers } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
      enabled: false,
    })

    expect(ipcRenderer.on).not.toHaveBeenCalledWith(
      'context-space:shortcut',
      expect.any(Function),
    )

    // 即便主进程仍然 emit，也没有 handler 在听
    emitIpc('switch-tab-2')
    expect(handlers.onSelectItem).not.toHaveBeenCalled()
  })

  it('组件卸载后 IPC 取消订阅（调用 unsubscribe）', () => {
    const unsubscribe = vi.fn()
    ipcRenderer.on.mockImplementationOnce(
      (channel: string, handler: (_event: unknown, payload: unknown) => void) => {
        if (channel === 'context-space:shortcut') {
          registeredHandlers.push(handler)
        }
        return unsubscribe
      },
    )

    const { result } = renderShortcutHook({
      visibleTabKeys: ['tabweb:a', 'tabweb:b', 'tabweb:c'],
      activeTabKey: 'tabweb:a',
    })

    result.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
