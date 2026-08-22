import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { DeltaApplier } from '../src/index.js'
import type { PGliteInstance } from '../src/index.js'
import type { SyncRecordChange, FieldColumnMap } from '@tabtin/table-kernel'

describe('DeltaApplier', () => {
  let pg: PGliteInstance
  let applier: DeltaApplier
  const TABLE = 'test_records'

  beforeEach(async () => {
    pg = new PGlite() as unknown as PGliteInstance
    applier = new DeltaApplier(pg)
    await pg.query(`
      CREATE TABLE "${TABLE}" (
        "id" TEXT PRIMARY KEY,
        "col_name" TEXT,
        "col_age" INTEGER
      )
    `)
  })

  afterEach(async () => {
    await (pg as unknown as PGlite).close()
  })

  describe('applyRecordChanges', () => {
    it('inserts new records on create action', async () => {
      const records: SyncRecordChange[] = [
        { id: 'r1', action: 'create', data: { col_name: 'Alice', col_age: 30 }, version: 1 },
        { id: 'r2', action: 'create', data: { col_name: 'Bob', col_age: 25 }, version: 1 },
      ]
      await applier.applyRecordChanges(TABLE, records)

      const result = await pg.query(`SELECT * FROM "${TABLE}" ORDER BY "id"`)
      expect(result.rows).toHaveLength(2)
      expect(result.rows[0]).toMatchObject({ id: 'r1', col_name: 'Alice', col_age: 30 })
    })

    it('upserts on update action (insert if not exists, update if exists)', async () => {
      await pg.query(`INSERT INTO "${TABLE}" ("id", "col_name", "col_age") VALUES ('r1', 'Alice', 30)`)

      const records: SyncRecordChange[] = [
        { id: 'r1', action: 'update', data: { col_name: 'Alice Updated', col_age: 31 }, version: 2 },
        { id: 'r3', action: 'update', data: { col_name: 'Charlie', col_age: 40 }, version: 2 },
      ]
      await applier.applyRecordChanges(TABLE, records)

      const result = await pg.query(`SELECT * FROM "${TABLE}" ORDER BY "id"`)
      expect(result.rows).toHaveLength(2)
      expect(result.rows[0]).toMatchObject({ id: 'r1', col_name: 'Alice Updated', col_age: 31 })
      expect(result.rows[1]).toMatchObject({ id: 'r3', col_name: 'Charlie', col_age: 40 })
    })

    it('deletes records on delete action', async () => {
      await pg.query(`INSERT INTO "${TABLE}" ("id", "col_name") VALUES ('r1', 'Alice'), ('r2', 'Bob')`)

      const records: SyncRecordChange[] = [
        { id: 'r1', action: 'delete', version: 3 },
      ]
      await applier.applyRecordChanges(TABLE, records)

      const result = await pg.query(`SELECT * FROM "${TABLE}"`)
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]).toMatchObject({ id: 'r2' })
    })

    it('skips create/update records without data', async () => {
      const records: SyncRecordChange[] = [
        { id: 'r1', action: 'create', version: 1 },
      ]
      await applier.applyRecordChanges(TABLE, records)

      const result = await pg.query(`SELECT * FROM "${TABLE}"`)
      expect(result.rows).toHaveLength(0)
    })

    it('translates field names via fieldColumnMap', async () => {
      const fcm: FieldColumnMap = new Map([
        ['name', 'col_name'],
        ['age', 'col_age'],
      ])
      const records: SyncRecordChange[] = [
        { id: 'r1', action: 'create', data: { name: 'Alice', age: 30 }, version: 1 },
      ]
      await applier.applyRecordChanges(TABLE, records, fcm)

      const result = await pg.query(`SELECT * FROM "${TABLE}"`)
      expect(result.rows[0]).toMatchObject({ id: 'r1', col_name: 'Alice', col_age: 30 })
    })
  })

  describe('detectAndRemoveGhosts', () => {
    it('removes local records not in remote set', async () => {
      await pg.query(`
        INSERT INTO "${TABLE}" ("id", "col_name") VALUES
          ('r1', 'Alice'), ('r2', 'Bob'), ('r3', 'Charlie')
      `)

      const remoteIds = new Set(['r1', 'r3'])
      const ghostIds = await applier.detectAndRemoveGhosts(TABLE, remoteIds)

      expect(ghostIds).toEqual(['r2'])
      const result = await pg.query(`SELECT "id" FROM "${TABLE}" ORDER BY "id"`)
      expect(result.rows.map((r: any) => r.id)).toEqual(['r1', 'r3'])
    })

    it('returns empty array when no ghosts exist', async () => {
      await pg.query(`INSERT INTO "${TABLE}" ("id", "col_name") VALUES ('r1', 'Alice')`)

      const ghostIds = await applier.detectAndRemoveGhosts(TABLE, new Set(['r1']))
      expect(ghostIds).toEqual([])
    })

    it('handles empty local table', async () => {
      const ghostIds = await applier.detectAndRemoveGhosts(TABLE, new Set(['r1']))
      expect(ghostIds).toEqual([])
    })

    it('removes all local records when remote is empty', async () => {
      await pg.query(`INSERT INTO "${TABLE}" ("id", "col_name") VALUES ('r1', 'Alice'), ('r2', 'Bob')`)

      const ghostIds = await applier.detectAndRemoveGhosts(TABLE, new Set())
      expect(ghostIds).toHaveLength(2)
      const result = await pg.query(`SELECT * FROM "${TABLE}"`)
      expect(result.rows).toHaveLength(0)
    })
  })
})
