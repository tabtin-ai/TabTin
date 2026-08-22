/**
 * FR-14（H2-D）：Electron 宿主级 SyncQueue 持久化集成测试。
 *
 * 与 Daemon 等价的 cross-instance recover 用例 + Electron 特有：
 *   - 验证 main 进程的 disk 实现只接触 Node fs。
 *   - 验证 ElectronAgentHost 的"启动 bootstrap recover"模式：用一个临
 *     时 SyncQueue 跑 recover 然后立即 dispose，不影响后续 session 的
 *     SyncQueue。
 *
 * 不构造 ElectronAgentHost（拉起 ipcMain / app 副作用，jsdom 不支持），
 * 直接对 FilePersistentQueue + SyncQueue 跑端到端 I/O。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  SyncQueue,
  FilePersistentQueue,
  TelemetryEvents,
  resetTelemetrySink,
  setTelemetrySink,
  buildSyncAccountDir,
  clearSyncAccountDir,
  listSyncAccountOwners,
  OwnerMismatchError,
  type TelemetryRecord,
  type TranscriptEntry,
  type PersistedEntryOwner,
} from '@tabtin/agent-runtime'

const TEST_OWNER: PersistedEntryOwner = {
  userId: 'user-electron-A',
  organizationId: 'wt-electron-1',
  agentId: 'agent-A',
}

const TEST_OWNER_B: PersistedEntryOwner = {
  userId: 'user-electron-B',
  organizationId: 'wt-electron-2',
  agentId: 'agent-B',
}

let tmpDir: string
let captured: TelemetryRecord[]

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-electron-sync-'))
  captured = []
  setTelemetrySink((r) => captured.push(r))
})

afterEach(() => {
  resetTelemetrySink()
  vi.useRealTimers()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function mkEntry(version: number): TranscriptEntry {
  return {
    type: 'user',
    timestamp: Date.now(),
    sessionId: 'sess-electron',
    version,
    message: { role: 'user', content: `m-${version}` },
  }
}

describe('Electron host SyncQueue persistence — bootstrap recover pattern', () => {
  it('Electron 关窗 → 重启 → bootstrap recover 找回未上传 batch', async () => {
    vi.useFakeTimers()

    // LH2-D1：用 owner-aware 路径（与生产 host 一致）
    const ownerDir = buildSyncAccountDir(tmpDir, TEST_OWNER)
    // ── Phase A: 模拟 Electron 进程（含 SessionStorage onWrite → SyncQueue） ──
    const persistA = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDir })
    const sqA = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        throw new Error('Phase A: 网络中断')
      },
      persistentQueue: persistA,
      retryDelaysMs: [10, 10, 10],
      newId: () => 'electron-batch-1',
    })
    sqA.enqueue(mkEntry(1))
    sqA.enqueue(mkEntry(2))
    sqA.enqueue(mkEntry(3))
    const flushP = sqA.flush()
    await vi.advanceTimersByTimeAsync(50)
    await flushP

    // 关窗：dispose syncQueue + 关 disk handle
    await sqA.dispose()
    await persistA.dispose()
    expect(fs.existsSync(path.join(ownerDir, 'pending.jsonl'))).toBe(true)

    // ── Phase B: 重启，模拟 ElectronAgentHost.start() 的 bootstrap recover ──
    const persistB = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDir })
    let recoveredBatch: TranscriptEntry[] | null = null
    const bootstrap = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async (batch) => {
        recoveredBatch = batch
      },
      persistentQueue: persistB,
      retryDelaysMs: [10],
    })
    const result = await bootstrap.recover()
    expect(result).toEqual({ recovered: 1, archived: 0, failed: 0 })
    expect(recoveredBatch).not.toBeNull()
    expect(recoveredBatch!.map((e) => e.version)).toEqual([1, 2, 3])

    // 磁盘条目应被 tombstone 删除
    expect(await persistB.loadAll()).toEqual([])

    await bootstrap.dispose()
    await persistB.dispose()

    // telemetry 双事件应均存在
    const persisted = captured.filter((r) => r.event_name === TelemetryEvents.SYNC_PERSISTED)
    const recovered = captured.filter((r) => r.event_name === TelemetryEvents.SYNC_RECOVERED)
    expect(persisted).toHaveLength(1)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.payload.id).toBe('electron-batch-1')
  })

  it('未配置 uploadFn 时 flush 完全 no-op，磁盘队列为空（保留 v1 兼容）', async () => {
    const ownerDir = buildSyncAccountDir(tmpDir, TEST_OWNER)
    const persist = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDir })
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      // 不传 uploadFn —— flush 应为 no-op
      persistentQueue: persist,
    })
    sq.enqueue(mkEntry(1))
    sq.enqueue(mkEntry(2))
    await sq.flush()

    // 磁盘文件应不存在（FilePersistentQueue 不会主动创建空文件）
    const pendingPath = path.join(ownerDir, 'pending.jsonl')
    expect(fs.existsSync(pendingPath)).toBe(false)

    await sq.dispose()
    await persist.dispose()
  })

  it('两个 session 的 SyncQueue 共享同一 owner 桶 PersistentQueue：互不抢占', async () => {
    const ownerDir = buildSyncAccountDir(tmpDir, TEST_OWNER)
    const persist = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDir })

    const sqA = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => undefined, // 假装总成功，验证不持久化
      persistentQueue: persist,
      telemetryContext: { session_id: 'sess-A', agent_id: 'agent-A' },
    })
    const sqB = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => undefined,
      persistentQueue: persist,
      telemetryContext: { session_id: 'sess-B', agent_id: 'agent-B' },
    })

    sqA.enqueue(mkEntry(11))
    sqB.enqueue(mkEntry(22))
    await Promise.all([sqA.flush(), sqB.flush()])

    expect(await persist.loadAll()).toEqual([])

    const queuedEvents = captured.filter((r) => r.event_name === TelemetryEvents.SYNC_QUEUED)
    expect(queuedEvents).toHaveLength(2)
    const sessionIds = queuedEvents.map((r) => r.session_id).sort()
    expect(sessionIds).toEqual(['sess-A', 'sess-B'])

    await sqA.dispose()
    await sqB.dispose()
    await persist.dispose()
  })

  // ── LH2-D1：账号分桶端到端 ────────────────────────────────────────

  it('LH2-D1：A 上传失败落 disk → B 登入：B 看不到 A 的目录、recover 时不会上传 A 的数据', async () => {
    vi.useFakeTimers()

    // A 账号写入待同步 batch（持续失败）
    const ownerDirA = buildSyncAccountDir(tmpDir, TEST_OWNER)
    const persistA = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDirA })
    const sqA = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => { throw new Error('A network down') },
      persistentQueue: persistA,
      retryDelaysMs: [10],
      newId: () => 'A-batch-1',
    })
    sqA.enqueue(mkEntry(1))
    const p = sqA.flush()
    await vi.advanceTimersByTimeAsync(20)
    await p
    await sqA.dispose()
    await persistA.dispose()

    // B 账号登入：构造 B 自己的桶（不会读到 A 的目录）
    const ownerDirB = buildSyncAccountDir(tmpDir, TEST_OWNER_B)
    expect(fs.existsSync(ownerDirA)).toBe(true)
    expect(fs.existsSync(ownerDirB)).toBe(false)

    const persistB = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDirB })
    let bUploaded = 0
    const sqB = new SyncQueue({
      owner: TEST_OWNER_B,
      uploadFn: async () => { bUploaded += 1 },
      persistentQueue: persistB,
    })
    const result = await sqB.recover()
    // B 的桶里没东西（A 的桶在另一个目录），recover 没动 A 的数据
    expect(result).toEqual({ recovered: 0, archived: 0, failed: 0 })
    expect(bUploaded).toBe(0)
    // A 的目录还在
    expect(fs.existsSync(path.join(ownerDirA, 'pending.jsonl'))).toBe(true)

    await sqB.dispose()
    await persistB.dispose()
  })

  it('LH2-D1：listSyncAccountOwners 启动期能扫到所有账号桶', async () => {
    fs.mkdirSync(buildSyncAccountDir(tmpDir, TEST_OWNER), { recursive: true })
    fs.mkdirSync(buildSyncAccountDir(tmpDir, TEST_OWNER_B), { recursive: true })

    const owners = await listSyncAccountOwners(tmpDir)
    expect(owners).toHaveLength(2)
    expect(owners.map((o) => `${o.userId}/${o.organizationId}`).sort()).toEqual([
      `${TEST_OWNER.userId}/${TEST_OWNER.organizationId}`,
      `${TEST_OWNER_B.userId}/${TEST_OWNER_B.organizationId}`,
    ])
  })

  // ── LH2-D2：登出清理目录 ────────────────────────────────────────

  it('LH2-D2：clearSyncAccountDir 只清当前账号目录，其他账号目录保留', async () => {
    const dirA = buildSyncAccountDir(tmpDir, TEST_OWNER)
    const dirB = buildSyncAccountDir(tmpDir, TEST_OWNER_B)
    fs.mkdirSync(dirA, { recursive: true })
    fs.mkdirSync(dirB, { recursive: true })
    fs.writeFileSync(path.join(dirA, 'pending.jsonl'), 'A entry\n')
    fs.writeFileSync(path.join(dirB, 'pending.jsonl'), 'B entry\n')

    await clearSyncAccountDir(tmpDir, TEST_OWNER)

    expect(fs.existsSync(dirA)).toBe(false)
    expect(fs.existsSync(dirB)).toBe(true)
    expect(fs.readFileSync(path.join(dirB, 'pending.jsonl'), 'utf-8')).toBe('B entry\n')
  })

  // ── LH2-D3：上传前 owner mismatch ────────────────────────────────

  it('LH2-D3：手动把 A 的 entry 复制到 B 桶 → B recover 时拒绝上传', async () => {
    // A 写入 + dispose
    const dirA = buildSyncAccountDir(tmpDir, TEST_OWNER)
    const persistA = new FilePersistentQueue<TranscriptEntry[]>({ dir: dirA })
    await persistA.append({
      id: 'leak-1',
      payload: [mkEntry(1)],
      createdAt: Date.now() - 1000,
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    })
    await persistA.dispose()

    // 模拟"手动拷贝文件到 B 桶"——A 的 pending.jsonl 直接复制到 B 桶
    const dirB = buildSyncAccountDir(tmpDir, TEST_OWNER_B)
    fs.mkdirSync(dirB, { recursive: true })
    fs.copyFileSync(path.join(dirA, 'pending.jsonl'), path.join(dirB, 'pending.jsonl'))

    // B 用 B 自己的 owner 跑 recover：应当拒绝（owner mismatch）
    const persistB = new FilePersistentQueue<TranscriptEntry[]>({ dir: dirB })
    let uploadedByB = 0
    const seenErrors: OwnerMismatchError[] = []
    const sqB = new SyncQueue({
      owner: TEST_OWNER_B,
      uploadFn: async () => { uploadedByB += 1 },
      persistentQueue: persistB,
      onError: (err) => {
        if (err instanceof OwnerMismatchError) seenErrors.push(err)
      },
    })
    const result = await sqB.recover()
    expect(result.failed).toBe(1)
    expect(uploadedByB).toBe(0) // 关键：B 的凭证没有发 A 的数据
    expect(seenErrors).toHaveLength(1)
    expect(seenErrors[0]!.entryOwner.userId).toBe(TEST_OWNER.userId)
    // entry 仍然在磁盘上（不删除、不归档）
    expect(await persistB.loadAll()).toHaveLength(1)
    await sqB.dispose()
    await persistB.dispose()
  })

  // 技术 Review #2（H2-D）：bootstrap recover 失败的可观测性
  // 模拟宿主 start() 时 bootstrap SyncQueue 的 onError 接线——loadAll 抛错应转
  // SYNC_BOOTSTRAP_RECOVER_FAILED telemetry。这正是 ElectronAgentHost.start() 现在
  // 的接线模式（onError 注入 → 转 telemetry），本测试锁定该契约不再回归。
  it('bootstrap onError 注入：recover 内 loadAll 失败时发 sync.bootstrap_recover_failed', async () => {
    const ownerDir = buildSyncAccountDir(tmpDir, TEST_OWNER)
    const persist = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDir })
    persist.loadAll = async () => {
      throw new Error('disk corrupted')
    }

    // 模拟 ElectronAgentHost.start() 的 bootstrap 接线
    const bootstrap = new SyncQueue({
      owner: TEST_OWNER,
      persistentQueue: persist,
      ownsPersistentQueue: false,
      onError: (err, ctx) => {
        // 转译为 telemetry（与 ElectronAgentHost 的 onError 等价）
        const message = err instanceof Error ? err.message : String(err)
        captured.push({
          event_name: TelemetryEvents.SYNC_BOOTSTRAP_RECOVER_FAILED,
          payload: { host: 'electron', phase: ctx.phase, error_message: message },
        } as TelemetryRecord)
      },
    })

    // recover 不应抛错（保 startup 不被阻塞）
    const result = await bootstrap.recover()
    expect(result).toEqual({ recovered: 0, archived: 0, failed: 0 })

    // 但 telemetry 必须发出来
    const events = captured.filter(
      (r) => r.event_name === TelemetryEvents.SYNC_BOOTSTRAP_RECOVER_FAILED,
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({
      host: 'electron',
      phase: 'recover',
      error_message: 'disk corrupted',
    })

    await bootstrap.dispose()
    await persist.dispose()
  })
})
