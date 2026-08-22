import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { FileHistoryService } from '../FileHistoryService.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * 持久化（manifest.json）专项：覆盖 init / flush / debounce / fail-safe /
 * persist 开关，验证"跨实例（模拟重启 / 同 thread 多 query）按 manifest resume"。
 * 与主测试文件物理隔离，主 40 个测试不受影响（默认 persist=false 行为不变）。
 */
describe('FileHistoryService 持久化（persist）', () => {
  let ws: string
  let hist: string

  beforeEach(async () => {
    ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fhp-ws-')))
    hist = await fs.mkdtemp(path.join(os.tmpdir(), 'fhp-hist-'))
  })

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true })
    await fs.rm(hist, { recursive: true, force: true })
  })

  const make = (persist: boolean, threadId = 'thread-1') =>
    new FileHistoryService({ threadId, workspaceRoot: ws, historyRoot: hist, logger: silentLogger, persist })
  const abs = (rel: string) => path.join(ws, rel)
  const write = (rel: string, c: string) => fs.writeFile(path.join(ws, rel), c)
  const read = (rel: string) => fs.readFile(path.join(ws, rel), 'utf8')
  const threadDir = (threadId = 'thread-1') =>
    path.join(hist, createHash('sha256').update(threadId).digest('hex'))
  const manifestPath = (threadId = 'thread-1') => path.join(threadDir(threadId), 'manifest.json')
  const manifestExists = async (threadId = 'thread-1') => {
    try {
      await fs.access(manifestPath(threadId))
      return true
    } catch {
      return false
    }
  }

  it('flush() 后 manifest 落盘，新实例 init() 可 resume 回退（模拟重启）', async () => {
    await write('a.txt', 'orig')
    const svc = make(true)
    await svc.init() // 无 manifest，从空
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'changed')
    await svc.flush()

    expect(await manifestExists()).toBe(true)
    const parsed = JSON.parse(await fs.readFile(manifestPath(), 'utf8')) as {
      version: number
      snapshots: Array<{ anchorId: string }>
    }
    expect(parsed.version).toBe(1)
    expect(parsed.snapshots.some((s) => s.anchorId === 'run-1')).toBe(true)

    // 全新实例只 init（不手动 loadSnapshots），应从 manifest 恢复 ledger
    const svc2 = make(true)
    await svc2.init()
    await svc2.rewind('run-1')
    expect(await read('a.txt')).toBe('orig')
  })

  it('debounced 自动 flush：mutation 后无需手动 flush 也最终落盘', async () => {
    await write('a.txt', 'orig')
    const svc = make(true)
    await svc.init()
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    // 不手动 flush，等 debounce 窗口（300ms）+ buffer 验证自动落盘
    await new Promise((r) => setTimeout(r, 450))
    expect(await manifestExists()).toBe(true)
    await svc.destroy() // 清掉残余定时器，避免 afterEach 后写盘
  })

  it('init() 无 manifest 从空开始且不抛', async () => {
    const svc = make(true)
    await expect(svc.init()).resolves.toBeUndefined()
    expect(svc.listAnchors()).toHaveLength(0)
  })

  it('init() 遇损坏 manifest fail-safe 从空开始且不抛', async () => {
    await fs.mkdir(threadDir(), { recursive: true })
    await fs.writeFile(manifestPath(), '{ not valid json')
    const svc = make(true)
    await expect(svc.init()).resolves.toBeUndefined()
    expect(svc.listAnchors()).toHaveLength(0)
  })

  it('persist:false（默认）：mutation 不写 manifest、flush() no-op', async () => {
    await write('a.txt', 'orig')
    const svc = make(false)
    await svc.init() // no-op
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await svc.flush() // no-op
    await new Promise((r) => setTimeout(r, 50))
    expect(await manifestExists()).toBe(false)
  })

  it('destroy() 清掉 manifest 与定时器（无残留）', async () => {
    await write('a.txt', 'orig')
    const svc = make(true)
    await svc.init()
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await svc.flush()
    expect(await manifestExists()).toBe(true)

    await svc.destroy()
    expect(await manifestExists()).toBe(false)
  })

  it('init 路径同样走 loadSnapshots 的 sanitize（拒绝非法 backupRef 防 ../ 注入）', async () => {
    await fs.mkdir(threadDir(), { recursive: true })
    const malicious = {
      version: 1,
      snapshots: [
        {
          anchorId: 'run-1',
          timestamp: Date.now(),
          trackedFileBackups: {
            'a.txt': { kind: 'file', backupRef: '../../etc/passwd', version: 1, backupTime: Date.now() },
          },
        },
      ],
    }
    await fs.writeFile(manifestPath(), JSON.stringify(malicious))
    const svc = make(true)
    await svc.init()
    const snap = svc.exportSnapshots().find((s) => s.anchorId === 'run-1')
    expect(snap).toBeTruthy()
    expect(Object.keys(snap!.trackedFileBackups)).toHaveLength(0) // 非法 entry 被 drop
  })

  // ── P2-5① 损坏 manifest quarantine（不静默覆盖）─────────────────────

  it('P2-5① init 遇损坏 manifest → 改名 .corrupt.<ts> 保留 + 标 degraded（不静默覆盖）', async () => {
    await fs.mkdir(threadDir(), { recursive: true })
    await fs.writeFile(manifestPath(), '{ truncated json not closed')
    const svc = make(true)
    await svc.init()

    // 原 manifest 不再在原位（已 quarantine），且保留为 .corrupt.<ts>
    expect(await manifestExists()).toBe(false)
    const entries = await fs.readdir(threadDir())
    expect(entries.some((e) => e.startsWith('manifest.json.corrupt.'))).toBe(true)
    // 降级可观测 + 从空开始
    expect(svc.getHealth().degraded).toBe(true)
    expect(svc.listAnchors()).toHaveLength(0)
  })

  it('P2-5① quarantine 后下次 flush 不覆盖 .corrupt（写的是全新 manifest.json）', async () => {
    await fs.mkdir(threadDir(), { recursive: true })
    await fs.writeFile(manifestPath(), 'not json at all')
    const svc = make(true)
    await svc.init()
    await write('a.txt', 'orig')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await svc.flush()

    const entries = await fs.readdir(threadDir())
    // 新 manifest.json 写出来了，且损坏副本仍在（取证不丢）
    expect(entries).toContain('manifest.json')
    expect(entries.some((e) => e.startsWith('manifest.json.corrupt.'))).toBe(true)
    await svc.destroy()
  })

  // ── P2-5②③ flushNow 返回健康状态 ──────────────────────────────────

  it('P2-5②③ flushNow 成功 → ok:true / degraded:false', async () => {
    await write('a.txt', 'orig')
    const svc = make(true)
    await svc.init()
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    const res = await svc.flushNow()
    expect(res.ok).toBe(true)
    expect(res.degraded).toBe(false)
    expect(await manifestExists()).toBe(true)
    await svc.destroy()
  })

  it('P2-5②③ flushNow 写盘失败 → ok:false + degraded（host 可观测，不静默）', async () => {
    // backupDir 路径被一个普通文件占住 → mkdir/writeFile 必失败。
    await fs.writeFile(threadDir(), 'occupied-by-file')
    const svc = make(true)
    // 不 init（init 读 manifest 也会撞 ENOTDIR）；只验 flushNow 把写失败暴露出来。
    await svc.beginSnapshot('run-1')
    const res = await svc.flushNow()
    expect(res.ok).toBe(false)
    expect(res.degraded).toBe(true)
    expect(res.error).toBeTruthy()
    expect(svc.getHealth().degraded).toBe(true)
  })

  it('P2-5② persist:false 时 flushNow no-op 返回 ok:true', async () => {
    const svc = make(false)
    const res = await svc.flushNow()
    expect(res.ok).toBe(true)
    expect(res.degraded).toBe(false)
    expect(await manifestExists()).toBe(false)
  })

  // ── P1-2 manifest 记录 root，mismatch 不复用 ────────────────────────

  it('P1-2 manifest workspaceRoot 与当前 root 不一致 → 不复用 snapshots（防相对路径错位）', async () => {
    // 用 root=ws 建账本并落盘
    const svcA = make(true)
    await svcA.init()
    await write('a.txt', 'orig')
    await svcA.beginSnapshot('run-1')
    await svcA.trackEdit('run-1', abs('a.txt'))
    await svcA.flush()
    expect(svcA.listAnchors()).toHaveLength(1)

    // 同 threadId（共享 backupDir / manifest）但换一个 root 的新实例
    const ws2 = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fhp-ws2-')))
    try {
      const svcB = new FileHistoryService({
        threadId: 'thread-1',
        workspaceRoot: ws2,
        historyRoot: hist,
        logger: silentLogger,
        persist: true,
      })
      await svcB.init()
      // root 不一致 → 不复用，从空开始
      expect(svcB.hasAnchor('run-1')).toBe(false)
      expect(svcB.listAnchors()).toHaveLength(0)
    } finally {
      await fs.rm(ws2, { recursive: true, force: true })
    }
  })

  it('P1-2 manifest workspaceRoot 一致 → 正常复用', async () => {
    const svcA = make(true)
    await svcA.init()
    await write('a.txt', 'orig')
    await svcA.beginSnapshot('run-1')
    await svcA.trackEdit('run-1', abs('a.txt'))
    await svcA.flush()

    // 同 root 同 threadId 的新实例：root 匹配 → resume
    const svcB = make(true)
    await svcB.init()
    expect(svcB.hasAnchor('run-1')).toBe(true)
    await svcB.destroy()
  })
})
