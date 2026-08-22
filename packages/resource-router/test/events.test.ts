/**
 * Resource-router events.ts 覆盖测试（专题"Agent 产物在 Space 内的打开" Wave 7）。
 *
 * 业务目标（PRD §6 + RFC v1.0 §8 + harness 总控 §2 W7 北极星）：
 *   验证 ResourceRouter 在所有 outcome × trigger_source 组合下都能 emit 出
 *   一条结构正确的 ResourceOpenEvent。本套件是 W7 上报通路 W2-W7 端到端
 *   验收的"客户端发射端"防回归网。
 *
 * 覆盖矩阵：
 *   - 5 个 outcome：in_space_opened / system_app_opened / denied_known_bad /
 *     error / modifier_key 短路（注：modifier_key 是 resolve_source 而非 outcome；
 *     用 modifierExternal=true 触发 system_app_opened with resolve_source='modifier_key'，
 *     共 4 个 outcome × 多个 resolve_source）
 *   - 5 个 trigger_source：chat_markdown / open_in_space_tool / rich_resource_card /
 *     user_paste / window_open_fallback（W7 北极星说"6"，那是 D2 的 6 个 resolve_source；
 *     本测试在 schema 维度真的覆盖 5 个 trigger_source）
 *   - 字段完整性：event_name / pointer_scheme / pointer_type / pointer_id_hash /
 *     resolve_source / outcome / duration_ms / ts / client / client_version 等
 *
 * 故意不复制 router.test.ts 的优先级测试——本套件聚焦"emit 钩子真触发了"
 * 这一行为，逻辑覆盖留给 router.test.ts。
 */

import { describe, expect, it, vi } from 'vitest'

import { parseResourcePointer } from '../src/parser.js'
import { ResourceRouterRegistry } from '../src/registry.js'
import { ResourceRouter } from '../src/router.js'
import { EventCollector, consoleEventEmitter } from '../src/events.js'
import {
  SYSTEM_CARRIER_APP_ID,
  type ContextRegistryAdapter,
  type OpenResourceTabFn,
  type ResourceOpenEvent,
  type ResourceOpenPreferenceStore,
  type ResourceOpenTriggerSource,
} from '../src/types.js'

// ── Fixture（极简，与 router.test.ts setupRouter 解耦） ──────────────────

class FakeContextRegistry implements ContextRegistryAdapter {
  constructor(private readonly known: Set<string>) {}
  hasHandlerByAppId(appId: string): boolean {
    return this.known.has(appId)
  }
  getAppIdsForType(): readonly string[] {
    return []
  }
}

const noopPreferenceStore: ResourceOpenPreferenceStore = {
  get: () => undefined,
  set: () => {},
  unset: () => {},
  getSessionOverride: () => undefined,
}

interface RouterFixture {
  router: ResourceRouter
  collector: EventCollector
  openTabSpy: ReturnType<typeof vi.fn>
  shellExternalSpy: ReturnType<typeof vi.fn>
}

function build(opts: {
  known?: string[]
  registryEntries?: Array<{
    appId: string
    types?: Array<{ type: string; priority: number }>
    schemes?: Array<{ scheme: string; priority: number }>
  }>
  shellSpy?: OpenResourceTabFn
  shellExternalSpy?: (url: string) => void | Promise<void>
}): RouterFixture {
  const ctxReg = new FakeContextRegistry(new Set(opts.known ?? []))
  const registry = new ResourceRouterRegistry()
  for (const e of opts.registryEntries ?? []) {
    registry.register(e.appId, { types: e.types, schemes: e.schemes })
  }
  const openTabSpy = vi.fn(opts.shellSpy ?? (async () => {}))
  const shellExternalSpy = vi.fn(opts.shellExternalSpy ?? (async () => {}))
  const collector = new EventCollector()
  const router = new ResourceRouter(
    {
      contextRegistry: ctxReg,
      preferenceStore: noopPreferenceStore,
      openResourceTab: openTabSpy,
      shellOpenExternal: shellExternalSpy,
      emitEvent: collector.emit,
      client: 'electron',
    },
    registry,
  )
  return { router, collector, openTabSpy, shellExternalSpy }
}

// ── 通用字段断言 ────────────────────────────────────────────────────

function assertEventShape(event: ResourceOpenEvent): void {
  expect(typeof event.event_name).toBe('string')
  expect(['resource_open.resolved', 'resource_open.failed']).toContain(event.event_name)
  expect(typeof event.trigger_source).toBe('string')
  expect(typeof event.pointer_scheme).toBe('string')
  expect(typeof event.pointer_id_hash).toBe('string')
  expect(event.pointer_id_hash.length).toBe(16)
  expect(/^[0-9a-f]+$/.test(event.pointer_id_hash)).toBe(true)
  expect(typeof event.resolve_source).toBe('string')
  expect(typeof event.outcome).toBe('string')
  expect(typeof event.duration_ms).toBe('number')
  expect(event.duration_ms).toBeGreaterThanOrEqual(0)
  expect(typeof event.ts).toBe('number')
  expect(event.ts).toBeGreaterThan(0)
  expect(event.client).toBe('electron')
  expect(typeof event.client_version).toBe('string')
}

// ── outcome 维度 5 个分支 ─────────────────────────────────────────────

describe('events emit · 5 outcome 分支', () => {
  it('outcome=in_space_opened (manifest_default)', async () => {
    const { router, collector } = build({
      known: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
    })
    await router.open('space_x', parseResourcePointer('tabtin://resource/table/tbl_a'))
    expect(collector.events).toHaveLength(1)
    const ev = collector.events[0]!
    assertEventShape(ev)
    expect(ev.event_name).toBe('resource_open.resolved')
    expect(ev.outcome).toBe('in_space_opened')
    expect(ev.resolve_source).toBe('manifest_default')
    expect(ev.resolved_carrier_app_id).toBe('tabdata')
    expect(ev.pointer_scheme).toBe('tabtin')
    expect(ev.pointer_type).toBe('table')
  })

  it('outcome=system_app_opened (manifest_default tabweb 不可用 → fallback system)', async () => {
    // 没有任何 carrier 注册 → 直接走第 5 层 system_fallback
    const { router, collector, shellExternalSpy } = build({})
    await router.open('space_x', parseResourcePointer('https://example.com'))
    expect(shellExternalSpy).toHaveBeenCalledWith('https://example.com')
    expect(collector.events).toHaveLength(1)
    const ev = collector.events[0]!
    assertEventShape(ev)
    expect(ev.event_name).toBe('resource_open.resolved')
    expect(ev.outcome).toBe('system_app_opened')
    expect(ev.resolve_source).toBe('system_fallback')
    expect(ev.resolved_carrier_app_id).toBeNull()
  })

  it('outcome=system_app_opened (modifier_key ⌘ 短路)', async () => {
    const { router, collector, shellExternalSpy } = build({
      known: ['tabweb'],
      registryEntries: [
        { appId: 'tabweb', schemes: [{ scheme: 'https:', priority: 50 }] },
      ],
    })
    await router.open(
      'space_x',
      parseResourcePointer('https://example.com'),
      { modifierExternal: true },
    )
    expect(shellExternalSpy).toHaveBeenCalled()
    expect(collector.events).toHaveLength(1)
    const ev = collector.events[0]!
    assertEventShape(ev)
    expect(ev.outcome).toBe('system_app_opened')
    expect(ev.resolve_source).toBe('modifier_key')
  })

  it('outcome=denied_known_bad (chrome:// 拒绝)', async () => {
    const { router, collector, shellExternalSpy } = build({})
    const out = await router.open('space_x', parseResourcePointer('chrome://settings'))
    expect(out.outcome).toBe('denied_known_bad')
    expect(shellExternalSpy).not.toHaveBeenCalled()
    expect(collector.events).toHaveLength(1)
    const ev = collector.events[0]!
    assertEventShape(ev)
    expect(ev.event_name).toBe('resource_open.failed')
    expect(ev.outcome).toBe('denied_known_bad')
    expect(typeof ev.error_message).toBe('string')
    expect(ev.error_message).toMatch(/chrome:/)
  })

  it('outcome=error (openResourceTab throw)', async () => {
    const { router, collector } = build({
      known: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
      shellSpy: async () => {
        throw new Error('openResourceTab boom')
      },
    })
    const out = await router.open(
      'space_x',
      parseResourcePointer('tabtin://resource/table/tbl_a'),
    )
    expect(out.outcome).toBe('error')
    expect(collector.events).toHaveLength(1)
    const ev = collector.events[0]!
    assertEventShape(ev)
    expect(ev.event_name).toBe('resource_open.failed')
    expect(ev.outcome).toBe('error')
    expect(ev.error_message).toMatch(/boom/)
  })

  it('outcome=error (shellOpenExternal throw → 走 fallback 后再 error)', async () => {
    const { router, collector } = build({
      shellExternalSpy: async () => {
        throw new Error('shellOpenExternal boom')
      },
    })
    const out = await router.open('space_x', parseResourcePointer('https://example.com'))
    expect(out.outcome).toBe('error')
    expect(collector.events).toHaveLength(1)
    const ev = collector.events[0]!
    assertEventShape(ev)
    expect(ev.event_name).toBe('resource_open.failed')
    expect(ev.outcome).toBe('error')
  })
})

// ── trigger_source 维度 5 个枚举 ──────────────────────────────────────

describe('events emit · 5 trigger_source 都被透传', () => {
  const sources: ResourceOpenTriggerSource[] = [
    'chat_markdown',
    'open_in_space_tool',
    'rich_resource_card',
    'user_paste',
    'window_open_fallback',
  ]

  for (const src of sources) {
    it(`trigger_source=${src} 进入 event payload`, async () => {
      const { router, collector } = build({
        known: ['tabdata'],
        registryEntries: [
          { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
        ],
      })
      await router.open(
        'space_x',
        parseResourcePointer('tabtin://resource/table/tbl_a'),
        { triggerSource: src },
      )
      expect(collector.events).toHaveLength(1)
      const ev = collector.events[0]!
      assertEventShape(ev)
      expect(ev.trigger_source).toBe(src)
    })
  }
})

// ── ResolveSource 维度（D2 五层 + ⌘ 短路 = 6 个 tag） ─────────────────

describe('events emit · 6 resolve_source 都被打 tag', () => {
  it('resolve_source=user_pref', async () => {
    const ctxReg = new FakeContextRegistry(new Set(['tabdata']))
    const prefStore: ResourceOpenPreferenceStore = {
      get: (k) => (k === 'type:table' ? 'tabdata' : undefined),
      set: () => {},
      unset: () => {},
      getSessionOverride: () => undefined,
    }
    const collector = new EventCollector()
    const router = new ResourceRouter(
      {
        contextRegistry: ctxReg,
        preferenceStore: prefStore,
        openResourceTab: vi.fn(async () => {}),
        shellOpenExternal: vi.fn(async () => {}),
        emitEvent: collector.emit,
        client: 'electron',
      },
      new ResourceRouterRegistry(),
    )
    await router.open('s_x', parseResourcePointer('tabtin://resource/table/tbl_a'))
    expect(collector.events[0]!.resolve_source).toBe('user_pref')
  })

  it('resolve_source=session_override', async () => {
    const ctxReg = new FakeContextRegistry(new Set(['tabdata']))
    const prefStore: ResourceOpenPreferenceStore = {
      get: () => undefined,
      set: () => {},
      unset: () => {},
      getSessionOverride: (k) => (k === 'type:table' ? 'tabdata' : undefined),
    }
    const collector = new EventCollector()
    const router = new ResourceRouter(
      {
        contextRegistry: ctxReg,
        preferenceStore: prefStore,
        openResourceTab: vi.fn(async () => {}),
        shellOpenExternal: vi.fn(async () => {}),
        emitEvent: collector.emit,
        client: 'electron',
      },
      new ResourceRouterRegistry(),
    )
    await router.open('s_x', parseResourcePointer('tabtin://resource/table/tbl_a'))
    expect(collector.events[0]!.resolve_source).toBe('session_override')
  })

  it('resolve_source=agent_hint', async () => {
    const { router, collector } = build({
      known: ['tabdata'],
      // 没注册 manifest type → hint 命中走第 3 层 agent_hint
      registryEntries: [],
    })
    await router.open(
      's_x',
      parseResourcePointer('tabtin://resource/table/tbl_a?hint=tabdata'),
    )
    expect(collector.events[0]!.resolve_source).toBe('agent_hint')
    expect(collector.events[0]!.hint_app_id).toBe('tabdata')
  })

  it('resolve_source=manifest_default', async () => {
    const { router, collector } = build({
      known: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
    })
    await router.open('s_x', parseResourcePointer('tabtin://resource/table/tbl_a'))
    expect(collector.events[0]!.resolve_source).toBe('manifest_default')
  })

  it('resolve_source=system_fallback', async () => {
    const { router, collector } = build({})
    await router.open('s_x', parseResourcePointer('https://x.com'))
    expect(collector.events[0]!.resolve_source).toBe('system_fallback')
  })

  it('resolve_source=modifier_key', async () => {
    const { router, collector } = build({})
    await router.open(
      's_x',
      parseResourcePointer('https://x.com'),
      { modifierExternal: true },
    )
    expect(collector.events[0]!.resolve_source).toBe('modifier_key')
  })
})

// ── 协议 D8 红线 + 健壮性 ──────────────────────────────────────────────

describe('events emit · D8 红线（不影响关键路径性能 + emit 失败不阻塞）', () => {
  it('emit hook throw 不影响 router.open 返回值', async () => {
    const ctxReg = new FakeContextRegistry(new Set(['tabdata']))
    const registry = new ResourceRouterRegistry()
    registry.register('tabdata', { types: [{ type: 'table', priority: 100 }] })
    const router = new ResourceRouter(
      {
        contextRegistry: ctxReg,
        preferenceStore: noopPreferenceStore,
        openResourceTab: vi.fn(async () => {}),
        shellOpenExternal: vi.fn(async () => {}),
        // 故意 throw
        emitEvent: () => {
          throw new Error('emit boom')
        },
        client: 'electron',
      },
      registry,
    )
    const out = await router.open(
      's_x',
      parseResourcePointer('tabtin://resource/table/tbl_a'),
    )
    // emit 抛错 router 仍然返回 in_space_opened（不能影响业务路径）
    expect(out.outcome).toBe('in_space_opened')
  })

  it('emitEvent 未注入（undefined）也能正常派发', async () => {
    const ctxReg = new FakeContextRegistry(new Set(['tabdata']))
    const registry = new ResourceRouterRegistry()
    registry.register('tabdata', { types: [{ type: 'table', priority: 100 }] })
    const router = new ResourceRouter(
      {
        contextRegistry: ctxReg,
        preferenceStore: noopPreferenceStore,
        openResourceTab: vi.fn(async () => {}),
        shellOpenExternal: vi.fn(async () => {}),
        // 故意省 emitEvent
        client: 'electron',
      },
      registry,
    )
    const out = await router.open(
      's_x',
      parseResourcePointer('tabtin://resource/table/tbl_a'),
    )
    expect(out.outcome).toBe('in_space_opened')
  })

  it('每次 router.open 只 emit 一次（不重复发射）', async () => {
    const { router, collector } = build({
      known: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
    })
    await router.open('s_x', parseResourcePointer('tabtin://resource/table/tbl_a'))
    await router.open('s_x', parseResourcePointer('tabtin://resource/table/tbl_b'))
    expect(collector.events).toHaveLength(2)
  })

  it('consoleEventEmitter 不抛错（即便在测试环境）', () => {
    expect(() => consoleEventEmitter({
      event_name: 'resource_open.resolved',
      trigger_source: 'chat_markdown',
      pointer_scheme: 'tabtin',
      pointer_type: 'table',
      pointer_id_hash: 'a'.repeat(16),
      hint_app_id: null,
      resolved_carrier_app_id: 'tabdata',
      resolve_source: 'manifest_default',
      outcome: 'in_space_opened',
      space_id: 's_x',
      user_id: 'u_x',
      organization_id: 'w_x',
      agent_run_id: null,
      message_id: null,
      tool_call_id: null,
      duration_ms: 5,
      ts: Date.now(),
      client: 'electron',
      client_version: 'test',
    })).not.toThrow()
  })

  it('EventCollector clear 后 events 长度归零', () => {
    const collector = new EventCollector()
    collector.emit({
      event_name: 'resource_open.resolved',
      trigger_source: 'chat_markdown',
      pointer_scheme: 'tabtin',
      pointer_type: 'table',
      pointer_id_hash: 'a'.repeat(16),
      hint_app_id: null,
      resolved_carrier_app_id: null,
      resolve_source: 'manifest_default',
      outcome: 'in_space_opened',
      space_id: '',
      user_id: '',
      organization_id: '',
      agent_run_id: null,
      message_id: null,
      tool_call_id: null,
      duration_ms: 0,
      ts: Date.now(),
      client: 'electron',
      client_version: '',
    })
    expect(collector.events).toHaveLength(1)
    collector.clear()
    expect(collector.events).toHaveLength(0)
  })
})

