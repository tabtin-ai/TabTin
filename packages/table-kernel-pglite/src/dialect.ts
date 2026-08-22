/**
 * Kysely PGlite Dialect — 让 Kysely 通过 PGlite 执行 SQL
 */

import type {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  QueryCompiler,
  QueryResult,
  CompiledQuery,
} from 'kysely'
import {
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely'

export interface PGliteInstance {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{
    rows: T[]
    affectedRows?: number
  }>
  close?(): Promise<void>
}

class PGliteDriver implements Driver {
  constructor(private pg: PGliteInstance) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new PGliteConnection(this.pg)
  }

  async beginTransaction(conn: DatabaseConnection): Promise<void> {
    await (conn as PGliteConnection).executeQuery({ sql: 'BEGIN', parameters: [], query: { kind: 'RawNode' } } as unknown as CompiledQuery)
  }

  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await (conn as PGliteConnection).executeQuery({ sql: 'COMMIT', parameters: [], query: { kind: 'RawNode' } } as unknown as CompiledQuery)
  }

  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await (conn as PGliteConnection).executeQuery({ sql: 'ROLLBACK', parameters: [], query: { kind: 'RawNode' } } as unknown as CompiledQuery)
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {
    await this.pg.close?.()
  }
}

class PGliteConnection implements DatabaseConnection {
  constructor(private pg: PGliteInstance) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery
    const result = await this.pg.query<R>(sql, parameters as unknown[])
    return {
      rows: result.rows as R[],
      numAffectedRows: result.affectedRows != null ? BigInt(result.affectedRows) : undefined,
    }
  }

  streamQuery(): AsyncIterableIterator<never> {
    throw new Error('PGlite does not support streaming queries')
  }
}

export class PGliteDialect implements Dialect {
  constructor(private pg: PGliteInstance) {}

  createDriver(): Driver {
    return new PGliteDriver(this.pg)
  }

  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler()
  }

  createAdapter(): DialectAdapter {
    return new PostgresAdapter()
  }

  createIntrospector(db: any): DatabaseIntrospector {
    return new PostgresIntrospector(db)
  }
}
