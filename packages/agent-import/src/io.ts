/**
 * 注入式 IO 层：adapter 只面向本接口，不直接 import fs/child_process。
 *
 * - 宿主（Electron 主进程 utilityProcess / CLI / 测试）提供实现；
 *   源目录白名单是宿主实现内部的路径策略（PRD §5.3），本包不做边界判定。
 * - 只读契约：本接口不提供任何写能力——对源工具目录零写入是产品承诺（PRD §6.1）。
 *   attachmentDir 抽图属于导出目录，由宿主单独提供 writeAttachment。
 * - sqlite 双策略（PRD §5.2）：小库（Codex/WorkBuddy，被运行中进程持锁）
 *   copySnapshot 三件套后打开；大库（Cursor 15.78GB）readonly 直开原库、
 *   backup 库 immutable 打开。查询走 Node / Electron 内置 `node:sqlite`
 *  （不依赖系统 sqlite3 CLI——Windows 默认无该工具，）；大库查询
 *   在 worker 线程执行并硬超时 terminate，避免挂死导入。
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

/** sqlite：unable to open database file (14) / SQLITE_CANTOPEN */
function isSqliteCantOpen(err: unknown): boolean {
  if (err && typeof err === 'object' && 'errcode' in err && (err as { errcode?: number }).errcode === 14) {
    return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  return /unable to open database file(?:\s*\(14\))?/i.test(msg)
}

/** Windows 对打开中的库常强制锁：copyFile 报 EBUSY / EPERM，需回退直开。 */
function isFileBusy(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

/**
 * 单条 sqlite 查询硬超时（ms）。运行中的 Cursor 主库（实测 15GB 活库）被边写边读时，
 * 即便走主键索引、EXPLAIN 正常，实际取数据页的 I/O 仍可能长时间挂起。
 * 大库查询放 worker：超时 terminate，把"查询挂起"降级为"该会话少量正文回填缺失"。
 */
const SQLITE_QUERY_TIMEOUT_MS = 8000

export interface SqliteQueryOptions {
  /** mode=ro（默认 true；本包内没有任何写场景） */
  readonly?: boolean
  /** 无 -wal/-shm 的备份库需 immutable=1 才打得开（Cursor state.vscdb.backup 实测） */
  immutable?: boolean
  /**
   * 持锁小库：先把 db(+wal/shm) 拷到临时目录再查（Codex/WorkBuddy 实测被
   * 运行中客户端锁住，直接 readonly 打开报 unable to open）。
   * 未显式 immutable 时先 mode=ro（可吃到已拷贝的 WAL 帧）；若报
   * unable to open database file (14)（WAL 主文件缺 sidecar）再回退 immutable=1。
   */
  copySnapshot?: boolean
}

export interface ImportIO {
  exists(p: string): Promise<boolean>
  stat(p: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean } | null>
  readdir(p: string): Promise<string[]>
  readTextFile(p: string, maxBytes?: number): Promise<string>
  /** 二进制读（WorkBuddy blobs/ 既存图片文件抽入 attachmentDir，保产物自包含） */
  readBinaryFile(p: string): Promise<Buffer>
  /** 流式逐行（单行可达 7MB、单文件 102MB——绝不整读，PRD §5.2 硬约束） */
  readJsonlLines(p: string): AsyncIterable<string>
  /** 返回行对象数组。SQL 由 adapter 提供，只读。 */
  querySqlite(dbPath: string, sql: string, opts?: SqliteQueryOptions): Promise<Record<string, unknown>[]>
  /** 抽出的 base64 图片落盘，返回文件路径（宿主决定目录与配额） */
  writeAttachment(suggestedName: string, data: Buffer): Promise<string>
  env(name: string): string | undefined
  homedir(): string
  /** 宿主 OS；路径白名单按平台分支（Cursor/Claude Desktop 的 Application Support） */
  platform(): NodeJS.Platform
}

function openReadonlyDb(dbPath: string, immutable: boolean): DatabaseSync {
  if (immutable) {
    const url = pathToFileURL(dbPath)
    url.search = 'immutable=1'
    return new DatabaseSync(url, { readOnly: true })
  }
  return new DatabaseSync(dbPath, { readOnly: true })
}

/** 同步只读查询；cantOpen 时自动 immutable 回退（除非已强制 immutable）。 */
export function querySqliteSync(
  dbPath: string,
  sql: string,
  forceImmutable = false,
): Record<string, unknown>[] {
  const run = (immutable: boolean): Record<string, unknown>[] => {
    const db = openReadonlyDb(dbPath, immutable)
    try {
      return db.prepare(sql).all() as Record<string, unknown>[]
    } finally {
      db.close()
    }
  }
  try {
    return run(forceImmutable)
  } catch (err) {
    if (!forceImmutable && isSqliteCantOpen(err)) return run(true)
    throw err
  }
}

/**
 * worker 源码（eval + type:module）：与 querySqliteSync 同语义，便于超时 terminate。
 * 不 import 本包路径，避免打包 / 路径解析问题。
 */
const SQLITE_QUERY_WORKER_SOURCE = `
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

function isCantOpen(err) {
  if (err && typeof err === 'object' && err.errcode === 14) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /unable to open database file(?:\\s*\\(14\\))?/i.test(msg)
}

function openReadonlyDb(dbPath, immutable) {
  if (immutable) {
    const url = pathToFileURL(dbPath)
    url.search = 'immutable=1'
    return new DatabaseSync(url, { readOnly: true })
  }
  return new DatabaseSync(dbPath, { readOnly: true })
}

function run(dbPath, sql, forceImmutable) {
  const once = (immutable) => {
    const db = openReadonlyDb(dbPath, immutable)
    try {
      return db.prepare(sql).all()
    } finally {
      db.close()
    }
  }
  try {
    return once(forceImmutable)
  } catch (err) {
    if (!forceImmutable && isCantOpen(err)) return once(true)
    throw err
  }
}

try {
  const { dbPath, sql, forceImmutable } = workerData
  const rows = run(dbPath, sql, forceImmutable === true)
  parentPort.postMessage({ ok: true, rows })
} catch (err) {
  parentPort.postMessage({
    ok: false,
    message: err instanceof Error ? err.message : String(err),
    cantOpen: isCantOpen(err),
  })
}
`

type WorkerResult =
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; message: string; cantOpen?: boolean }

function querySqliteInWorker(
  dbPath: string,
  sql: string,
  forceImmutable: boolean,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    const worker = new Worker(SQLITE_QUERY_WORKER_SOURCE, {
      eval: true,
      // @types/node@20 的 WorkerOptions 尚未含 type:'module'；Node 20.10+/22 运行时支持
      ...({ type: 'module' } as object),
      workerData: { dbPath, sql, forceImmutable },
    })
    const timer = setTimeout(() => {
      timedOut = true
      void worker.terminate()
    }, SQLITE_QUERY_TIMEOUT_MS)

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    worker.on('message', (msg: WorkerResult) => {
      finish(() => {
        if (msg.ok) resolve(msg.rows)
        else reject(new Error(msg.message))
      })
    })
    worker.on('error', (err) => {
      finish(() => reject(err))
    })
    worker.on('exit', (code) => {
      finish(() => {
        if (timedOut) {
          const err = new Error(
            `sqlite query timed out after ${SQLITE_QUERY_TIMEOUT_MS}ms`,
          ) as Error & { killed?: boolean }
          err.killed = true
          reject(err)
          return
        }
        if (code !== 0) reject(new Error(`sqlite worker exited with code ${code}`))
      })
    })
  })
}

/** Node 直连实现：CLI 宿主与单测直接用；Electron 主进程可原样复用。 */
export class NodeImportIO implements ImportIO {
  /** 本次 IO 生命周期内已证实"查询挂起超时"的原始库路径——熔断：后续查询直接空返回，
   *  避免每个会话都白等一次超时（同一导入 run 复用同一 io 实例，见 runner.this.io）。 */
  private readonly degradedDbs = new Set<string>()

  constructor(private readonly attachmentRoot?: string) {}

  async exists(p: string): Promise<boolean> {
    try {
      await fsp.access(p)
      return true
    } catch {
      return false
    }
  }

  async stat(p: string) {
    try {
      const s = await fsp.stat(p)
      return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() }
    } catch {
      return null
    }
  }

  async readdir(p: string): Promise<string[]> {
    try {
      return await fsp.readdir(p)
    } catch {
      return []
    }
  }

  async readTextFile(p: string, maxBytes?: number): Promise<string> {
    if (maxBytes == null) return fsp.readFile(p, 'utf8')
    const fd = await fsp.open(p, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      const { bytesRead } = await fd.read(buf, 0, maxBytes, 0)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await fd.close()
    }
  }

  async readBinaryFile(p: string): Promise<Buffer> {
    return fsp.readFile(p)
  }

  async *readJsonlLines(p: string): AsyncIterable<string> {
    const stream = fs.createReadStream(p, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of rl) yield line
    } finally {
      rl.close()
      stream.destroy()
    }
  }

  async querySqlite(
    dbPath: string,
    sql: string,
    opts: SqliteQueryOptions = {},
  ): Promise<Record<string, unknown>[]> {
    // 熔断：已证实挂起的库直接空返回（best-effort 降级，不再逐会话白等超时）。
    if (this.degradedDbs.has(dbPath)) return []
    let target = dbPath
    let tmpDir: string | null = null
    let usedSnapshot = false
    if (opts.copySnapshot) {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-import-db-'))
      target = path.join(tmpDir, path.basename(dbPath))
      try {
        await fsp.copyFile(dbPath, target)
        for (const suffix of ['-wal', '-shm']) {
          try {
            await fsp.copyFile(dbPath + suffix, target + suffix)
          } catch {
            /* 无 wal/shm 属正常 */
          }
        }
        usedSnapshot = true
      } catch (err) {
        // Windows 独占锁：拷贝失败则退回直开原库（只读 / immutable 回退仍生效）。
        if (!isFileBusy(err)) throw err
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
        tmpDir = null
        target = dbPath
        usedSnapshot = false
      }
    }
    const forceImmutable = opts.immutable === true

    try {
      // 小库快照：进程内查即可（拷贝后无持锁风险，且避免每条查询拉起 worker）。
      // 大库直开 / 快照失败回退：worker + 硬超时，防止 Cursor 活库 I/O 挂死导入。
      if (usedSnapshot) {
        return querySqliteSync(target, sql, forceImmutable)
      }
      return await querySqliteInWorker(target, sql, forceImmutable)
    } catch (err) {
      if ((err as { killed?: boolean })?.killed) {
        if (!usedSnapshot) this.degradedDbs.add(dbPath)
        return []
      }
      throw err
    } finally {
      if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true })
    }
  }

  async writeAttachment(suggestedName: string, data: Buffer): Promise<string> {
    const root =
      this.attachmentRoot ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-import-att-')))
    await fsp.mkdir(root, { recursive: true })
    const safe = suggestedName.replace(/[^A-Za-z0-9._-]/g, '_')
    const target = path.join(root, `${Date.now()}-${safe}`)
    await fsp.writeFile(target, data)
    return target
  }

  env(name: string): string | undefined {
    return process.env[name]
  }

  homedir(): string {
    return os.homedir()
  }

  platform(): NodeJS.Platform {
    return process.platform
  }
}
