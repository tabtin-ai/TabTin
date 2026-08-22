/**
 * Router 派发测试 ── D2 优先级 5 层 + ⌘ 短路 + D5 双轨双向覆盖。
 *
 * 这是 W2 协议层最敏感的逻辑。任何 Wave 改动 router.ts 后必须跑过本套件，
 * 不仅是 happy path 还有边界（hint 指向不存在 app / preference 跨 type 串扰 /
 * known-bad scheme / openResourceTab 抛 error 降级）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { parseResourcePointer } from '../src/parser.js'
import { ResourceRouterRegistry } from '../src/registry.js'
import { ResourceRouter, preferenceKeyOf } from '../src/router.js'
import { EventCollector } from '../src/events.js'
import type {
  ContextRegistryAdapter,
  OpenResourceTabFn,
  LocalFileResourceResolver,
  ResourceOpenPreferenceStore,
} from '../src/types.js'
import { SYSTEM_CARRIER_APP_ID } from '../src/types.js'

// ── 测试 fixture ────────────────────────────────────────────────────

class FakeContextRegistry implements ContextRegistryAdapter {
  constructor(private readonly known: Set<string>) {}
  hasHandlerByAppId(appId: string): boolean {
    return this.known.has(appId)
  }
  getAppIdsForType(): readonly string[] {
    return []
  }
}

class FakePreferenceStore implements ResourceOpenPreferenceStore {
  private readonly map = new Map<string, string>()
  private readonly session = new Map<string, string>()
  get(key: string): string | undefined {
    return this.map.get(key)
  }
  set(key: string, carrierAppId: string): void {
    this.map.set(key, carrierAppId)
  }
  unset(key: string): void {
    this.map.delete(key)
  }
  /** W4：sessionOverride 数据源 */
  getSessionOverride(key: string): string | undefined {
    return this.session.get(key)
  }
  setSessionOverride(key: string, carrierAppId: string): void {
    this.session.set(key, carrierAppId)
  }
}

function setupRouter(opts: {
  known?: string[]
  prefs?: Record<string, string>
  /** W4：会话临时切换数据源（routes 通过 preferenceStore.getSessionOverride 读） */
  sessionOverrides?: Record<string, string>
  registryEntries?: Array<{
    appId: string
    types?: Array<{ type: string; priority: number }>
    schemes?: Array<{ scheme: string; priority: number }>
  }>
  shellSpy?: OpenResourceTabFn
  shellExternalSpy?: (url: string) => void | Promise<void>
  localFileResolver?: LocalFileResourceResolver
}): {
  router: ResourceRouter
  registry: ResourceRouterRegistry
  prefs: FakePreferenceStore
  collector: EventCollector
  openTabSpy: ReturnType<typeof vi.fn>
  shellExternalSpy: ReturnType<typeof vi.fn>
} {
  const known = new Set(opts.known ?? [])
  // SYSTEM_CARRIER_APP_ID 永远不该被 hasHandlerByAppId 命中——它是兜底专用 id
  // 测试里必须保证不混入
  known.delete(SYSTEM_CARRIER_APP_ID)
  const ctxReg = new FakeContextRegistry(known)
  const prefs = new FakePreferenceStore()
  for (const [k, v] of Object.entries(opts.prefs ?? {})) prefs.set(k, v)
  for (const [k, v] of Object.entries(opts.sessionOverrides ?? {})) {
    prefs.setSessionOverride(k, v)
  }
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
      preferenceStore: prefs,
      openResourceTab: openTabSpy,
      shellOpenExternal: shellExternalSpy,
      localFileResolver: opts.localFileResolver,
      emitEvent: collector.emit,
    },
    registry,
  )
  return { router, registry, prefs, collector, openTabSpy, shellExternalSpy }
}

// ── D2 五层优先级 ────────────────────────────────────────────────────

describe('Router D2 priority layers', () => {
  it('layer 4 manifest_default: routes table self-format to tabdata', async () => {
    const { router, openTabSpy } = setupRouter({
      known: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/table/tbl_abc')
    const out = await router.open('space_x', pointer)
    expect(out.outcome).toBe('in_space_opened')
    expect(out.carrierAppId).toBe('tabdata')
    expect(out.resolveSource).toBe('manifest_default')
    expect(openTabSpy).toHaveBeenCalledWith('space_x', expect.objectContaining({
      type: 'table',
      id: 'tbl_abc',
    }))
  })

  it('registerOnly 只静默登记到指定标签桶', async () => {
    const { router, openTabSpy, shellExternalSpy } = setupRouter({
      known: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/table/tbl_register')
    const out = await router.open('space_x', pointer, {
      tabScopeKey: 'conversation:session-1',
      registerOnly: true,
    })

    expect(out.outcome).toBe('in_space_opened')
    expect(openTabSpy).toHaveBeenCalledWith('space_x', expect.objectContaining({
      type: 'table',
      id: 'tbl_register',
      tabScopeKey: 'conversation:session-1',
      silent: true,
    }))
    expect(shellExternalSpy).not.toHaveBeenCalled()
  })

  it('layer 4 industry: routes https to tabweb (D5 双轨双向)', async () => {
    const { router, openTabSpy } = setupRouter({
      known: ['tabweb'],
      registryEntries: [
        { appId: 'tabweb', schemes: [{ scheme: 'https:', priority: 50 }] },
      ],
    })
    const pointer = parseResourcePointer('https://example.com')
    const out = await router.open('space_x', pointer)
    expect(out.outcome).toBe('in_space_opened')
    expect(out.carrierAppId).toBe('tabweb')
    expect(out.resolveSource).toBe('manifest_default')
    expect(openTabSpy).toHaveBeenCalledWith('space_x', expect.objectContaining({
      type: 'https',
      id: 'https://example.com',
    }))
  })

  it('D5 same carrier dual-track: tabweb opens both webpage type and https scheme', async () => {
    // 修复 Review 视角 A P1-1：原 router 测试用 tabdata（type）+ tabweb（scheme）
    // 是两个不同 carrier 验证双轨；本测试加"同一 carrier 双向"覆盖——
    // tabweb manifest 真实声明同时 opens.types=['webpage'] + opens.schemes=['https:']
    // 必须证明同一 ResourceRouter 实例下两条路径都派发到同一 carrier。
    const { router, openTabSpy } = setupRouter({
      known: ['tabweb'],
      registryEntries: [
        {
          appId: 'tabweb',
          types: [
            { type: 'webpage', priority: 100 },
            { type: 'web_selection', priority: 100 },
            { type: 'web_annotation', priority: 100 },
          ],
          schemes: [
            { scheme: 'http:', priority: 50 },
            { scheme: 'https:', priority: 50 },
          ],
        },
      ],
    })

    // 自有格式轨：tabtin://resource/webpage/<encoded url>?hint=tabweb
    const selfPointer = parseResourcePointer(
      'tabtin://resource/webpage/https%3A%2F%2Fexample.com?hint=tabweb',
    )
    const selfOut = await router.open('space_x', selfPointer)
    expect(selfOut.outcome).toBe('in_space_opened')
    expect(selfOut.carrierAppId).toBe('tabweb')
    // 自有格式 + hint=tabweb，hint 命中（第 3 层）
    expect(selfOut.resolveSource).toBe('agent_hint')

    // 行业格式轨：原始 https URL
    const industryPointer = parseResourcePointer('https://example.com')
    const industryOut = await router.open('space_x', industryPointer)
    expect(industryOut.outcome).toBe('in_space_opened')
    expect(industryOut.carrierAppId).toBe('tabweb')
    // 行业格式 hint=null，走 manifest_default（第 4 层）
    expect(industryOut.resolveSource).toBe('manifest_default')

    // 关键：两条轨都到 tabweb（同一 carrier）
    expect(openTabSpy).toHaveBeenCalledTimes(2)
  })

  it('D5 same carrier dual-track via user_pref: type pref does NOT leak to scheme pref', async () => {
    // tabweb 同时声明 webpage type + https scheme；用户只为 webpage 设了偏好
    // → https 行业轨不应被偏好影响（type:webpage 与 scheme:https: 是不同 prefKey）
    const { router } = setupRouter({
      known: ['tabweb', 'tabcode'],
      prefs: { 'type:webpage': 'tabcode' }, // 用户偏好：webpage 类型用 tabcode 看
      registryEntries: [
        {
          appId: 'tabweb',
          types: [{ type: 'webpage', priority: 100 }],
          schemes: [{ scheme: 'https:', priority: 50 }],
        },
      ],
    })

    const selfOut = await router.open(
      'space_x',
      parseResourcePointer('tabtin://resource/webpage/https%3A%2F%2Fa.b'),
    )
    expect(selfOut.carrierAppId).toBe('tabcode')
    expect(selfOut.resolveSource).toBe('user_pref')

    const industryOut = await router.open(
      'space_x',
      parseResourcePointer('https://example.com'),
    )
    expect(industryOut.carrierAppId).toBe('tabweb')
    expect(industryOut.resolveSource).toBe('manifest_default')
  })

  it('layer 3 agent_hint overrides manifest_default', async () => {
    // 自有格式 type=document，hint=tabdoc。manifest 里 tabweb 也注册了 document
    // （高 priority），但 hint 应当胜出。
    const { router, openTabSpy } = setupRouter({
      known: ['tabdoc', 'tabweb'],
      registryEntries: [
        { appId: 'tabweb', types: [{ type: 'document', priority: 200 }] },
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x?hint=tabdoc')
    const out = await router.open('space_x', pointer)
    expect(out.carrierAppId).toBe('tabdoc')
    expect(out.resolveSource).toBe('agent_hint')
    expect(openTabSpy).toHaveBeenCalled()
  })

  it('layer 1 user_pref overrides agent_hint (D2 用户主权)', async () => {
    const { router } = setupRouter({
      known: ['tabdoc', 'tabweb'],
      prefs: { 'type:document': 'tabweb' },
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
        { appId: 'tabweb', types: [{ type: 'document', priority: 50 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x?hint=tabdoc')
    const out = await router.open('space_x', pointer)
    expect(out.carrierAppId).toBe('tabweb')
    expect(out.resolveSource).toBe('user_pref')
  })

  it('layer 2 session_override overrides hint but loses to user_pref', async () => {
    const { router } = setupRouter({
      known: ['tabdoc', 'tabweb', 'tabcode'],
      prefs: { 'type:document': 'tabcode' },
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x?hint=tabdoc')
    const result = router.resolve(pointer, {
      spaceId: 'space_x',
      sessionOverride: {
        pointerKey: preferenceKeyOf(pointer)!,
        carrierAppId: 'tabweb',
      },
    })
    // user_pref (tabcode) 在最前
    expect(result.chosen.appId).toBe('tabcode')
    expect(result.chosen.source).toBe('user_pref')
    // session_override 在第二
    expect(result.candidates[1]?.source).toBe('session_override')
    expect(result.candidates[1]?.appId).toBe('tabweb')
    // agent_hint 在第三
    expect(result.candidates[2]?.source).toBe('agent_hint')
    expect(result.candidates[2]?.appId).toBe('tabdoc')
  })

  it('layer 5 system_fallback when no candidate found', async () => {
    const { router, shellExternalSpy } = setupRouter({
      // 没人能开 weixin:// → 进 system_fallback
      known: [],
      registryEntries: [],
    })
    const pointer = parseResourcePointer('weixin://dl/business/?ticket=t1')
    const out = await router.open('space_x', pointer)
    expect(out.outcome).toBe('system_app_opened')
    expect(out.resolveSource).toBe('system_fallback')
    expect(out.carrierAppId).toBeNull()
    expect(shellExternalSpy).toHaveBeenCalledWith('weixin://dl/business/?ticket=t1')
  })
})

// ── ⌘ 修饰键短路（D2 之外的独立通道） ──────────────────────────────────

describe('Router modifier_external short-circuit', () => {
  it('skips all 1-4 layers and goes straight to system', async () => {
    const { router, openTabSpy, shellExternalSpy } = setupRouter({
      known: ['tabweb'],
      registryEntries: [
        { appId: 'tabweb', schemes: [{ scheme: 'https:', priority: 50 }] },
      ],
    })
    const pointer = parseResourcePointer('https://example.com')
    const out = await router.open('space_x', pointer, { modifierExternal: true })
    expect(out.outcome).toBe('system_app_opened')
    expect(out.resolveSource).toBe('modifier_key')
    expect(openTabSpy).not.toHaveBeenCalled()
    expect(shellExternalSpy).toHaveBeenCalledWith('https://example.com')
  })
})

// ── 健壮性：hint 指向不存在 app / openResourceTab 抛 error / known-bad scheme

describe('Router robustness', () => {
  it('agent_hint pointing to unregistered app falls through to manifest', async () => {
    const { router } = setupRouter({
      known: ['tabdoc'],
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    // hint=tabXX 不存在 → 该候选被剔除；manifest_default tabdoc 接管
    const pointer = parseResourcePointer(
      'tabtin://resource/document/doc_x?hint=tabXX',
    )
    const out = await router.open('space_x', pointer)
    expect(out.outcome).toBe('in_space_opened')
    expect(out.carrierAppId).toBe('tabdoc')
    expect(out.resolveSource).toBe('manifest_default')
  })

  it('forceCarrierAppId pointing to unregistered app falls back to manifest_default (not system)', async () => {
    // 修复 Review 视角 A P0-1 后：force 不再绝对短路。force 指向不存在的 app
    // 时，其 sessionOverride candidate 在 resolve() 内被 hasHandlerByAppId 过滤，
    // 自然降级到 D2 第 4 层 manifest_default——用户右键「用 X 打开」体验：
    // 如果 X 不可用，至少还能用默认载体打开，而不是直接跳系统应用
    const { router, openTabSpy } = setupRouter({
      known: ['tabweb'],
      registryEntries: [
        { appId: 'tabweb', schemes: [{ scheme: 'https:', priority: 50 }] },
      ],
    })
    const pointer = parseResourcePointer('https://example.com')
    const out = await router.open('space_x', pointer, {
      forceCarrierAppId: 'nonexistent_app',
    })
    expect(out.outcome).toBe('in_space_opened')
    expect(out.carrierAppId).toBe('tabweb')
    expect(out.resolveSource).toBe('manifest_default')
    expect(openTabSpy).toHaveBeenCalled()
  })

  it('user_pref overrides forceCarrierAppId (D2 第 1 层胜过第 2 层)', async () => {
    // 修复 Review 视角 A P0-1：原实现 force 绝对短路；新实现 force 经
    // sessionOverride 注入 resolve()，user_pref 仍胜过它（PRD §4 D2 用户主权）
    const { router, openTabSpy } = setupRouter({
      known: ['tabdoc', 'tabweb', 'tabcode'],
      prefs: { 'type:document': 'tabcode' },
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await router.open('space_x', pointer, {
      forceCarrierAppId: 'tabweb', // 用户右键"用 tabweb 打开"
    })
    // user_pref(tabcode) 胜过 session_override(tabweb)
    expect(out.outcome).toBe('in_space_opened')
    expect(out.carrierAppId).toBe('tabcode')
    expect(out.resolveSource).toBe('user_pref')
    expect(openTabSpy).toHaveBeenCalledWith('space_x', expect.objectContaining({
      type: 'document',
      id: 'doc_x',
    }))
  })

  it('forceCarrierAppId beats agent_hint when no user_pref (D2 第 2 层胜过第 3 层)', async () => {
    // 没有 user_pref 时，force（sessionOverride 第 2 层）应胜过 hint（第 3 层）
    const { router } = setupRouter({
      known: ['tabdoc', 'tabweb'],
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer(
      'tabtin://resource/document/doc_x?hint=tabdoc',
    )
    const out = await router.open('space_x', pointer, {
      forceCarrierAppId: 'tabweb',
    })
    expect(out.carrierAppId).toBe('tabweb')
    expect(out.resolveSource).toBe('session_override')
  })

  it('openResourceTab throwing → outcome=error, not silent', async () => {
    const { router } = setupRouter({
      known: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
      shellSpy: () => {
        throw new Error('boom')
      },
    })
    const pointer = parseResourcePointer('tabtin://resource/table/tbl_abc')
    const out = await router.open('space_x', pointer)
    expect(out.outcome).toBe('error')
    expect(out.errorMessage).toBe('boom')
  })

  it('chrome: scheme blocked by KNOWN_BAD_SCHEMES on system fallback', async () => {
    const { router, shellExternalSpy } = setupRouter({
      known: [],
      registryEntries: [],
    })
    const pointer = parseResourcePointer('chrome://settings')
    const out = await router.open('space_x', pointer)
    expect(out.outcome).toBe('denied_known_bad')
    expect(out.errorMessage).toMatch(/known-bad/)
    expect(shellExternalSpy).not.toHaveBeenCalled()
  })

  it('devtools: scheme blocked', async () => {
    const { router } = setupRouter({})
    const pointer = parseResourcePointer('devtools://devtools/foo')
    const out = await router.open('space_x', pointer)
    expect(out.outcome).toBe('denied_known_bad')
  })
})

// ── Local file artifacts ───────────────────────────────────────────────

describe('Router local file resource resolver', () => {
  it('resolves tabtin file pointers through injected localFileResolver before opening tab', async () => {
    const localFileResolver = vi.fn<LocalFileResourceResolver>().mockResolvedValue({
      type: 'file',
      id: 'artifacts/report.xlsx',
      title: 'report.xlsx',
      meta: {
        artifact_kind: 'local_file',
        relative_path: 'artifacts/report.xlsx',
        absolute_path: '/Users/me/work/artifacts/report.xlsx',
      },
    })
    const { router, openTabSpy } = setupRouter({
      known: ['tabfiles'],
      registryEntries: [
        { appId: 'tabfiles', types: [{ type: 'file', priority: 80 }] },
      ],
      localFileResolver,
    })

    const pointer = parseResourcePointer('tabtin://resource/file/artifacts%2Freport.xlsx?hint=tabfiles')
    const out = await router.open('space_x', pointer)

    expect(out.outcome).toBe('in_space_opened')
    expect(out.carrierAppId).toBe('tabfiles')
    expect(localFileResolver).toHaveBeenCalledWith({ spaceId: 'space_x', pointer })
    expect(openTabSpy).toHaveBeenCalledWith(
      'space_x',
      expect.objectContaining({
        type: 'file',
        id: 'artifacts/report.xlsx',
        meta: expect.objectContaining({
          artifact_kind: 'local_file',
          relative_path: 'artifacts/report.xlsx',
        }),
      }),
    )
  })

  it('preserves resolver-provided silent refresh hints for already-open local files', async () => {
    const localFileResolver = vi.fn<LocalFileResourceResolver>().mockResolvedValue({
      type: 'file',
      id: 'artifacts/report.xlsx',
      title: 'report.xlsx',
      silent: true,
      meta: {
        artifact_kind: 'local_file',
        relative_path: 'artifacts/report.xlsx',
        local_file_refresh_token: 'v2',
      },
    })
    const { router, openTabSpy } = setupRouter({
      known: ['tabfiles'],
      registryEntries: [
        { appId: 'tabfiles', types: [{ type: 'file', priority: 80 }] },
      ],
      localFileResolver,
    })

    const pointer = parseResourcePointer('tabtin://resource/file/artifacts%2Freport.xlsx?hint=tabfiles')
    const out = await router.open('space_x', pointer)

    expect(out.outcome).toBe('in_space_opened')
    expect(openTabSpy).toHaveBeenCalledWith(
      'space_x',
      expect.objectContaining({
        type: 'file',
        id: 'artifacts/report.xlsx',
        silent: true,
        meta: expect.objectContaining({
          local_file_refresh_token: 'v2',
        }),
      }),
    )
  })

  it('localFileResolver errors become outcome=error and do not open fallback paths', async () => {
    const localFileResolver = vi.fn<LocalFileResourceResolver>().mockRejectedValue(
      new Error('需要先设置或创建 Agent 工作目录'),
    )
    const { router, openTabSpy, shellExternalSpy } = setupRouter({
      known: ['tabfiles'],
      registryEntries: [
        { appId: 'tabfiles', types: [{ type: 'file', priority: 80 }] },
      ],
      localFileResolver,
    })

    const pointer = parseResourcePointer('tabtin://resource/file/artifacts%2Freport.xlsx?hint=tabfiles')
    const out = await router.open('space_x', pointer)

    expect(out.outcome).toBe('error')
    expect(out.errorMessage).toBe('需要先设置或创建 Agent 工作目录')
    expect(openTabSpy).not.toHaveBeenCalled()
    expect(shellExternalSpy).not.toHaveBeenCalled()
  })

  it('continues with default params when resolver returns null', async () => {
    const { router, openTabSpy } = setupRouter({
      known: ['tabfiles'],
      registryEntries: [
        { appId: 'tabfiles', types: [{ type: 'file', priority: 80 }] },
      ],
      localFileResolver: () => null,
    })

    const pointer = parseResourcePointer('tabtin://resource/file/cloud-file-id?hint=tabfiles')
    const out = await router.open('space_x', pointer)

    expect(out.outcome).toBe('in_space_opened')
    expect(openTabSpy).toHaveBeenCalledWith(
      'space_x',
      expect.objectContaining({
        type: 'file',
        id: 'cloud-file-id',
      }),
    )
  })
})

// ── 偏好 key 跨类型不串扰 ─────────────────────────────────────────────

describe('preference key isolation', () => {
  it('user pref for type:document does not leak to type:table', async () => {
    const { router } = setupRouter({
      known: ['tabdoc', 'tabdata'],
      prefs: { 'type:document': 'tabdoc' },
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
    })
    const tablePointer = parseResourcePointer('tabtin://resource/table/tbl_a')
    const out = await router.open('space_x', tablePointer)
    expect(out.carrierAppId).toBe('tabdata')
    expect(out.resolveSource).toBe('manifest_default')
  })

  it('preferenceKeyOf returns scheme:<scheme>: for industry format', () => {
    expect(preferenceKeyOf(parseResourcePointer('https://x.com'))).toBe('scheme:https:')
    expect(preferenceKeyOf(parseResourcePointer('mailto:a@b.com'))).toBe('scheme:mailto:')
    expect(preferenceKeyOf(parseResourcePointer('file:///x'))).toBe('scheme:file:')
  })

  it('preferenceKeyOf returns null for unknown scheme', () => {
    expect(preferenceKeyOf(parseResourcePointer('garbage'))).toBeNull()
  })

  it('preferenceKeyOf returns null for self-format with missing type', () => {
    expect(preferenceKeyOf(parseResourcePointer('tabtin://resource/'))).toBeNull()
  })
})

// ── resolve() 永远返回非空 candidates（兜底契约） ─────────────────────

describe('resolve invariants', () => {
  it('candidates is always non-empty (system fallback ensures it)', () => {
    const { router } = setupRouter({})
    const result = router.resolve(parseResourcePointer('garbage'), { spaceId: 's' })
    expect(result.candidates.length).toBeGreaterThanOrEqual(1)
    // 至少最后一个是 system fallback
    expect(result.candidates.at(-1)?.source).toBe('system_fallback')
    expect(result.candidates.at(-1)?.appId).toBe(SYSTEM_CARRIER_APP_ID)
  })

  it('chosen equals candidates[0]', () => {
    const { router } = setupRouter({
      known: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
    })
    const result = router.resolve(
      parseResourcePointer('tabtin://resource/table/tbl_x'),
      { spaceId: 's' },
    )
    expect(result.chosen).toBe(result.candidates[0])
  })
})

// ── 埋点事件 ─────────────────────────────────────────────────────

// ── W4 专题补测：preferenceStore.getSessionOverride 数据源 + L19 偏好降级
//
// 重点不是再测一遍 D2 五层（W2 已测），而是验证 W4 在 router.open 内部加的
// "preferenceStore.getSessionOverride fallback"路径与 D2 排序仍然一致——
// 这是 W4 接通 zustand store 让所有 router.open 调用点（chat / open_in_space /
// 富 ResourceCard）自动获得 sessionOverride 行为的关键。
//
// L19 偏好降级：用户 user_pref 指向不可用的 carrier 时，应当降级到 manifest_default
// 而非系统应用——避免"我设了偏好结果跳系统浏览器"的体验反差。

describe('W4 preferenceStore.getSessionOverride integration', () => {
  it('store sessionOverride takes effect when forceCarrierAppId not provided', async () => {
    // 模拟 chat 链接左键点击：renderer 不传 forceCarrierAppId，但用户上次右键
    // "用 X 打开"已写入 store sessionOverrides → 本次点击应当走 X
    const { router } = setupRouter({
      known: ['tabdoc', 'tabweb'],
      sessionOverrides: { 'type:document': 'tabweb' },
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await router.open('space_x', pointer) // 不传 forceCarrierAppId
    expect(out.outcome).toBe('in_space_opened')
    expect(out.carrierAppId).toBe('tabweb')
    expect(out.resolveSource).toBe('session_override')
  })

  it('explicit forceCarrierAppId beats store sessionOverride', async () => {
    // 调用方显式传入的 forceCarrierAppId 优先级 > store 自动注入；保留显式
    // 入口便于"右键直接选择 X 打开（且不持久化为 session override）"等
    // 极端场景（虽然 ResourceLinkContextMenu 现实现总会写 store，但接口
    // 留显式入口给 open_in_space 等其他调用点）
    const { router } = setupRouter({
      known: ['tabdoc', 'tabweb', 'tabcode'],
      sessionOverrides: { 'type:document': 'tabweb' },
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await router.open('space_x', pointer, {
      forceCarrierAppId: 'tabcode',
    })
    expect(out.carrierAppId).toBe('tabcode')
    expect(out.resolveSource).toBe('session_override')
  })

  it('user_pref still beats store sessionOverride (D2 用户主权)', async () => {
    // 即使 store 里同时有 user_pref 和 sessionOverride，D2 第 1 层永远胜过
    // 第 2 层——用户的"始终用 X 打开"应当压过任何 session 临时切换
    const { router } = setupRouter({
      known: ['tabdoc', 'tabweb', 'tabcode'],
      prefs: { 'type:document': 'tabcode' },
      sessionOverrides: { 'type:document': 'tabweb' },
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await router.open('space_x', pointer)
    expect(out.carrierAppId).toBe('tabcode')
    expect(out.resolveSource).toBe('user_pref')
  })

  it('L19 user_pref pointing to unavailable carrier → falls back to manifest_default', async () => {
    // L19 关键体验对齐：用户偏好的 carrier 不可用（卸载该 App / handler
    // 没注册）时，**自动降级到 manifest_default 而非系统应用**——这是 W4
    // settings Panel 文案明示的承诺
    const { router } = setupRouter({
      known: ['tabdoc'], // 'tabweb' 不在 known 里 → handler 不存在
      prefs: { 'type:document': 'tabweb' }, // 用户偏好指向不可用 App
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
        { appId: 'tabweb', types: [{ type: 'document', priority: 50 }] }, // manifest 注册了但 handler 缺
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await router.open('space_x', pointer)
    expect(out.outcome).toBe('in_space_opened')
    expect(out.carrierAppId).toBe('tabdoc') // 降级到 manifest_default
    expect(out.resolveSource).toBe('manifest_default')
    // 关键：不是 system_fallback / system_app_opened
    expect(out.resolveSource).not.toBe('system_fallback')
    expect(out.outcome).not.toBe('system_app_opened')
  })

  it('store sessionOverride for unavailable carrier → also falls back to manifest_default', async () => {
    // 同 L19 设计——session_override 指向不可用 carrier 时同样降级
    const { router } = setupRouter({
      known: ['tabdoc'],
      sessionOverrides: { 'type:document': 'tabweb' },
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
      ],
    })
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await router.open('space_x', pointer)
    expect(out.carrierAppId).toBe('tabdoc')
    expect(out.resolveSource).toBe('manifest_default')
  })

  it('preferenceStore.getSessionOverride absent → router still works (向后兼容)', async () => {
    // 模拟 W2 旧版本测试 fixture（FakePreferenceStore 不实现 getSessionOverride）：
    // router 应当 graceful degrade，不抛错；仅丢失 D2 第 2 层 store 数据源
    // （forceCarrierAppId 显式入口仍可用）
    const known = new Set(['tabdoc'])
    const ctxReg = new FakeContextRegistry(known)
    const minimalStore: ResourceOpenPreferenceStore = {
      get: () => undefined,
      set: () => {},
      unset: () => {},
      // 故意不实现 getSessionOverride
    }
    const registry = new ResourceRouterRegistry()
    registry.register('tabdoc', { types: [{ type: 'document', priority: 100 }] })
    const router = new ResourceRouter(
      {
        contextRegistry: ctxReg,
        preferenceStore: minimalStore,
        openResourceTab: vi.fn(),
        shellOpenExternal: vi.fn(),
      },
      registry,
    )
    const pointer = parseResourcePointer('tabtin://resource/document/doc_x')
    const out = await router.open('space_x', pointer)
    expect(out.outcome).toBe('in_space_opened')
    expect(out.carrierAppId).toBe('tabdoc')
    expect(out.resolveSource).toBe('manifest_default')
  })

  it('store sessionOverride respects pointerKey isolation (type vs scheme)', async () => {
    // session override 写在 type:document，但点击 https URL（prefKey=scheme:https:）
    // 应当不受影响——pointerKey 跨维度隔离
    const { router } = setupRouter({
      known: ['tabdoc', 'tabweb'],
      sessionOverrides: { 'type:document': 'tabweb' },
      registryEntries: [
        { appId: 'tabdoc', types: [{ type: 'document', priority: 100 }] },
        { appId: 'tabweb', schemes: [{ scheme: 'https:', priority: 50 }] },
      ],
    })
    const httpsPointer = parseResourcePointer('https://example.com')
    const out = await router.open('space_x', httpsPointer)
    expect(out.carrierAppId).toBe('tabweb')
    expect(out.resolveSource).toBe('manifest_default') // 不是 session_override
  })
})

describe('telemetry events', () => {
  it('emits resource_open.resolved on success', async () => {
    const { router, collector } = setupRouter({
      known: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
    })
    await router.open('space_x', parseResourcePointer('tabtin://resource/table/tbl_a'))
    expect(collector.events).toHaveLength(1)
    const e = collector.events[0]!
    expect(e.event_name).toBe('resource_open.resolved')
    expect(e.outcome).toBe('in_space_opened')
    expect(e.resolved_carrier_app_id).toBe('tabdata')
    expect(e.resolve_source).toBe('manifest_default')
    expect(e.pointer_scheme).toBe('tabtin')
    expect(e.pointer_type).toBe('table')
    // pointer_id_hash 不是明文
    expect(e.pointer_id_hash).not.toContain('tbl_a')
    expect(e.pointer_id_hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('emits resource_open.failed on denied_known_bad', async () => {
    const { router, collector } = setupRouter({})
    await router.open('s', parseResourcePointer('chrome://x'))
    expect(collector.events[0]!.event_name).toBe('resource_open.failed')
    expect(collector.events[0]!.outcome).toBe('denied_known_bad')
  })

  it('emit failures do not break router output', async () => {
    const { router } = setupRouter({
      known: ['tabdata'],
      registryEntries: [
        { appId: 'tabdata', types: [{ type: 'table', priority: 100 }] },
      ],
    })
    // 替换 emitEvent 为 throw
    ;(router as any).deps.emitEvent = () => {
      throw new Error('telemetry pipe down')
    }
    const out = await router.open('s', parseResourcePointer('tabtin://resource/table/x'))
    expect(out.outcome).toBe('in_space_opened')
  })
})
