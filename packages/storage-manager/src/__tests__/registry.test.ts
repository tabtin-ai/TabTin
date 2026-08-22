/**
 * 注册中心 + bridge 单元测试。
 *
 * 覆盖目标（≥ 80%）：
 *   - registerStorageBucket / unregister
 *   - listBuckets 含 filter（group / category / includeHidden / 多条件 AND）
 *   - getBucket / clearBucket / exportBucket / listBucketItems / getBucketSize
 *     的成功路径 + bucket 不存在 / 能力缺失 错误
 *   - 重复注册抛错
 *   - assertValidBucket：data 类无 warnings 应抛错；category-confirmation
 *     一致性约束；非法 group / category / 非函数 sizeFn 等
 *   - ConfirmationLevel 与 BucketCategory 的隐含约束（data 必须 hard，cache 必须 none）
 *   - IPC bridge：注册 handler → 收到 IpcResult 信封；错误归一
 *   - Daemon bridge：未配置时 listBuckets 返回 [] / 其他抛 NotConfigured
 *   - Renderer bridge：local + main 聚合视图 + 路由
 *   - 集成 demo：mock 注册 → list → clear → export 调用链
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BucketAlreadyRegisteredError,
  BucketCapabilityMissingError,
  BucketNotFoundError,
  DaemonBridgeNotConfiguredError,
  IPC_CHANNELS,
  InvalidBucketError,
  RendererStorageBridge,
  __resetForTesting,
  assertValidBucket,
  bucketToDescriptor,
  clearBucket,
  createDaemonBridge,
  createMainProcessBridge,
  defaultConfirmationFor,
  exportBucket,
  getBucket,
  getBucketSize,
  isDaemonStorageFetcherConfigured,
  listBucketItems,
  listBuckets,
  registerStorageBucket,
  registerStorageManagerIpc,
  setDaemonStorageFetcher,
  type BucketCategory,
  type BucketDescriptor,
  type BucketGroup,
  type IpcMainTransport,
  type IpcRendererInvoker,
  type IpcResult,
  type StorageBucket,
} from '../index.js'

// ── 测试工厂 ────────────────────────────────────────────────────

function makeCacheBucket(
  overrides: Partial<StorageBucket> = {},
): StorageBucket {
  return {
    id: 'test:cache',
    category: 'cache',
    group: 'cache',
    displayName: '测试缓存',
    description: '一句话说明',
    sizeFn: async () => ({ bytes: 1024, itemCount: 3 }),
    ...overrides,
  }
}

function makeSemiCacheBucket(
  overrides: Partial<StorageBucket> = {},
): StorageBucket {
  return {
    id: 'test:semi',
    category: 'semi-cache',
    group: 'cache',
    displayName: '半缓存',
    description: '一句话',
    sizeFn: async () => ({ bytes: 2048 }),
    ...overrides,
  }
}

function makeDataBucket(overrides: Partial<StorageBucket> = {}): StorageBucket {
  return {
    id: 'test:data',
    category: 'data',
    group: 'business-app',
    displayName: '业务数据',
    description: '一句话',
    sizeFn: async () => ({ bytes: 4096, itemCount: 7 }),
    warnings: ['清后不可恢复'],
    ...overrides,
  }
}

beforeEach(() => {
  __resetForTesting()
  setDaemonStorageFetcher(undefined)
})

afterEach(() => {
  __resetForTesting()
  setDaemonStorageFetcher(undefined)
})

// ── 注册与查询 ──────────────────────────────────────────────────

describe('registerStorageBucket / listBuckets', () => {
  it('注册成功并可被 list / get', () => {
    const off = registerStorageBucket(makeCacheBucket())
    expect(typeof off).toBe('function')

    const list = listBuckets()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('test:cache')
    expect(getBucket('test:cache')?.displayName).toBe('测试缓存')
  })

  it('未指定 requiresConfirmation 时按 category 默认补齐', () => {
    registerStorageBucket(makeCacheBucket())
    registerStorageBucket(makeSemiCacheBucket())
    registerStorageBucket(makeDataBucket())

    expect(getBucket('test:cache')?.requiresConfirmation).toBe('none')
    expect(getBucket('test:semi')?.requiresConfirmation).toBe('soft')
    expect(getBucket('test:data')?.requiresConfirmation).toBe('hard')
  })

  it('未指定 hideFromList 时默认 false', () => {
    registerStorageBucket(makeCacheBucket())
    expect(getBucket('test:cache')?.hideFromList).toBe(false)
  })

  it('unregister 后从 list 中消失', () => {
    const off = registerStorageBucket(makeCacheBucket())
    expect(listBuckets()).toHaveLength(1)
    off()
    expect(listBuckets()).toHaveLength(0)
    expect(getBucket('test:cache')).toBeUndefined()
  })

  it('unregister 是幂等的（重复调用不出错）', () => {
    const off = registerStorageBucket(makeCacheBucket())
    off()
    off()
    expect(listBuckets()).toHaveLength(0)
  })

  it('先 unregister 再 register 同 id 时旧 unregister 不会误删新实例', () => {
    const off1 = registerStorageBucket(makeCacheBucket())
    off1()
    registerStorageBucket(makeCacheBucket({ displayName: '新实例' }))
    off1() // 旧 unregister 再调一次，不应误删
    expect(getBucket('test:cache')?.displayName).toBe('新实例')
  })

  it('重复注册同 id 抛 BucketAlreadyRegisteredError', () => {
    registerStorageBucket(makeCacheBucket())
    expect(() => registerStorageBucket(makeCacheBucket())).toThrow(
      BucketAlreadyRegisteredError,
    )
  })
})

describe('listBuckets filter', () => {
  beforeEach(() => {
    registerStorageBucket(makeCacheBucket({ id: 'a:cache', group: 'cache' }))
    registerStorageBucket(
      makeDataBucket({ id: 'b:data', group: 'business-app' }),
    )
    registerStorageBucket(
      makeDataBucket({ id: 'c:data-conv', group: 'conversation' }),
    )
    registerStorageBucket(
      makeDataBucket({
        id: 'd:hidden',
        group: 'system',
        hideFromList: true,
      }),
    )
  })

  it('按 group 过滤', () => {
    const r = listBuckets({ group: 'business-app' })
    expect(r.map((b) => b.id)).toEqual(['b:data'])
  })

  it('按 category 过滤', () => {
    const r = listBuckets({ category: 'cache' })
    expect(r.map((b) => b.id)).toEqual(['a:cache'])
  })

  it('多条件是 AND 关系', () => {
    const r = listBuckets({ category: 'data', group: 'conversation' })
    expect(r.map((b) => b.id)).toEqual(['c:data-conv'])
  })

  it('默认隐藏 hideFromList: true 的 bucket', () => {
    const r = listBuckets()
    expect(r.map((b) => b.id).sort()).toEqual(['a:cache', 'b:data', 'c:data-conv'])
  })

  it('includeHidden 时返回隐藏 bucket', () => {
    const r = listBuckets({ includeHidden: true })
    expect(r.map((b) => b.id).sort()).toEqual([
      'a:cache',
      'b:data',
      'c:data-conv',
      'd:hidden',
    ])
  })
})

// ── 操作 API ───────────────────────────────────────────────────

describe('clearBucket / exportBucket / listBucketItems / getBucketSize', () => {
  it('getBucketSize 调用底层 sizeFn', async () => {
    registerStorageBucket(
      makeDataBucket({
        sizeFn: async () => ({ bytes: 9999, itemCount: 42 }),
      }),
    )
    const size = await getBucketSize('test:data')
    expect(size).toEqual({ bytes: 9999, itemCount: 42 })
  })

  it('getBucketSize bucket 不存在 → BucketNotFoundError', async () => {
    await expect(getBucketSize('nope')).rejects.toThrow(BucketNotFoundError)
  })

  it('clearBucket 调用 clearFn', async () => {
    const clearFn = vi.fn(async () => ({
      clearedItemCount: 3,
      freedBytes: 1024,
    }))
    registerStorageBucket(makeDataBucket({ clearFn }))
    const r = await clearBucket('test:data', { dryRun: false })
    expect(r.freedBytes).toBe(1024)
    expect(clearFn).toHaveBeenCalledWith({ dryRun: false })
  })

  it('clearBucket 没声明 clearFn → BucketCapabilityMissingError', async () => {
    registerStorageBucket(makeDataBucket())
    await expect(clearBucket('test:data')).rejects.toThrow(
      BucketCapabilityMissingError,
    )
    try {
      await clearBucket('test:data')
    } catch (err) {
      expect(err).toBeInstanceOf(BucketCapabilityMissingError)
      expect((err as BucketCapabilityMissingError).capability).toBe('clearFn')
    }
  })

  it('exportBucket 调用 exportFn', async () => {
    registerStorageBucket(
      makeDataBucket({
        exportFn: async () => ({
          filename: 'data.json',
          data: '{"hello":1}',
          mimeType: 'application/json',
        }),
      }),
    )
    const r = await exportBucket('test:data')
    expect(r.filename).toBe('data.json')
    expect(r.data).toBe('{"hello":1}')
  })

  it('exportBucket 没声明 exportFn → BucketCapabilityMissingError', async () => {
    registerStorageBucket(makeDataBucket())
    await expect(exportBucket('test:data')).rejects.toThrow(
      BucketCapabilityMissingError,
    )
  })

  it('listBucketItems 没声明 listFn → BucketCapabilityMissingError（F-4 补漏）', async () => {
    registerStorageBucket(makeDataBucket())
    await expect(listBucketItems('test:data')).rejects.toThrow(
      BucketCapabilityMissingError,
    )
    try {
      await listBucketItems('test:data')
    } catch (err) {
      expect(err).toBeInstanceOf(BucketCapabilityMissingError)
      expect((err as BucketCapabilityMissingError).capability).toBe('listFn')
    }
  })

  it('listBucketItems 调用 listFn', async () => {
    registerStorageBucket(
      makeDataBucket({
        listFn: async () => [
          { id: 'a', label: 'A', bytes: 100 },
          { id: 'b', label: 'B', bytes: 200 },
        ],
      }),
    )
    const items = await listBucketItems('test:data')
    expect(items).toHaveLength(2)
  })

  it('listBucketItems bucket 不存在 → BucketNotFoundError', async () => {
    await expect(listBucketItems('nope')).rejects.toThrow(BucketNotFoundError)
  })
})

// ── assertValidBucket ──────────────────────────────────────────

describe('assertValidBucket / category-confirmation 约束', () => {
  it('合法 cache bucket 通过', () => {
    expect(() => assertValidBucket(makeCacheBucket())).not.toThrow()
  })

  it('合法 data bucket（带 warnings + hard）通过', () => {
    expect(() => assertValidBucket(makeDataBucket())).not.toThrow()
  })

  it('data 类无 warnings 抛 InvalidBucketError', () => {
    expect(() =>
      assertValidBucket(
        makeDataBucket({ warnings: undefined }) as StorageBucket,
      ),
    ).toThrow(InvalidBucketError)
  })

  it('data 类 warnings = [] 抛错', () => {
    expect(() => assertValidBucket(makeDataBucket({ warnings: [] }))).toThrow(
      InvalidBucketError,
    )
  })

  it('data 类 warnings 含空字符串抛错', () => {
    expect(() =>
      assertValidBucket(makeDataBucket({ warnings: ['有效', '   '] })),
    ).toThrow(InvalidBucketError)
  })

  it('cache 类显式 requiresConfirmation: hard 抛错', () => {
    expect(() =>
      assertValidBucket(
        makeCacheBucket({ requiresConfirmation: 'hard' }),
      ),
    ).toThrow(/cache 类必须 requiresConfirmation === 'none'/)
  })

  it('semi-cache 类 requiresConfirmation: none 抛错', () => {
    expect(() =>
      assertValidBucket(
        makeSemiCacheBucket({ requiresConfirmation: 'none' }),
      ),
    ).toThrow(/semi-cache 类必须 requiresConfirmation === 'soft'/)
  })

  it('data 类 requiresConfirmation: none 抛错', () => {
    expect(() =>
      assertValidBucket(makeDataBucket({ requiresConfirmation: 'none' })),
    ).toThrow(/data 类不允许/)
  })

  it('data 类 requiresConfirmation: soft 通过（L3 部分对话框）', () => {
    expect(() =>
      assertValidBucket(makeDataBucket({ requiresConfirmation: 'soft' })),
    ).not.toThrow()
  })

  it('id 为空抛错', () => {
    expect(() => assertValidBucket(makeCacheBucket({ id: '' }))).toThrow(
      /id 必须是非空字符串/,
    )
  })

  it('非法 category 抛错', () => {
    expect(() =>
      assertValidBucket(
        makeCacheBucket({ category: 'foo' as BucketCategory }),
      ),
    ).toThrow(/category 必须是/)
  })

  it('非法 group 抛错', () => {
    expect(() =>
      assertValidBucket(makeCacheBucket({ group: 'random' as BucketGroup })),
    ).toThrow(/group 必须是/)
  })

  it('非函数 sizeFn 抛错', () => {
    expect(() =>
      assertValidBucket(
        makeCacheBucket({ sizeFn: 'not-a-fn' as unknown as StorageBucket['sizeFn'] }),
      ),
    ).toThrow(/sizeFn 必填/)
  })

  it('listFn 不是函数抛错', () => {
    expect(() =>
      assertValidBucket(
        makeCacheBucket({
          listFn: 'oops' as unknown as StorageBucket['listFn'],
        }),
      ),
    ).toThrow(/listFn 必须是函数/)
  })

  it('displayName 空字符串抛错', () => {
    expect(() => assertValidBucket(makeCacheBucket({ displayName: '   ' }))).toThrow(
      /displayName 必须是非空字符串/,
    )
  })

  it('description 空字符串抛错', () => {
    expect(() => assertValidBucket(makeCacheBucket({ description: '' }))).toThrow(
      /description 必须是非空字符串/,
    )
  })

  it('注册时校验失败抛错（registerStorageBucket 内部调用 assertValidBucket）', () => {
    expect(() =>
      registerStorageBucket(makeDataBucket({ warnings: undefined })),
    ).toThrow(InvalidBucketError)
  })

  it('defaultConfirmationFor 三种 category 映射正确', () => {
    expect(defaultConfirmationFor('cache')).toBe('none')
    expect(defaultConfirmationFor('semi-cache')).toBe('soft')
    expect(defaultConfirmationFor('data')).toBe('hard')
  })
})

// ── bucketToDescriptor ─────────────────────────────────────────

describe('bucketToDescriptor', () => {
  it('剥掉函数引用，标记 capabilities', () => {
    const bucket: StorageBucket = makeDataBucket({
      listFn: async () => [],
      clearFn: async () => ({ clearedItemCount: 0, freedBytes: 0 }),
    })
    const desc = bucketToDescriptor(bucket, 'main')
    expect(desc).toEqual({
      id: 'test:data',
      category: 'data',
      group: 'business-app',
      displayName: '业务数据',
      description: '一句话',
      warnings: ['清后不可恢复'],
      requiresConfirmation: 'hard', // makeDataBucket 默认（来自 register 后状态：但 bucketToDescriptor 单独投影时若未指定也兜底 'none'）
      hideFromList: false,
      capabilities: { canList: true, canClear: true, canExport: false },
      source: 'main',
    })
  })

  it('未指定 requiresConfirmation 时按 category 兜底推导', () => {
    expect(bucketToDescriptor(makeCacheBucket()).requiresConfirmation).toBe(
      'none',
    )
    expect(bucketToDescriptor(makeSemiCacheBucket()).requiresConfirmation).toBe(
      'soft',
    )
    expect(bucketToDescriptor(makeDataBucket()).requiresConfirmation).toBe(
      'hard',
    )
  })
})

// ── IPC bridge ─────────────────────────────────────────────────

describe('registerStorageManagerIpc', () => {
  function makeFakeIpcMain(): IpcMainTransport & {
    handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
  } {
    const handlers = new Map<
      string,
      (event: unknown, ...args: unknown[]) => unknown
    >()
    return {
      handlers,
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      removeHandler(channel) {
        handlers.delete(channel)
      },
    }
  }

  it('注册 5 个 channel', () => {
    const ipc = makeFakeIpcMain()
    registerStorageManagerIpc(ipc)
    expect(ipc.handlers.size).toBe(5)
    expect(ipc.handlers.has(IPC_CHANNELS.LIST_BUCKETS)).toBe(true)
    expect(ipc.handlers.has(IPC_CHANNELS.GET_BUCKET_SIZE)).toBe(true)
    expect(ipc.handlers.has(IPC_CHANNELS.LIST_BUCKET_ITEMS)).toBe(true)
    expect(ipc.handlers.has(IPC_CHANNELS.CLEAR_BUCKET)).toBe(true)
    expect(ipc.handlers.has(IPC_CHANNELS.EXPORT_BUCKET)).toBe(true)
  })

  it('unregister 后 channel 全部移除', () => {
    const ipc = makeFakeIpcMain()
    const off = registerStorageManagerIpc(ipc)
    off()
    expect(ipc.handlers.size).toBe(0)
  })

  it('LIST_BUCKETS handler 返回 ok 信封 + 仅 main bucket', async () => {
    registerStorageBucket(makeCacheBucket())
    const ipc = makeFakeIpcMain()
    registerStorageManagerIpc(ipc)
    const handler = ipc.handlers.get(IPC_CHANNELS.LIST_BUCKETS)!
    const result = (await handler(null)) as IpcResult<BucketDescriptor[]>
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toHaveLength(1)
      expect(result.value[0]?.source).toBe('main')
    }
  })

  it('GET_BUCKET_SIZE handler bucket 不存在时返回错误信封', async () => {
    const ipc = makeFakeIpcMain()
    registerStorageManagerIpc(ipc)
    const handler = ipc.handlers.get(IPC_CHANNELS.GET_BUCKET_SIZE)!
    const result = (await handler(null, 'nope')) as IpcResult<unknown>
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.name).toBe('BucketNotFoundError')
      expect(result.error.bucketId).toBe('nope')
    }
  })

  it('CLEAR_BUCKET 错误归一为信封不抛出', async () => {
    registerStorageBucket(makeDataBucket())
    const ipc = makeFakeIpcMain()
    registerStorageManagerIpc(ipc)
    const handler = ipc.handlers.get(IPC_CHANNELS.CLEAR_BUCKET)!
    // 没声明 clearFn
    const result = (await handler(null, 'test:data')) as IpcResult<unknown>
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.name).toBe('BucketCapabilityMissingError')
      expect(result.error.capability).toBe('clearFn')
    }
  })

  it('EXPORT_BUCKET handler 把 string data 包成 utf-8 payload', async () => {
    registerStorageBucket(
      makeDataBucket({
        exportFn: async () => ({
          filename: 'a.json',
          data: '{"x":1}',
          mimeType: 'application/json',
        }),
      }),
    )
    const ipc = makeFakeIpcMain()
    registerStorageManagerIpc(ipc)
    const handler = ipc.handlers.get(IPC_CHANNELS.EXPORT_BUCKET)!
    const result = (await handler(null, 'test:data')) as IpcResult<{
      filename: string
      data: string
      encoding: string
    }>
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.encoding).toBe('utf-8')
      expect(result.value.data).toBe('{"x":1}')
    }
  })

  it('EXPORT_BUCKET handler 把 Uint8Array data 包成 base64 payload', async () => {
    const raw = new Uint8Array([1, 2, 3, 4])
    registerStorageBucket(
      makeDataBucket({
        exportFn: async () => ({
          filename: 'a.bin',
          data: raw,
          mimeType: 'application/octet-stream',
        }),
      }),
    )
    const ipc = makeFakeIpcMain()
    registerStorageManagerIpc(ipc)
    const handler = ipc.handlers.get(IPC_CHANNELS.EXPORT_BUCKET)!
    const result = (await handler(null, 'test:data')) as IpcResult<{
      filename: string
      data: string
      encoding: string
    }>
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.encoding).toBe('base64')
      expect(Buffer.from(result.value.data, 'base64').equals(Buffer.from(raw))).toBe(
        true,
      )
    }
  })
})

// ── Daemon bridge ──────────────────────────────────────────────

describe('daemon-bridge', () => {
  it('未配置时 listBuckets 返回 []', async () => {
    expect(isDaemonStorageFetcherConfigured()).toBe(false)
    const bridge = createDaemonBridge()
    const buckets = await bridge.listBuckets()
    expect(buckets).toEqual([])
  })

  it('未配置时 clearBucket 抛 NotConfigured', async () => {
    const bridge = createDaemonBridge()
    await expect(bridge.clearBucket('any')).rejects.toThrow(
      DaemonBridgeNotConfiguredError,
    )
  })

  it('注入 fetcher 后调用走真实实现', async () => {
    const fetchListBuckets = vi.fn(async () => [
      {
        id: 'daemon:foo',
        category: 'data' as const,
        group: 'system' as const,
        displayName: 'Daemon foo',
        description: 'x',
        warnings: ['ok'],
        requiresConfirmation: 'hard' as const,
        hideFromList: false,
        capabilities: { canList: false, canClear: true, canExport: false },
      } satisfies BucketDescriptor,
    ])
    setDaemonStorageFetcher({
      listBuckets: fetchListBuckets,
      getBucketSize: async () => ({
        id: 'daemon:foo',
        bytes: 1,
        measuredAt: 0,
      }),
      listBucketItems: async () => ({
        id: 'daemon:foo',
        items: [],
        measuredAt: 0,
      }),
      clearBucket: async () => ({
        id: 'daemon:foo',
        dryRun: false,
        clearedItemCount: 1,
        freedBytes: 1,
      }),
      exportBucket: async () => ({
        id: 'daemon:foo',
        filename: 'x.json',
        data: '{}',
        encoding: 'utf-8',
        mimeType: 'application/json',
      }),
    })
    expect(isDaemonStorageFetcherConfigured()).toBe(true)
    const bridge = createDaemonBridge()
    const buckets = await bridge.listBuckets()
    expect(fetchListBuckets).toHaveBeenCalled()
    expect(buckets[0]?.source).toBe('daemon')
  })

  it('F-1 lazy 解析：先 createDaemonBridge 再 setDaemonStorageFetcher 也能正常工作', async () => {
    // 先建桥（此时 _fetcher 还是 NOT_CONFIGURED）
    const bridge = createDaemonBridge()
    // 早期调用：fetcher 未注入，listBuckets 走 NOT_CONFIGURED 返回 []
    expect(await bridge.listBuckets()).toEqual([])

    // 后续注入真实 fetcher
    const realListBuckets = vi.fn(async () => [
      {
        id: 'daemon:lazy',
        category: 'data' as const,
        group: 'system' as const,
        displayName: 'Lazy daemon bucket',
        description: 'F-1 守护',
        warnings: ['ok'],
        requiresConfirmation: 'hard' as const,
        hideFromList: false,
        capabilities: { canList: false, canClear: false, canExport: false },
      } satisfies BucketDescriptor,
    ])
    setDaemonStorageFetcher({
      listBuckets: realListBuckets,
      getBucketSize: async () => ({
        id: 'daemon:lazy',
        bytes: 42,
        measuredAt: 0,
      }),
      listBucketItems: async () => ({
        id: 'daemon:lazy',
        items: [],
        measuredAt: 0,
      }),
      clearBucket: async () => ({
        id: 'daemon:lazy',
        dryRun: false,
        clearedItemCount: 0,
        freedBytes: 0,
      }),
      exportBucket: async () => ({
        id: 'daemon:lazy',
        filename: 'lazy.json',
        data: '{}',
        encoding: 'utf-8',
        mimeType: 'application/json',
      }),
    })

    // 用同一个 bridge（不要重新 createDaemonBridge）调，应该走真实 fetcher
    const buckets = await bridge.listBuckets()
    expect(realListBuckets).toHaveBeenCalled()
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.id).toBe('daemon:lazy')
    expect(buckets[0]?.source).toBe('daemon')

    const size = await bridge.getBucketSize('daemon:lazy')
    expect(size.bytes).toBe(42)
  })

  it('F-1 显式注入 fetcher 时仍按瞬间快照（覆盖 lazy 行为）', async () => {
    const explicitFetcher = {
      listBuckets: vi.fn(async () => [] as BucketDescriptor[]),
      getBucketSize: async () => ({
        id: 'x',
        bytes: 0,
        measuredAt: 0,
      }),
      listBucketItems: async () => ({ id: 'x', items: [], measuredAt: 0 }),
      clearBucket: async () => ({
        id: 'x',
        dryRun: false,
        clearedItemCount: 0,
        freedBytes: 0,
      }),
      exportBucket: async () => ({
        id: 'x',
        filename: 'x',
        data: '',
        encoding: 'utf-8' as const,
        mimeType: 'text/plain',
      }),
    }
    const bridge = createDaemonBridge(explicitFetcher)
    await bridge.listBuckets()
    expect(explicitFetcher.listBuckets).toHaveBeenCalled()

    // 后续 setDaemonStorageFetcher 不应影响显式注入的桥（按调用方意图）
    const otherListBuckets = vi.fn(async () => [] as BucketDescriptor[])
    setDaemonStorageFetcher({
      listBuckets: otherListBuckets,
      getBucketSize: explicitFetcher.getBucketSize,
      listBucketItems: explicitFetcher.listBucketItems,
      clearBucket: explicitFetcher.clearBucket,
      exportBucket: explicitFetcher.exportBucket,
    })
    await bridge.listBuckets()
    expect(otherListBuckets).not.toHaveBeenCalled()
    expect(explicitFetcher.listBuckets).toHaveBeenCalledTimes(2)
  })
})

// ── Renderer bridge ────────────────────────────────────────────

describe('RendererStorageBridge 聚合', () => {
  function makeFakeInvoker(
    handlers: Map<string, (...args: unknown[]) => unknown>,
  ): IpcRendererInvoker {
    return {
      async invoke(channel, ...args) {
        const h = handlers.get(channel)
        if (!h) throw new Error(`no handler for ${channel}`)
        return h(...args)
      },
    }
  }

  it('listAllBuckets 合并 local + main + daemon', async () => {
    // local
    registerStorageBucket(makeCacheBucket({ id: 'local:cache' }))

    // main bridge：注册一个 fake ipcMain 并把它的 handler 包成 invoker
    // 这里直接 mock 一个 invoker 走 LIST_BUCKETS 等通道
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    handlers.set(IPC_CHANNELS.LIST_BUCKETS, async () => {
      const result: IpcResult<BucketDescriptor[]> = {
        ok: true,
        value: [
          {
            id: 'main:audit',
            category: 'data',
            group: 'system',
            displayName: 'Audit',
            description: 'x',
            warnings: ['x'],
            requiresConfirmation: 'hard',
            hideFromList: false,
            capabilities: { canList: false, canClear: true, canExport: false },
            source: 'main',
          },
        ],
      }
      return result
    })
    const mainBridge = createMainProcessBridge(makeFakeInvoker(handlers))

    // daemon bridge
    setDaemonStorageFetcher({
      listBuckets: async () => [
        {
          id: 'daemon:agent-sync',
          category: 'data',
          group: 'conversation',
          displayName: 'Agent Sync',
          description: 'x',
          warnings: ['x'],
          requiresConfirmation: 'hard',
          hideFromList: false,
          capabilities: { canList: true, canClear: true, canExport: false },
        },
      ],
      getBucketSize: async () => ({ id: '', bytes: 0, measuredAt: 0 }),
      listBucketItems: async () => ({ id: '', items: [], measuredAt: 0 }),
      clearBucket: async () => ({
        id: '',
        dryRun: false,
        clearedItemCount: 0,
        freedBytes: 0,
      }),
      exportBucket: async () => ({
        id: '',
        filename: 'x.json',
        data: '{}',
        encoding: 'utf-8',
        mimeType: 'application/json',
      }),
    })
    const daemonBridge = createDaemonBridge()

    const bridge = new RendererStorageBridge({ mainBridge, daemonBridge })
    const all = await bridge.listAllBuckets()
    expect(all.map((b) => b.id).sort()).toEqual([
      'daemon:agent-sync',
      'local:cache',
      'main:audit',
    ])
    const local = all.find((b) => b.id === 'local:cache')!
    expect(local.source).toBe('renderer')
    const main = all.find((b) => b.id === 'main:audit')!
    expect(main.source).toBe('main')
    const daemon = all.find((b) => b.id === 'daemon:agent-sync')!
    expect(daemon.source).toBe('daemon')
  })

  it('getBucketSize 路由：local 优先', async () => {
    const sizeFn = vi.fn(async () => ({ bytes: 999 }))
    registerStorageBucket(makeCacheBucket({ id: 'local:cache', sizeFn }))
    const bridge = new RendererStorageBridge({})
    const r = await bridge.getBucketSize('local:cache')
    expect(r.bytes).toBe(999)
    expect(sizeFn).toHaveBeenCalled()
  })

  it('getBucketSize 路由：local 没有 → main bridge', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    handlers.set(IPC_CHANNELS.GET_BUCKET_SIZE, async (id) => {
      const result: IpcResult<{
        id: string
        bytes: number
        measuredAt: number
      }> = {
        ok: true,
        value: { id: id as string, bytes: 5555, measuredAt: 1 },
      }
      return result
    })
    const mainBridge = createMainProcessBridge(makeFakeInvoker(handlers))
    const bridge = new RendererStorageBridge({ mainBridge })
    const r = await bridge.getBucketSize('main:foo')
    expect(r.bytes).toBe(5555)
  })

  it('createMainProcessBridge 抛错信封被反序列化为 RemoteStorageManagerError', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    handlers.set(IPC_CHANNELS.GET_BUCKET_SIZE, async () => {
      const result: IpcResult<unknown> = {
        ok: false,
        error: {
          name: 'BucketNotFoundError',
          message: 'not found',
          bucketId: 'x',
        },
      }
      return result
    })
    const mainBridge = createMainProcessBridge(makeFakeInvoker(handlers))
    await expect(mainBridge.getBucketSize('x')).rejects.toMatchObject({
      message: 'not found',
    })
  })

  it('registerLocal 转发到 registry 并可被 listAllBuckets 看到', async () => {
    const bridge = new RendererStorageBridge({})
    const off = bridge.registerLocal(makeCacheBucket({ id: 'rb:cache' }))
    const all = await bridge.listAllBuckets()
    expect(all.map((b) => b.id)).toContain('rb:cache')
    off()
    const all2 = await bridge.listAllBuckets()
    expect(all2.map((b) => b.id)).not.toContain('rb:cache')
  })

  it('listBucketItems / clearBucket / exportBucket 路由：local 优先', async () => {
    const listFn = vi.fn(async () => [{ id: 'a', label: 'A' }])
    const clearFn = vi.fn(async () => ({
      clearedItemCount: 1,
      freedBytes: 100,
    }))
    const exportFn = vi.fn(async () => ({
      filename: 'a.json',
      data: '{"a":1}',
      mimeType: 'application/json',
    }))
    registerStorageBucket(
      makeDataBucket({ id: 'local:full', listFn, clearFn, exportFn }),
    )
    const bridge = new RendererStorageBridge({})

    const items = await bridge.listBucketItems('local:full')
    expect(items.items).toHaveLength(1)

    const cleared = await bridge.clearBucket('local:full', { dryRun: true })
    expect(cleared.dryRun).toBe(true)
    expect(cleared.freedBytes).toBe(100)

    const exported = await bridge.exportBucket('local:full')
    expect(exported.encoding).toBe('utf-8')
    expect(exported.data).toBe('{"a":1}')
  })

  it('exportBucket 路由：local Uint8Array → base64', async () => {
    const raw = new Uint8Array([0xff, 0x00, 0x42])
    registerStorageBucket(
      makeDataBucket({
        id: 'local:bin',
        exportFn: async () => ({
          filename: 'a.bin',
          data: raw,
          mimeType: 'application/octet-stream',
        }),
      }),
    )
    const bridge = new RendererStorageBridge({})
    const r = await bridge.exportBucket('local:bin')
    expect(r.encoding).toBe('base64')
    expect(Buffer.from(r.data, 'base64').equals(Buffer.from(raw))).toBe(true)
  })

  it('exportBucket 路由：local Blob-like (arrayBuffer) → base64', async () => {
    const ab = new Uint8Array([1, 2, 3]).buffer
    registerStorageBucket(
      makeDataBucket({
        id: 'local:blob',
        exportFn: async () => ({
          filename: 'a.bin',
          data: { arrayBuffer: async () => ab } as unknown as Blob,
          mimeType: 'application/octet-stream',
        }),
      }),
    )
    const bridge = new RendererStorageBridge({})
    const r = await bridge.exportBucket('local:blob')
    expect(r.encoding).toBe('base64')
    expect(Buffer.from(r.data, 'base64').equals(Buffer.from([1, 2, 3]))).toBe(
      true,
    )
  })

  it('listBucketItems / clearBucket / exportBucket 路由到 main bridge', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    handlers.set(IPC_CHANNELS.LIST_BUCKET_ITEMS, async (id) => {
      const r: IpcResult<{
        id: string
        items: Array<{ id: string; label: string }>
        measuredAt: number
      }> = {
        ok: true,
        value: {
          id: id as string,
          items: [{ id: 'm', label: 'main item' }],
          measuredAt: 0,
        },
      }
      return r
    })
    handlers.set(IPC_CHANNELS.CLEAR_BUCKET, async (id) => {
      const r: IpcResult<{
        id: string
        dryRun: boolean
        clearedItemCount: number
        freedBytes: number
      }> = {
        ok: true,
        value: {
          id: id as string,
          dryRun: false,
          clearedItemCount: 9,
          freedBytes: 99,
        },
      }
      return r
    })
    handlers.set(IPC_CHANNELS.EXPORT_BUCKET, async (id) => {
      const r: IpcResult<{
        id: string
        filename: string
        data: string
        encoding: 'utf-8' | 'base64'
        mimeType: string
      }> = {
        ok: true,
        value: {
          id: id as string,
          filename: 'm.json',
          data: '{}',
          encoding: 'utf-8',
          mimeType: 'application/json',
        },
      }
      return r
    })
    const mainBridge = createMainProcessBridge(makeFakeInvoker(handlers))
    const bridge = new RendererStorageBridge({ mainBridge })

    expect((await bridge.listBucketItems('main:foo')).items).toHaveLength(1)
    expect((await bridge.clearBucket('main:foo')).clearedItemCount).toBe(9)
    expect((await bridge.exportBucket('main:foo')).filename).toBe('m.json')
  })

  it('未注册任何 bridge 时调用未知 id 抛错', async () => {
    const bridge = new RendererStorageBridge({})
    await expect(bridge.getBucketSize('nope')).rejects.toThrow(
      /找不到/,
    )
  })
})

// ── 集成 demo：完整调用链 ──────────────────────────────────────

describe('集成 demo: register → list → size → clear → export', () => {
  it('完整链路', async () => {
    // 1. 业务模块注册 bucket
    const clearFn = vi.fn(async (opts?: { itemIds?: string[]; dryRun?: boolean }) => ({
      clearedItemCount: opts?.itemIds?.length ?? 5,
      freedBytes: opts?.dryRun ? 0 : 1024 * 1024,
    }))
    const exportFn = vi.fn(async () => ({
      filename: 'voice-hotwords.json',
      data: JSON.stringify({ hotwords: ['TabTin', 'Agent'] }),
      mimeType: 'application/json',
    }))
    registerStorageBucket({
      id: 'voice:hotwords',
      category: 'data',
      group: 'business-app',
      displayName: 'Voice 热词',
      description: '语音识别的自定义热词与替换规则',
      warnings: ['热词清空后语音识别可能误识专有词'],
      sizeFn: async () => ({ bytes: 4096, itemCount: 12 }),
      listFn: async () => [
        { id: 'h1', label: 'TabTin', bytes: 32 },
        { id: 'h2', label: 'Agent', bytes: 32 },
      ],
      clearFn,
      exportFn,
    })

    // 2. UI 列出
    const list = listBuckets({ category: 'data' })
    expect(list.map((b) => b.id)).toEqual(['voice:hotwords'])
    expect(list[0]?.requiresConfirmation).toBe('hard')

    // 3. UI 探测容量
    const size = await getBucketSize('voice:hotwords')
    expect(size).toEqual({ bytes: 4096, itemCount: 12 })

    // 4. UI 部分清理 dryRun
    const dry = await clearBucket('voice:hotwords', {
      itemIds: ['h1'],
      dryRun: true,
    })
    expect(dry.freedBytes).toBe(0)
    expect(clearFn).toHaveBeenCalledWith({ itemIds: ['h1'], dryRun: true })

    // 5. UI 实清
    const real = await clearBucket('voice:hotwords', { itemIds: ['h1'] })
    expect(real.freedBytes).toBe(1024 * 1024)

    // 6. UI 导出
    const exported = await exportBucket('voice:hotwords')
    expect(exported.filename).toBe('voice-hotwords.json')
    const parsed = JSON.parse(exported.data as string)
    expect(parsed.hotwords).toContain('TabTin')

    // 7. Descriptor 形态正确
    const desc = bucketToDescriptor(getBucket('voice:hotwords')!)
    expect(desc.capabilities).toEqual({
      canList: true,
      canClear: true,
      canExport: true,
    })
  })
})
