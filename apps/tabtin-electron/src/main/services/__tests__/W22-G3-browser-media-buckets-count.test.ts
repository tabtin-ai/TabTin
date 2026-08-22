/**
 * W2.2 G3 北极星验收：`listBuckets({ group })` 聚合数量符合 RFC §五 W2.2 G3。
 *
 * 15 个 bucket（main 7 + renderer 3 + 5 个已经在其他组注册的不算，本测试只
 * 管 G3 新加的）：
 *   browser 组（7 个）：
 *     1. browser:env-partitions
 *     2. browser:task-partitions
 *     3. browser:upgrade-partitions
 *     4. browser:legacy-crawlspace-partitions
 *     5. browser:bookmarks
 *     6. browser:browsing-history
 *     （http-cache-aggregate 归 cache 组，共用）
 *   media 组（5 个）：
 *     1. media:recordings
 *     2. media:screenshots
 *     3. media:exports-pdf
 *     4. download:user-downloads
 *     5. download:agent-sandbox-downloads
 *   cache 组（3 个）：
 *     1. browser:http-cache-aggregate
 *     2. media:tabvideo-render-tmp
 *     3. media:stream-download-tmp
 *   system 组（1 个）：
 *     1. oss:pending-confirms
 *
 * 本测试覆盖 main 进程 7 个 bucket（不含 renderer 3 个，也不含 browser:bookmarks /
 * browser:browsing-history / oss:pending-confirms——这些在 renderer 进程 singleton
 * 上注册，jsdom 环境下由另一个测试验证）。
 *
 * 北极星 A（RFC §三 Wave 2 北极星 A）在部署后通过真实启动的 Electron main 进程
 * 跑 `storageManager.listBuckets()` 验证总数 ≥ 30。此测试锁定 G3 增量贡献。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'

const fakeUserData = path.join(os.tmpdir(), `tabtin-w22g3-count-${Date.now()}`)
const fakeSandboxRoot = path.join(os.tmpdir(), `tabtin-w22g3-sandbox-${Date.now()}`)

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
  session: {
    fromPartition: vi.fn(() => ({
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
    })),
    defaultSession: { clearCache: vi.fn(async () => undefined) },
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

vi.mock('../ConfigService', () => ({
  configService: {
    get: () => ({}),
    set: () => undefined,
    clearByKey: () => undefined,
  },
}))

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}))

describe('W2.2 G3 北极星：main 进程 7 个 bucket 聚合', () => {
  beforeEach(async () => {
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
    const b = await import('../BrowserStorageBucketRegistration')
    const m = await import('../MediaStorageBucketRegistration')
    b.unregisterBrowserStorageBuckets()
    m.unregisterMediaStorageBuckets()
  })

  it('registerBrowserStorageBuckets + registerMediaStorageBuckets 共产 12 个 bucket', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerBrowserStorageBuckets } = await import(
      '../BrowserStorageBucketRegistration'
    )
    const { registerMediaStorageBuckets } = await import(
      '../MediaStorageBucketRegistration'
    )

    registerBrowserStorageBuckets()
    registerMediaStorageBuckets()

    // browser 组：4 个 partition + bookmarks/browsing-history 由 renderer 注册 → main 这里有 4 个
    const browser = sm.listBuckets({ group: 'browser' })
    expect(browser.map((b) => b.id).sort()).toEqual([
      'browser:env-partitions',
      'browser:legacy-crawlspace-partitions',
      'browser:task-partitions',
      'browser:upgrade-partitions',
    ])

    // media 组：5 个
    const media = sm.listBuckets({ group: 'media' })
    expect(media.map((b) => b.id).sort()).toEqual([
      'download:agent-sandbox-downloads',
      'download:user-downloads',
      'media:exports-pdf',
      'media:recordings',
      'media:screenshots',
    ])

    // cache 组：3 个（browser:http-cache-aggregate + media:tabvideo-render-tmp + media:stream-download-tmp）
    const cache = sm.listBuckets({ group: 'cache' })
    expect(cache.map((b) => b.id).sort()).toEqual([
      'browser:http-cache-aggregate',
      'media:stream-download-tmp',
      'media:tabvideo-render-tmp',
    ])
  })

  it('所有 data 类 bucket 的 warnings 都非空（assertValidBucket 强约束）', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerBrowserStorageBuckets } = await import(
      '../BrowserStorageBucketRegistration'
    )
    const { registerMediaStorageBuckets } = await import(
      '../MediaStorageBucketRegistration'
    )
    registerBrowserStorageBuckets()
    registerMediaStorageBuckets()

    const all = sm.listBuckets()
    for (const b of all) {
      if (b.category === 'data') {
        expect(Array.isArray(b.warnings)).toBe(true)
        expect(b.warnings!.length).toBeGreaterThan(0)
      }
    }
  })
})
