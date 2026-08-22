/**
 * BrowserStorageBucketRegistration · W2.2 G3 守护测试
 *
 * 守住的核心约束：
 *   1. registerBrowserStorageBuckets() 注册出 5 个 main-process 侧 bucket：
 *        - browser:env-partitions          (browser / data / hard)
 *        - browser:task-partitions         (browser / data / hard)
 *        - browser:upgrade-partitions      (browser / cache / none)
 *        - browser:legacy-crawlspace-partitions (browser / semi-cache / soft)
 *        - browser:http-cache-aggregate    (cache / cache / none)
 *   2. userData/Partitions/ 不存在时 sizeFn / listFn 返回空，不抛错
 *   3. partition safe-name 反向解码正确：`_3a` → `:`
 *   4. 幂等：连续两次调用不抛错
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// ── mocks ────────────────────────────────────────────────────────

const fakeUserData = path.join(os.tmpdir(), `tabtin-bucket-test-${Date.now()}`)

vi.mock('electron', () => {
  const api = {
    session: {
      fromPartition: vi.fn(() => ({
        clearStorageData: vi.fn(async () => undefined),
        clearCache: vi.fn(async () => undefined),
      })),
      defaultSession: {
        clearCache: vi.fn(async () => undefined),
      },
    },
  }
  return api
})

vi.mock('@tabtin/shared/storage-paths', () => ({
  getUserDataPath: (...segs: string[]) => path.join(fakeUserData, ...segs),
}))

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}))

describe('BrowserStorageBucketRegistration', () => {
  beforeEach(async () => {
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
    const mod = await import('../BrowserStorageBucketRegistration')
    mod.unregisterBrowserStorageBuckets()
  })

  afterEach(() => {
    try {
      fs.rmSync(fakeUserData, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('一次性注册 5 个 main-process bucket；字段符合 RFC §五 W2.2 G3', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerBrowserStorageBuckets } = await import(
      '../BrowserStorageBucketRegistration'
    )

    registerBrowserStorageBuckets()

    const browser = sm.listBuckets({ group: 'browser' })
    const cache = sm.listBuckets({ group: 'cache' })

    expect(browser.map((b) => b.id).sort()).toEqual([
      'browser:env-partitions',
      'browser:legacy-crawlspace-partitions',
      'browser:task-partitions',
      'browser:upgrade-partitions',
    ])
    expect(cache.map((b) => b.id)).toContain('browser:http-cache-aggregate')

    const env = sm.getBucket('browser:env-partitions')!
    expect(env.category).toBe('data')
    expect(env.requiresConfirmation).toBe('hard')
    expect(env.warnings?.length ?? 0).toBeGreaterThan(0)

    const upgrade = sm.getBucket('browser:upgrade-partitions')!
    expect(upgrade.category).toBe('cache')
    expect(upgrade.requiresConfirmation).toBe('none')

    const legacy = sm.getBucket('browser:legacy-crawlspace-partitions')!
    expect(legacy.category).toBe('semi-cache')
    expect(legacy.requiresConfirmation).toBe('soft')

    const task = sm.getBucket('browser:task-partitions')!
    expect(task.category).toBe('data')
    expect(task.requiresConfirmation).toBe('hard')

    const http = sm.getBucket('browser:http-cache-aggregate')!
    expect(http.category).toBe('cache')
    expect(http.group).toBe('cache')
  })

  it('Partitions/ 不存在时 sizeFn / listFn 返回 0 / []，不抛错', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerBrowserStorageBuckets } = await import(
      '../BrowserStorageBucketRegistration'
    )

    registerBrowserStorageBuckets()

    for (const id of [
      'browser:env-partitions',
      'browser:task-partitions',
      'browser:upgrade-partitions',
      'browser:legacy-crawlspace-partitions',
    ]) {
      const b = sm.getBucket(id)!
      const size = await b.sizeFn()
      expect(size.bytes).toBe(0)
      expect(size.itemCount).toBe(0)
      const list = await b.listFn!()
      expect(list).toEqual([])
    }
  })

  it('safeToPartition 把 _3a 反解回 :', async () => {
    const { __internals } = await import(
      '../BrowserStorageBucketRegistration'
    )
    expect(__internals.safeToPartition('persist_3atabtin_3aenv_3adefault')).toBe(
      'persist:tabtin:env:default',
    )
    expect(__internals.safeToPartition('tabtin_3aupgrade_3a1234')).toBe(
      'tabtin:upgrade:1234',
    )
    expect(__internals.safeToPartition('task-xyz')).toBe('task-xyz')
  })

  it('扫描 userData/Partitions/ 能找到仿造的 task / upgrade / legacy 目录', async () => {
    // 造 4 个目录：env / task / upgrade / crawlspace 各一个
    fs.mkdirSync(path.join(fakeUserData, 'Partitions'), { recursive: true })
    const partitions = [
      'persist_3atabtin_3aenv_3adefault',
      'persist_3atask-abc',
      'tabtin_3aupgrade_3a123',
      'tabtin_3acrawlspace_3aold',
    ]
    for (const p of partitions) {
      const full = path.join(fakeUserData, 'Partitions', p)
      fs.mkdirSync(full, { recursive: true })
      // 加一个小文件让 du > 0
      fs.writeFileSync(path.join(full, 'dummy.txt'), 'x'.repeat(16))
    }

    const sm = await import('@tabtin/storage-manager')
    const { registerBrowserStorageBuckets } = await import(
      '../BrowserStorageBucketRegistration'
    )
    registerBrowserStorageBuckets()

    const env = await sm.getBucket('browser:env-partitions')!.sizeFn()
    expect(env.itemCount).toBe(1)

    const task = await sm.getBucket('browser:task-partitions')!.sizeFn()
    expect(task.itemCount).toBe(1)

    const upgrade = await sm.getBucket('browser:upgrade-partitions')!.sizeFn()
    expect(upgrade.itemCount).toBe(1)

    const legacy = await sm
      .getBucket('browser:legacy-crawlspace-partitions')!
      .sizeFn()
    expect(legacy.itemCount).toBe(1)
  })

  it('幂等：连续调用 registerBrowserStorageBuckets 不抛错', async () => {
    const { registerBrowserStorageBuckets } = await import(
      '../BrowserStorageBucketRegistration'
    )
    expect(() => registerBrowserStorageBuckets()).not.toThrow()
    expect(() => registerBrowserStorageBuckets()).not.toThrow()
  })

  it('env-partitions.clearFn 调 session.fromPartition(...).clearStorageData，不 rm 目录', async () => {
    fs.mkdirSync(path.join(fakeUserData, 'Partitions'), { recursive: true })
    const envSafeName = 'persist_3atabtin_3aenv_3adefault'
    const envPath = path.join(fakeUserData, 'Partitions', envSafeName)
    fs.mkdirSync(envPath, { recursive: true })
    fs.writeFileSync(path.join(envPath, 'Cookies'), 'x'.repeat(100))

    const electronMock = await import('electron')
    const clearStorageDataFn = vi.fn(async () => undefined)
    ;(electronMock.session.fromPartition as any).mockImplementation(() => ({
      clearStorageData: clearStorageDataFn,
      clearCache: vi.fn(async () => undefined),
    }))

    const sm = await import('@tabtin/storage-manager')
    const { registerBrowserStorageBuckets } = await import(
      '../BrowserStorageBucketRegistration'
    )
    registerBrowserStorageBuckets()

    const env = sm.getBucket('browser:env-partitions')!
    const r = await env.clearFn!()
    expect(r.clearedItemCount).toBe(1)
    // env.clearFn 走 clearStorageData，不删目录
    expect(clearStorageDataFn).toHaveBeenCalled()
    const callArg = clearStorageDataFn.mock.calls[0]?.[0] as any
    expect(Array.isArray(callArg?.storages)).toBe(true)
    expect(callArg.storages).toContain('cookies')
    expect(callArg.storages).toContain('localstorage')
    // 目录没被删
    expect(fs.existsSync(envPath)).toBe(true)
  })

  it('task / upgrade / legacy-crawlspace 的 clearFn rm 整个目录', async () => {
    fs.mkdirSync(path.join(fakeUserData, 'Partitions'), { recursive: true })
    const taskSafe = 'persist_3atask-abc'
    const upgradeSafe = 'tabtin_3aupgrade_3a123'
    const legacySafe = 'tabtin_3acrawlspace_3aold'
    const taskPath = path.join(fakeUserData, 'Partitions', taskSafe)
    const upgradePath = path.join(fakeUserData, 'Partitions', upgradeSafe)
    const legacyPath = path.join(fakeUserData, 'Partitions', legacySafe)
    for (const p of [taskPath, upgradePath, legacyPath]) {
      fs.mkdirSync(p, { recursive: true })
      fs.writeFileSync(path.join(p, 'dummy.txt'), 'y'.repeat(32))
    }

    const sm = await import('@tabtin/storage-manager')
    const { registerBrowserStorageBuckets } = await import(
      '../BrowserStorageBucketRegistration'
    )
    registerBrowserStorageBuckets()

    const task = sm.getBucket('browser:task-partitions')!
    const upgrade = sm.getBucket('browser:upgrade-partitions')!
    const legacy = sm.getBucket('browser:legacy-crawlspace-partitions')!

    await task.clearFn!()
    await upgrade.clearFn!()
    await legacy.clearFn!()

    expect(fs.existsSync(taskPath)).toBe(false)
    expect(fs.existsSync(upgradePath)).toBe(false)
    expect(fs.existsSync(legacyPath)).toBe(false)
  })

  it('http-cache-aggregate 只聚合 env / persist-tin，不碰默认 session 主窗口 cache', async () => {
    // env partition 有 Cache 子目录
    const envSafe = 'persist_3atabtin_3aenv_3adefault'
    const envPath = path.join(fakeUserData, 'Partitions', envSafe)
    fs.mkdirSync(path.join(envPath, 'Cache'), { recursive: true })
    fs.writeFileSync(path.join(envPath, 'Cache', 'a.bin'), 'z'.repeat(500))

    // task partition 也有 Cache 子目录——但 task 归 task-partitions 桶清，
    // **不应**被 http-cache-aggregate 算入
    const taskSafe = 'persist_3atask-zzz'
    const taskPath = path.join(fakeUserData, 'Partitions', taskSafe)
    fs.mkdirSync(path.join(taskPath, 'Cache'), { recursive: true })
    fs.writeFileSync(path.join(taskPath, 'Cache', 'b.bin'), 'z'.repeat(9999))

    const sm = await import('@tabtin/storage-manager')
    const { registerBrowserStorageBuckets } = await import(
      '../BrowserStorageBucketRegistration'
    )
    registerBrowserStorageBuckets()

    const http = sm.getBucket('browser:http-cache-aggregate')!
    const list = await http.listFn!()
    // 应该只看到 env 的 partition，不看到 task / upgrade / legacy
    const ids = list.map((i) => i.id)
    expect(ids).toContain(envSafe)
    expect(ids).not.toContain(taskSafe)
  })

  it('env-partitions sizeFn 不双计 Cache 子目录（HTTP cache 归 aggregate）', async () => {
    const envSafe = 'persist_3atabtin_3aenv_3adefault'
    const envPath = path.join(fakeUserData, 'Partitions', envSafe)
    fs.mkdirSync(envPath, { recursive: true })
    // data 部分
    fs.writeFileSync(path.join(envPath, 'Cookies'), 'x'.repeat(200))
    // cache 部分（应被 env sizeFn 排除）
    fs.mkdirSync(path.join(envPath, 'Cache'), { recursive: true })
    fs.writeFileSync(path.join(envPath, 'Cache', 'a.bin'), 'y'.repeat(10_000))

    const sm = await import('@tabtin/storage-manager')
    const { registerBrowserStorageBuckets } = await import(
      '../BrowserStorageBucketRegistration'
    )
    registerBrowserStorageBuckets()

    const env = await sm.getBucket('browser:env-partitions')!.sizeFn()
    // env 容量只应反映 Cookies（200 B），不含 Cache（10000 B）
    expect(env.bytes).toBeLessThan(5000)
    expect(env.bytes).toBeGreaterThanOrEqual(200)

    const http = await sm.getBucket('browser:http-cache-aggregate')!.sizeFn()
    expect(http.bytes).toBeGreaterThanOrEqual(10_000)
  })
})
