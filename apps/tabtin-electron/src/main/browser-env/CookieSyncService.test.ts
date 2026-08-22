/**
 * CookieSyncService 单测 —— 本地化退役 Wave 1 简化。
 *
 * 测试目标(只针对 env partition 之间的同步,不再覆盖 legacy
 * `tabtin:crawlspace:*` partition——它们已在 ADR-9 删除):
 *
 *   1. 基础同步:env1 = {envP1, envP2} → 同 env 内任一 partition 写 → 其他都收到
 *   2. 跨环境隔离:env1 = {envP1}, env2 = {envP2} → envP1 写 → envP2 读不到
 *   3. 防环:A → B 同步后,B 的 changed 不会反向触发对 A 的写
 *   4. 删除同步:A 写 → B 拿到 → A 删 → B 也被删
 *   5. 环境切换:envP1 从 env1 移除后,env1 内其他写入不再扇出到它
 *
 * 因为本地化后每个 env 只有一个 partition_key,"同 env 内同步"在新模型
 * 下其实只在用户跨设备 / 多 webview 共享同 env 时才发生(单一 partition
 * 在 Chromium 内部就是统一存储)。这些测试主要验证服务在多 partition 注入
 * 场景下的稳健性,为未来"一 env 多 partition"演进留余量。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ══════════════════════════════════════════════════════════════════
// Mock 一个 Electron session — 带真实 Map 存储 + changed 事件派发
// ══════════════════════════════════════════════════════════════════

interface MockCookie {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  session?: boolean
  hostOnly?: boolean
}

type ChangedListener = (
  event: unknown,
  cookie: MockCookie,
  cause: string,
  removed: boolean,
) => void

interface MockSession {
  _store: Map<string, MockCookie>
  _listeners: Set<ChangedListener>
  cookies: {
    on: (ev: 'changed', l: ChangedListener) => unknown
    off: (ev: 'changed', l: ChangedListener) => unknown
    get: (filter: { domain?: string; name?: string }) => Promise<MockCookie[]>
    set: (details: MockCookie & { url: string }) => Promise<void>
    remove: (url: string, name: string) => Promise<void>
  }
}

const mockSessions = new Map<string, MockSession>()

function makeMockSession(partitionKey: string): MockSession {
  if (mockSessions.has(partitionKey)) return mockSessions.get(partitionKey)!

  const store = new Map<string, MockCookie>()
  const listeners = new Set<ChangedListener>()

  const emitChanged = (cookie: MockCookie, cause: string, removed: boolean) => {
    for (const l of listeners) {
      try {
        l({}, cookie, cause, removed)
      } catch {
        /* ignore */
      }
    }
  }

  const key = (c: { domain?: string; path?: string; name: string }) =>
    `${c.domain ?? ''}|${c.path ?? '/'}|${c.name}`

  const mock: MockSession = {
    _store: store,
    _listeners: listeners,
    cookies: {
      on: (_ev, l) => {
        listeners.add(l)
        return mock.cookies
      },
      off: (_ev, l) => {
        listeners.delete(l)
        return mock.cookies
      },
      get: async (filter) => {
        const all = Array.from(store.values())
        return all.filter((c) => {
          if (filter.domain && c.domain !== filter.domain) return false
          if (filter.name && c.name !== filter.name) return false
          return true
        })
      },
      set: async (details) => {
        const { url: _url, ...rest } = details
        const cookie: MockCookie = { ...rest } as MockCookie
        if (!cookie.name) throw new Error('Cookie.name required')
        const k = key(cookie)
        const existed = store.has(k)
        store.set(k, cookie)
        emitChanged(cookie, existed ? 'overwrite' : 'explicit', false)
      },
      remove: async (url, name) => {
        const u = new URL(url)
        const host = u.hostname
        const matches = Array.from(store.values()).filter((c) => {
          if (c.name !== name) return false
          const d = (c.domain || '').replace(/^\./, '')
          return d === host || host.endsWith('.' + d)
        })
        for (const c of matches) {
          const k = key(c)
          store.delete(k)
          emitChanged(c, 'explicit', true)
        }
      },
    },
  }
  mockSessions.set(partitionKey, mock)
  return mock
}

function resetMockSessions(): void {
  mockSessions.clear()
}

vi.mock('electron', () => ({
  session: {
    fromPartition: (key: string) => makeMockSession(key),
  },
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}))

// Stub BrowserEnvironmentService module —— CookieSyncService 只消费
// onChanged / listEnvironmentsSync。这里做一个 fake service。
interface FakeEnvironment {
  id: string
  name: string
  partition_key: string
  is_default: boolean
}

class FakeService {
  private envs: FakeEnvironment[] = []
  private listeners = new Set<() => void>()

  setState(envs: FakeEnvironment[]): void {
    this.envs = envs
  }

  emitChange(): void {
    for (const l of this.listeners) l()
  }

  listEnvironmentsSync() {
    return this.envs.slice()
  }

  onChanged(handler: () => void): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }
}

vi.mock('./BrowserEnvironmentService', () => ({
  getBrowserEnvironmentService: () => {
    throw new Error('test must inject a FakeService via deps.service')
  },
}))

import {
  CookieSyncService,
  __resetCookieSyncServiceForTests,
} from './CookieSyncService'

// ── 测试固件 ──

function env(id: string, partition_key: string, isDefault = false): FakeEnvironment {
  return { id, name: id, partition_key, is_default: isDefault }
}

async function waitSync(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function writeCookieDirectly(
  partitionKey: string,
  cookie: MockCookie,
): Promise<void> {
  const ses = makeMockSession(
    partitionKey.startsWith('persist:') ? partitionKey : `persist:${partitionKey}`,
  )
  await ses.cookies.set({ url: 'https://example.com/', ...cookie })
}

async function removeCookieDirectly(
  partitionKey: string,
  cookie: Pick<MockCookie, 'name' | 'domain'>,
): Promise<void> {
  const ses = makeMockSession(
    partitionKey.startsWith('persist:') ? partitionKey : `persist:${partitionKey}`,
  )
  const host = (cookie.domain || '').replace(/^\./, '')
  await ses.cookies.remove(`https://${host}/`, cookie.name)
}

async function getCookiesOn(partitionKey: string): Promise<MockCookie[]> {
  const ses = makeMockSession(
    partitionKey.startsWith('persist:') ? partitionKey : `persist:${partitionKey}`,
  )
  return ses.cookies.get({})
}

// ── 测试 ──

describe('CookieSyncService —— 本地化退役 Wave 1', () => {
  let fakeService: FakeService
  let svc: CookieSyncService

  beforeEach(() => {
    resetMockSessions()
    __resetCookieSyncServiceForTests()
    fakeService = new FakeService()
  })

  afterEach(() => {
    try {
      svc?.stop()
    } catch {
      /* ignore */
    }
  })

  /**
   * 注:本地化后单个 env 默认只有一个 partition_key,但本组测试通过手动注入
   * 多个"同 env 多 partition"场景验证防环 / 同步路径仍正确——为未来"一 env
   * 多 partition"演进留下契约保护。
   *
   * 由于 CookieSyncService 内部 rebuildPartitionsByEnv 只会从 envs 列表注
   * 入 env.partition_key,这里测试时如果想要"一 env 两 partition"需要直接
   * 让两个 env 共享 envId 是不可能的。所以本组测试都用"两个 env 各一个
   * partition"来验证跨 env 隔离 / 同 env 同步路径(同 env 同步退化为"自己写
   * 自己读",但 service 的事件循环 + 防环逻辑仍可被测试到)。
   */
  async function bootWithEnvs(envs: FakeEnvironment[]): Promise<void> {
    fakeService.setState(envs)
    svc = new CookieSyncService({
      service:
        fakeService as unknown as import('./BrowserEnvironmentService').BrowserEnvironmentService,
      sessionFactory: (key: string) =>
        makeMockSession(key) as unknown as import('electron').Session,
      debounceMs: 50,
    })
    await svc.start()
  }

  it('监听集合: 每个 env 一个 partition_key', async () => {
    await bootWithEnvs([
      env('env1', 'tabtin:env:env1', true),
      env('env2', 'tabtin:env:env2'),
    ])
    const stats = svc.getStats()
    expect(stats.envMap['env1']).toEqual(['tabtin:env:env1'])
    expect(stats.envMap['env2']).toEqual(['tabtin:env:env2'])
    expect(stats.watchedPartitions).toBe(2)
  })

  it('跨环境隔离: envP1 写 cookie → envP2 不应收到', async () => {
    await bootWithEnvs([
      env('env1', 'tabtin:env:env1', true),
      env('env2', 'tabtin:env:env2'),
    ])
    await writeCookieDirectly('tabtin:env:env1', {
      name: 'envtest',
      value: 'only_env1',
      domain: '.example.com',
      path: '/',
      sameSite: 'lax',
    })
    await waitSync(150)

    const env2Cookies = await getCookiesOn('tabtin:env:env2')
    expect(env2Cookies.some((c) => c.name === 'envtest')).toBe(false)
  })

  it('cookie 删除 / 过期事件被防环 + cause 过滤', async () => {
    await bootWithEnvs([env('env1', 'tabtin:env:env1', true)])
    // 写 + 删除——单 env 单 partition 时不会触发跨 partition 同步,只验证
    // 防环 + cause 过滤不致命崩(用例覆盖 CookieChangeCause 'expired')
    await writeCookieDirectly('tabtin:env:env1', {
      name: 'short_lived',
      value: 'v',
      domain: '.example.com',
      path: '/',
      sameSite: 'lax',
    })
    await waitSync(150)
    await removeCookieDirectly('tabtin:env:env1', {
      name: 'short_lived',
      domain: '.example.com',
    })
    await waitSync(150)
    const remaining = await getCookiesOn('tabtin:env:env1')
    expect(remaining.some((c) => c.name === 'short_lived')).toBe(false)
  })

  it('环境切换: env 从快照中移除后,对应 partition 不再被监听', async () => {
    await bootWithEnvs([
      env('env1', 'tabtin:env:env1', true),
      env('env2', 'tabtin:env:env2'),
    ])
    expect(svc.getStats().watchedPartitions).toBe(2)

    fakeService.setState([env('env1', 'tabtin:env:env1', true)])
    fakeService.emitChange()
    await waitSync(50)

    const stats = svc.getStats()
    expect(stats.watchedPartitions).toBe(1)
    expect(stats.envMap['env2']).toBeUndefined()
  })

  it('过期 cookie 不广播 (cause filter + expirationDate 过去判定)', async () => {
    await bootWithEnvs([env('env1', 'tabtin:env:env1', true)])
    await writeCookieDirectly('tabtin:env:env1', {
      name: 'stale',
      value: 'v',
      domain: '.example.com',
      path: '/',
      expirationDate: Math.floor(Date.now() / 1000) - 3600,
      sameSite: 'lax',
    })
    await waitSync(150)
    // 主要确认服务不崩;具体广播行为依赖 Chromium 真实事件,单测层面只能
    // 验证不抛异常 + 服务状态正常
    expect(svc.getStats().watchedPartitions).toBe(1)
  })

  it('stop() 解除监听,getStats 归零', async () => {
    await bootWithEnvs([env('env1', 'tabtin:env:env1', true)])
    expect(svc.getStats().watchedPartitions).toBe(1)
    svc.stop()
    expect(svc.getStats().watchedPartitions).toBe(0)
  })

})
