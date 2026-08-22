/**
 * EventPersistence — NDJSON file-based event storage for run sessions.
 *
 * Persists browser automation events so they survive app restarts and
 * can be used for replay, auditing, and video generation.
 *
 * Storage layout:
 *   {dataRoot}/users/{userId}/organizations/{organizationId}/run-events/{runId}.ndjson
 *
 * Each line is a self-contained JSON record:
 *   {"id":1,"runId":"...","viewId":"...","type":"...","timestamp":...,"data":...,"context":...}
 *
 * Why NDJSON instead of SQLite:
 *   - Zero native dependencies (no electron-rebuild breakage on Electron upgrades)
 *   - Async appendFile avoids blocking the main-process event loop
 *   - Access patterns (append per run, read per run, delete by age) map 1:1 to files
 */

import { app } from 'electron'
import { join } from 'node:path'
import {
  existsSync, mkdirSync, readdirSync, statSync,
  readFileSync, unlinkSync,
} from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { getBucket, registerStorageBucket } from '@tabtin/storage-manager'
import { resolveDataRoot, resolveOrganizationRoot } from '@tabtin/terminal-core'
import { createLogger } from '../logger'
import { TokenManager } from '../auth'
import { getCLIOrganizationId } from '../cli/cli-context'

const log = createLogger('EventPersistence')

export interface PersistedEvent {
  id?: number
  runId: string
  viewId?: string
  type: string
  timestamp: number
  data?: any
  context?: any
}

const MAX_FLUSH_RETRIES = 3
const QUEUE_SOFT_LIMIT = 500
const QUEUE_HARD_LIMIT = 1000
const DROP_LOG_INTERVAL_MS = 5000

const HIGH_PRIORITY_TYPES = new Set([
  'navigation', 'error', 'click', 'input', 'page-load',
  'run-start', 'run-end', 'step-start', 'step-end',
  'task-start', 'task-end', 'fatal',
])

interface EventOwner {
  userId: string
  organizationId: string
}

export interface EventPersistenceOwnerScope {
  dataRoot: string
  getCurrentOwner: () => EventOwner | null
}

type QueuedEvent = PersistedEvent & {
  _dataDir: string
  _flushRetries?: number
}

export class EventPersistence {
  private dataDir: string
  private writeQueue: QueuedEvent[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private retentionDays = 14
  private initialized = false
  private _initPromise: Promise<void> | null = null
  private _flushLock: Promise<void> = Promise.resolve()
  private _droppedSinceLastLog = 0
  private _lastDropLogTime = 0
  private readonly ownerScope: EventPersistenceOwnerScope | null
  private readonly initializedDataDirs = new Set<string>()

  constructor(dataDir?: string, ownerScope?: EventPersistenceOwnerScope) {
    this.dataDir = dataDir || join(app.getPath('userData'), 'run-events')
    this.ownerScope = ownerScope ?? null
  }

  async init(): Promise<void> {
    if (this.initialized) return
    if (this._initPromise) return this._initPromise

    this._initPromise = this._doInit()
    return this._initPromise
  }

  private async _doInit(): Promise<void> {
    try {
      const dataDir = this.resolveCurrentDataDir()
      if (dataDir) this.ensureDataDir(dataDir)
      // 旧版本写在设备级全局目录。它们无法安全迁移给任何账号，因此只延续
      // 原有 14 天 TTL，不参与读取、回放或存储管理。
      if (this.ownerScope && existsSync(this.dataDir)) {
        this.cleanOldEvents(this.dataDir)
      }

      this.initialized = true

      // RP-030 fix: 定时器在初始化成功后才启动，防止初始化失败时
      // 定时器不断触发 flush → 重试 init 的竞态循环
      if (!this.flushTimer) {
        this.flushTimer = setInterval(() => {
          this.flush().catch(err => log.error('定时 flush 失败', err))
        }, 1000)
      }

      log.info('初始化完成', { dataDir: dataDir ?? '等待登录身份' })
    } catch (err) {
      this._initPromise = null
      log.error('初始化失败', { dataDir: this.dataDir }, err)
      throw err
    }
  }

  addEvent(event: PersistedEvent): void {
    const dataDir = this.resolveCurrentDataDir()
    if (!dataDir) {
      this._recordDrop(event, '无法解析当前用户或组织')
      return
    }
    if (this.ownerScope) {
      try {
        this.ensureDataDir(dataDir)
      } catch (err) {
        log.error('事件目录初始化失败，拒绝落盘', { dataDir }, err)
        return
      }
    }

    const queueLen = this.writeQueue.length

    if (queueLen >= QUEUE_HARD_LIMIT) {
      this._recordDrop(event)
      return
    }

    if (queueLen >= QUEUE_SOFT_LIMIT && !HIGH_PRIORITY_TYPES.has(event.type)) {
      this._recordDrop(event)
      return
    }

    this.writeQueue.push({ ...event, _dataDir: dataDir })

    if (this.writeQueue.length >= 50) {
      void this.flush()
    }
  }

  private _recordDrop(event: PersistedEvent, reason = '背压限制'): void {
    this._droppedSinceLastLog++
    const now = Date.now()
    if (now - this._lastDropLogTime >= DROP_LOG_INTERVAL_MS) {
      log.warn('背压丢弃事件', {
        droppedSinceLastLog: this._droppedSinceLastLog,
        queue: this.writeQueue.length,
        latestType: event.type,
        reason,
      })
      this._droppedSinceLastLog = 0
      this._lastDropLogTime = now
    }
  }

  flush(): Promise<void> {
    let releaseLock!: () => void
    const prev = this._flushLock
    this._flushLock = new Promise(r => { releaseLock = r })

    return prev
      .then(() => this._doFlush())
      .finally(() => releaseLock())
  }

  private async _doFlush(): Promise<void> {
    if (this.writeQueue.length === 0) return

    if (!this.initialized) {
      try {
        await this.init()
      } catch {
        return
      }
    }

    if (!this.initialized) return

    const events = this.writeQueue.splice(0) as QueuedEvent[]

    const grouped = new Map<string, QueuedEvent[]>()
    for (const evt of events) {
      const key = `${evt._dataDir}\0${evt.runId}`
      let list = grouped.get(key)
      if (!list) {
        list = []
        grouped.set(key, list)
      }
      list.push(evt)
    }

    const toRetry: QueuedEvent[] = []

    for (const evts of grouped.values()) {
      const first = evts[0]
      if (!first) continue
      const { runId } = first
      const dataDir = this.ownerScope ? first._dataDir : this.dataDir
      try {
        const filePath = this.runFilePath(runId, dataDir)
        const lines = evts.map(evt => JSON.stringify({
          runId: evt.runId,
          viewId: evt.viewId || null,
          type: evt.type,
          timestamp: evt.timestamp,
          data: evt.data ?? null,
          context: evt.context ?? null,
        })).join('\n') + '\n'

        await appendFile(filePath, lines, 'utf-8')
      } catch (err) {
        log.error('flush 写盘失败', { runId, eventCount: evts.length }, err)
        for (const evt of evts) {
          const retries = (evt._flushRetries ?? 0) + 1
          if (retries <= MAX_FLUSH_RETRIES) {
            evt._flushRetries = retries
            toRetry.push(evt)
          } else {
            log.error('事件达到最大重试次数，丢弃', {
              runId,
              type: evt.type,
              retries,
            })
          }
        }
      }
    }

    if (toRetry.length > 0) {
      this.writeQueue.unshift(...toRetry)
    }
  }

  getEvents(runId: string, since?: number): PersistedEvent[] {
    const dataDir = this.resolveCurrentDataDir()
    if (!dataDir) return []
    const filePath = this.runFilePath(runId, dataDir)
    if (!existsSync(filePath)) return []

    try {
      const content = readFileSync(filePath, 'utf-8')
      const events: PersistedEvent[] = []

      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const evt = JSON.parse(line) as PersistedEvent
          if (since != null && evt.timestamp <= since) continue
          events.push({
            ...evt,
            data: evt.data ?? undefined,
            context: evt.context ?? undefined,
          })
        } catch { /* skip malformed lines */ }
      }

      return events.sort((a, b) => a.timestamp - b.timestamp)
    } catch (err) {
      log.error('getEvents 读盘失败', { runId }, err)
      return []
    }
  }

  listRuns(dataDir = this.resolveCurrentDataDir()): Array<{
    runId: string
    eventCount: number
    firstEvent: number
    lastEvent: number
  }> {
    if (!dataDir || !existsSync(dataDir)) return []
    try {
      const files = readdirSync(dataDir).filter(f => f.endsWith('.ndjson'))
      const runs: Array<{ runId: string; eventCount: number; firstEvent: number; lastEvent: number }> = []

      for (const file of files) {
        const encodedRunId = file.slice(0, -'.ndjson'.length)
        const runId = Buffer.from(encodedRunId, 'base64url').toString()
        const filePath = join(dataDir, file)
        const content = readFileSync(filePath, 'utf-8')
        const lines = content.split('\n').filter(l => l.trim())

        if (lines.length === 0) continue

        let firstEvent = Infinity
        let lastEvent = -Infinity
        let eventCount = 0

        for (const line of lines) {
          try {
            const evt = JSON.parse(line)
            eventCount++
            if (evt.timestamp < firstEvent) firstEvent = evt.timestamp
            if (evt.timestamp > lastEvent) lastEvent = evt.timestamp
          } catch { /* skip */ }
        }

        if (eventCount > 0) {
          runs.push({ runId, eventCount, firstEvent, lastEvent })
        }
      }

      return runs.sort((a, b) => b.lastEvent - a.lastEvent)
    } catch (err) {
      log.error('listRuns 失败', err)
      return []
    }
  }

  private cleanOldEvents(dataDir: string): void {
    try {
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000
      const files = readdirSync(dataDir).filter(f => f.endsWith('.ndjson'))
      let cleaned = 0

      for (const file of files) {
        const filePath = join(dataDir, file)
        const stat = statSync(filePath)
        if (stat.mtimeMs < cutoff) {
          unlinkSync(filePath)
          cleaned++
        }
      }

      if (cleaned > 0) {
        log.info('清理过期事件文件', { cleaned })
      }
    } catch (err) {
      log.error('清理过期事件文件失败', err)
    }
  }

  private runFilePath(runId: string, dataDir: string): string {
    const safeRunId = Buffer.from(runId).toString('base64url')
    return join(dataDir, `${safeRunId}.ndjson`)
  }

  private cleanLegacySqliteDb(dataDir: string): void {
    try {
      const legacyDb = join(dataDir, 'events.db')
      if (existsSync(legacyDb)) {
        unlinkSync(legacyDb)
        log.info('已移除遗留 SQLite 数据库: events.db')
      }
      const legacyWal = join(dataDir, 'events.db-wal')
      if (existsSync(legacyWal)) unlinkSync(legacyWal)
      const legacyShm = join(dataDir, 'events.db-shm')
      if (existsSync(legacyShm)) unlinkSync(legacyShm)
    } catch (err) {
      log.warn('清理遗留 db 失败', err)
    }
  }

  /** 当前账号/组织的唯一事件目录；身份缺失时 fail closed。 */
  getCurrentDataDir(): string | null {
    return this.resolveCurrentDataDir()
  }

  /**
   * 存储状态是设备视角：列出当前登录用户在本设备上的全部组织事件目录。
   * 事件写入与回放仍只使用当前组织目录，避免跨组织读取运行态数据。
   */
  getCurrentUserDataDirs(): Array<{ organizationId: string; dataDir: string }> {
    if (!this.ownerScope) {
      return [{ organizationId: 'legacy', dataDir: this.dataDir }]
    }
    const owner = this.ownerScope.getCurrentOwner()
    if (!owner?.userId) return []
    const organizationsRoot = join(
      this.ownerScope.dataRoot,
      'users',
      owner.userId,
      'organizations',
    )
    try {
      return readdirSync(organizationsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => ({
          organizationId: entry.name,
          dataDir: join(organizationsRoot, entry.name, 'run-events'),
        }))
    } catch {
      return []
    }
  }

  private resolveCurrentDataDir(): string | null {
    if (!this.ownerScope) return this.dataDir
    const owner = this.ownerScope.getCurrentOwner()
    if (!owner?.userId || !owner.organizationId) return null
    return join(
      resolveOrganizationRoot(
        this.ownerScope.dataRoot,
        owner.userId,
        owner.organizationId,
      ),
      'run-events',
    )
  }

  private ensureDataDir(dataDir: string): void {
    if (this.initializedDataDirs.has(dataDir)) return
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    this.cleanOldEvents(dataDir)
    this.cleanLegacySqliteDb(dataDir)
    this.initializedDataDirs.add(dataDir)
  }

  pauseFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  resumeFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setInterval(() => this.flush(), 1000)
  }

  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }
}

let sharedInstance: EventPersistence | null = null

export function getEventPersistence(): EventPersistence {
  if (!sharedInstance) {
    sharedInstance = new EventPersistence(undefined, {
      dataRoot: resolveDataRoot(),
      getCurrentOwner: () => {
        const userInfo = TokenManager.getCachedUserInfo() as {
          id?: unknown
          user_id?: unknown
          userId?: unknown
        } | null
        const rawUserId = userInfo?.id ?? userInfo?.user_id ?? userInfo?.userId
        const organizationId = getCLIOrganizationId()
        if (rawUserId === undefined || rawUserId === null || rawUserId === '' || !organizationId) {
          return null
        }
        return { userId: String(rawUserId), organizationId }
      },
    })
    void sharedInstance.init()
    _registerRunEventsBucket(sharedInstance)
  }
  return sharedInstance
}

// ─── storage-manager 注册（agent:run-events） ──────────────────
// W2.2-G2：browser-automation run 的 NDJSON 事件流，14 天 TTL 自动清理。
// 路径：`{dataRoot}/users/{userId}/organizations/{organizationId}/run-events/
// {base64url(runId)}.ndjson`。
// semi-cache——清掉后旧 run 无法 replay/重看，但当前 run 不受影响，云端
// 不会有这些事件流（仅本地 audit/replay 用）。
const RUN_EVENTS_BUCKET_ID = 'agent:run-events'

function _registerRunEventsBucket(instance: EventPersistence): void {
  if (getBucket(RUN_EVENTS_BUCKET_ID)) return

  const scanFiles = (): { bytes: number; count: number } => {
    let bytes = 0
    let count = 0
    for (const { dataDir } of instance.getCurrentUserDataDirs()) {
      if (!existsSync(dataDir)) continue
      try {
        for (const file of readdirSync(dataDir)) {
          if (!file.endsWith('.ndjson')) continue
          try {
            bytes += statSync(join(dataDir, file)).size
            count++
          } catch { /* skip unreadable */ }
        }
      } catch { /* dir read failure */ }
    }
    return { bytes, count }
  }

  registerStorageBucket({
    id: RUN_EVENTS_BUCKET_ID,
    category: 'semi-cache',
    group: 'browser',
    displayName: 'Browser-Run 事件流',
    description: '浏览器自动化 run 的 NDJSON 事件流（14 天自动清理）',
    sizeFn: async () => {
      const { bytes, count } = scanFiles()
      return { bytes, itemCount: count }
    },
    listFn: async () => {
      return instance.getCurrentUserDataDirs().flatMap(({ organizationId, dataDir }) =>
        instance.listRuns(dataDir).map((run) => {
          const safeRunId = Buffer.from(run.runId).toString('base64url')
          const filePath = join(dataDir, `${safeRunId}.ndjson`)
          let bytes: number | undefined
          try {
            bytes = statSync(filePath).size
          } catch { /* file may disappear between list and stat */ }
          const timestamp = run.firstEvent
            ? new Date(run.firstEvent).toLocaleString('zh-CN', { hour12: false })
            : '时间未知'
          return {
            id: Buffer.from(JSON.stringify([organizationId, run.runId])).toString('base64url'),
            label: `${timestamp} 的浏览器自动化记录（${run.eventCount} 条事件）`,
            ...(bytes !== undefined ? { bytes } : {}),
            metadata: {
              organizationId,
              runId: run.runId,
              eventCount: run.eventCount,
              firstEvent: run.firstEvent,
              lastEvent: run.lastEvent,
            },
          }
        }),
      )
    },
    clearFn: async (options) => {
      const targetIds = options?.itemIds && options.itemIds.length > 0
        ? new Set(options.itemIds)
        : null
      let clearedItemCount = 0
      let freedBytes = 0
      for (const { organizationId, dataDir } of instance.getCurrentUserDataDirs()) {
        if (!existsSync(dataDir)) continue
        for (const file of readdirSync(dataDir)) {
          if (!file.endsWith('.ndjson')) continue
          const runId = Buffer.from(file.slice(0, -'.ndjson'.length), 'base64url').toString()
          const itemId = Buffer.from(JSON.stringify([organizationId, runId])).toString('base64url')
          if (targetIds && !targetIds.has(itemId)) continue
          const filePath = join(dataDir, file)
          const bytes = statSync(filePath).size
          if (!options?.dryRun) unlinkSync(filePath)
          clearedItemCount++
          freedBytes += bytes
        }
      }
      return { clearedItemCount, freedBytes }
    },
  })
}
