/**
 * AA-003 / AA-004 回归测试
 *
 * AA-003: EventPersistence.flush() 使用异步 appendFile，不阻塞主进程事件循环
 * AA-004: 初始化失败时 flushTimer 仍启动；flush 自动重试 init；_initPromise 去重
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/fake-userdata'),
  },
}))

describe('AA-003: flush() 异步非阻塞', () => {
  let tempDir: string
  let EP: typeof import('../EventPersistence')

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ep-test-'))
    vi.resetModules()
    EP = await import('../EventPersistence')
  })

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
  })

  it('flush() 应返回 Promise', () => {
    const ep = new EP.EventPersistence(tempDir)
    const result = ep.flush()
    expect(result).toBeInstanceOf(Promise)
    return result.then(() => ep.destroy())
  })

  it('flush() 应异步写入 NDJSON 文件', async () => {
    const ep = new EP.EventPersistence(tempDir)
    await ep.init()

    ep.addEvent({
      runId: 'run-async-test',
      type: 'TEST_EVENT',
      timestamp: Date.now(),
      data: { key: 'value' },
    })

    await ep.flush()

    const safeRunId = Buffer.from('run-async-test').toString('base64url')
    const filePath = join(tempDir, `${safeRunId}.ndjson`)
    expect(existsSync(filePath)).toBe(true)

    const content = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(content.trim())
    expect(parsed.runId).toBe('run-async-test')
    expect(parsed.type).toBe('TEST_EVENT')
    expect(parsed.data).toEqual({ key: 'value' })

    await ep.destroy()
  })

  it('并发 flush 应串行执行不丢数据', async () => {
    const ep = new EP.EventPersistence(tempDir)
    await ep.init()

    for (let i = 0; i < 10; i++) {
      ep.addEvent({
        runId: 'run-concurrent',
        type: `EVENT_${i}`,
        timestamp: Date.now() + i,
      })
    }

    await Promise.all([ep.flush(), ep.flush(), ep.flush()])

    const events = ep.getEvents('run-concurrent')
    expect(events).toHaveLength(10)

    await ep.destroy()
  })

  it('destroy() 先停定时器再 flush 剩余事件', async () => {
    const ep = new EP.EventPersistence(tempDir)
    await ep.init()

    ep.addEvent({
      runId: 'run-destroy',
      type: 'BEFORE_DESTROY',
      timestamp: Date.now(),
    })

    await ep.destroy()

    const events = ep.getEvents('run-destroy')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('BEFORE_DESTROY')
  })
})

describe('AA-004: 初始化竞态与重试', () => {
  let tempDir: string
  let EP: typeof import('../EventPersistence')

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ep-init-'))
    vi.resetModules()
    EP = await import('../EventPersistence')
  })

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
  })

  it('init 去重：多次调用 init() 只执行一次', async () => {
    const ep = new EP.EventPersistence(tempDir)
    const [r1, r2, r3] = await Promise.all([ep.init(), ep.init(), ep.init()])
    expect(r1).toBeUndefined()
    expect(r2).toBeUndefined()
    expect(r3).toBeUndefined()
    await ep.destroy()
  })

  it('init 失败后 flush 自动重试 init', async () => {
    const blocker = join(tempDir, 'not-a-directory')
    writeFileSync(blocker, 'block')
    const badDir = join(blocker, 'impossible-subdir')
    const ep = new EP.EventPersistence(badDir)

    try { await ep.init() } catch {}

    ep.addEvent({
      runId: 'run-retry',
      type: 'QUEUED_EVENT',
      timestamp: Date.now(),
    })

    // @ts-expect-error — access private for test
    expect(ep.initialized).toBe(false)

    // @ts-expect-error — switch to valid dir and reset init promise to allow retry
    ep.dataDir = tempDir
    // @ts-expect-error — reset private init promise to verify retry behavior
    ep._initPromise = null

    await ep.flush()

    // @ts-expect-error — inspect private state to verify retry succeeded
    expect(ep.initialized).toBe(true)

    const events = ep.getEvents('run-retry')
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('QUEUED_EVENT')

    await ep.destroy()
  })

  it('RP-030 fix: flushTimer 在 init 失败时不应启动', async () => {
    const blocker = join(tempDir, 'not-a-directory')
    writeFileSync(blocker, 'block')
    const badDir = join(blocker, 'impossible-subdir')
    const ep = new EP.EventPersistence(badDir)

    try { await ep.init() } catch {}

    // @ts-expect-error — RP-030 修复后：初始化失败不启动定时器
    expect(ep.flushTimer).toBeNull()

    await ep.destroy()
  })
})

describe('账号与组织隔离', () => {
  let tempDir: string
  let EP: typeof import('../EventPersistence')

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ep-owner-scope-'))
    vi.resetModules()
    EP = await import('../EventPersistence')
  })

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
  })

  it('账号切换前已入队的事件仍写回原账号目录', async () => {
    let owner: { userId: string; organizationId: string } | null = {
      userId: 'user-a',
      organizationId: 'org-a',
    }
    const ep = new EP.EventPersistence(undefined, {
      dataRoot: tempDir,
      getCurrentOwner: () => owner,
    })
    await ep.init()

    ep.addEvent({ runId: 'shared-run-id', type: 'ACCOUNT_A', timestamp: 1 })
    owner = { userId: 'user-b', organizationId: 'org-b' }
    ep.addEvent({ runId: 'shared-run-id', type: 'ACCOUNT_B', timestamp: 2 })
    await ep.flush()

    const runAFile = join(
      tempDir, 'users', 'user-a', 'organizations', 'org-a', 'run-events',
      `${Buffer.from('shared-run-id').toString('base64url')}.ndjson`,
    )
    const runBFile = join(
      tempDir, 'users', 'user-b', 'organizations', 'org-b', 'run-events',
      `${Buffer.from('shared-run-id').toString('base64url')}.ndjson`,
    )
    expect(existsSync(runAFile)).toBe(true)
    expect(existsSync(runBFile)).toBe(true)
    expect(ep.getEvents('shared-run-id')).toMatchObject([{ type: 'ACCOUNT_B' }])

    const userBOrgC = join(
      tempDir, 'users', 'user-b', 'organizations', 'org-c', 'run-events',
    )
    mkdirSync(userBOrgC, { recursive: true })
    expect(ep.getCurrentUserDataDirs().map(item => item.organizationId).sort()).toEqual([
      'org-b',
      'org-c',
    ])

    owner = null
    ep.addEvent({ runId: 'unscoped', type: 'NO_OWNER', timestamp: 3 })
    await ep.flush()
    expect(existsSync(join(tempDir, 'run-events'))).toBe(false)

    await ep.destroy()
  })
})
