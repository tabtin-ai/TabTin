/**
 * MediaStorageBucketRegistration · W2.2 G3 守护测试
 *
 * 守住的核心约束：
 *   1. registerMediaStorageBuckets() 注册出 7 个 main-process 侧 bucket：
 *        - media:tabvideo-render-tmp    (cache / cache / none)
 *        - media:stream-download-tmp    (cache / cache / none)
 *        - media:recordings             (media / data / soft)
 *        - media:screenshots            (media / data / soft)
 *        - media:exports-pdf            (media / data / soft)
 *        - download:user-downloads      (media / data / soft)
 *        - download:agent-sandbox-downloads (media / data / soft)
 *   2. download:user-downloads 的 clearFn 只改 ConfigService 的 download.history，
 *      绝对不 rm 磁盘文件（关键产品约束）
 *   3. 各 data 桶的 warnings 非空（assertValidBucket 强制）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'

// ── mocks ────────────────────────────────────────────────────────

const fakeUserData = path.join(os.tmpdir(), `tabtin-media-bucket-test-${Date.now()}`)
const fakeSandboxRoot = path.join(os.tmpdir(), `tabtin-media-sandbox-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return fakeUserData
      if (key === 'temp') return os.tmpdir()
      if (key === 'home') return os.homedir()
      if (key === 'downloads') return path.join(os.homedir(), 'Downloads')
      throw new Error(`unmocked getPath(${key})`)
    },
  },
}))

vi.mock('@tabtin/shared/storage-paths', () => ({
  getHomeTabtinPath: (...segs: string[]) =>
    path.join(fakeUserData, '__tabtin_home__', ...segs),
  getUserDataPath: (...segs: string[]) => path.join(fakeUserData, ...segs),
}))

vi.mock('@tabtin/terminal-core', () => ({
  resolveSpacesRoot: () => fakeSandboxRoot,
}))

//  批次 13：space 路径 helper 出口从 engine barrel 收敛到包入口。
vi.mock('@tabtin/agent-runtime', () => ({
  resolveSpacesRoot: (root: string) => path.join(root, 'agent-spaces'),
  resolveSpaceDownloadsDir: (root: string, spaceId: string) =>
    path.join(root, 'agent-spaces', spaceId, 'downloads'),
}))

// ConfigService 只 mock 两个方法，存 history 用本地 Map
const _mockHistoryStore = new Map<string, Record<string, unknown>>()
vi.mock('../ConfigService', () => ({
  configService: {
    get: (key: string) => _mockHistoryStore.get(key),
    set: (key: string, value: Record<string, unknown>) => {
      _mockHistoryStore.set(key, value)
    },
    clearByKey: (key: string) => {
      _mockHistoryStore.delete(key)
    },
  },
}))

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}))

describe('MediaStorageBucketRegistration', () => {
  beforeEach(async () => {
    _mockHistoryStore.clear()
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
    const mod = await import('../MediaStorageBucketRegistration')
    mod.unregisterMediaStorageBuckets()
  })

  it('一次性注册 7 个 main-process bucket；media 组 ≥ 5, cache 组 ≥ 2', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerMediaStorageBuckets } = await import(
      '../MediaStorageBucketRegistration'
    )

    registerMediaStorageBuckets()

    const media = sm.listBuckets({ group: 'media' })
    const cache = sm.listBuckets({ group: 'cache' })

    const mediaIds = media.map((b) => b.id).sort()
    expect(mediaIds).toEqual([
      'download:agent-sandbox-downloads',
      'download:user-downloads',
      'media:exports-pdf',
      'media:recordings',
      'media:screenshots',
    ])

    const cacheIds = cache.map((b) => b.id).sort()
    expect(cacheIds).toContain('media:tabvideo-render-tmp')
    expect(cacheIds).toContain('media:stream-download-tmp')
  })

  it('各 data 类 bucket（recordings / screenshots / exports-pdf / user-downloads / agent-sandbox-downloads）warnings 非空', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerMediaStorageBuckets } = await import(
      '../MediaStorageBucketRegistration'
    )
    registerMediaStorageBuckets()
    for (const id of [
      'media:recordings',
      'media:screenshots',
      'media:exports-pdf',
      'download:user-downloads',
      'download:agent-sandbox-downloads',
    ]) {
      const b = sm.getBucket(id)!
      expect(b.category).toBe('data')
      expect(b.requiresConfirmation).toBe('soft')
      expect(Array.isArray(b.warnings)).toBe(true)
      expect(b.warnings!.length).toBeGreaterThan(0)
    }
  })

  it('download:user-downloads 的 clearFn 只删 history 不删磁盘文件', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerMediaStorageBuckets } = await import(
      '../MediaStorageBucketRegistration'
    )
    registerMediaStorageBuckets()

    const bucket = sm.getBucket('download:user-downloads')!

    // 预置一些 history 记录
    _mockHistoryStore.set('download.history', {
      a: { id: 'a', name: 'a.mp4', savePath: '/nonexistent/a.mp4', status: 'completed' },
      b: { id: 'b', name: 'b.pdf', savePath: '/nonexistent/b.pdf', status: 'completed' },
    })

    const size = await bucket.sizeFn()
    expect(size.itemCount).toBe(2)
    // sizeFn 只算 history 条目自身容量（约 600 B × N），不累加磁盘文件
    expect(size.bytes).toBeGreaterThan(0)
    expect(size.bytes).toBeLessThan(10_000) // 远小于典型视频文件

    const list = await bucket.listFn!()
    expect(list).toHaveLength(2)
    // list 的 bytes 也是"每条 history 的占用"，不是磁盘文件大小
    for (const item of list) {
      expect(item.bytes).toBeLessThan(2000)
      // metadata 里给 UI 展示"磁盘文件大小"作为独立信息
      expect(item.metadata).toHaveProperty('actualFileBytes')
      expect(item.metadata).toHaveProperty('fileExists')
    }

    // 全清
    const all = await bucket.clearFn!()
    expect(all.clearedItemCount).toBe(2)
    expect(all.freedBytes).toBeGreaterThan(0)
    expect(_mockHistoryStore.has('download.history')).toBe(false)

    // 再清空状态下 size = 0
    const size2 = await bucket.sizeFn()
    expect(size2.itemCount).toBe(0)
  })

  it('download:user-downloads 部分清理（itemIds）只删指定 id，其余保留', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerMediaStorageBuckets } = await import(
      '../MediaStorageBucketRegistration'
    )
    registerMediaStorageBuckets()
    const bucket = sm.getBucket('download:user-downloads')!

    _mockHistoryStore.set('download.history', {
      a: { id: 'a', name: 'a.mp4', savePath: '/x/a.mp4', status: 'completed' },
      b: { id: 'b', name: 'b.pdf', savePath: '/x/b.pdf', status: 'completed' },
      c: { id: 'c', name: 'c.png', savePath: '/x/c.png', status: 'completed' },
    })

    const result = await bucket.clearFn!({ itemIds: ['a', 'c'] })
    expect(result.clearedItemCount).toBe(2)
    expect(result.freedBytes).toBeGreaterThan(0)
    const remaining = _mockHistoryStore.get('download.history') as Record<
      string,
      unknown
    >
    expect(Object.keys(remaining).sort()).toEqual(['b'])
  })

  it('classifyDownloadSource 能把 TabTin 子目录 / 系统下载 / 未知路径区分开', async () => {
    const { __internals } = await import('../MediaStorageBucketRegistration')
    const downloads = path.join(os.homedir(), 'Downloads')

    expect(
      __internals.classifyDownloadSource(path.join(downloads, 'TabTin', 'a.mp4')),
    ).toBe('tabtin-sub')
    expect(__internals.classifyDownloadSource(path.join(downloads, 'a.pdf'))).toBe(
      'system',
    )
    expect(__internals.classifyDownloadSource('/some/random/path')).toBe('unknown')
    expect(__internals.classifyDownloadSource(undefined)).toBe('unknown')
  })
})
