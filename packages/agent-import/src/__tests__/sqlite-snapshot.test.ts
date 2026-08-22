/**
 * 回归：WAL 主库在无 -wal/-shm sidecar 时，copySnapshot 必须能打开。
 * 复现用户症状：unable to open database file (14)。
 * 另：有 sidecar 时须读到未 checkpoint 的 WAL 帧（不能一律 immutable）。
 *
 * 夹具用 node:sqlite 建库，不依赖系统 sqlite3 CLI（Windows 默认无，）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeImportIO } from '../io.js'

const tmpDirs: string[] = []

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    for (let i = 0; i < 5; i++) {
      try {
        await fsp.rm(dir, { recursive: true, force: true })
        break
      } catch (err) {
        // Windows：持锁进程刚 kill 时目录仍可能 EBUSY
        if (!['EBUSY', 'EPERM'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
        await new Promise((r) => setTimeout(r, 100))
      }
    }
  }
})

async function makeWalDbWithoutSidecars(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-import-wal-'))
  tmpDirs.push(dir)
  const db = path.join(dir, 'workbuddy.db')
  const conn = new DatabaseSync(db)
  try {
    conn.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE sessions(
        id TEXT, cwd TEXT, created_at INT, updated_at INT,
        last_activity_at INT, deleted_at INT
      );
      INSERT INTO sessions VALUES('s1','/ws',1,2,2,NULL);
    `)
  } finally {
    conn.close()
  }
  for (const suffix of ['-wal', '-shm'] as const) {
    await fsp.unlink(db + suffix).catch(() => undefined)
  }
  expect(await fsp.readdir(dir)).toEqual(['workbuddy.db'])
  return db
}

/** 持锁写入连接，避免关闭时自动 checkpoint 清空 WAL（node:sqlite 子进程，免 python）。 */
function holdWalWriter(db: string): Promise<{ kill: () => void }> {
  return new Promise((resolve, reject) => {
    const script = `
import { DatabaseSync } from 'node:sqlite';
import { createWriteStream } from 'node:fs';
const db = new DatabaseSync(${JSON.stringify(db)});
db.exec("PRAGMA journal_mode=WAL");
db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY)");
db.prepare("INSERT INTO sessions VALUES(?)").run("s1");
db.prepare("INSERT INTO sessions VALUES(?)").run("s2");
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`
    const child: ChildProcess = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    })
    let settled = false
    const fail = (err: Error) => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        reject(err)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!settled && chunk.toString().includes('ready')) {
        settled = true
        resolve({ kill: () => child.kill('SIGKILL') })
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      // node:sqlite experimental 警告可忽略
      if (/ExperimentalWarning|SQLite is an experimental/i.test(text)) return
      fail(new Error(text))
    })
    child.on('error', fail)
    child.on('exit', (code) => {
      if (!settled) fail(new Error(`wal holder exited early: ${code}`))
    })
  })
}

describe('NodeImportIO querySqlite copySnapshot', () => {
  it('WAL 主文件无 sidecar 时 copySnapshot 可读（mode=ro error 14 → immutable 回退）', async () => {
    const db = await makeWalDbWithoutSidecars()
    const io = new NodeImportIO()
    const rows = await io.querySqlite(
      db,
      'SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL',
      { copySnapshot: true },
    )
    expect(rows).toEqual([{ n: 1 }])
  })

  it('显式 immutable 与 copySnapshot 组合同样可读', async () => {
    const db = await makeWalDbWithoutSidecars()
    const io = new NodeImportIO()
    const rows = await io.querySqlite(db, 'SELECT COUNT(*) AS n FROM sessions', {
      copySnapshot: true,
      immutable: true,
    })
    expect(rows).toEqual([{ n: 1 }])
  })

  it('三件套快照 + copySnapshot 能读到未 checkpoint 的 WAL 新行', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-import-wal-live-'))
    tmpDirs.push(dir)
    const db = path.join(dir, 'workbuddy.db')
    const holder = await holdWalWriter(db)
    try {
      expect((await fsp.stat(db + '-wal')).size).toBeGreaterThan(0)
      const io = new NodeImportIO()
      const rows = await io.querySqlite(db, 'SELECT id FROM sessions ORDER BY id', {
        copySnapshot: true,
      })
      expect(rows.map((r) => r.id)).toEqual(['s1', 's2'])
    } finally {
      holder.kill()
      // 等持锁进程退出，避免 afterEach 在 Windows 上 EBUSY
      await new Promise((r) => setTimeout(r, 200))
    }
  })

  it('无系统 sqlite3 CLI 时 copySnapshot 仍可读', async () => {
    const db = await makeWalDbWithoutSidecars()
    const io = new NodeImportIO()
    const rows = await io.querySqlite(db, 'SELECT id FROM sessions', { copySnapshot: true })
    expect(rows.map((r) => r.id)).toEqual(['s1'])
  })
})
