/**
 * resourceTelemetry integration test — Wave 7 renderer → IPC → main 的端到端绑定。
 *
 * 防回归覆盖（W4 P0 同款"真 wiring 守门"教训）：
 *   1. wireResourceRouter 注入 createResourceTelemetryEmitter() 后，
 *      router.open 触发的事件能跨过整条链路：
 *        emitter → window.tabtin.resourceTelemetry.emit → 测试 spy
 *   2. emitter 真从 useAuthStore + useOrganizationStore 注入 user_id / organization_id
 *      （W7 自挖：preload IPC 序列化只接受 plain object，user_id 注入必须发生
 *      在 renderer 端而不是 main 端 —— 否则跨进程边界字段缺失）
 *   3. 未登录态（user 缺失）skip emit，不污染表（PG UUIDField 不收空字符串）
 *   4. preload IPC 不存在时静默 noop（test / detached 窗口环境不挂掉）
 *   5. emit 抛错不阻塞 router 业务（router.open 仍返回 outcome）
 *   6. 矩阵：5 trigger × 3 outcome 都能跨链路
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseResourcePointer } from '@tabtin/resource-router'

import {
  resourceRouter,
  resourceRouterRegistry,
  wireResourceRouter,
} from '@/services/resourceRouter'
import { createResourceTelemetryEmitter } from '@/services/resourceTelemetryEmitter'
import {
  useResourceOpenPreferences,
  createResourceOpenPreferenceAdapter,
} from '@/stores/useResourceOpenPreferences'

// 真实 store
import { useAuthStore } from '@/stores/useAuthStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'

// ─── 真实 wiring 装配 ────────────────────────────────────────────────

const openResourceTabSpy = vi.fn()
const shellOpenExternalSpy = vi.fn().mockResolvedValue(undefined)
const ipcEmitSpy = vi.fn().mockResolvedValue({ ok: true })
let knownAppIds = new Set<string>()

function makeContextRegistryAdapter() {
  return {
    hasHandlerByAppId: (appId: string) => knownAppIds.has(appId),
    getAppIdsForType: () => [],
  }
}

interface ResetOpts {
  knownAppIds?: string[]
  registryEntries?: Array<{
    appId: string
    types?: Array<{ type: string; priority: number }>
    schemes?: Array<{ scheme: string; priority: number }>
  }>
  user?: { id: string; username: string } | null
  organizationId?: string | null
  /** 模拟 preload IPC 是否注入到 window.tabtin */
  withPreload?: boolean
  /** ipc emit spy 是否抛错（验证非阻塞契约） */
  ipcThrows?: boolean
}

function resetWiring(opts: ResetOpts = {}) {
  // ── store 重置 ──
  useResourceOpenPreferences.setState({ preferences: {}, sessionOverrides: {} })
  ;(resourceRouterRegistry as unknown as {
    typeIndex: Map<unknown, unknown>
    schemeIndex: Map<unknown, unknown>
  }).typeIndex.clear()
  ;(resourceRouterRegistry as unknown as {
    typeIndex: Map<unknown, unknown>
    schemeIndex: Map<unknown, unknown>
  }).schemeIndex.clear()
  for (const e of opts.registryEntries ?? []) {
    resourceRouterRegistry.register(e.appId, { types: e.types, schemes: e.schemes })
  }
  knownAppIds = new Set(opts.knownAppIds ?? [])

  // ── auth + organization store 重置 ──
  useAuthStore.setState({
    user: opts.user === undefined
      ? { id: 'user-fixture-1', username: 'fixture' }
      : (opts.user as never),
    accessToken: opts.user ? 'mock-token' : null,
    authPhase: opts.user ? 'authenticated' : 'unauthenticated',
  } as never)
  useOrganizationStore.setState({
    selectedOrganization: opts.organizationId === null
      ? null
      : { id: opts.organizationId ?? 'organization-fixture-1', name: 'fixture' },
  } as never)

  // ── preload IPC 模拟 ──
  ipcEmitSpy.mockReset()
  if (opts.ipcThrows) {
    ipcEmitSpy.mockImplementation(() => {
      throw new Error('mock IPC down')
    })
  } else {
    ipcEmitSpy.mockResolvedValue({ ok: true })
  }
  if (opts.withPreload === false) {
    ;(window as unknown as { tabtin?: unknown }).tabtin = {} // 不挂 resourceTelemetry
  } else {
    ;(window as unknown as { tabtin?: unknown }).tabtin = {
      resourceTelemetry: { emit: ipcEmitSpy },
    }
  }

  openResourceTabSpy.mockClear()
  shellOpenExternalSpy.mockClear()

  // ── wire 真实 stack（与 registry/index.ts 同款配置）──
  wireResourceRouter({
    contextRegistry: makeContextRegistryAdapter(),
    openResourceTab: (...args) => openResourceTabSpy(...args),
    shellOpenExternal: (url) => shellOpenExternalSpy(url),
    preferenceStore: createResourceOpenPreferenceAdapter(),
    emitEvent: createResourceTelemetryEmitter(),
  })
}

beforeEach(() => {
  resetWiring()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ─── 1. 链路通：router → emitter → IPC ───────────────────────────────

describe('resourceTelemetry integration — 端到端链路', () => {
  it('router.open 在 D2 各层都触发 IPC emit（manifest_default 链路）', async () => {
    resetWiring({
      knownAppIds: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/table/tbl_1')
    const out = await resourceRouter.open('space-1', pointer, {
      triggerSource: 'chat_markdown',
    })
    expect(out.outcome).toBe('in_space_opened')
    expect(ipcEmitSpy).toHaveBeenCalledTimes(1)
    const [event] = ipcEmitSpy.mock.calls[0] as [Record<string, unknown>]
    expect(event.event_name).toBe('resource_open.resolved')
    expect(event.outcome).toBe('in_space_opened')
    expect(event.resolve_source).toBe('manifest_default')
    expect(event.trigger_source).toBe('chat_markdown')
  })

  it('emit payload 真带 user_id / organization_id（W7 自挖：必须 renderer 端注入）', async () => {
    resetWiring({
      knownAppIds: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
      user: { id: 'user-w7-test', username: 'w7' },
      organizationId: 'wt-w7-test',
    })
    const pointer = parseResourcePointer('tabtin://resource/table/tbl_2')
    await resourceRouter.open('space-1', pointer, { triggerSource: 'chat_markdown' })
    expect(ipcEmitSpy).toHaveBeenCalledTimes(1)
    const [event] = ipcEmitSpy.mock.calls[0] as [Record<string, unknown>]
    expect(event.user_id).toBe('user-w7-test')
    expect(event.organization_id).toBe('wt-w7-test')
  })

  it('opts.userId 被显式传入时不被 store 覆盖（保留调用方意图）', async () => {
    resetWiring({
      knownAppIds: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
      user: { id: 'store-user', username: 'store' },
      organizationId: 'store-wt',
    })
    const pointer = parseResourcePointer('tabtin://resource/table/tbl_3')
    await resourceRouter.open('space-1', pointer, {
      triggerSource: 'open_in_space_tool',
      userId: 'explicit-user',
      organizationId: 'explicit-wt',
    })
    const [event] = ipcEmitSpy.mock.calls[0] as [Record<string, unknown>]
    expect(event.user_id).toBe('explicit-user')
    expect(event.organization_id).toBe('explicit-wt')
  })
})

// ─── 2. 防御：未登录 / preload 不可用 ─────────────────────────────────

describe('resourceTelemetry integration — 防御 + 静默', () => {
  it('user 未登录（user=null）→ 跳过 emit（不污染 PG UUIDField）', async () => {
    resetWiring({
      knownAppIds: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
      user: null,
    })
    const pointer = parseResourcePointer('tabtin://resource/table/tbl_4')
    const out = await resourceRouter.open('space-1', pointer)
    expect(out.outcome).toBe('in_space_opened')
    expect(ipcEmitSpy).not.toHaveBeenCalled()
  })

  it('organization 未选中 → 跳过 emit', async () => {
    resetWiring({
      knownAppIds: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
      organizationId: null,
    })
    await resourceRouter.open(
      'space-1',
      parseResourcePointer('tabtin://resource/table/tbl_5'),
    )
    expect(ipcEmitSpy).not.toHaveBeenCalled()
  })

  it('preload IPC 不可用（test / detached）→ 静默 noop，router 仍正常派发', async () => {
    resetWiring({
      knownAppIds: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
      withPreload: false,
    })
    const out = await resourceRouter.open(
      'space-1',
      parseResourcePointer('tabtin://resource/table/tbl_6'),
    )
    expect(out.outcome).toBe('in_space_opened')
    expect(openResourceTabSpy).toHaveBeenCalledTimes(1)
  })

  it('IPC emit 抛错 → router.open 仍正常返回 outcome（fire-and-forget 契约）', async () => {
    resetWiring({
      knownAppIds: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
      ipcThrows: true,
    })
    const out = await resourceRouter.open(
      'space-1',
      parseResourcePointer('tabtin://resource/table/tbl_7'),
    )
    expect(out.outcome).toBe('in_space_opened')
    expect(openResourceTabSpy).toHaveBeenCalledTimes(1)
  })
})

// ─── 3. trigger × outcome 矩阵（W7 北极星 #1 守门）────────────────────

describe('resourceTelemetry integration — trigger × outcome 矩阵', () => {
  const triggers = [
    'chat_markdown',
    'open_in_space_tool',
    'rich_resource_card',
    'user_paste',
    'window_open_fallback',
  ] as const

  it.each(triggers)('trigger=%s 真 emit', async (trigger) => {
    resetWiring({
      knownAppIds: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
    })
    await resourceRouter.open(
      'space-1',
      parseResourcePointer('tabtin://resource/table/tbl_x'),
      { triggerSource: trigger },
    )
    expect(ipcEmitSpy).toHaveBeenCalledTimes(1)
    const [event] = ipcEmitSpy.mock.calls[0] as [Record<string, unknown>]
    expect(event.trigger_source).toBe(trigger)
  })

  it('outcome=denied_known_bad（chrome:// scheme）真 emit', async () => {
    resetWiring({})
    await resourceRouter.open(
      'space-1',
      parseResourcePointer('chrome://settings'),
    )
    expect(ipcEmitSpy).toHaveBeenCalledTimes(1)
    const [event] = ipcEmitSpy.mock.calls[0] as [Record<string, unknown>]
    expect(event.outcome).toBe('denied_known_bad')
    expect(event.event_name).toBe('resource_open.failed')
  })

  it('outcome=system_app_opened（system fallback）真 emit', async () => {
    resetWiring({})
    await resourceRouter.open(
      'space-1',
      parseResourcePointer('https://example.com'),
    )
    expect(ipcEmitSpy).toHaveBeenCalledTimes(1)
    const [event] = ipcEmitSpy.mock.calls[0] as [Record<string, unknown>]
    expect(event.outcome).toBe('system_app_opened')
    expect(event.resolve_source).toBe('system_fallback')
  })

  it('outcome=error（shellOpenExternal throw）真 emit', async () => {
    resetWiring({})
    shellOpenExternalSpy.mockRejectedValueOnce(new Error('mock OS error'))
    await resourceRouter.open(
      'space-1',
      parseResourcePointer('https://example.com'),
    )
    expect(ipcEmitSpy).toHaveBeenCalledTimes(1)
    const [event] = ipcEmitSpy.mock.calls[0] as [Record<string, unknown>]
    expect(event.outcome).toBe('error')
    expect(event.error_message).toBe('mock OS error')
  })
})
