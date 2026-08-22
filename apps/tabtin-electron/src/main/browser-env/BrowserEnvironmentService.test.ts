/**
 * BrowserEnvironmentService 单元测试 —— 本地化退役 Wave 1 重写。
 *
 * 覆盖：
 *   1. 构造时同步用 guest snapshot 初始化 —— IPC 立即可用
 *   2. start() 异步切到真实 userId 的快照
 *   3. 写操作（create / rename / delete / bind）写本地 + emit change
 *   4. 多账号切换：onAuthChanged 触发后切到新 userId 的 snapshot
 *   5. 业务校验失败时抛 BrowserEnvValidationError
 *   6. 默认 env 永远存在 + 不可改名 / 删除
 *   7. snapshot 含悬空 environment_id 被 guard 忽略
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserEnvSnapshot } from '../services/ConfigService'

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../services/ConfigService', () => {
  class ConfigPersistError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ConfigPersistError'
    }
  }
  return {
    configService: {
      get: vi.fn(),
      set: vi.fn(),
    },
    ConfigPersistError,
  }
})

vi.mock('../auth', () => ({
  TokenManager: {
    preloadAuthData: vi.fn(async () => undefined),
    getUserInfo: vi.fn(async () => null),
    // L-W1-8 契约：defaultResolveUserId 现在同时读 accessToken 与 userInfo，
    // 缺 token 视为"无效会话"走 guest snapshot。mock 补 getAccessToken 避免
    // 测试以为 mock 表面默认"已登录"。
    getAccessToken: vi.fn(async () => null),
    onAuthChanged: vi.fn(() => () => undefined),
    // L-W1-8 历史名仍保留供老调用方兼容；mock 让两个名字都能通过 import。
    onAuthAvailable: vi.fn(() => () => undefined),
  },
}))

import {
  BrowserEnvironmentService,
  BrowserEnvValidationError,
  __resetBrowserEnvironmentServiceForTests,
} from './BrowserEnvironmentService'
import {
  BrowserEnvLocalStore,
  GUEST_USER_ID,
  type BrowserEnvStorageBackend,
} from './BrowserEnvLocalStore'

// ── 测试固件 ──

class InMemoryBackend implements BrowserEnvStorageBackend {
  private data: Record<string, BrowserEnvSnapshot> = {}

  get(): Record<string, BrowserEnvSnapshot> {
    // 返回浅拷贝,模拟 ConfigService 的语义
    return { ...this.data }
  }

  set(value: Record<string, BrowserEnvSnapshot>): void {
    this.data = { ...value }
  }

  preset(userId: string, snapshot: BrowserEnvSnapshot): void {
    this.data[userId] = snapshot
  }

  raw(): Record<string, BrowserEnvSnapshot> {
    return this.data
  }
}

function makeService(opts: {
  backend?: InMemoryBackend
  resolveUserId?: () => Promise<string>
  onAuthChanged?: (cb: () => void) => () => void
  resolveCurrentOrganizationId?: () => string | null | undefined
} = {}) {
  const backend = opts.backend ?? new InMemoryBackend()
  const store = new BrowserEnvLocalStore(backend)
  const svc = new BrowserEnvironmentService({
    store,
    resolveUserId: opts.resolveUserId ?? (async () => GUEST_USER_ID),
    onAuthChanged: opts.onAuthChanged ?? (() => () => undefined),
    resolveCurrentOrganizationId: opts.resolveCurrentOrganizationId,
  })
  return { svc, backend, store }
}

describe('BrowserEnvironmentService —— 本地化退役 Wave 1', () => {
  beforeEach(() => {
    __resetBrowserEnvironmentServiceForTests()
  })

  describe('构造时同步初始化', () => {
    it('构造后立即返回真实默认 partition,无 pending 概念', () => {
      const { svc } = makeService()
      // 任何 spaceId 都应回落到默认 env partition,而不是 pending 占位
      expect(svc.getPartitionForSpace('any-space')).toBe('tabtin:env:default')
      expect(svc.getEnvironmentBySpace('any-space')?.is_default).toBe(true)
    })

    it('构造时 ensureDefault 写入 guest snapshot', () => {
      const backend = new InMemoryBackend()
      makeService({ backend })
      const stored = backend.raw()[GUEST_USER_ID]
      expect(stored).toBeDefined()
      expect(stored.environments).toHaveLength(1)
      expect(stored.environments[0].is_default).toBe(true)
      expect(stored.environments[0].partition_key).toBe('tabtin:env:default')
    })
  })

  describe('start() —— 异步切到真实 userId', () => {
    it('start() 后切到真实 userId 的 snapshot 并 emit change', async () => {
      const backend = new InMemoryBackend()
      // 预置 user-1 的快照(含一个独立 env + binding)
      backend.preset('user-1', {
        environments: [
          {
            id: 'default',
            name: '默认环境',
            partition_key: 'tabtin:env:default',
            is_default: true,
            binding_count: 0,
            explicit_binding_count: 0,
            using_space_count: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 'env-personal',
            name: '个人',
            partition_key: 'tabtin:env:personal-uuid',
            is_default: false,
            binding_count: 0,
            explicit_binding_count: 0,
            using_space_count: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        bindings: [
          { space_id: 'sp-1', environment_id: 'env-personal', is_explicit: true },
        ],
      })

      const { svc } = makeService({
        backend,
        resolveUserId: async () => 'user-1',
      })
      const changes: unknown[] = []
      svc.onChanged((p) => changes.push(p))

      await svc.start()

      expect(svc.getPartitionForSpace('sp-1')).toBe('tabtin:env:personal-uuid')
      expect(svc.getEnvironmentBySpace('sp-1')?.id).toBe('env-personal')
      expect(svc.getPartitionForSpace('sp-other')).toBe('tabtin:env:default')
      expect(changes.map((c: any) => c.reason)).toContain('manual-refresh')
    })

    it('start() 解析 userId 失败仅 warn,继续用 guest snapshot', async () => {
      const backend = new InMemoryBackend()
      const { svc } = makeService({
        backend,
        resolveUserId: async () => {
          throw new Error('boom')
        },
      })

      await svc.start()
      // 仍然在 guest snapshot 上工作
      expect(svc.getPartitionForSpace('any-space')).toBe('tabtin:env:default')
    })
  })

  describe('多账号切换', () => {
    it('onAuthChanged 触发时切到新 userId 的 snapshot', async () => {
      const backend = new InMemoryBackend()
      backend.preset('user-1', {
        environments: [
          {
            id: 'default',
            name: '默认环境',
            partition_key: 'tabtin:env:default',
            is_default: true,
            binding_count: 0,
            explicit_binding_count: 0,
            using_space_count: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 'env-u1',
            name: 'user-1 私有',
            partition_key: 'tabtin:env:u1-uuid',
            is_default: false,
            binding_count: 0,
            explicit_binding_count: 0,
            using_space_count: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        bindings: [
          { space_id: 'shared-space', environment_id: 'env-u1', is_explicit: true },
        ],
      })
      backend.preset('user-2', {
        environments: [
          {
            id: 'default',
            name: '默认环境',
            partition_key: 'tabtin:env:default',
            is_default: true,
            binding_count: 0,
            explicit_binding_count: 0,
            using_space_count: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        bindings: [],
      })

      let currentUserId = 'user-1'
      let authCb: (() => void) | null = null

      const { svc } = makeService({
        backend,
        resolveUserId: async () => currentUserId,
        onAuthChanged: (cb) => {
          authCb = cb
          return () => {
            authCb = null
          }
        },
      })

      await svc.start()
      expect(svc.getPartitionForSpace('shared-space')).toBe('tabtin:env:u1-uuid')

      currentUserId = 'user-2'
      authCb!()
      // wait microtask
      await new Promise((r) => setTimeout(r, 5))

      // user-2 的快照里 shared-space 没有 binding → fallback 默认 env
      expect(svc.getPartitionForSpace('shared-space')).toBe('tabtin:env:default')
    })

    it('登出（user_id 不变 / 没有用户）时不破坏现有数据', async () => {
      const backend = new InMemoryBackend()
      const { svc } = makeService({
        backend,
        resolveUserId: async () => GUEST_USER_ID,
      })
      await svc.start()
      // guest snapshot 已被持久化
      expect(backend.raw()[GUEST_USER_ID]).toBeDefined()
    })
  })

  describe('写操作', () => {
    it('createEnvironment 写本地 + emit change + 派生 binding_count=0', async () => {
      const backend = new InMemoryBackend()
      const { svc } = makeService({ backend })

      const changes: any[] = []
      svc.onChanged((p) => changes.push(p))

      const env = await svc.createEnvironment('个人')
      expect(env.name).toBe('个人')
      expect(env.is_default).toBe(false)
      expect(env.partition_key).toMatch(/^tabtin:env:[0-9a-f]+$/)
      expect(env.binding_count).toBe(0)

      // 已写入 store
      expect(backend.raw()[GUEST_USER_ID].environments.some((e) => e.id === env.id)).toBe(true)
      expect(changes.map((c) => c.reason)).toContain('created')
      expect(changes.find((c) => c.reason === 'created').environmentId).toBe(env.id)

      // 同步 list 立即可见
      expect(svc.listEnvironmentsSync().some((e) => e.id === env.id)).toBe(true)
    })

    it('createEnvironment 名字冲突 → ENV_NAME_DUPLICATE', async () => {
      const { svc } = makeService()
      await svc.createEnvironment('Foo')
      await expect(svc.createEnvironment('Foo')).rejects.toMatchObject({
        code: 'ENV_NAME_DUPLICATE',
      })
    })

    it('createEnvironment 空名字 → ENV_NAME_REQUIRED', async () => {
      const { svc } = makeService()
      await expect(svc.createEnvironment('  ')).rejects.toMatchObject({
        code: 'ENV_NAME_REQUIRED',
      })
    })

    it('renameEnvironment 改名 + emit change', async () => {
      const { svc } = makeService()
      const created = await svc.createEnvironment('Foo')
      const changes: any[] = []
      svc.onChanged((p) => changes.push(p))
      const renamed = await svc.renameEnvironment(created.id, 'Bar')
      expect(renamed.name).toBe('Bar')
      expect(changes.map((c) => c.reason)).toContain('renamed')
    })

    it('默认 env 不能改名 → DEFAULT_ENV_LOCKED', async () => {
      const { svc } = makeService()
      const def = svc.listEnvironmentsSync().find((e) => e.is_default)!
      await expect(svc.renameEnvironment(def.id, 'X')).rejects.toMatchObject({
        code: 'DEFAULT_ENV_LOCKED',
      })
    })

    it('默认 env 不能删除 → DEFAULT_ENV_LOCKED', async () => {
      const { svc } = makeService()
      const def = svc.listEnvironmentsSync().find((e) => e.is_default)!
      await expect(svc.deleteEnvironment(def.id)).rejects.toMatchObject({
        code: 'DEFAULT_ENV_LOCKED',
      })
    })

    it('deleteEnvironment 删除 + 把绑定的 Space 重置回默认 env', async () => {
      const { svc } = makeService()
      const env = await svc.createEnvironment('Foo')
      await svc.bindSpaceToEnvironment('sp-A', env.id)
      await svc.bindSpaceToEnvironment('sp-B', env.id)
      const result = await svc.deleteEnvironment(env.id)
      expect(result.deleted_id).toBe(env.id)
      expect(result.rebound_bindings).toBe(2)
      expect(result.rebound_space_ids.sort()).toEqual(['sp-A', 'sp-B'])
      // 删除后 sp-A / sp-B 走默认 env partition
      expect(svc.getPartitionForSpace('sp-A')).toBe('tabtin:env:default')
      expect(svc.getPartitionForSpace('sp-B')).toBe('tabtin:env:default')
    })

    it('bindSpaceToEnvironment 绑定 + getPartitionForSpace 立刻看到新值', async () => {
      const { svc } = makeService()
      const env = await svc.createEnvironment('Foo')
      expect(svc.getPartitionForSpace('sp-1')).toBe('tabtin:env:default')
      await svc.bindSpaceToEnvironment('sp-1', env.id)
      expect(svc.getPartitionForSpace('sp-1')).toBe(env.partition_key)
    })

    it('bindSpaceToEnvironment 不存在的 env → ENV_NOT_FOUND', async () => {
      const { svc } = makeService()
      await expect(
        svc.bindSpaceToEnvironment('sp-1', 'ghost-env'),
      ).rejects.toMatchObject({ code: 'ENV_NOT_FOUND' })
    })

    it('bindSpaceToEnvironment 同 Space 二次绑定覆盖前一个', async () => {
      const { svc } = makeService()
      const env1 = await svc.createEnvironment('A')
      const env2 = await svc.createEnvironment('B')
      await svc.bindSpaceToEnvironment('sp-1', env1.id)
      await svc.bindSpaceToEnvironment('sp-1', env2.id)
      expect(svc.getPartitionForSpace('sp-1')).toBe(env2.partition_key)
      // 只剩一条 binding(去重)
      expect(svc.listBindingsSync().filter((b) => b.space_id === 'sp-1')).toHaveLength(1)
    })

    it('using_space_count 派生:绑了 3 个 Space → 显示 3', async () => {
      const { svc } = makeService()
      const env = await svc.createEnvironment('Foo')
      await svc.bindSpaceToEnvironment('sp-1', env.id)
      await svc.bindSpaceToEnvironment('sp-2', env.id)
      await svc.bindSpaceToEnvironment('sp-3', env.id)
      const refreshed = svc.listEnvironmentsSync().find((e) => e.id === env.id)!
      expect(refreshed.using_space_count).toBe(3)
      expect(refreshed.explicit_binding_count).toBe(3)
      expect(refreshed.binding_count).toBe(3)
    })
  })

  describe('Organization 级浏览器 partition（边界改造 Phase 3a）', () => {
    it('注入 organization 解析器后，未绑定 Space 走 tabtin:organization:{id}:browser', () => {
      const { svc } = makeService({ resolveCurrentOrganizationId: () => 'wt-123' })
      expect(svc.getPartitionForSpace('sp-any')).toBe('tabtin:organization:wt-123:browser')
      // 无 spaceId 也走 organization 罐
      expect(svc.getPartitionForSpace('')).toBe('tabtin:organization:wt-123:browser')
    })

    it('权威 Workspace organization 覆盖当前活跃 organization', () => {
      const { svc } = makeService({ resolveCurrentOrganizationId: () => 'org-active-ui' })

      expect(svc.getPartitionForSpace('package-space', 'org-package-workspace'))
        .toBe('tabtin:organization:org-package-workspace:browser')
    })

    it('显式 env 绑定优先于 organization 罐（legacy 独立环境仍生效）', async () => {
      const { svc } = makeService({ resolveCurrentOrganizationId: () => 'wt-123' })
      const env = await svc.createEnvironment('独立环境')
      await svc.bindSpaceToEnvironment('sp-bound', env.id)
      // 绑定的 Space 用 env partition，未绑定的走 organization 罐
      expect(svc.getPartitionForSpace('sp-bound')).toBe(env.partition_key)
      expect(svc.getPartitionForSpace('sp-free')).toBe('tabtin:organization:wt-123:browser')
    })

    it('解析器返回空 / 未注入 → 回落默认 env partition（既有行为）', () => {
      const noResolver = makeService()
      expect(noResolver.svc.getPartitionForSpace('sp-any')).toBe('tabtin:env:default')
      const emptyResolver = makeService({ resolveCurrentOrganizationId: () => null })
      expect(emptyResolver.svc.getPartitionForSpace('sp-any')).toBe('tabtin:env:default')
    })

    it('解析器抛错 → 回落默认 env partition，不冒泡', () => {
      const { svc } = makeService({
        resolveCurrentOrganizationId: () => {
          throw new Error('boom')
        },
      })
      expect(svc.getPartitionForSpace('sp-any')).toBe('tabtin:env:default')
    })

    it('setCurrentOrganizationIdResolver 运行时注入即刻生效', () => {
      const { svc } = makeService()
      expect(svc.getPartitionForSpace('sp-any')).toBe('tabtin:env:default')
      svc.setCurrentOrganizationIdResolver(() => 'wt-late')
      expect(svc.getPartitionForSpace('sp-any')).toBe('tabtin:organization:wt-late:browser')
      // 解除后回落默认
      svc.setCurrentOrganizationIdResolver(null)
      expect(svc.getPartitionForSpace('sp-any')).toBe('tabtin:env:default')
    })

    it('organizationId 含非法字符被 sanitize 进 partition 名', () => {
      const { svc } = makeService({ resolveCurrentOrganizationId: () => 'wt/../x y' })
      expect(svc.getPartitionForSpace('sp-any')).toBe('tabtin:organization:wt____x_y:browser')
    })
  })

  describe('防御性边界', () => {
    it('snapshot 含悬空 environment_id 的 binding 被 guard 跳过,Space fallback 默认 env', () => {
      const backend = new InMemoryBackend()
      backend.preset(GUEST_USER_ID, {
        environments: [
          {
            id: 'default',
            name: '默认环境',
            partition_key: 'tabtin:env:default',
            is_default: true,
            binding_count: 0,
            explicit_binding_count: 0,
            using_space_count: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        bindings: [
          { space_id: 'sp-x', environment_id: 'ghost-env', is_explicit: true },
        ],
      })
      const { svc } = makeService({ backend })
      // sp-x 的 binding 被悬空守门忽略 → fallback 到默认 env
      expect(svc.getPartitionForSpace('sp-x')).toBe('tabtin:env:default')
    })

    it('snapshot environments 为空时 ensureDefault 自动补上默认 env', () => {
      const backend = new InMemoryBackend()
      backend.preset(GUEST_USER_ID, { environments: [], bindings: [] })
      const { svc } = makeService({ backend })
      // 应自动恢复默认 env
      expect(svc.listEnvironmentsSync().some((e) => e.is_default)).toBe(true)
    })

    it('腐坏快照: 已有 id=default 但 is_default=false → repair 后只剩一条 id=default(不重复)', () => {
      // 模拟"用户某次手贱 PATCH / 历史 bug 写出"的脏数据:partition_key 也是脏的
      const backend = new InMemoryBackend()
      backend.preset(GUEST_USER_ID, {
        environments: [
          {
            id: 'default',
            name: '被改成奇怪名字',
            partition_key: 'tabtin:env:wrong-key',
            is_default: false, // 关键脏点
            binding_count: 0,
            explicit_binding_count: 0,
            using_space_count: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 'env-A',
            name: '正常自建',
            partition_key: 'tabtin:env:a-uuid',
            is_default: false,
            binding_count: 0,
            explicit_binding_count: 0,
            using_space_count: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        bindings: [],
      })
      const { svc } = makeService({ backend })
      const envs = svc.listEnvironmentsSync()
      // 不应有两条 id='default'
      const defaultEntries = envs.filter((e) => e.id === 'default')
      expect(defaultEntries).toHaveLength(1)
      // repair 后那条 entry 字段全部对齐到默认 env 标准
      const def = defaultEntries[0]
      expect(def.is_default).toBe(true)
      expect(def.name).toBe('默认环境')
      expect(def.partition_key).toBe('tabtin:env:default')
      // 自建 env 应保留
      expect(envs.some((e) => e.id === 'env-A')).toBe(true)
      // 持久化也只剩一条 id='default'
      const persisted = backend.raw()[GUEST_USER_ID]
      expect(persisted.environments.filter((e) => e.id === 'default')).toHaveLength(1)
    })

    it('writeSync 抛 ConfigPersistError 时,创建操作以 PERSIST_FAILED 失败 + 不变更内存', async () => {
      const backend = new InMemoryBackend()
      const { svc } = makeService({ backend })
      const beforeCount = svc.listEnvironmentsSync().length
      const { ConfigPersistError } = await import('../services/ConfigService')
      // mock backend.set 抛 ConfigPersistError(模拟磁盘满 / 权限失败)
      ;(backend as any).set = vi.fn().mockImplementation(() => {
        throw new ConfigPersistError('disk full')
      })
      // create 内部 persist → ConfigPersistError → 转 BrowserEnvValidationError
      // (PERSIST_FAILED) 抛回调用方;IPC 层会转成 success:false
      await expect(svc.createEnvironment('Foo')).rejects.toMatchObject({
        code: 'PERSIST_FAILED',
      })
      // 关键:内存没有被改(不会留下"UI 显示成功 + 重启数据回滚"的隐藏 bug)
      expect(svc.listEnvironmentsSync().length).toBe(beforeCount)
    })
  })

  describe('BrowserEnvValidationError', () => {
    it('暴露 code + message', async () => {
      const { svc } = makeService()
      try {
        await svc.createEnvironment('')
        throw new Error('应抛错')
      } catch (err) {
        expect(err).toBeInstanceOf(BrowserEnvValidationError)
        expect((err as BrowserEnvValidationError).code).toBe('ENV_NAME_REQUIRED')
      }
    })
  })
})
