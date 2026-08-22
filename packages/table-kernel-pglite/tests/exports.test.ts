/**
 * 导出链完整性验证 — 确保 @tabtin/table-kernel-pglite 的公开 API 保持稳定。
 */
import { describe, it, expect } from 'vitest'
import * as pglite from '../src/index.js'

describe('table-kernel-pglite public exports', () => {
  it('exports PGliteSyncService', () => {
    expect(pglite.PGliteSyncService).toBeDefined()
    expect(typeof pglite.PGliteSyncService).toBe('function')
  })

  it('exports OutboxFlusher', () => {
    expect(pglite.OutboxFlusher).toBeDefined()
    expect(typeof pglite.OutboxFlusher).toBe('function')
  })

  it('exports PGliteOutboxStore and PGliteUnitOfWork', () => {
    expect(pglite.PGliteOutboxStore).toBeDefined()
    expect(pglite.PGliteUnitOfWork).toBeDefined()
  })

  it('exports PGliteSyncStateStore', () => {
    expect(pglite.PGliteSyncStateStore).toBeDefined()
    expect(typeof pglite.PGliteSyncStateStore).toBe('function')
  })

  it('exports DeltaApplier', () => {
    expect(pglite.DeltaApplier).toBeDefined()
    expect(typeof pglite.DeltaApplier).toBe('function')
  })

  it('exports PGliteQueryService', () => {
    expect(pglite.PGliteQueryService).toBeDefined()
    expect(typeof pglite.PGliteQueryService).toBe('function')
  })

  it('exports sync error utilities', () => {
    expect(typeof pglite.isRetryableSyncError).toBe('function')
    expect(typeof pglite.toSyncErrorMessage).toBe('function')
  })

  it('exports schema utilities', () => {
    expect(typeof pglite.fieldTypeToSqlType).toBe('function')
    expect(typeof pglite.generateCreateTableSql).toBe('function')
    expect(typeof pglite.initializeSchema).toBe('function')
  })

  it('exports whereNodeToSql', () => {
    expect(typeof pglite.whereNodeToSql).toBe('function')
  })

  it('exports PGliteDialect', () => {
    expect(pglite.PGliteDialect).toBeDefined()
  })
})
