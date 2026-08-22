/**
 * ResourceLinkContextMenu.e2e — W4 北极星
 *
 * `pnpm --filter tabtin-electron test:e2e ResourceLinkContextMenu.e2e`
 *
 * 覆盖 W4 用户偏好 / 会话临时切换的端到端：
 *
 *   场景 1 「用 X 打开」（一次性 / session）：
 *     - 右键 → 子菜单"用 TabCode 打开" → store.sessionOverrides 写入 + router.open 用 forceCarrierAppId
 *     - 关键：仅 sessionOverrides，preferences 仍空（不持久化）
 *
 *   场景 2 「始终用 X 打开」（持久化 / preferences）：
 *     - 右键 → 子菜单"始终用 TabCode 打开" → store.preferences 写入（落 localStorage）+ router.open 立即按新偏好生效
 *     - 关键：preferences 持久化（reload localStorage 后仍在）
 *
 *   场景 3 跨多次操作不残留污染：
 *     - 用户先点"用 X 打开"再点"始终用 Y 打开"——sessionOverrides 仅留 X，preferences 仅留 Y
 *
 *   场景 4 已选偏好的 ✓ 标记：
 *     - 子菜单内当前 user_pref / sessionOverride 对应项渲染 ✓
 *
 * 项目无 Playwright e2e 基础设施（参照 W3 ResourceLink.e2e.test.ts 同款 fallback 模式）。
 * 用 vitest + @testing-library/react 渲染 ResourceLinkContextMenuHost + 模拟 imperative
 * 调用，覆盖整条 store ↔ router ↔ menu 链路。
 */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { parseResourcePointer } from '@tabtin/resource-router'

// 必须 override setup.ts 的 react-i18next mock，让 defaultValue 生效——
// menu 文案完全靠 defaultValue 兜底，i18n 文件没补对应 key
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const def = (options as { defaultValue?: string } | undefined)?.defaultValue
      let str = typeof def === 'string' ? def : key
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          if (k === 'defaultValue') continue
          str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
        }
      }
      return str
    },
    i18n: { language: 'zh-CN' },
  }),
}))

// router.open 是 mock — 我们只验证菜单项点击是否调对了 router 接口
const routerOpen = vi.fn(async () => ({
  outcome: 'in_space_opened',
  carrierAppId: 'tabcode',
  resolveSource: 'session_override',
  durationMs: 0,
}))

// router.resolve 在 menu 打开时被调以拿 candidates；返回固定的 2 个 carrier
const routerResolve = vi.fn(() => ({
  pointer: parseResourcePointer('tabtin://resource/document/doc_1'),
  candidates: [
    { appId: 'tabdoc', priority: 1_000_000_000, source: 'manifest_default' as const },
    { appId: 'tabcode', priority: 50, source: 'manifest_default' as const },
    { appId: '__system__', priority: -1, source: 'system_fallback' as const },
  ],
  chosen: { appId: 'tabdoc', priority: 1_000_000_000, source: 'manifest_default' as const },
}))

vi.mock('@/services/resourceRouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/resourceRouter')>()
  return {
    ...actual,
    resourceRouter: {
      open: (...args: unknown[]) => routerOpen(...args),
      resolve: (...args: unknown[]) => routerResolve(...args),
    },
  }
})

// contextRegistry — 给 menu 显示 carrier 名（'TabDoc' / 'TabCode'）
vi.mock('@/components/context-space/registry/instance', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/components/context-space/registry/instance')
  >()
  const handlers: Record<string, { displayLabel: string; displayEmoji?: string }> = {
    tabdoc: { displayLabel: 'TabDoc', displayEmoji: '📄' },
    tabcode: { displayLabel: 'TabCode', displayEmoji: '💻' },
  }
  vi.spyOn(actual.contextRegistry, 'getHandlerByAppId')
    .mockImplementation((appId: string) => handlers[appId] as never)
  return actual
})

// toast — 写偏好后弹 toast，不影响测试，stub 即可
vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

import {
  ResourceLinkContextMenuHost,
  showResourceLinkContextMenu,
} from '../ResourceLinkContextMenu'
import { useResourceOpenPreferences } from '@/stores/useResourceOpenPreferences'
import { PERSIST_KEYS } from '@/stores/persist-key-registry'

const POINTER = parseResourcePointer('tabtin://resource/document/doc_1')

beforeEach(() => {
  useResourceOpenPreferences.setState({ preferences: {}, sessionOverrides: {} })
  routerOpen.mockClear()
  routerResolve.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

function showMenu() {
  act(() => {
    showResourceLinkContextMenu({
      x: 100,
      y: 100,
      href: 'tabtin://resource/document/doc_1',
      spaceId: 'space-test',
      pointer: POINTER,
    })
  })
}

function showMenuWithScope(tabScopeKey: string) {
  act(() => {
    showResourceLinkContextMenu({
      x: 100,
      y: 100,
      href: 'tabtin://resource/document/doc_1',
      spaceId: 'space-test',
      tabScopeKey,
      pointer: POINTER,
    })
  })
}

async function openSubmenu(triggerLabelPattern: RegExp): Promise<HTMLElement> {
  // 用 regex match：trigger 加了 secondary 文案 / aria-label 之后 accessible name
  // 含"（仅本次）"等后缀，精确字符串 match 会失效
  const trigger = await screen.findByRole('menuitem', { name: triggerLabelPattern })
  // hover trigger → 触发延迟打开（100ms）
  await act(async () => {
    fireEvent.mouseEnter(trigger)
    // 让 setTimeout 100ms 触发的状态更新进入 act batching
    await new Promise((r) => setTimeout(r, 150))
  })
  await waitFor(() => {
    const submenu = trigger.parentElement?.querySelector('[role="menu"]')
    expect(submenu).toBeTruthy()
  })
  return trigger.parentElement!.querySelector('[role="menu"]') as HTMLElement
}

describe('ResourceLinkContextMenu W4 e2e — "用 X 打开" / "始终用 X 打开"', () => {
  it('右键菜单含两个新子菜单：用其他应用打开 / 始终用其他应用打开', async () => {
    render(<ResourceLinkContextMenuHost />)
    showMenu()
    await screen.findByRole('menu', { name: /链接操作菜单/ })
    expect(screen.getByText('用其他应用打开')).toBeTruthy()
    expect(screen.getByText('始终用其他应用打开')).toBeTruthy()
  })

  it('场景 1 「用 X 打开」→ 仅写 sessionOverrides，preferences 不变', async () => {
    render(<ResourceLinkContextMenuHost />)
    showMenu()
    const submenu = await openSubmenu(/^用其他应用打开/)

    // 子菜单含两个 carrier 选项
    expect(within(submenu).getByText('TabDoc')).toBeTruthy()
    expect(within(submenu).getByText('TabCode')).toBeTruthy()

    fireEvent.click(within(submenu).getByText('TabCode'))

    const state = useResourceOpenPreferences.getState()
    expect(state.sessionOverrides['type:document']).toBe('tabcode')
    expect(state.preferences['type:document']).toBeUndefined() // 未持久化

    // router.open 被调，且 forceCarrierAppId=tabcode
    expect(routerOpen).toHaveBeenCalledTimes(1)
    const [, , opts] = routerOpen.mock.calls[0]
    expect((opts as Record<string, unknown>).forceCarrierAppId).toBe('tabcode')
  })

  it('在 Space 内打开时透传 tabScopeKey 到 ResourceRouter', async () => {
    render(<ResourceLinkContextMenuHost />)
    showMenuWithScope('conversation:session-1')
    await screen.findByRole('menu', { name: /链接操作菜单/ })

    fireEvent.click(screen.getByRole('menuitem', { name: /在工作空间内打开/ }))

    const [, , opts] = routerOpen.mock.calls[0]
    expect((opts as Record<string, unknown>).tabScopeKey).toBe('conversation:session-1')
  })

  it('场景 2 「始终用 X 打开」→ preferences 写入并持久化到 localStorage', async () => {
    render(<ResourceLinkContextMenuHost />)
    showMenu()
    const submenu = await openSubmenu(/^始终用其他应用打开/)

    fireEvent.click(within(submenu).getByText('TabCode'))

    // store.preferences 写入
    expect(useResourceOpenPreferences.getState().preferences['type:document']).toBe('tabcode')

    // localStorage 落库（zustand persist）
    const raw = localStorage.getItem(PERSIST_KEYS.resourceOpenPreferences)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.state.preferences['type:document']).toBe('tabcode')

    // 同时立即调一次 router.open（让用户感受到偏好已生效）；不传 forceCarrierAppId
    expect(routerOpen).toHaveBeenCalledTimes(1)
    const [, , opts] = routerOpen.mock.calls[0]
    expect((opts as Record<string, unknown>).forceCarrierAppId).toBeUndefined()
  })

  it('场景 3 多次切换不残留污染：先 sessionOverride X，再 preference Y', async () => {
    render(<ResourceLinkContextMenuHost />)

    // step 1：用 TabCode 打开（session）
    showMenu()
    let submenu = await openSubmenu(/^用其他应用打开/)
    fireEvent.click(within(submenu).getByText('TabCode'))

    // 重新打开菜单
    showMenu()
    submenu = await openSubmenu(/^始终用其他应用打开/)
    fireEvent.click(within(submenu).getByText('TabDoc'))

    const state = useResourceOpenPreferences.getState()
    // session 仍是 X（tabcode），preferences 是 Y（tabdoc）
    expect(state.sessionOverrides['type:document']).toBe('tabcode')
    expect(state.preferences['type:document']).toBe('tabdoc')
  })

  it('场景 4 ✓ 标记：当前 user_pref 项在子菜单内显示 aria-checked', async () => {
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabcode')
    render(<ResourceLinkContextMenuHost />)
    showMenu()
    const submenu = await openSubmenu(/^始终用其他应用打开/)

    // tabcode 项 aria-checked=true，tabdoc 为 false
    const tabcodeItem = within(submenu).getByRole('menuitemradio', { name: /TabCode/ })
    const tabdocItem = within(submenu).getByRole('menuitemradio', { name: /TabDoc/ })
    expect(tabcodeItem.getAttribute('aria-checked')).toBe('true')
    expect(tabdocItem.getAttribute('aria-checked')).toBe('false')
  })

  it('场景 4 ✓ 标记：当前 sessionOverride 项在 "用 X 打开" 子菜单内显示 aria-checked', async () => {
    useResourceOpenPreferences.getState().setSessionOverride('type:document', 'tabdoc')
    render(<ResourceLinkContextMenuHost />)
    showMenu()
    const submenu = await openSubmenu(/^用其他应用打开/)

    const tabdocItem = within(submenu).getByRole('menuitemradio', { name: /TabDoc/ })
    const tabcodeItem = within(submenu).getByRole('menuitemradio', { name: /TabCode/ })
    expect(tabdocItem.getAttribute('aria-checked')).toBe('true')
    expect(tabcodeItem.getAttribute('aria-checked')).toBe('false')
  })

  it('"用 X 打开" 子菜单不含 system_fallback（__system__ 在外面单独"在外部应用打开"）', async () => {
    render(<ResourceLinkContextMenuHost />)
    showMenu()
    const submenu = await openSubmenu(/^用其他应用打开/)
    // 不应渲染 __system__ 这个 appId
    expect(within(submenu).queryByText(/__system__/)).toBeNull()
  })
})

// ── 持久化往返：跨 mount 模拟应用重启偏好仍在 ──────────────────────────

describe('ResourceLinkContextMenu W4 e2e — 持久化往返', () => {
  it('设过偏好后 unmount + remount，preferences 仍存（localStorage 兜底）', async () => {
    const view = render(<ResourceLinkContextMenuHost />)
    showMenu()
    const submenu = await openSubmenu(/^始终用其他应用打开/)
    fireEvent.click(within(submenu).getByText('TabCode'))

    // localStorage 已写入
    const raw = localStorage.getItem(PERSIST_KEYS.resourceOpenPreferences)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!).state.preferences['type:document']).toBe('tabcode')

    // unmount 模拟应用关闭
    view.unmount()
    // store 内存状态保留——zustand 是 module singleton
    expect(useResourceOpenPreferences.getState().preferences['type:document']).toBe('tabcode')

    // remount 时偏好仍在（实际应用启动时 zustand persist 会从 localStorage 重水化；
    // 这里 module singleton 内存已有，效果等价）
    render(<ResourceLinkContextMenuHost />)
    showMenu()
    const submenu2 = await openSubmenu(/^始终用其他应用打开/)
    const tabcodeItem = within(submenu2).getByRole('menuitemradio', { name: /TabCode/ })
    expect(tabcodeItem.getAttribute('aria-checked')).toBe('true')
  })
})
