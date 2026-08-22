/**
 * resourceRouter integration test — W4「Agent 产物在 Space 内的打开」专题
 *
 * 这是 W4 三方 review（A/B/C）共同发现 P0 后必须补的回归测试。
 *
 * P0 复盘：renderer 层的 `preferenceStoreProxy` 漏代理 `getSessionOverride`，
 * 导致 router.open 内部读 sessionOverride 永远拿到 undefined。所有 unit 测试
 * 通过的原因是 router test 用 FakePreferenceStore（直接实现接口）、
 * Menu/Panel e2e 把整个 `services/resourceRouter` 模块整个 mock 掉——
 * 谁都没碰过真实 wiring 这一层。
 *
 * 本测试直接装配真实 stack：
 *   1. wireResourceRouter 注入真实 createResourceOpenPreferenceAdapter
 *   2. 注入测试 mock 的 contextRegistry / openResourceTab / shellOpenExternal
 *   3. 写 useResourceOpenPreferences zustand store
 *   4. 调真实 resourceRouter.open（不 mock）
 *   5. 断言派发结果
 *
 * 任何下次"加一个 preferenceStore 字段"的 Wave 必须保证本测试 PASS——
 * 否则就跟 W4 P0 同款断点。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseResourcePointer } from '@tabtin/resource-router'

import {
  resourceRouter,
  resourceRouterRegistry,
  wireResourceRouter,
} from '@/services/resourceRouter'
import {
  useResourceOpenPreferences,
  createResourceOpenPreferenceAdapter,
} from '@/stores/useResourceOpenPreferences'

// ─── 真实 wiring 装配（每个 it 前重置）─────────────────────────────────

const openResourceTabSpy = vi.fn()
const shellOpenExternalSpy = vi.fn().mockResolvedValue(undefined)
let knownAppIds = new Set<string>()

function makeContextRegistryAdapter() {
  return {
    hasHandlerByAppId: (appId: string) => knownAppIds.has(appId),
    getAppIdsForType: () => [],
  }
}

function resetWiring(opts: {
  knownAppIds: string[]
  registryEntries?: Array<{
    appId: string
    types?: Array<{ type: string; priority: number }>
    schemes?: Array<{ scheme: string; priority: number }>
  }>
}) {
  // 重置 store
  useResourceOpenPreferences.setState({ preferences: {}, sessionOverrides: {} })

  // 重置 registry
  ;(resourceRouterRegistry as unknown as { typeIndex: Map<unknown, unknown>; schemeIndex: Map<unknown, unknown> }).typeIndex.clear()
  ;(resourceRouterRegistry as unknown as { typeIndex: Map<unknown, unknown>; schemeIndex: Map<unknown, unknown> }).schemeIndex.clear()
  for (const e of opts.registryEntries ?? []) {
    resourceRouterRegistry.register(e.appId, { types: e.types, schemes: e.schemes })
  }

  // 重置 handler set
  knownAppIds = new Set(opts.knownAppIds)

  // 重置 spies
  openResourceTabSpy.mockClear()
  shellOpenExternalSpy.mockClear()

  // wire 真实 stack（与 registry/index.ts 同款配置，但用 spy 替代真实 IPC）
  wireResourceRouter({
    contextRegistry: makeContextRegistryAdapter(),
    openResourceTab: (...args) => openResourceTabSpy(...args),
    shellOpenExternal: (url) => shellOpenExternalSpy(url),
    preferenceStore: createResourceOpenPreferenceAdapter(),
  })
}

beforeEach(() => {
  resetWiring({ knownAppIds: [] })
})

afterEach(() => {
  vi.clearAllMocks()
})

// ─── P0 回归：sessionOverride wiring 链路 ─────────────────────────────

describe('resourceRouter integration — sessionOverride wiring（P0 回归）', () => {
  it('user 写 sessionOverride 后普通点击（不传 forceCarrierAppId）走 session_override', async () => {
    // 这是 W4 三方 P0 的核心：原 proxy 漏代理 getSessionOverride 时本测试必挂
    resetWiring({
      knownAppIds: ['tabdoc', 'tabweb'],
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    useResourceOpenPreferences
      .getState()
      .setSessionOverride('type:document', 'tabweb')

    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await resourceRouter.open('space-1', pointer, {
      triggerSource: 'chat_markdown',
    })

    expect(out.outcome).toBe('in_space_opened')
    expect(out.carrierAppId).toBe('tabweb')
    expect(out.resolveSource).toBe('session_override')
    expect(openResourceTabSpy).toHaveBeenCalledTimes(1)
    expect(shellOpenExternalSpy).not.toHaveBeenCalled()
  })

  it('user 写 user_pref 后普通点击走 user_pref（D2 第 1 层永远胜过其他）', async () => {
    resetWiring({
      knownAppIds: ['tabdoc', 'tabweb', 'tabcode'],
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabcode')
    // 同时写 sessionOverride，验证 D2 第 1 层胜过第 2 层
    useResourceOpenPreferences
      .getState()
      .setSessionOverride('type:document', 'tabweb')

    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await resourceRouter.open('space-1', pointer)

    expect(out.carrierAppId).toBe('tabcode')
    expect(out.resolveSource).toBe('user_pref')
  })

  it('L19：user_pref 指向不可用 carrier → 降级 manifest_default 而非系统应用', async () => {
    // 也是三方 P1 关注：UI 文案承诺的 L19 行为是否真在 wiring 上成立
    resetWiring({
      knownAppIds: ['tabdoc'], // tabweb 注册到 manifest 但 handler 缺
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
        { appId: 'tabweb', types: [{ type: 'document', priority: 50 }] },
      ],
    })
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabweb')

    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await resourceRouter.open('space-1', pointer)

    expect(out.outcome).toBe('in_space_opened')
    expect(out.carrierAppId).toBe('tabdoc')
    expect(out.resolveSource).toBe('manifest_default')
    // 关键：不是系统应用兜底
    expect(shellOpenExternalSpy).not.toHaveBeenCalled()
  })

  it('clearAllPreferences 不清 sessionOverrides（widget 反思 10 多 turn 隔离）', async () => {
    resetWiring({
      knownAppIds: ['tabdoc', 'tabweb'],
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabcode')
    useResourceOpenPreferences
      .getState()
      .setSessionOverride('type:document', 'tabweb')

    useResourceOpenPreferences.getState().clearAllPreferences()

    // sessionOverrides 仍在
    expect(useResourceOpenPreferences.getState().sessionOverrides['type:document']).toBe('tabweb')

    // 下次 open 走 sessionOverride（user_pref 已清）
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await resourceRouter.open('space-1', pointer)
    expect(out.carrierAppId).toBe('tabweb')
    expect(out.resolveSource).toBe('session_override')
  })

  it('右键菜单连续多次切换 sessionOverride 不残留污染', async () => {
    resetWiring({
      knownAppIds: ['tabdoc', 'tabweb', 'tabcode'],
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')

    // 第 1 次：右键"用 tabweb 打开"（forceCarrierAppId）
    useResourceOpenPreferences
      .getState()
      .setSessionOverride('type:document', 'tabweb')
    const r1 = await resourceRouter.open('space-1', pointer, {
      forceCarrierAppId: 'tabweb',
    })
    expect(r1.carrierAppId).toBe('tabweb')

    // 第 2 次：右键改"用 tabcode 打开"
    useResourceOpenPreferences
      .getState()
      .setSessionOverride('type:document', 'tabcode')
    const r2 = await resourceRouter.open('space-1', pointer, {
      forceCarrierAppId: 'tabcode',
    })
    expect(r2.carrierAppId).toBe('tabcode')

    // 第 3 次：左键普通点击（不传 force），sessionOverride 仍是 tabcode
    const r3 = await resourceRouter.open('space-1', pointer)
    expect(r3.carrierAppId).toBe('tabcode')
    expect(r3.resolveSource).toBe('session_override')
  })

  it('未设任何偏好 → 走 manifest_default', async () => {
    // 控制组：确保不是因为 sessionOverride 总是命中才让其他用例 PASS
    resetWiring({
      knownAppIds: ['tabdoc'],
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await resourceRouter.open('space-1', pointer)
    expect(out.carrierAppId).toBe('tabdoc')
    expect(out.resolveSource).toBe('manifest_default')
  })

  it('⌘ 修饰键短路：直接走系统应用，跳过 sessionOverride / user_pref', async () => {
    resetWiring({
      knownAppIds: ['tabdoc'],
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    useResourceOpenPreferences
      .getState()
      .setPreference('type:document', 'tabdoc')
    useResourceOpenPreferences
      .getState()
      .setSessionOverride('type:document', 'tabdoc')

    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await resourceRouter.open('space-1', pointer, {
      modifierExternal: true,
    })
    expect(out.outcome).toBe('system_app_opened')
    expect(out.resolveSource).toBe('modifier_key')
    expect(openResourceTabSpy).not.toHaveBeenCalled()
    expect(shellOpenExternalSpy).toHaveBeenCalled()
  })

  it('行业格式（https）通过 sessionOverride 切换 carrier', async () => {
    resetWiring({
      knownAppIds: ['tabweb', 'tabcode'],
      registryEntries: [
        { appId: 'tabweb', schemes: [{ scheme: 'https:', priority: 50 }] },
      ],
    })
    useResourceOpenPreferences
      .getState()
      .setSessionOverride('scheme:https:', 'tabcode')

    const pointer = parseResourcePointer('https://example.com/x')
    const out = await resourceRouter.open('space-1', pointer)
    expect(out.carrierAppId).toBe('tabcode')
    expect(out.resolveSource).toBe('session_override')
  })
})

describe('resourceRouter integration — TabData 记录定位', () => {
  it('把资源链接中的 recordIds 转为每次打开都可消费的记录聚焦意图', async () => {
    resetWiring({
      knownAppIds: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
    })

    const pointer = parseResourcePointer(
      'tabtin://resource/table/table-1?hint=tabdata&recordIds=record-42',
    )
    await resourceRouter.open('space-1', pointer)

    expect(openResourceTabSpy).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({
        type: 'table',
        id: 'table-1',
        meta: expect.objectContaining({
          recordIds: 'record-42',
          recordFocusRecordId: 'record-42',
          recordFocusRequestId: expect.any(String),
        }),
      }),
    )
  })
})

// ─── BR-31：outcome 真实性（openResourceTab 失败 → error，触发 chat 兜底）────────

describe('resourceRouter integration — BR-31 outcome 真实性', () => {
  it('https 默认走 manifest_default(tabweb)，把原始 URL 透传给 openResourceTab', async () => {
    resetWiring({
      knownAppIds: ['tabweb'],
      registryEntries: [
        { appId: 'tabweb', schemes: [{ scheme: 'https:', priority: 50 }] },
      ],
    })
    const pointer = parseResourcePointer('https://www.iana.org/')
    const out = await resourceRouter.open('space-1', pointer, { triggerSource: 'chat_markdown' })

    expect(out.outcome).toBe('in_space_opened')
    expect(out.carrierAppId).toBe('tabweb')
    expect(out.resolveSource).toBe('manifest_default')
    expect(openResourceTabSpy).toHaveBeenCalledTimes(1)
    expect(openResourceTabSpy).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({ type: 'https', id: 'https://www.iana.org/' }),
    )
    // 走载体而非系统应用兜底
    expect(shellOpenExternalSpy).not.toHaveBeenCalled()
  })

  it('openResourceTab throw（tabweb view 创建失败时本应如此）→ outcome=error', async () => {
    // BR-31 核心契约：wired openResourceTab（registry/index.ts）对 tabweb-URL 走真实
    // crawl view 创建，失败时 throw；router 捕获后 outcome='error'。MarkdownRenderer
    // 据 outcome==='error' 触发 BR-25 的 http(s) 兜底 openExternal（router 本身不兜底）。
    resetWiring({
      knownAppIds: ['tabweb'],
      registryEntries: [
        { appId: 'tabweb', schemes: [{ scheme: 'https:', priority: 50 }] },
      ],
    })
    openResourceTabSpy.mockImplementationOnce(() => {
      throw new Error('openWebTabInSpace failed for url: https://www.iana.org/')
    })

    const pointer = parseResourcePointer('https://www.iana.org/')
    const out = await resourceRouter.open('space-1', pointer, { triggerSource: 'chat_markdown' })

    expect(out.outcome).toBe('error')
    expect(out.carrierAppId).toBeNull()
    expect(out.errorMessage).toContain('openWebTabInSpace failed')
    // router 不在内部兜底——兜底在 MarkdownRenderer 按 outcome=error 触发
    expect(shellOpenExternalSpy).not.toHaveBeenCalled()
  })
})
