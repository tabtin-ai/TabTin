import type {
  IChangeOutbox,
  IUnitOfWork,
  OutboxChangeEnvelope,
  OutboxStats,
} from '@tabtin/table-kernel'
import type { PGliteInstance } from './dialect.js'

const OUTBOX_TABLE = '__tabtin_sync_outbox'

interface OutboxRow {
  change_id: string
  table_id: string
  record_id: string
  action: 'create' | 'update' | 'delete'
  payload: string
  mutation: string
  status: 'pending' | 'processing' | 'acked' | 'failed'
  attempt_count: number
  last_error: string | null
  ack_version: number | null
  created_at: string
  updated_at: string
}

interface OutboxStatsRow {
  pending: number | string | null
  processing: number | string | null
  failed: number | string | null
  acked: number | string | null
  last_ack_version: number | string | null
}

export async function initializeOutboxSchema(pg: PGliteInstance): Promise<void> {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS "${OUTBOX_TABLE}" (
      "change_id" TEXT PRIMARY KEY,
      "table_id" TEXT NOT NULL,
      "record_id" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "payload" JSONB NOT NULL,
      "mutation" JSONB NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "attempt_count" INTEGER NOT NULL DEFAULT 0,
      "last_error" TEXT,
      "ack_version" DOUBLE PRECISION,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pg.query(
    `CREATE INDEX IF NOT EXISTS "${OUTBOX_TABLE}_table_status_idx" ON "${OUTBOX_TABLE}" ("table_id", "status", "created_at")`,
  )
}

export class PGliteUnitOfWork implements IUnitOfWork {
  constructor(private readonly pg: PGliteInstance) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.pg.query('BEGIN')
    try {
      const result = await fn()
      await this.pg.query('COMMIT')
      return result
    } catch (err) {
      try { await this.pg.query('ROLLBACK') } catch { /* ignore rollback error */ }
      throw err
    }
  }
}

export class PGliteOutboxStore implements IChangeOutbox {
  constructor(private readonly pg: PGliteInstance) {}

  async initialize(): Promise<void> {
    await initializeOutboxSchema(this.pg)
  }

  async append(change: OutboxChangeEnvelope): Promise<void> {
    await this.pg.query(
      `INSERT INTO "${OUTBOX_TABLE}" (
        "change_id",
        "table_id",
        "record_id",
        "action",
        "payload",
        "mutation",
        "status",
        "attempt_count",
        "last_error",
        "ack_version",
        "created_at",
        "updated_at"
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
      [
        change.changeId,
        change.tableId,
        change.recordId,
        change.action,
        JSON.stringify(change.payload),
        JSON.stringify(change.mutation),
        change.status ?? 'pending',
        change.attemptCount ?? 0,
        change.lastError ?? null,
        change.ackVersion ?? null,
        change.createdAt,
        change.updatedAt ?? change.createdAt,
      ],
    )
  }

  async appendMany(changes: OutboxChangeEnvelope[]): Promise<void> {
    for (const change of changes) {
      await this.append(change)
    }
  }

  async listPending(options: { tableId?: string; limit?: number } = {}): Promise<OutboxChangeEnvelope[]> {
    const { tableId, limit = 100 } = options
    const rows = await this.pg.query<OutboxRow>(
      tableId
        ? `SELECT
             "change_id",
             "table_id",
             "record_id",
             "action",
             "payload"::text AS payload,
             "mutation"::text AS mutation,
             "status",
             "attempt_count",
             "last_error",
             "ack_version",
             "created_at"::text AS created_at,
             "updated_at"::text AS updated_at
           FROM "${OUTBOX_TABLE}"
           WHERE "status" = 'pending' AND "table_id" = $1
           ORDER BY "created_at" ASC
           LIMIT $2`
        : `SELECT
             "change_id",
             "table_id",
             "record_id",
             "action",
             "payload"::text AS payload,
             "mutation"::text AS mutation,
             "status",
             "attempt_count",
             "last_error",
             "ack_version",
             "created_at"::text AS created_at,
             "updated_at"::text AS updated_at
           FROM "${OUTBOX_TABLE}"
           WHERE "status" = 'pending'
           ORDER BY "created_at" ASC
           LIMIT $1`,
      tableId ? [tableId, limit] : [limit],
    )
    return rows.rows.map(mapRow)
  }

  async listFailed(options: { tableId?: string; limit?: number } = {}): Promise<OutboxChangeEnvelope[]> {
    const { tableId, limit = 100 } = options
    const rows = await this.pg.query<OutboxRow>(
      tableId
        ? `SELECT
             "change_id",
             "table_id",
             "record_id",
             "action",
             "payload"::text AS payload,
             "mutation"::text AS mutation,
             "status",
             "attempt_count",
             "last_error",
             "ack_version",
             "created_at"::text AS created_at,
             "updated_at"::text AS updated_at
           FROM "${OUTBOX_TABLE}"
           WHERE "status" = 'failed' AND "table_id" = $1
           ORDER BY "updated_at" DESC
           LIMIT $2`
        : `SELECT
             "change_id",
             "table_id",
             "record_id",
             "action",
             "payload"::text AS payload,
             "mutation"::text AS mutation,
             "status",
             "attempt_count",
             "last_error",
             "ack_version",
             "created_at"::text AS created_at,
             "updated_at"::text AS updated_at
           FROM "${OUTBOX_TABLE}"
           WHERE "status" = 'failed'
           ORDER BY "updated_at" DESC
           LIMIT $1`,
      tableId ? [tableId, limit] : [limit],
    )
    return rows.rows.map(mapRow)
  }

  async listTableIds(): Promise<string[]> {
    const result = await this.pg.query<{ table_id: string }>(
      `SELECT DISTINCT "table_id"
       FROM "${OUTBOX_TABLE}"
       WHERE "status" <> 'acked'
       ORDER BY "table_id" ASC`,
    )
    return result.rows.map((row) => row.table_id)
  }

  async recoverProcessing(): Promise<number> {
    const result = await this.pg.query(
      `UPDATE "${OUTBOX_TABLE}"
       SET "status" = 'pending',
           "updated_at" = NOW()
       WHERE "status" = 'processing'`,
    )
    return result.affectedRows ?? 0
  }

  async markProcessing(changeIds: string[]): Promise<void> {
    if (changeIds.length === 0) return
    await this.pg.query(
      `UPDATE "${OUTBOX_TABLE}"
       SET "status" = 'processing',
           "updated_at" = NOW()
       WHERE "change_id" IN (${placeholders(changeIds.length)})`,
      changeIds,
    )
  }

  async markAcked(changeIds: string[], ackVersion?: number): Promise<void> {
    if (changeIds.length === 0) return
    const params = ackVersion == null ? changeIds : [ackVersion, ...changeIds]
    const versionSql = ackVersion == null ? '' : `"ack_version" = $1, `
    const offset = ackVersion == null ? 0 : 1
    await this.pg.query(
      `UPDATE "${OUTBOX_TABLE}"
       SET ${versionSql}"status" = 'acked',
           "last_error" = NULL,
           "updated_at" = NOW()
       WHERE "change_id" IN (${placeholders(changeIds.length, offset)})`,
      params,
    )
  }

  async markFailed(
    changeIds: string[],
    error: string,
    options: { retryable?: boolean } = {},
  ): Promise<void> {
    if (changeIds.length === 0) return
    const nextStatus = options.retryable === false ? 'failed' : 'pending'
    await this.pg.query(
      `UPDATE "${OUTBOX_TABLE}"
       SET "status" = $1,
           "attempt_count" = "attempt_count" + 1,
           "last_error" = $2,
           "updated_at" = NOW()
       WHERE "change_id" IN (${placeholders(changeIds.length, 2)})`,
      [nextStatus, error, ...changeIds],
    )
  }

  async retryFailed(changeIds: string[]): Promise<number> {
    if (changeIds.length === 0) return 0
    const result = await this.pg.query(
      `UPDATE "${OUTBOX_TABLE}"
       SET "status" = 'pending',
           "attempt_count" = 0,
           "last_error" = NULL,
           "updated_at" = NOW()
       WHERE "status" = 'failed' AND "change_id" IN (${placeholders(changeIds.length)})`,
      changeIds,
    )
    return result.affectedRows ?? 0
  }

  async purgeAcked(options: { tableId?: string; olderThanMs?: number } = {}): Promise<number> {
    const { tableId, olderThanMs } = options
    const conditions = ['"status" = \'acked\'']
    const params: unknown[] = []
    let paramIndex = 1

    if (tableId) {
      conditions.push(`"table_id" = $${paramIndex}`)
      params.push(tableId)
      paramIndex++
    }
    if (olderThanMs != null) {
      const ms = Math.max(0, Math.floor(Number(olderThanMs)))
      if (!Number.isFinite(ms)) throw new Error('olderThanMs must be a finite number')
      conditions.push(`"updated_at" < NOW() - ($${paramIndex}::bigint || ' milliseconds')::interval`)
      params.push(ms)
      paramIndex++
    }

    const result = await this.pg.query(
      `DELETE FROM "${OUTBOX_TABLE}" WHERE ${conditions.join(' AND ')}`,
      params,
    )
    return result.affectedRows ?? 0
  }

  async getStats(tableId?: string): Promise<OutboxStats> {
    const summary = await this.pg.query<OutboxStatsRow>(
      tableId
        ? `SELECT
             COALESCE(SUM(CASE WHEN "status" = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
             COALESCE(SUM(CASE WHEN "status" = 'processing' THEN 1 ELSE 0 END), 0) AS processing,
             COALESCE(SUM(CASE WHEN "status" = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
             COALESCE(SUM(CASE WHEN "status" = 'acked' THEN 1 ELSE 0 END), 0) AS acked,
             MAX("ack_version") AS last_ack_version
           FROM "${OUTBOX_TABLE}"
           WHERE "table_id" = $1`
        : `SELECT
             COALESCE(SUM(CASE WHEN "status" = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
             COALESCE(SUM(CASE WHEN "status" = 'processing' THEN 1 ELSE 0 END), 0) AS processing,
             COALESCE(SUM(CASE WHEN "status" = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
             COALESCE(SUM(CASE WHEN "status" = 'acked' THEN 1 ELSE 0 END), 0) AS acked,
             MAX("ack_version") AS last_ack_version
           FROM "${OUTBOX_TABLE}"`,
      tableId ? [tableId] : [],
    )
    const latestError = await this.pg.query<{ last_error: string | null }>(
      tableId
        ? `SELECT "last_error"
           FROM "${OUTBOX_TABLE}"
           WHERE "table_id" = $1 AND "last_error" IS NOT NULL
           ORDER BY "updated_at" DESC
           LIMIT 1`
        : `SELECT "last_error"
           FROM "${OUTBOX_TABLE}"
           WHERE "last_error" IS NOT NULL
           ORDER BY "updated_at" DESC
           LIMIT 1`,
      tableId ? [tableId] : [],
    )
    const row = summary.rows[0]
    return {
      pending: toNumber(row?.pending),
      processing: toNumber(row?.processing),
      failed: toNumber(row?.failed),
      acked: toNumber(row?.acked),
      lastAckVersion: row?.last_ack_version == null ? null : toNumber(row.last_ack_version),
      lastError: latestError.rows[0]?.last_error ?? null,
    }
  }
}

function mapRow(row: OutboxRow): OutboxChangeEnvelope {
  return {
    changeId: row.change_id,
    tableId: row.table_id,
    recordId: row.record_id,
    action: row.action,
    payload: JSON.parse(row.payload) as OutboxChangeEnvelope['payload'],
    mutation: JSON.parse(row.mutation) as OutboxChangeEnvelope['mutation'],
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    ackVersion: row.ack_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function placeholders(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, i) => `$${i + 1 + offset}`).join(', ')
}

function toNumber(value: number | string | null | undefined): number {
  if (value == null) return 0
  return typeof value === 'number' ? value : Number(value)
}
