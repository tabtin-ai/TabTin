import type { SyncRecordChange, FieldColumnMap } from '@tabtin/table-kernel'
import { translateFieldId } from '@tabtin/table-kernel'
import type { PGliteInstance } from './dialect.js'

const GHOST_DELETE_BATCH_SIZE = 500

export class DeltaApplier {
  constructor(private readonly pg: PGliteInstance) {}

  async applyRecordChanges(
    dbTableName: string,
    records: SyncRecordChange[],
    fieldColumnMap?: FieldColumnMap,
  ): Promise<void> {
    for (const rc of records) {
      switch (rc.action) {
        case 'create':
        case 'update': {
          if (!rc.data) continue
          const mergedData: Record<string, unknown> = {
            id: rc.id,
            ...this.translateData(rc.data, fieldColumnMap),
          }
          const columns = Object.keys(mergedData)
          const values = Object.values(mergedData)
          const placeholders = columns.map((_, i) => `$${i + 1}`)
          const onConflict = columns
            .filter((c) => c !== 'id')
            .map((c) => `"${c}" = EXCLUDED."${c}"`)
            .join(', ')
          const sql = onConflict
            ? `INSERT INTO "${dbTableName}" (${columns.map((c) => `"${c}"`).join(', ')})
               VALUES (${placeholders.join(', ')})
               ON CONFLICT ("id") DO UPDATE SET ${onConflict}`
            : `INSERT INTO "${dbTableName}" (${columns.map((c) => `"${c}"`).join(', ')})
               VALUES (${placeholders.join(', ')})
               ON CONFLICT ("id") DO NOTHING`
          await this.pg.query(sql, values)
          break
        }
        case 'delete': {
          await this.pg.query(`DELETE FROM "${dbTableName}" WHERE "id" = $1`, [rc.id])
          break
        }
      }
    }
  }

  /**
   * Detect and remove ghost records: local rows that no longer exist on the remote.
   * Returns the list of removed ghost record IDs.
   */
  async detectAndRemoveGhosts(
    dbTableName: string,
    remoteIds: Set<string>,
  ): Promise<string[]> {
    const localResult = await this.pg.query<{ id: string }>(
      `SELECT "id" FROM "${dbTableName}"`,
    )
    const ghostIds: string[] = []
    for (const row of localResult.rows) {
      if (!remoteIds.has(row.id)) ghostIds.push(row.id)
    }
    if (ghostIds.length > 0) {
      for (let i = 0; i < ghostIds.length; i += GHOST_DELETE_BATCH_SIZE) {
        const batch = ghostIds.slice(i, i + GHOST_DELETE_BATCH_SIZE)
        const placeholders = batch.map((_, j) => `$${j + 1}`).join(', ')
        await this.pg.query(
          `DELETE FROM "${dbTableName}" WHERE "id" IN (${placeholders})`,
          batch,
        )
      }
    }
    return ghostIds
  }

  async getRecordCount(dbTableName: string): Promise<number> {
    const result = await this.pg.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "${dbTableName}"`,
    )
    return parseInt(result.rows[0]?.cnt ?? '0', 10)
  }

  private translateData(
    data: Record<string, unknown>,
    fieldColumnMap?: FieldColumnMap,
  ): Record<string, unknown> {
    if (!fieldColumnMap) return data
    const translated: Record<string, unknown> = {}
    for (const [fieldId, value] of Object.entries(data)) {
      if (fieldId === 'id') continue
      translated[translateFieldId(fieldId, fieldColumnMap)] = value
    }
    return translated
  }
}
