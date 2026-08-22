import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { FileHistoryService } from '../FileHistoryService.js'
import type { FileHistorySnapshot } from '../types.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

describe('FileHistoryService', () => {
  let ws: string
  let hist: string
  let svc: FileHistoryService

  beforeEach(async () => {
    // canonicalize ws（realpath）——服务内部按 realpath 归一 key，测试断言用同款
    // canonical 路径才不会在 macOS（/var → /private/var）上漂移。
    ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fh-ws-')))
    hist = await fs.mkdtemp(path.join(os.tmpdir(), 'fh-hist-'))
    svc = new FileHistoryService({
      threadId: 'thread-1',
      workspaceRoot: ws,
      historyRoot: hist,
      logger: silentLogger,
    })
  })

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true })
    await fs.rm(hist, { recursive: true, force: true })
  })

  const write = (rel: string, content: string) => fs.writeFile(path.join(ws, rel), content)
  const read = (rel: string) => fs.readFile(path.join(ws, rel), 'utf8')
  const exists = async (rel: string) => {
    try {
      await fs.access(path.join(ws, rel))
      return true
    } catch {
      return false
    }
  }
  const abs = (rel: string) => path.join(ws, rel)
  const backupDirOf = (threadId: string) =>
    path.join(hist, createHash('sha256').update(threadId).digest('hex'))

  // ── 基础语义（INV-1..4）────────────────────────────────────────────

  it('改文件 → 回退还原改前内容（INV-1）', async () => {
    await write('a.txt', 'v1')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'v2-by-agent')

    const r = await svc.rewind('run-1')

    expect(await read('a.txt')).toBe('v1')
    expect(r.filesRestored).toContain(abs('a.txt'))
    expect(r.failedFiles).toHaveLength(0)
  })

  it('新建文件 → 回退删除（absent）', async () => {
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('new.txt')) // 改前不存在
    await write('new.txt', 'created-by-agent')

    const r = await svc.rewind('run-1')

    expect(await exists('new.txt')).toBe(false)
    expect(r.filesDeleted).toContain(abs('new.txt'))
  })

  it('未 track 的文件回退时绝不被碰（INV-3）', async () => {
    await write('untouched.txt', 'user-content')
    await write('a.txt', 'v1')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'v2')

    await svc.rewind('run-1')

    expect(await read('untouched.txt')).toBe('user-content')
    expect(await read('a.txt')).toBe('v1')
  })

  it('同一轮内对同一文件 trackEdit 两次，只保留改前一次（INV-2）', async () => {
    await write('a.txt', 'before')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'mid')
    await svc.trackEdit('run-1', abs('a.txt')) // 不应把 mid 当成 before
    await write('a.txt', 'after')

    await svc.rewind('run-1')

    expect(await read('a.txt')).toBe('before')
  })

  it('多 anchor：回退到指定一轮开始前', async () => {
    await write('a.txt', 's0')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 's1')
    await svc.beginSnapshot('run-2')
    await svc.trackEdit('run-2', abs('a.txt'))
    await write('a.txt', 's2')

    await svc.rewind('run-2')
    expect(await read('a.txt')).toBe('s1')
  })

  it('回退到更早 anchor 还原到最初', async () => {
    await write('a.txt', 's0')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 's1')
    await svc.beginSnapshot('run-2')
    await svc.trackEdit('run-2', abs('a.txt'))
    await write('a.txt', 's2')

    await svc.rewind('run-1')
    expect(await read('a.txt')).toBe('s0')
  })

  it('getAffectedPaths 预览将被还原的文件', async () => {
    await write('a.txt', 'v1')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'v2')

    const affected = await svc.getAffectedPaths('run-1')
    expect(affected).toContain(abs('a.txt'))
  })

  it('getRewindDiff 预览与 rewind 同 anchor 的文件 diff', async () => {
    await write('a.txt', 'before')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'after')

    const diffs = await svc.getRewindDiff('run-1')
    expect(diffs).toEqual([
      { path: 'a.txt', status: 'modified', before: 'after', after: 'before' },
    ])
  })

  it('createSafetySnapshot + rewind 可还原回退前状态', async () => {
    await write('a.txt', 'original')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'rewound')

    await svc.createSafetySnapshot('safety:session:1')
    await svc.rewind('run-1')
    expect(await read('a.txt')).toBe('original')

    await svc.rewind('safety:session:1')
    expect(await read('a.txt')).toBe('rewound')
  })

  it('rewind 不存在的 anchor 抛错', async () => {
    await expect(svc.rewind('does-not-exist')).rejects.toThrow()
  })

  it('getAffectedPaths 不存在的 anchor 抛错（与 rewind 对称，C-FH5）', async () => {
    // 未知 anchor 不再静默返 []（那会让预览误显「无文件可恢复」），而是抛错让
    // 调用方回落后端能力判定——与 rewind 的 not-found 语义对称。
    await expect(svc.getAffectedPaths('does-not-exist')).rejects.toThrow()
  })

  it('不依赖 git：纯临时目录可 track + rewind（INV-4）', async () => {
    await write('a.txt', 'orig')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'changed')

    await svc.rewind('run-1')
    expect(await read('a.txt')).toBe('orig')
  })

  it('exportSnapshots / loadSnapshots 持久化往返后仍可回退', async () => {
    await write('a.txt', 'orig')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('a.txt'))
    await write('a.txt', 'changed')

    const exported = svc.exportSnapshots()
    const svc2 = new FileHistoryService({
      threadId: 'thread-1',
      workspaceRoot: ws,
      historyRoot: hist,
      logger: silentLogger,
    })
    svc2.loadSnapshots(exported)

    await svc2.rewind('run-1')
    expect(await read('a.txt')).toBe('orig')
  })

  it('子目录文件（嵌套路径）也能 track + rewind', async () => {
    await fs.mkdir(path.join(ws, 'src/nested'), { recursive: true })
    await write('src/nested/b.ts', 'export const x = 1')
    await svc.beginSnapshot('run-1')
    await svc.trackEdit('run-1', abs('src/nested/b.ts'))
    await write('src/nested/b.ts', 'export const x = 2')

    await svc.rewind('run-1')
    expect(await read('src/nested/b.ts')).toBe('export const x = 1')
  })

  // ── P0-1 trackEdit 带 anchorId + 三阶段提交防并发 ──────────────────

  describe('P0-1 trackEdit(anchorId) 归属正确轮 + 防并发', () => {
    it('备份写入指定 anchorId 的 snapshot，而非"最新"', async () => {
      await write('a.txt', 'a0')
      await svc.beginSnapshot('run-1')
      await svc.beginSnapshot('run-2') // run-2 现在是最新
      // 显式归属 run-1（更早的轮），不应落到最新的 run-2
      await svc.trackEdit('run-1', abs('a.txt'))

      const snaps = svc.exportSnapshots()
      const run1 = snaps.find((s) => s.anchorId === 'run-1')!
      const run2 = snaps.find((s) => s.anchorId === 'run-2')!
      expect(run1.trackedFileBackups['a.txt']).toBeDefined()
      expect(run2.trackedFileBackups['a.txt']).toBeUndefined()
    })

    it('beginSnapshot 未跑（早于/失败）时 trackEdit 以正确 anchorId 兜底建锚点', async () => {
      await write('a.txt', 'v1')
      // 没有 beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 'v2')

      expect(svc.hasAnchor('run-1')).toBe(true)
      await svc.rewind('run-1')
      expect(await read('a.txt')).toBe('v1')
    })

    it('并发 trackEdit 同 anchor 同文件：只一个 before-backup，回退到改前', async () => {
      await write('a.txt', 'before')
      await svc.beginSnapshot('run-1')
      await Promise.all([
        svc.trackEdit('run-1', abs('a.txt')),
        svc.trackEdit('run-1', abs('a.txt')),
        svc.trackEdit('run-1', abs('a.txt')),
      ])
      await write('a.txt', 'after')

      const snap = svc.exportSnapshots().find((s) => s.anchorId === 'run-1')!
      // 同一文件只一条 entry（INV-2，三阶段 commit re-check 防 race 覆盖）
      expect(Object.keys(snap.trackedFileBackups)).toEqual(['a.txt'])

      await svc.rewind('run-1')
      expect(await read('a.txt')).toBe('before')
    })

    it('并发 trackEdit 不同文件同 anchor：都被记录', async () => {
      await write('a.txt', 'a')
      await write('b.txt', 'b')
      await svc.beginSnapshot('run-1')
      await Promise.all([
        svc.trackEdit('run-1', abs('a.txt')),
        svc.trackEdit('run-1', abs('b.txt')),
      ])
      await write('a.txt', 'a2')
      await write('b.txt', 'b2')

      const r = await svc.rewind('run-1')
      expect(await read('a.txt')).toBe('a')
      expect(await read('b.txt')).toBe('b')
      expect(r.filesRestored.sort()).toEqual([abs('a.txt'), abs('b.txt')].sort())
    })
  })

  // ── P0-2 备份缺失 fail-visible ─────────────────────────────────────

  describe('P0-2 备份缺失 fail-visible', () => {
    it('备份文件缺失 → 计入 failedFiles，不静默当成功，不改动磁盘', async () => {
      await write('a.txt', 'v1')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 'v2')

      // 模拟备份丢失（磁盘损坏 / 误删）
      await fs.rm(backupDirOf('thread-1'), { recursive: true, force: true })

      const r = await svc.rewind('run-1')
      expect(r.failedFiles).toContain(abs('a.txt'))
      expect(r.filesRestored).not.toContain(abs('a.txt'))
      // 文件保持现状，绝不假装"已还原"
      expect(await read('a.txt')).toBe('v2')
    })

    it('metadata 解析不到目标版本 → failedFiles', async () => {
      // 手工构造一个 trackedFile 没有任何 v1 备份的损坏状态
      const corrupt: FileHistorySnapshot[] = [
        {
          anchorId: 'run-1',
          timestamp: Date.now(),
          // version 2，没有 v1 → firstVersionBackup 解析不到
          trackedFileBackups: {
            'a.txt': { kind: 'file', backupRef: 'a'.repeat(16) + '@v2', version: 2, backupTime: Date.now() },
          },
        },
        {
          anchorId: 'run-0',
          timestamp: Date.now(),
          trackedFileBackups: {},
        },
      ]
      svc.loadSnapshots(corrupt)
      await write('a.txt', 'cur')
      const r = await svc.rewind('run-0') // run-0 无 a.txt，回退 firstVersion 也找不到
      expect(r.failedFiles).toContain(abs('a.txt'))
    })
  })

  // ── P0-3 beginSnapshot race window 继承 ────────────────────────────

  describe('P0-3 beginSnapshot 异步窗口继承', () => {
    it('beginSnapshot 覆盖当前所有 tracked 文件（含 latest 之后新 track 的）', async () => {
      await write('a.txt', 'a0')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 'a1')
      // 在 run-1 之后又 track 了一个新文件 b（模拟"latest 之后新增 tracked"）
      await write('b.txt', 'b0')
      await svc.trackEdit('run-1', abs('b.txt'))

      await svc.beginSnapshot('run-2')
      const run2 = svc.exportSnapshots().find((s) => s.anchorId === 'run-2')!
      expect(Object.keys(run2.trackedFileBackups).sort()).toEqual(['a.txt', 'b.txt'])
    })

    it('异步窗口内 track 进上一轮的文件，回退新轮仍可还原（数据安全）', async () => {
      await write('a.txt', 'a0')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 'a1')
      await write('b.txt', 'b0')

      // 不 await，制造 beginSnapshot 异步窗口；窗口内一个落到上一轮(run-1)的 trackEdit
      const begin = svc.beginSnapshot('run-2')
      await svc.trackEdit('run-1', abs('b.txt'))
      await begin

      await write('b.txt', 'b1')
      const r = await svc.rewind('run-2')
      // 无论 Phase3 继承命中还是 firstVersion 兜底，b 都必须能回退到 b0
      expect(await read('b.txt')).toBe('b0')
      expect(r.failedFiles).not.toContain(abs('b.txt'))
    })
  })

  // ── P0-4 resume 备份迁移 ───────────────────────────────────────────

  describe('P0-4 copyFileHistoryForResume', () => {
    it('迁移上个 session 备份后，新 session 可回退', async () => {
      await write('a.txt', 'a0')
      const svcA = new FileHistoryService({
        threadId: 'tA',
        workspaceRoot: ws,
        historyRoot: hist,
        logger: silentLogger,
      })
      await svcA.beginSnapshot('run-1')
      await svcA.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 'a1')
      const exported = svcA.exportSnapshots()

      const svcB = new FileHistoryService({
        threadId: 'tB',
        workspaceRoot: ws,
        historyRoot: hist,
        logger: silentLogger,
      })
      svcB.loadSnapshots(exported)
      await svcB.copyFileHistoryForResume('tA')

      // 备份已迁到 tB 的 backupDir
      await svcB.rewind('run-1')
      expect(await read('a.txt')).toBe('a0')
    })

    it('迁移失败（上个 session 备份缺失）→ 对应 snapshot 不可用，fail-visible', async () => {
      await write('a.txt', 'a0')
      const svcA = new FileHistoryService({
        threadId: 'tA',
        workspaceRoot: ws,
        historyRoot: hist,
        logger: silentLogger,
      })
      await svcA.beginSnapshot('run-1')
      await svcA.trackEdit('run-1', abs('a.txt'))
      const exported = svcA.exportSnapshots()
      // 上个 session 备份目录被清掉
      await svcA.destroy()

      const svcB = new FileHistoryService({
        threadId: 'tB',
        workspaceRoot: ws,
        historyRoot: hist,
        logger: silentLogger,
      })
      svcB.loadSnapshots(exported)
      await svcB.copyFileHistoryForResume('tA')

      // run-1 应不可用（snapshot 被丢弃），而不是"半可用"静默失败
      expect(svcB.hasAnchor('run-1')).toBe(false)
      await expect(svcB.rewind('run-1')).rejects.toThrow()
    })

    it('同 thread 迁移是 no-op', async () => {
      await write('a.txt', 'a0')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 'a1')
      await svc.copyFileHistoryForResume('thread-1') // 同 thread
      await svc.rewind('run-1')
      expect(await read('a.txt')).toBe('a0')
    })
  })

  // ── P1-5 文件元数据保真（mode）─────────────────────────────────────

  describe('P1-5 mode 保真', () => {
    it('可执行脚本回退后保留 executable bit', async () => {
      await write('script.sh', '#!/bin/sh\necho hi\n')
      await fs.chmod(abs('script.sh'), 0o755)
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('script.sh'))
      await write('script.sh', 'tampered')
      await fs.chmod(abs('script.sh'), 0o644)

      await svc.rewind('run-1')
      expect(await read('script.sh')).toBe('#!/bin/sh\necho hi\n')
      const st = await fs.stat(abs('script.sh'))
      expect(st.mode & 0o777).toBe(0o755)
    })

    it('仅 mode 变化（内容不变）也被识别为 differs 并恢复 mode', async () => {
      await write('s.sh', 'samebody')
      await fs.chmod(abs('s.sh'), 0o755)
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('s.sh'))
      // 只改权限，内容不动
      await fs.chmod(abs('s.sh'), 0o600)

      const r = await svc.rewind('run-1')
      expect(r.filesRestored).toContain(abs('s.sh'))
      const st = await fs.stat(abs('s.sh'))
      expect(st.mode & 0o777).toBe(0o755)
    })
  })

  // ── P1-6 类型 / 符号链接安全 ───────────────────────────────────────

  describe('P1-6 类型 / symlink 安全', () => {
    it('rewind 当前是 symlink：先 unlink 再写普通文件，不写穿 target', async () => {
      await write('real.txt', 'REAL')
      await write('data.txt', 'v1')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('data.txt')) // 备份普通文件 'v1'
      // 把 data.txt 换成指向 real.txt 的 symlink
      await fs.rm(abs('data.txt'))
      await fs.symlink(abs('real.txt'), abs('data.txt'))

      await svc.rewind('run-1')

      const lst = await fs.lstat(abs('data.txt'))
      expect(lst.isSymbolicLink()).toBe(false) // 已变回普通文件
      expect(await read('data.txt')).toBe('v1')
      expect(await read('real.txt')).toBe('REAL') // target 没被 copyFile 跟随写穿
    })

    it('track 一个目录 → 记 unsupported，回退不删除、计入 failedFiles', async () => {
      await fs.mkdir(abs('somedir'))
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('somedir'))

      const r = await svc.rewind('run-1')
      expect(await exists('somedir')).toBe(true) // 绝不当 absent 删除
      expect(r.filesDeleted).not.toContain(abs('somedir'))
      expect(r.failedFiles).toContain(abs('somedir'))
    })

    it('track 一个 symlink → 记 unsupported（不伪装成 absent），回退不破坏 link/target', async () => {
      await write('real.txt', 'REAL')
      await fs.symlink(abs('real.txt'), abs('link.txt'))
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('link.txt'))

      const snap = svc.exportSnapshots().find((s) => s.anchorId === 'run-1')!
      expect(Object.values(snap.trackedFileBackups).some((b) => b.kind === 'unsupported')).toBe(true)

      await svc.rewind('run-1')
      // link 与 target 都不被破坏
      expect(await read('real.txt')).toBe('REAL')
    })
  })

  // ── P1-7 错误只吞 ENOENT ───────────────────────────────────────────

  describe('P1-7 非 ENOENT 错误不静默', () => {
    it('createBackup 遇 ENOTDIR 记 backup-failed（不当成 absent 误删，fail-visible）', async () => {
      // pdir 是普通文件 → lstat(pdir/child) 触发 ENOTDIR（非 ENOENT）。
      // 旧实现 catch-all 把它当 absent 记录 → 回退会"删除"该路径（数据丢失隐患）。
      // P1-B 后：非 ENOENT 抛出 → trackEdit 记 `backup-failed`（既**不**当 absent 误删，
      // 又 fail-visible：进 trackedFiles、rewind 计入 failedFiles）。
      await write('pdir', 'iamfile')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('pdir/child.txt'))

      const snap = svc.exportSnapshots().find((s) => s.anchorId === 'run-1')!
      // 记一条 backup-failed 标记（而非 absent / 而非静默漏记）
      expect(snap.trackedFileBackups['pdir/child.txt']?.kind).toBe('backup-failed')

      const r = await svc.rewind('run-1')
      // fail-visible：计入 failedFiles，且绝不删除该路径
      expect(r.failedFiles).toContain(abs('pdir/child.txt'))
      expect(r.filesDeleted).not.toContain(abs('pdir/child.txt'))
    })

    it('rewind 恢复时遇非 ENOENT 错误 → failedFiles，不静默成功', async () => {
      await fs.mkdir(abs('pdir'))
      await write('pdir/child.txt', 'v1')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('pdir/child.txt'))
      await write('pdir/child.txt', 'v2')

      // 把 pdir 从目录换成普通文件 → 访问 pdir/child.txt 触发 ENOTDIR（非 ENOENT）
      await fs.rm(abs('pdir'), { recursive: true, force: true })
      await write('pdir', 'now-a-file')

      const r = await svc.rewind('run-1')
      expect(r.failedFiles).toContain(abs('pdir/child.txt'))
      expect(r.filesRestored).not.toContain(abs('pdir/child.txt'))
    })
  })

  // ── P1-B 首次 track 备份失败 fail-visible（INV-1 / INV-5）────────────

  describe('P1-B 首次 track 备份失败 fail-visible', () => {
    it('首次 track 的文件备份失败 → 进 trackedFiles 并计入 failedFiles（不静默漏）', async () => {
      // 用 ENOTDIR 制造 createBackup 失败：blocker 是普通文件，lstat(blocker/child) 抛 ENOTDIR。
      // 该文件此前从未被 track（首次）。修复前备份失败直接 return → 不进 trackedFiles →
      // rewind 不遍历 → failedFiles 为空（静默漏洞）。修复后记 backup-failed 进 trackedFiles。
      await write('blocker', 'i-am-a-file')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('blocker/child.txt'))

      const r = await svc.rewind('run-1')
      expect(r.failedFiles).toContain(abs('blocker/child.txt'))
      expect(r.filesRestored).toHaveLength(0)
      expect(r.filesDeleted).toHaveLength(0)
    })

    it('backup-failed 不影响同轮其他文件正常回退（INV-3 + fail-visible 并存）', async () => {
      await write('good.txt', 'v1')
      await write('blocker', 'file')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('good.txt')) // 正常备份
      await svc.trackEdit('run-1', abs('blocker/child.txt')) // 备份失败 → backup-failed
      await write('good.txt', 'v2-by-agent')

      const r = await svc.rewind('run-1')
      // 正常文件还原到改前；失败文件 fail-visible，互不影响
      expect(await read('good.txt')).toBe('v1')
      expect(r.filesRestored).toContain(abs('good.txt'))
      expect(r.failedFiles).toContain(abs('blocker/child.txt'))
    })

    it('getAffectedPaths 不把 backup-failed 计入"将被触碰路径"（不会被 path guard 误拒）', async () => {
      // backup-failed 不会被 rewind 实际写/删，故不进 affected（与 rewind 写删集合严格同构）。
      await write('blocker', 'file')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('blocker/child.txt'))

      const affected = await svc.getAffectedPaths('run-1')
      expect(affected).not.toContain(abs('blocker/child.txt'))
    })

    it('富预览把 backup-failed 明确列为不可恢复，不把空 affected 误报为无影响', async () => {
      await write('blocker', 'file')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('blocker/child.txt'))

      const preview = await svc.getRewindPreview('run-1')

      expect(preview.affectedPaths).toEqual([])
      expect(preview.unrestorable).toEqual([
        expect.objectContaining({
          path: 'blocker/child.txt',
          reason: 'backup_failed',
        }),
      ])
    })

    it('备份失败的 backup-failed 跨持久化 round-trip 保留（loadSnapshots 不丢弃）', async () => {
      await write('blocker', 'file')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('blocker/child.txt'))

      // 导出 → 重新 load（模拟 resume / 重启），backup-failed 标记必须保留，
      // 否则重启后这个无法回退的文件又会静默消失。
      const exported = svc.exportSnapshots()
      const svc2 = new FileHistoryService({
        threadId: 'thread-1',
        workspaceRoot: ws,
        historyRoot: hist,
        logger: silentLogger,
      })
      svc2.loadSnapshots(exported)
      const r = await svc2.rewind('run-1')
      expect(r.failedFiles).toContain(abs('blocker/child.txt'))
    })
  })

  // ── P1-8 key 稳定性 + 安全 ─────────────────────────────────────────

  describe('P1-8 key 稳定性 + 安全', () => {
    it('threadId 用 hash：a/b 与 a_b 不串备份（旧 sanitize 会碰撞同一 backupDir）', async () => {
      // 旧 lossy sanitize：'a/b' → 'a_b'，与 'a_b' 落到同一 backupDir，备份文件名
      // （hash(rel)@v1）相同 → 互相覆盖。修复用 sha256(threadId) → 目录隔离。
      await write('x.txt', 'one')
      const svc1 = new FileHistoryService({
        threadId: 'a/b',
        workspaceRoot: ws,
        historyRoot: hist,
        logger: silentLogger,
      })
      await svc1.beginSnapshot('r')
      await svc1.trackEdit('r', abs('x.txt')) // 备份 'one'
      await write('x.txt', 'two')

      const svc2 = new FileHistoryService({
        threadId: 'a_b',
        workspaceRoot: ws,
        historyRoot: hist,
        logger: silentLogger,
      })
      await svc2.beginSnapshot('r')
      await svc2.trackEdit('r', abs('x.txt')) // 若同目录会覆盖 svc1 的 'one'
      await write('x.txt', 'three')

      await svc1.rewind('r')
      // svc1 必须还原到自己的 'one'，不被 svc2 串改
      expect(await read('x.txt')).toBe('one')
      // 计算用断言冗余保底：两 thread 的 hash 目录确实不同
      expect(backupDirOf('a/b')).not.toBe(backupDirOf('a_b'))
    })

    it('canonicalize：同一文件经 symlink 目录访问归一为同一 key（不分裂 entry）', async () => {
      await fs.mkdir(abs('realdir'))
      await write('realdir/x.txt', 'v1')
      await fs.symlink(abs('realdir'), abs('linkdir'))
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('realdir/x.txt'))
      await svc.trackEdit('run-1', abs('linkdir/x.txt')) // 经 symlink 目录访问同一真实文件

      const snap = svc.exportSnapshots().find((s) => s.anchorId === 'run-1')!
      expect(Object.keys(snap.trackedFileBackups)).toHaveLength(1)
    })

    it('loadSnapshots 拒绝非法 backupRef（防 ../ 路径注入），保留合法 entry', async () => {
      const malicious: FileHistorySnapshot[] = [
        {
          anchorId: 'run-1',
          timestamp: Date.now(),
          trackedFileBackups: {
            evil: { kind: 'file', backupRef: '../../../etc/passwd', version: 1, backupTime: Date.now() },
            ok: { kind: 'file', backupRef: 'a'.repeat(16) + '@v1', version: 1, backupTime: Date.now() },
            absentOk: { kind: 'absent', backupRef: null, version: 1, backupTime: Date.now() },
          },
        },
      ]
      svc.loadSnapshots(malicious)
      const loaded = svc.exportSnapshots()[0]
      expect(loaded.trackedFileBackups['evil']).toBeUndefined() // 非法被丢弃
      expect(loaded.trackedFileBackups['ok']).toBeDefined()
      expect(loaded.trackedFileBackups['absentOk']).toBeDefined()
    })

    it('exportSnapshots 深拷贝 FileBackup：篡改导出物不影响内部状态', async () => {
      await write('a.txt', 'v1')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 'v2')

      const e1 = svc.exportSnapshots()
      e1.find((s) => s.anchorId === 'run-1')!.trackedFileBackups['a.txt'].backupRef = 'TAMPERED'

      const e2 = svc.exportSnapshots()
      expect(e2.find((s) => s.anchorId === 'run-1')!.trackedFileBackups['a.txt'].backupRef).not.toBe('TAMPERED')
      // 内部状态未被污染，仍可正常回退
      await svc.rewind('run-1')
      expect(await read('a.txt')).toBe('v1')
    })
  })

  // ── P1-9 大文件 mtime 快路径 ───────────────────────────────────────

  describe('P1-9 mtime 快路径', () => {
    it('内容相同 → 不触发恢复', async () => {
      await write('a.txt', 'same-content')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      // 不改内容

      const r = await svc.rewind('run-1')
      expect(r.filesRestored).not.toContain(abs('a.txt'))
    })

    it('同 size 且 mtime 被回拨仍按原始字节识别变更', async () => {
      await write('a.txt', 'AAAA')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      // 同 size 改内容，并把 mtime 往前调。mtime 不能作为 CAS 的内容证明。
      await write('a.txt', 'BBBB')
      const past = new Date(Date.now() - 60_000)
      await fs.utimes(abs('a.txt'), past, past)

      const r = await svc.rewind('run-1')
      expect(r.filesRestored).toContain(abs('a.txt'))
      expect(await read('a.txt')).toBe('AAAA')
    })

    it('同 size 但 mtime 晚于备份 → 比内容，内容不同则恢复', async () => {
      await write('a.txt', 'AAAA')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 'BBBB') // 默认 mtime = now（晚于备份）

      const r = await svc.rewind('run-1')
      expect(r.filesRestored).toContain(abs('a.txt'))
      expect(await read('a.txt')).toBe('AAAA')
    })
  })

  // ── 跨轮 矩阵：新建 / 删除 / 再改 / 再删 ────────────────────────────

  describe('跨轮矩阵', () => {
    it('跨轮新建：文件在 run-2 才出现，回退 run-1 删除它', async () => {
      await write('a.txt', 'a0')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 'a1')

      await svc.beginSnapshot('run-2')
      await svc.trackEdit('run-2', abs('newfile.txt')) // run-2 才新建
      await write('newfile.txt', 'created')

      // 回退到 run-1（newfile 当时不存在）→ 应删除 newfile（firstVersion=absent 兜底）
      const r = await svc.rewind('run-1')
      expect(await exists('newfile.txt')).toBe(false)
      expect(r.filesDeleted).toContain(abs('newfile.txt'))
      expect(await read('a.txt')).toBe('a0')
    })

    it('删除文件：删前备份，回退恢复', async () => {
      await write('doomed.txt', 'keep-me')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('doomed.txt')) // 删除工具的删前备份
      await fs.rm(abs('doomed.txt')) // agent 删除

      const r = await svc.rewind('run-1')
      expect(await read('doomed.txt')).toBe('keep-me')
      expect(r.filesRestored).toContain(abs('doomed.txt'))
    })

    it('改 → 删 → 再改 跨多轮，回退到各轮起点正确', async () => {
      await write('f.txt', 'v0')
      // run-1：改
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('f.txt'))
      await write('f.txt', 'v1')
      // run-2：删
      await svc.beginSnapshot('run-2')
      await svc.trackEdit('run-2', abs('f.txt'))
      await fs.rm(abs('f.txt'))
      // run-3：再建
      await svc.beginSnapshot('run-3')
      await svc.trackEdit('run-3', abs('f.txt'))
      await write('f.txt', 'v3')

      // 回退 run-3 起点：f 当时不存在（run-2 删了）→ 删除
      const r3 = await svc.rewind('run-3')
      expect(await exists('f.txt')).toBe(false)
      expect(r3.filesDeleted).toContain(abs('f.txt'))

      // 回退 run-2 起点：f 当时是 v1
      await svc.rewind('run-2')
      expect(await read('f.txt')).toBe('v1')

      // 回退 run-1 起点：f 当时是 v0
      await svc.rewind('run-1')
      expect(await read('f.txt')).toBe('v0')
    })

    it('新建 → 删除（同轮内 create 后又 delete）回退后保持不存在', async () => {
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('tmp.txt')) // 改前不存在 → absent
      await write('tmp.txt', 'created')
      await svc.trackEdit('run-1', abs('tmp.txt')) // 同轮再 track（删前）→ INV-2 不覆盖 absent
      await fs.rm(abs('tmp.txt'))

      // 回退 run-1：before 状态是 absent → 保持不存在
      const r = await svc.rewind('run-1')
      expect(await exists('tmp.txt')).toBe(false)
      expect(r.failedFiles).toHaveLength(0)
    })
  })

  // ── P0-1 rewind path guard（host 注入；越界路径原子拒绝）─────────────

  describe('P0-1 rewind path guard', () => {
    it('expected preview revision 在同一把锁内重算，不匹配时不写盘', async () => {
      await write('a.txt', 'v1')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 'v2')

      const preview = await svc.getRewindPreview('run-1')
      const confirmedRevision = preview.fingerprints[0]?.current.kind === 'file'
        ? preview.fingerprints[0].current.sha256
        : 'missing'
      await write('a.txt', 'v3-after-confirm')

      await expect(svc.rewind('run-1', {
        expectedPreviewRevision: confirmedRevision,
        previewRevisionFactory: current => (
          current.fingerprints[0]?.current.kind === 'file'
            ? current.fingerprints[0].current.sha256
            : 'missing'
        ),
      })).rejects.toThrow(/preview revision mismatch/)

      expect(await read('a.txt')).toBe('v3-after-confirm')
    })

    it('预览指纹使用原始字节 sha256，不把不同二进制内容解码成同一文本', async () => {
      const filePath = abs('binary.dat')
      const targetBytes = Buffer.from([0xff, 0xfe, 0x00, 0x61])
      const currentBytes = Buffer.from([0xff, 0xfd, 0x00, 0x61])
      await fs.writeFile(filePath, targetBytes)
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', filePath)
      await fs.writeFile(filePath, currentBytes)

      const preview = await svc.getRewindPreview('run-1')
      expect(preview.fingerprints).toEqual([
        expect.objectContaining({
          path: 'binary.dat',
          status: 'modified',
          current: expect.objectContaining({
            kind: 'file',
            size: currentBytes.length,
            sha256: createHash('sha256').update(currentBytes).digest('hex'),
          }),
          target: expect.objectContaining({
            kind: 'file',
            size: targetBytes.length,
            sha256: createHash('sha256').update(targetBytes).digest('hex'),
          }),
        }),
      ])
    })

    it('任一受影响路径不允许 → 抛错，且不触碰任何文件（原子拒绝）', async () => {
      await write('a.txt', 'v1')
      await write('b.txt', 'v1')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await svc.trackEdit('run-1', abs('b.txt'))
      await write('a.txt', 'v2')
      await write('b.txt', 'v2')

      // guard 只拒 b.txt；rewind 必须整体拒绝、连 a.txt 也不还原（原子）。
      await expect(
        svc.rewind('run-1', {
          pathGuard: (p) => ({ allowed: !p.endsWith('b.txt'), reason: 'outside workspace' }),
        }),
      ).rejects.toThrow(/blocked by path guard/)

      expect(await read('a.txt')).toBe('v2')
      expect(await read('b.txt')).toBe('v2')
    })

    it('全部允许 → 正常还原（与无 guard 行为一致）', async () => {
      await write('a.txt', 'v1')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 'v2')

      const r = await svc.rewind('run-1', { pathGuard: () => ({ allowed: true }) })
      expect(await read('a.txt')).toBe('v1')
      expect(r.filesRestored).toContain(abs('a.txt'))
    })

    it('guard 只对"会被写/删"的路径调用（unchanged / unsupported 不入 guard）', async () => {
      await write('changed.txt', 'v1')
      await write('same.txt', 'unchanged')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('changed.txt'))
      await svc.trackEdit('run-1', abs('same.txt'))
      await write('changed.txt', 'v2') // 仅 changed 改了

      const seen: string[] = []
      await svc.rewind('run-1', {
        pathGuard: (p) => {
          seen.push(p)
          return { allowed: true }
        },
      })
      // same.txt 未变 → 不在受影响集 → 不过 guard
      expect(seen).toEqual([abs('changed.txt')])
    })
  })

  // ── P2-4 service 级串行互斥 ────────────────────────────────────────

  describe('P2-4 串行互斥', () => {
    it('并发 beginSnapshot + trackEdit + rewind 串行执行，账本不损坏', async () => {
      await write('a.txt', 's0')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 's1')

      // 同时发起三个 mutation/回退；串行锁按入队顺序原子执行，不交错损坏。
      await Promise.all([
        svc.beginSnapshot('run-2'),
        svc.trackEdit('run-2', abs('a.txt')),
        svc.rewind('run-1'),
      ])

      // 锁保证 run-1 anchor 仍完整可达，再次回退稳定到 s0。
      await svc.rewind('run-1')
      expect(await read('a.txt')).toBe('s0')
    })

    it('rewind 与 trackEdit 互斥：rewind 进行中 track 的文件不会被半还原', async () => {
      await write('a.txt', 'v1')
      await svc.beginSnapshot('run-1')
      await svc.trackEdit('run-1', abs('a.txt'))
      await write('a.txt', 'v2')

      // 并发 rewind('run-1') 与 trackEdit('run-1', b.txt)。串行后两者各自完整执行。
      await write('b.txt', 'newfile')
      await Promise.all([
        svc.rewind('run-1'),
        svc.trackEdit('run-1', abs('b.txt')),
      ])
      // a.txt 还原到 v1；不抛错；账本一致。
      expect(await read('a.txt')).toBe('v1')
    })
  })

  // ── §3.9 规则 2 · 子 agent fork 继承父 anchor ──────────────────────
  //
  // 生产链路：子 runtime 经 fork-query 共享父的**同一** FileHistoryService 实例
  // （fileHistory 不 clone），且 query / fork-query / agent-tool 把**父轮 anchorId**
  // 一路透传给所有后代——子的 trackEdit 用父 anchorId（不另建自己的 anchor）。下面
  // 用同一 svc + 同一 anchorId 模拟「父 begin + 父 track + 子 track」，证明回退父轮
  // 一并恢复子改动（= 回退这一轮 = 回退它派生的全部工作）。
  describe('§3.9 规则 2 · 子 agent fork 继承父 anchor', () => {
    it('子用父 anchorId track 的文件，被父 rewind 一并还原（即便之后已有新轮）', async () => {
      await write('parent.txt', 'p0')
      await write('child.txt', 'c0')

      // 父轮开始 + 父 agent 改 parent.txt
      await svc.beginSnapshot('parent-run')
      await svc.trackEdit('parent-run', abs('parent.txt'))
      await write('parent.txt', 'p1')

      // 子 agent fork：**继承父 anchorId**（不建自己的 anchor），改 child.txt
      await svc.trackEdit('parent-run', abs('child.txt'))
      await write('child.txt', 'c1')

      // 之后又来一轮新对话（证明回退不是靠 firstVersion 全局兜底蒙对——parent-run
      // snapshot 自身就持有 child.txt 的 before-backup）
      await svc.beginSnapshot('next-run')
      await svc.trackEdit('next-run', abs('parent.txt'))
      await write('parent.txt', 'p2')

      // 子文件确定性地挂在**父轮** snapshot 上（fileCount=2：parent.txt + child.txt）
      const parentAnchor = svc.listAnchors().find((a) => a.anchorId === 'parent-run')!
      expect(parentAnchor.fileCount).toBe(2)

      // 回退父轮 → 父子改动一并恢复到父轮**开始前**
      const r = await svc.rewind('parent-run')
      expect(await read('parent.txt')).toBe('p0')
      expect(await read('child.txt')).toBe('c0')
      expect(r.filesRestored.sort()).toEqual([abs('parent.txt'), abs('child.txt')].sort())
      expect(r.failedFiles).toHaveLength(0)
    })

    it('孙 agent（深层 fork）继承同一父 anchorId，回退父轮也一并还原', async () => {
      await write('p.txt', 'p0')
      await write('c.txt', 'c0')
      await write('g.txt', 'g0')

      await svc.beginSnapshot('top-run')
      await svc.trackEdit('top-run', abs('p.txt')) // 父
      await svc.trackEdit('top-run', abs('c.txt')) // 子（继承 top-run）
      await svc.trackEdit('top-run', abs('g.txt')) // 孙（继承 top-run）
      await write('p.txt', 'p1')
      await write('c.txt', 'c1')
      await write('g.txt', 'g1')

      const r = await svc.rewind('top-run')
      expect(await read('p.txt')).toBe('p0')
      expect(await read('c.txt')).toBe('c0')
      expect(await read('g.txt')).toBe('g0')
      expect(r.filesRestored).toHaveLength(3)
      expect(r.failedFiles).toHaveLength(0)
    })

    it('子 fork 新建的文件，被父 rewind 删除（absent 语义）', async () => {
      await write('parent.txt', 'p0')
      await svc.beginSnapshot('parent-run')
      await svc.trackEdit('parent-run', abs('parent.txt'))
      await write('parent.txt', 'p1')

      // 子继承父 anchorId，新建 child-new.txt（track 时尚不存在 → absent）
      await svc.trackEdit('parent-run', abs('child-new.txt'))
      await write('child-new.txt', 'created-by-child')

      const r = await svc.rewind('parent-run')
      expect(await read('parent.txt')).toBe('p0')
      expect(await exists('child-new.txt')).toBe(false)
      expect(r.filesDeleted).toContain(abs('child-new.txt'))
      expect(r.failedFiles).toHaveLength(0)
    })

    it('对照：子另建自己的 anchor 时子文件不挂在父轮（这正是 §3.9 要消除的「靠全局 fallback」模糊）', async () => {
      await write('parent.txt', 'p0')
      await write('child.txt', 'c0')

      await svc.beginSnapshot('parent-run')
      await svc.trackEdit('parent-run', abs('parent.txt'))
      await write('parent.txt', 'p1')

      // 旧（错误）模型：子用自己的 runId 另建 anchor
      await svc.beginSnapshot('child-run')
      await svc.trackEdit('child-run', abs('child.txt'))
      await write('child.txt', 'c1')

      // 父轮 snapshot 不含 child.txt——子文件没归到父轮，父 rewind 想恢复子改动只能
      // 靠 resolveTargetBackup 的 firstVersion 全局兜底（顺序/版本敏感、模糊）。继承父
      // anchor 才让子文件确定性挂在父轮（对比上面 fileCount=2 的用例）。
      const parentAnchor = svc.listAnchors().find((a) => a.anchorId === 'parent-run')!
      expect(parentAnchor.fileCount).toBe(1)
      expect(parentAnchor.fileCount).not.toBe(2)
    })
  })
})
