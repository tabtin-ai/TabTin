import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { FileHistoryRegistry } from '../FileHistoryRegistry.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

describe('FileHistoryRegistry', () => {
  let ws: string
  let hist: string
  let reg: FileHistoryRegistry

  beforeEach(async () => {
    ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fhr-ws-')))
    hist = await fs.mkdtemp(path.join(os.tmpdir(), 'fhr-hist-'))
    reg = new FileHistoryRegistry({ historyRoot: hist, logger: silentLogger })
  })

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true })
    await fs.rm(hist, { recursive: true, force: true })
  })

  const abs = (rel: string) => path.join(ws, rel)
  const write = (rel: string, c: string) => fs.writeFile(path.join(ws, rel), c)
  const read = (rel: string) => fs.readFile(path.join(ws, rel), 'utf8')

  it('getOrCreate 同 threadId 复用同一实例', async () => {
    const a = await reg.getOrCreate('t1', ws)
    const b = await reg.getOrCreate('t1', ws)
    expect(a).toBe(b)
    expect(reg.size()).toBe(1)
  })

  it('getOrCreate 不同 threadId 建不同实例', async () => {
    const a = await reg.getOrCreate('t1', ws)
    const b = await reg.getOrCreate('t2', ws)
    expect(a).not.toBe(b)
    expect(reg.size()).toBe(2)
  })

  it('并发 getOrCreate 同 threadId 只建一个实例（in-flight 去重）', async () => {
    const [a, b, c] = await Promise.all([
      reg.getOrCreate('t1', ws),
      reg.getOrCreate('t1', ws),
      reg.getOrCreate('t1', ws),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(reg.size()).toBe(1)
  })

  it('get 返回已建实例 / 未建返回 undefined', async () => {
    expect(reg.get('t1')).toBeUndefined()
    const svc = await reg.getOrCreate('t1', ws)
    expect(reg.get('t1')).toBe(svc)
  })

  it('同一实例跨轮累积 snapshots，回退到指定轮（per-thread 复用的核心价值）', async () => {
    const svc = await reg.getOrCreate('t1', ws)
    await write('a.txt', 's0')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 's1')
    await svc.beginSnapshot('run-2')
    await svc.trackEdit('run-2', abs('a.txt'))
    await write('a.txt', 's2')

    // 第二次 getOrCreate 仍是同实例 → run-1 anchor 跨轮仍可达
    const same = await reg.getOrCreate('t1', ws)
    expect(same).toBe(svc)
    await same.rewind('run-1')
    expect(await read('a.txt')).toBe('s0')

    await reg.remove('t1') // 清理定时器
  })

  it('remove 从缓存移除但保留磁盘备份；重新 getOrCreate 可 resume（默认 persist）', async () => {
    const svc = await reg.getOrCreate('t1', ws)
    await write('a.txt', 'orig')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'changed')
    await svc.flush()

    await reg.remove('t1')
    expect(reg.get('t1')).toBeUndefined()
    expect(reg.size()).toBe(0)

    // 重新取（registry 默认 persist:true）→ init 从 manifest resume → 仍能回退
    const resumed = await reg.getOrCreate('t1', ws)
    expect(resumed).not.toBe(svc)
    await resumed.rewind('run-1')
    expect(await read('a.txt')).toBe('orig')

    await reg.remove('t1')
  })

  it('clear 清空全部缓存但保留磁盘；后续仍可 getOrCreate resume', async () => {
    const a = await reg.getOrCreate('t1', ws)
    await write('a.txt', 'orig')
    await a.beginSnapshot('run-1')
    await a.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'changed')
    await reg.getOrCreate('t2', ws)
    expect(reg.size()).toBe(2)

    await reg.clear()
    expect(reg.size()).toBe(0)
    expect(reg.get('t1')).toBeUndefined()

    // clear 已 flush，磁盘 manifest 仍在 → 重新取可 resume 回退
    const resumed = await reg.getOrCreate('t1', ws)
    await resumed.rewind('run-1')
    expect(await read('a.txt')).toBe('orig')
    await reg.remove('t1')
  })

  // ── P1-2 workspaceRoot 漂移 ────────────────────────────────────────

  it('P1-2 getOrCreate root 变化 → seal 旧实例、按新 root 新建（不串旧账本）', async () => {
    const ws2 = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fhr-ws2-')))
    try {
      const a = await reg.getOrCreate('t1', ws)
      await write('a.txt', 'orig')
      await a.beginSnapshot('run-1')
      await a.trackEdit('run-1', abs('a.txt'))
      expect(a.hasAnchor('run-1')).toBe(true)

      // 同 thread 换 root → 新实例（旧被 flush+seal），新实例不复用旧 root 的 anchor
      // （manifest root mismatch → init 不加载，避免相对路径 key 错位）。
      const b = await reg.getOrCreate('t1', ws2)
      expect(b).not.toBe(a)
      expect(b.workspaceRoot).not.toBe(a.workspaceRoot)
      expect(b.hasAnchor('run-1')).toBe(false)
      expect(reg.size()).toBe(1)
      await reg.remove('t1')
    } finally {
      await fs.rm(ws2, { recursive: true, force: true })
    }
  })

  it('P1-2 getOrCreate 同 root（canonical 等价，末尾斜杠）→ 复用同实例，不误判漂移', async () => {
    const a = await reg.getOrCreate('t1', ws)
    const b = await reg.getOrCreate('t1', ws + path.sep)
    expect(b).toBe(a)
    expect(reg.size()).toBe(1)
    await reg.remove('t1')
  })

  // ── P1-3 销毁竞 race（tombstone）─────────────────────────────────

  it('P1-3 remove 期间并发 getOrCreate：等移除落定后重建，可 resume，无重复实例', async () => {
    const a = await reg.getOrCreate('t1', ws)
    await write('a.txt', 'orig')
    await a.beginSnapshot('run-1')
    await a.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'changed')
    await a.flush()

    // 同步发起 remove + getOrCreate：getOrCreate 命中 removing tombstone 会先等
    // 移除落定，再从 manifest resume 重建 —— 不与旧 flush 抢 manifest、不建重复实例。
    const [, b] = await Promise.all([reg.remove('t1'), reg.getOrCreate('t1', ws)])
    expect(b).not.toBe(a)
    expect(reg.size()).toBe(1)

    await b.rewind('run-1')
    expect(await read('a.txt')).toBe('orig')
    await reg.remove('t1')
  })

  it('P1-3 重入 remove 同 thread 复用同一 in-flight（不重复 flush/删两次）', async () => {
    const a = await reg.getOrCreate('t1', ws)
    await write('a.txt', 'orig')
    await a.beginSnapshot('run-1')
    await a.trackEdit('run-1', abs('a.txt'))

    // 同步两次 remove → 第二次复用第一次的 in-flight promise
    const p1 = reg.remove('t1')
    const p2 = reg.remove('t1')
    await Promise.all([p1, p2])
    expect(reg.size()).toBe(0)
    expect(reg.get('t1')).toBeUndefined()
  })

  // ── Bug 1：进程重启后 lazy-resume（getOrResume）────────────────────

  it('Bug1 getOrResume：进程重启（全新 registry，内存空）后从磁盘 manifest 恢复出可 rewind 的 service', async () => {
    // 用第一个 registry 建账本并落盘（模拟"发过消息的会话"）。
    const reg1 = new FileHistoryRegistry({ historyRoot: hist, logger: silentLogger })
    const svc = await reg1.getOrCreate('t-restart', ws)
    await write('a.txt', 'orig')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'changed')
    await svc.flushNow() // 确定性落盘 manifest（含 workspaceRoot）
    await reg1.clear()

    // 模拟重启：全新 registry，内存空，该 thread 从未跑过 query。
    const reg2 = new FileHistoryRegistry({ historyRoot: hist, logger: silentLogger })
    expect(reg2.get('t-restart')).toBeUndefined() // 旧入口（仅内存）会拒绝回退

    // getOrResume 按 threadId 探测磁盘 manifest → 用其记录的 workspaceRoot 恢复账本。
    const resumed = await reg2.getOrResume('t-restart')
    expect(resumed).toBeDefined()
    expect(resumed!.hasAnchor('run-1')).toBe(true)
    await resumed!.rewind('run-1')
    expect(await read('a.txt')).toBe('orig')
    await reg2.remove('t-restart')
  })

  it('Bug1 getOrResume：磁盘无 manifest → undefined（绝不静默建空 service / 绝不整仓 reset）', async () => {
    const resumed = await reg.getOrResume('never-existed')
    expect(resumed).toBeUndefined()
    expect(reg.size()).toBe(0)
  })

  it('Bug1 getOrResume：内存已有实例 → 直接复用（不重建、不读盘）', async () => {
    const svc = await reg.getOrCreate('t1', ws)
    const resumed = await reg.getOrResume('t1')
    expect(resumed).toBe(svc)
    expect(reg.size()).toBe(1)
    await reg.remove('t1')
  })

  it('Bug1 getOrResume：刚 track 完未 flush（manifest 无 workspaceRoot）也能从内存返回，不被磁盘探测漏掉', async () => {
    // 默认 persist:true。只 beginSnapshot/trackEdit，不 flush → manifest 可能尚未落盘。
    const svc = await reg.getOrCreate('t1', ws)
    await write('a.txt', 'orig')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    // 内存命中分支优先于磁盘探测：即便 manifest 还没 workspaceRoot 也能拿到可回退实例。
    const resumed = await reg.getOrResume('t1')
    expect(resumed).toBe(svc)
    expect(resumed!.hasAnchor('run-1')).toBe(true)
    await reg.remove('t1')
  })

  it('Bug1 getOrResume：lazy 恢复后再 getOrResume 复用同一实例（无重复实例）', async () => {
    const reg1 = new FileHistoryRegistry({ historyRoot: hist, logger: silentLogger })
    const svc = await reg1.getOrCreate('t-restart', ws)
    await write('a.txt', 'orig')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await svc.flushNow()
    await reg1.clear()

    const reg2 = new FileHistoryRegistry({ historyRoot: hist, logger: silentLogger })
    const first = await reg2.getOrResume('t-restart')
    const second = await reg2.getOrResume('t-restart')
    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(reg2.size()).toBe(1)
    await reg2.remove('t-restart')
  })

  it('Bug1 getOrResume：并发恢复同 thread 只建一个实例（复用 getOrCreate in-flight 去重）', async () => {
    const reg1 = new FileHistoryRegistry({ historyRoot: hist, logger: silentLogger })
    const svc = await reg1.getOrCreate('t-restart', ws)
    await write('a.txt', 'orig')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await svc.flushNow()
    await reg1.clear()

    const reg2 = new FileHistoryRegistry({ historyRoot: hist, logger: silentLogger })
    const [a, b, c] = await Promise.all([
      reg2.getOrResume('t-restart'),
      reg2.getOrResume('t-restart'),
      reg2.getOrResume('t-restart'),
    ])
    expect(a).toBeDefined()
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(reg2.size()).toBe(1)
    await reg2.remove('t-restart')
  })
})
