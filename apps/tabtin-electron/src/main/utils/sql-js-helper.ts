/**
 * Lazy-initialized sql.js (WASM SQLite) singleton.
 *
 * Used by credential-vault extractors to read browser SQLite files
 * without requiring a native C++ module (no electron-rebuild needed).
 */

import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

/** sql.js 运行时形态（仓库内仅声明用到的 API，避免依赖缺失的 @types） */
export type SqlJsStatic = {
  Database: new (data?: ArrayLike<number> | Buffer | null) => {
    close(): void
    prepare(sql: string): {
      bind(params?: unknown[]): void
      step(): boolean
      getAsObject(): Record<string, unknown>
      free(): void
    }
  }
}

let _sqlJs: SqlJsStatic | null = null

// electron-vite 把本文件编译成 ESM .mjs chunk 后，文件级 `require` 不存在。
// 显式 createRequire 比依赖 electron-vite 自动注入的 shim 更稳。
const require = createRequire(import.meta.url)

/**
 * 解析 sql.js 的 wasm 文件绝对路径。
 *
 * sql.js@1.14+ 在 package.json 中加了严格的 `exports` 字段：
 *   - `.` → 主入口
 *   - `./dist/*` → 允许子路径访问 dist/ 下任意文件
 * 所以不能再 resolve `sql.js/package.json`（不在 exports 白名单），
 * 但可以直接 resolve `sql.js/dist/sql-wasm.wasm`。
 *
 * 该写法对 dev / packaged（含 asar、pnpm symlink）都生效，
 * 因为 Node 的模块解析会沿 require parent 链向上查找 node_modules。
 */
function resolveWasmPath(): string {
  try {
    return require.resolve('sql.js/dist/sql-wasm.wasm')
  } catch {
    // 兜底：极少数情况下解析失败时手动拼路径。
    // packaged 模式下尝试 asar.unpacked，再退化到 asar 内。
    const appPath = app.isPackaged ? app.getAppPath() : dirname(fileURLToPath(import.meta.url))
    if (app.isPackaged) {
      const unpacked = appPath.replace(/app\.asar$/, 'app.asar.unpacked')
      const unpackedWasm = join(unpacked, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
      if (existsSync(unpackedWasm)) return unpackedWasm
    }
    return join(appPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  }
}

export async function getSqlJs(): Promise<SqlJsStatic> {
  if (_sqlJs) return _sqlJs
  const initSqlJs = (await import('sql.js')).default as (opts?: {
    wasmBinary?: Buffer
  }) => Promise<SqlJsStatic>
  const wasmPath = resolveWasmPath()
  const wasmBinary = readFileSync(wasmPath)
  _sqlJs = await initSqlJs({ wasmBinary })
  return _sqlJs
}

/**
 * Open a SQLite database file (read-only) via sql.js and run a callback,
 * then automatically close the database.
 */
export async function withSqliteFile<T>(
  filePath: string,
  fn: (helpers: SqliteHelpers) => T,
): Promise<T> {
  const SQL = await getSqlJs()
  const buffer = readFileSync(filePath)
  const db = new SQL.Database(buffer)
  try {
    return fn(new SqliteHelpers(db))
  } finally {
    db.close()
  }
}

/**
 * Thin wrapper that provides a better-sqlite3-like `queryAll()` API
 * over a sql.js Database instance.
 */
export class SqliteHelpers {
  constructor(private db: InstanceType<SqlJsStatic['Database']>) {}

  queryAll(sql: string, params?: unknown[]): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql)
    try {
      if (params && params.length > 0) stmt.bind(params)
      const results: Record<string, unknown>[] = []
      while (stmt.step()) {
        results.push(stmt.getAsObject() as Record<string, unknown>)
      }
      return results
    } finally {
      stmt.free()
    }
  }
}
