import { recordMutationToData } from '../../domain/record/mutation-spec.js'
import { ErrorCodes } from '../../errors.js'
import type {
  CommandResult,
  BatchRecordDeleteInput,
  BatchRecordPersistInput,
  ITableRecordQueryRepository,
  ITableRecordRepository,
  RecordPersistInput,
  ILocalDb,
} from '../../ports/index.js'
import { invertFieldColumnMap, translateColumnName, translateFieldId } from '../column-map.js'

export class LocalRecordRepository implements ITableRecordRepository, ITableRecordQueryRepository {
  private readonly manageTransactions: boolean

  constructor(
    private readonly db: ILocalDb,
    options: { manageTransactions?: boolean } = {},
  ) {
    this.manageTransactions = options.manageTransactions ?? false
  }

  async createRecord(input: RecordPersistInput): Promise<CommandResult<{ recordId: string }>> {
    const tableName = this.db.getDbTableName(input.tableId)
    const allData: Record<string, unknown> = {
      id: input.recordId,
      ...this.toDbRecordData(input.tableId, recordMutationToData(input.mutation)),
    }
    const columns = Object.keys(allData)
    const values = Object.values(allData)
    const placeholders = columns.map((_, i) => `$${i + 1}`)

    try {
      await this.db.query(
        `INSERT INTO "${tableName}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
        values,
      )
      return { success: true, data: { recordId: input.recordId }, errors: [] }
    } catch (err) {
      return { success: false, errors: [{ code: ErrorCodes.DB_ERROR, message: String(err) }] }
    }
  }

  async updateRecord(input: RecordPersistInput): Promise<CommandResult> {
    const tableName = this.db.getDbTableName(input.tableId)
    const entries = Object.entries(this.toDbRecordData(input.tableId, recordMutationToData(input.mutation)))
    if (entries.length === 0) return { success: true, errors: [] }

    const setClauses = entries.map(([column], i) => `"${column}" = $${i + 1}`)
    const values = entries.map(([, value]) => value)
    values.push(input.recordId)

    try {
      const exists = await this.db.query<{ id: string }>(
        `SELECT "id" FROM "${tableName}" WHERE "id" = $1`,
        [input.recordId],
      )
      if (exists.rows.length === 0) {
        return { success: false, errors: [{ code: ErrorCodes.NOT_FOUND, message: `Record "${input.recordId}" not found` }] }
      }
      await this.db.query(
        `UPDATE "${tableName}" SET ${setClauses.join(', ')} WHERE "id" = $${values.length}`,
        values,
      )
      return { success: true, errors: [] }
    } catch (err) {
      return { success: false, errors: [{ code: ErrorCodes.DB_ERROR, message: String(err) }] }
    }
  }

  async deleteRecord(input: { tableId: string; recordId: string }): Promise<CommandResult> {
    const tableName = this.db.getDbTableName(input.tableId)
    try {
      const exists = await this.db.query<{ id: string }>(
        `SELECT "id" FROM "${tableName}" WHERE "id" = $1`,
        [input.recordId],
      )
      if (exists.rows.length === 0) {
        return { success: false, errors: [{ code: ErrorCodes.NOT_FOUND, message: `Record "${input.recordId}" not found` }] }
      }
      await this.db.query(`DELETE FROM "${tableName}" WHERE "id" = $1`, [input.recordId])
      return { success: true, errors: [] }
    } catch (err) {
      return { success: false, errors: [{ code: ErrorCodes.DB_ERROR, message: String(err) }] }
    }
  }

  async batchCreateRecords(input: BatchRecordPersistInput): Promise<CommandResult<{ recordIds: string[]; count: number }>> {
    const tableName = this.db.getDbTableName(input.tableId)
    try {
      await this.withOptionalTransaction(async () => {
        for (const record of input.records) {
          const allData: Record<string, unknown> = {
            id: record.recordId,
            ...this.toDbRecordData(input.tableId, recordMutationToData(record.mutation)),
          }
          const columns = Object.keys(allData)
          const values = Object.values(allData)
          const placeholders = columns.map((_, i) => `$${i + 1}`)
          await this.db.query(
            `INSERT INTO "${tableName}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
            values,
          )
        }
      })
      return {
        success: true,
        data: { recordIds: input.records.map((record) => record.recordId), count: input.records.length },
        errors: [],
      }
    } catch (err) {
      return { success: false, errors: [{ code: ErrorCodes.DB_ERROR, message: String(err) }] }
    }
  }

  async batchUpdateRecords(input: BatchRecordPersistInput): Promise<CommandResult<{ count: number }>> {
    const tableName = this.db.getDbTableName(input.tableId)
    try {
      await this.withOptionalTransaction(async () => {
        for (const record of input.records) {
          const entries = Object.entries(this.toDbRecordData(input.tableId, recordMutationToData(record.mutation)))
          if (entries.length === 0) continue
          const setClauses = entries.map(([column], i) => `"${column}" = $${i + 1}`)
          const values = [...entries.map(([, value]) => value), record.recordId]
          await this.db.query(
            `UPDATE "${tableName}" SET ${setClauses.join(', ')} WHERE "id" = $${values.length}`,
            values,
          )
        }
      })
      return { success: true, data: { count: input.records.length }, errors: [] }
    } catch (err) {
      return { success: false, errors: [{ code: ErrorCodes.DB_ERROR, message: String(err) }] }
    }
  }

  async batchDeleteRecords(input: BatchRecordDeleteInput): Promise<CommandResult<{ count: number }>> {
    const tableName = this.db.getDbTableName(input.tableId)
    try {
      await this.withOptionalTransaction(async () => {
        const placeholders = input.recordIds.map((_, i) => `$${i + 1}`).join(', ')
        await this.db.query(`DELETE FROM "${tableName}" WHERE "id" IN (${placeholders})`, input.recordIds)
      })
      return { success: true, data: { count: input.recordIds.length }, errors: [] }
    } catch (err) {
      return { success: false, errors: [{ code: ErrorCodes.DB_ERROR, message: String(err) }] }
    }
  }

  async hasRecord(tableId: string, recordId: string): Promise<boolean> {
    const tableName = this.db.getDbTableName(tableId)
    const result = await this.db.query<{ id: string }>(
      `SELECT "id" FROM "${tableName}" WHERE "id" = $1`,
      [recordId],
    )
    return result.rows.length > 0
  }

  async getRecord(tableId: string, recordId: string): Promise<Record<string, unknown> | null> {
    const tableName = this.db.getDbTableName(tableId)
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM "${tableName}" WHERE "id" = $1`,
      [recordId],
    )
    const row = result.rows[0]
    if (!row) return null
    const fieldColumnMap = this.db.getFieldColumnMap?.(tableId)
    if (!fieldColumnMap) {
      const { id: _id, ...rest } = row
      return rest
    }
    const invertedMap = invertFieldColumnMap(fieldColumnMap)
    const translated: Record<string, unknown> = {}
    for (const [columnName, value] of Object.entries(row)) {
      if (columnName === 'id') continue
      translated[translateColumnName(columnName, invertedMap)] = value
    }
    return translated
  }

  private toDbRecordData(tableId: string, data: Record<string, unknown>): Record<string, unknown> {
    const fieldColumnMap = this.db.getFieldColumnMap?.(tableId)
    if (!fieldColumnMap) {
      return data
    }
    const translated: Record<string, unknown> = {}
    for (const [fieldId, value] of Object.entries(data)) {
      translated[translateFieldId(fieldId, fieldColumnMap)] = value
    }
    return translated
  }

  private async withOptionalTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.manageTransactions) {
      return fn()
    }
    await this.db.query('BEGIN')
    try {
      const result = await fn()
      await this.db.query('COMMIT')
      return result
    } catch (err) {
      try { await this.db.query('ROLLBACK') } catch { /* ignore rollback error */ }
      throw err
    }
  }
}
