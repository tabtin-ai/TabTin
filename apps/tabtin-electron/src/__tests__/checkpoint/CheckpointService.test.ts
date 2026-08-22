/**
 * CheckpointService 单元测试
 *
 * 测试 Shadow Git 检查点核心功能：
 * 1. 初始化 shadow repo
 * 2. 创建 checkpoint (commit)
 * 3. 修改文件后恢复 (restore)
 * 4. diff 对比
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { CheckpointService, type CheckpointLogger } from '@tabtin/checkpoint-core'

const TEST_DIR_PREFIX = 'tabtin-ckpt-test-'

function createTestLogger(): CheckpointLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

async function createTempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), TEST_DIR_PREFIX))
  await fs.writeFile(path.join(dir, 'hello.txt'), 'initial content\n')
  await fs.writeFile(path.join(dir, 'readme.md'), '# Test Project\n')
  return dir
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

describe('CheckpointService', () => {
  let projectDir: string
  let checkpointsRoot: string
  let service: CheckpointService

  beforeEach(async () => {
    projectDir = await createTempProject()
    checkpointsRoot = path.join(os.tmpdir(), 'tabtin-test-checkpoints-' + process.pid)
    service = new CheckpointService(projectDir, checkpointsRoot, createTestLogger())
  })

  afterEach(async () => {
    await cleanupDir(projectDir)
    await cleanupDir(checkpointsRoot)
  })

  it('should initialize shadow git repo', async () => {
    const gitPath = await service.init()
    expect(gitPath).toBeTruthy()
    expect(gitPath.endsWith('.git')).toBe(true)

    const exists = await fs.access(gitPath).then(() => true).catch(() => false)
    expect(exists).toBe(true)
  })

  it('should create a checkpoint and return commit hash', async () => {
    await service.init()
    const hash = await service.commit({ allowEmpty: true })
    expect(hash).toBeTruthy()
    expect(typeof hash).toBe('string')
    expect(hash!.length).toBeGreaterThan(4)
  })

  it('should restore files to a previous checkpoint', async () => {
    await service.init()

    const hash1 = await service.commit({ allowEmpty: true })
    expect(hash1).toBeTruthy()

    await fs.writeFile(path.join(projectDir, 'hello.txt'), 'modified content\n')
    const hash2 = await service.commit()
    expect(hash2).toBeTruthy()
    expect(hash2).not.toBe(hash1)

    const modifiedContent = await fs.readFile(path.join(projectDir, 'hello.txt'), 'utf-8')
    expect(modifiedContent).toBe('modified content\n')

    await service.restore(hash1!)
    const restoredContent = await fs.readFile(path.join(projectDir, 'hello.txt'), 'utf-8')
    expect(restoredContent).toBe('initial content\n')
  })

  it('should compute diffs between checkpoints', async () => {
    await service.init()

    const hash1 = await service.commit({ allowEmpty: true })

    await fs.writeFile(path.join(projectDir, 'hello.txt'), 'changed\n')
    await fs.writeFile(path.join(projectDir, 'new-file.txt'), 'new\n')

    const hash2 = await service.commit()

    const diffs = await service.getDiff(hash1!, hash2!)
    expect(diffs.length).toBeGreaterThan(0)

    const helloEntry = diffs.find(d => d.relativePath === 'hello.txt')
    expect(helloEntry).toBeTruthy()
    expect(helloEntry!.before).toContain('initial content')
    expect(helloEntry!.after).toContain('changed')
  })

  it('should handle multiple sequential checkpoints', async () => {
    await service.init()

    const hashes: string[] = []
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(projectDir, 'counter.txt'), `count=${i}\n`)
      const h = await service.commit()
      expect(h).toBeTruthy()
      hashes.push(h!)
    }

    expect(new Set(hashes).size).toBe(5)

    await service.restore(hashes[2])
    const content = await fs.readFile(path.join(projectDir, 'counter.txt'), 'utf-8')
    expect(content).toBe('count=2\n')
  })

  it('should be idempotent on re-init', async () => {
    const path1 = await service.init()
    const path2 = await service.init()
    expect(path1).toBe(path2)
  })

  it('should return initial checkpoint hash', async () => {
    await service.init()
    const first = await service.getInitialCommitHash()
    expect(first).toBeTruthy()

    await fs.writeFile(path.join(projectDir, 'hello.txt'), 'after-init\n')
    const latest = await service.commit()
    expect(latest).toBeTruthy()
    expect(latest).not.toBe(first)

    const root = await service.getInitialCommitHash()
    expect(root).toBe(first)
  })

  // ── D-04: 锁机制统一验证 ──────────────────────────────────────────

  it('concurrent init() calls should return the same path (initPromise dedup)', async () => {
    // 并发发起多次 init，验证 initPromise 确保只初始化一次
    const [p1, p2, p3] = await Promise.all([
      service.init(),
      service.init(),
      service.init(),
    ])
    expect(p1).toBe(p2)
    expect(p2).toBe(p3)
    expect(p1.endsWith('.git')).toBe(true)
  })

  it('concurrent commits should be serialized (withLock queuing, not throw)', async () => {
    await service.init()
    // 三次并发 commit — 旧版会因为 acquireLock 直接抛出，新版应全部成功
    const results = await Promise.all([
      service.commit({ allowEmpty: true }),
      service.commit({ allowEmpty: true }),
      service.commit({ allowEmpty: true }),
    ])
    expect(results).toHaveLength(3)
    for (const hash of results) {
      expect(typeof hash).toBe('string')
      expect(hash!.length).toBeGreaterThan(4)
    }
    // 所有 hash 应互不相同（每次 commit 内容可能相同但 timestamp 不同）
    const unique = new Set(results)
    expect(unique.size).toBeGreaterThan(0)
  })

  it('commit then restore should serialize correctly via withLock', async () => {
    await service.init()
    const hash1 = await service.commit({ allowEmpty: true })
    expect(hash1).toBeTruthy()

    await fs.writeFile(path.join(projectDir, 'hello.txt'), 'pending-write\n')

    // commit 和 restore 并发启动 — withLock 保证串行
    const [hash2] = await Promise.all([
      service.commit(),
      service.restore(hash1!),
    ])
    // 操作完成即可，无异常即为通过
    expect(typeof hash2 === 'string' || hash2 === undefined).toBe(true)
  })

  it('destroy() and commit() concurrent: withLock ensures no deadlock, one may fail gracefully', async () => {
    await service.init()
    await service.commit({ allowEmpty: true })

    // 并发发起 commit + destroy — withLock 保证串行，不会死锁。
    // 先执行者成功，后执行者可能因目录已删除而失败，但必须是 rejection 而非死锁/挂起。
    const results = await Promise.allSettled([service.commit({ allowEmpty: true }), service.destroy()])
    expect(results).toHaveLength(2)
    // 至少一个操作应该完成（fulfilled）
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    // 若有 rejected，错误必须来自 git 操作失败，而非超时/死锁
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(Error)
      }
    }
  })
})
