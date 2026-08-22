/**
 * @types/node@20 尚未带齐 node:sqlite；Electron 41 / Node 24 运行时已可用。
 * 仅声明本包用到的 API，避免 typecheck 因 types 版本卡住。
 */
declare module 'node:sqlite' {
  export interface DatabaseSyncOptions {
    readOnly?: boolean
    timeout?: number
  }

  export class DatabaseSync {
    constructor(path: string | URL, options?: DatabaseSyncOptions)
    prepare(sql: string): {
      all(...params: unknown[]): Record<string, unknown>[]
      run(...params: unknown[]): unknown
      get(...params: unknown[]): Record<string, unknown> | undefined
    }
    exec(sql: string): void
    close(): void
  }
}
