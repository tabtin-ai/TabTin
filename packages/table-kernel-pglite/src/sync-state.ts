import type { PGliteInstance } from './dialect.js'

const SYNC_STATE_TABLE = '__tabtin_sync_state'

export interface SyncState {
  tableId: string
  lastPulledVersion: number
  lastAckedVersion: number | null
  lastReconciledAt: string | null
}

export interface ISyncStateStore {
  initialize(): Promise<void>
  get(tableId: string): Promise<SyncState | null>
  upsert(tableId: string, patch: Partial<Omit<SyncState, 'tableId'>>): Promise<void>
  listTrackedTableIds(): Promise<string[]>
  delete(tableId: string): Promise<void>
}

export class PGliteSyncStateStore implements ISyncStateStore {
  constructor(private readonly pg: PGliteInstance) {}

  async initialize(): Promise<void> {
    await this.pg.query(`
      CREATE TABLE IF NOT EXISTS "${SYNC_STATE_TABLE}" (
        "table_id" TEXT PRIMARY KEY,
        "last_pulled_version" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "last_acked_version" DOUBLE PRECISION,
        "last_reconciled_at" TIMESTAMPTZ,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  }

  async get(tableId: string): Promise<SyncState | null> {
    const result = await this.pg.query<{
      table_id: string
      last_pulled_version: number
      last_acked_version: number | null
      last_reconciled_at: string | null
    }>(
      `SELECT "table_id", "last_pulled_version", "last_acked_version",
              "last_reconciled_at"::text AS last_reconciled_at
       FROM "${SYNC_STATE_TABLE}"
       WHERE "table_id" = $1`,
      [tableId],
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      tableId: row.table_id,
      lastPulledVersion: row.last_pulled_version,
      lastAckedVersion: row.last_acked_version,
      lastReconciledAt: row.last_reconciled_at,
    }
  }

  async upsert(tableId: string, patch: Partial<Omit<SyncState, 'tableId'>>): Promise<void> {
    const pulledVersion = patch.lastPulledVersion ?? 0
    const ackedVersion = patch.lastAckedVersion ?? null
    const reconciledAt = patch.lastReconciledAt ?? null

    const updateClauses: string[] = ['"updated_at" = NOW()']
    if (patch.lastPulledVersion !== undefined) {
      updateClauses.push('"last_pulled_version" = EXCLUDED."last_pulled_version"')
    }
    if (patch.lastAckedVersion !== undefined) {
      updateClauses.push('"last_acked_version" = EXCLUDED."last_acked_version"')
    }
    if (patch.lastReconciledAt !== undefined) {
      updateClauses.push('"last_reconciled_at" = EXCLUDED."last_reconciled_at"')
    }

    await this.pg.query(
      `INSERT INTO "${SYNC_STATE_TABLE}"
         ("table_id", "last_pulled_version", "last_acked_version", "last_reconciled_at")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("table_id") DO UPDATE SET ${updateClauses.join(', ')}`,
      [tableId, pulledVersion, ackedVersion, reconciledAt],
    )
  }

  async listTrackedTableIds(): Promise<string[]> {
    const result = await this.pg.query<{ table_id: string }>(
      `SELECT "table_id" FROM "${SYNC_STATE_TABLE}" ORDER BY "table_id" ASC`,
    )
    return result.rows.map((row) => row.table_id)
  }

  async delete(tableId: string): Promise<void> {
    await this.pg.query(
      `DELETE FROM "${SYNC_STATE_TABLE}" WHERE "table_id" = $1`,
      [tableId],
    )
  }
}
