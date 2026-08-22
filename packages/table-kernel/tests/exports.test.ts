/**
 * 导出链完整性验证 — 确保 @tabtin/table-kernel 的公开 API 保持稳定。
 * 新增或迁移导出时，在此追加断言以防回归。
 */
import { describe, it, expect } from 'vitest'
import * as kernel from '../src/index.js'

describe('table-kernel public exports', () => {
  it('exports LocalRecordRepository and RemoteRecordRepository', () => {
    expect(kernel.LocalRecordRepository).toBeDefined()
    expect(typeof kernel.LocalRecordRepository).toBe('function')
    expect(kernel.RemoteRecordRepository).toBeDefined()
    expect(typeof kernel.RemoteRecordRepository).toBe('function')
  })

  it('exports command executors', () => {
    expect(kernel.BaseExecutor).toBeDefined()
    expect(kernel.EventEmittingExecutor).toBeDefined()
    expect(kernel.DryRunExecutor).toBeDefined()
    expect(kernel.RemoteExecutor).toBeDefined()
    expect(kernel.LocalExecutor).toBeDefined()
  })

  it('exports RecordWriteFlow', () => {
    expect(kernel.RecordWriteFlow).toBeDefined()
    expect(typeof kernel.RecordWriteFlow).toBe('function')
  })

  it('exports RecordAggregate', () => {
    expect(kernel.RecordAggregate).toBeDefined()
    expect(typeof kernel.RecordAggregate).toBe('function')
  })

  it('exports domain event factory functions', () => {
    expect(typeof kernel.createRecordCreatedEvent).toBe('function')
    expect(typeof kernel.createRecordUpdatedEvent).toBe('function')
    expect(typeof kernel.createRecordDeletedEvent).toBe('function')
    expect(typeof kernel.createRecordsBatchCreatedEvent).toBe('function')
    expect(typeof kernel.createRecordsBatchUpdatedEvent).toBe('function')
    expect(typeof kernel.createRecordsBatchDeletedEvent).toBe('function')
  })

  it('exports ErrorCodes', () => {
    expect(kernel.ErrorCodes).toBeDefined()
    expect(typeof kernel.ErrorCodes).toBe('object')
  })

  it('exports mutation builders', () => {
    expect(typeof kernel.buildSetMutation).toBe('function')
    expect(typeof kernel.buildUnsetMutation).toBe('function')
    expect(typeof kernel.buildBatchSetMutation).toBe('function')
    expect(typeof kernel.buildRecordMutationSpec).toBe('function')
    expect(typeof kernel.recordMutationToData).toBe('function')
  })

  it('exports adapter utilities', () => {
    expect(typeof kernel.buildFieldColumnMap).toBe('function')
    expect(typeof kernel.invertFieldColumnMap).toBe('function')
    expect(typeof kernel.translateColumnName).toBe('function')
    expect(typeof kernel.externalFilterToKernel).toBe('function')
    expect(typeof kernel.externalSortToKernel).toBe('function')
  })

  it('exports spec builders and visitors', () => {
    expect(typeof kernel.buildRecordSpec).toBe('function')
    expect(typeof kernel.specToWhereNode).toBe('function')
    expect(typeof kernel.specToDjangoQ).toBe('function')
    expect(typeof kernel.memoryFilter).toBe('function')
  })

  it('exports filter and sort utilities', () => {
    expect(typeof kernel.filterRecords).toBe('function')
    expect(typeof kernel.sortRecords).toBe('function')
    expect(typeof kernel.recordMatchesFilter).toBe('function')
  })

  it('exports FieldAggregate and related symbols', () => {
    expect(kernel.FieldAggregate).toBeDefined()
    expect(typeof kernel.FieldAggregate).toBe('function')
    expect(kernel.FieldAggregateError).toBeDefined()
    expect(typeof kernel.FieldAggregateError).toBe('function')
    expect(typeof kernel.generateFieldId).toBe('function')
  })

  it('exports TableAggregate and related symbols', () => {
    expect(kernel.TableAggregate).toBeDefined()
    expect(typeof kernel.TableAggregate).toBe('function')
    expect(kernel.TableAggregateError).toBeDefined()
    expect(typeof kernel.TableAggregateError).toBe('function')
    expect(typeof kernel.generateTableId).toBe('function')
  })

  it('exports NoopUnitOfWork', () => {
    expect(kernel.NoopUnitOfWork).toBeDefined()
    expect(typeof kernel.NoopUnitOfWork).toBe('function')
    const uow = new kernel.NoopUnitOfWork()
    expect(typeof uow.run).toBe('function')
  })

  it('exports shared ID generators', () => {
    expect(typeof kernel.generateRecordId).toBe('function')
    expect(typeof kernel.generateEventId).toBe('function')
    expect(typeof kernel.generateChangeId).toBe('function')
  })

  it('exports FieldWriteFlow', () => {
    expect(kernel.FieldWriteFlow).toBeDefined()
    expect(typeof kernel.FieldWriteFlow).toBe('function')
  })

  it('exports RemoteFieldRepository', () => {
    expect(kernel.RemoteFieldRepository).toBeDefined()
    expect(typeof kernel.RemoteFieldRepository).toBe('function')
  })

  it('exports NoopEventBus', () => {
    expect(kernel.NoopEventBus).toBeDefined()
    expect(typeof kernel.NoopEventBus).toBe('function')
    const bus = new kernel.NoopEventBus()
    expect(typeof bus.publish).toBe('function')
  })

  it('exports aggregation utilities', () => {
    expect(typeof kernel.aggregate).toBe('function')
  })

  it('exports TableWriteFlow', () => {
    expect(kernel.TableWriteFlow).toBeDefined()
    expect(typeof kernel.TableWriteFlow).toBe('function')
  })

  it('exports RemoteTableRepository', () => {
    expect(kernel.RemoteTableRepository).toBeDefined()
    expect(typeof kernel.RemoteTableRepository).toBe('function')
  })

  it('exports ViewAggregate', () => {
    expect(kernel.ViewAggregate).toBeDefined()
    expect(typeof kernel.ViewAggregate).toBe('function')
  })

  it('exports ViewAggregateError', () => {
    expect(kernel.ViewAggregateError).toBeDefined()
    expect(typeof kernel.ViewAggregateError).toBe('function')
  })

  it('exports generateViewId', () => {
    expect(typeof kernel.generateViewId).toBe('function')
    expect(kernel.generateViewId()).toMatch(/^viw_/)
  })

  it('exports ViewWriteFlow', () => {
    expect(kernel.ViewWriteFlow).toBeDefined()
    expect(typeof kernel.ViewWriteFlow).toBe('function')
  })

  it('exports RemoteViewRepository', () => {
    expect(kernel.RemoteViewRepository).toBeDefined()
    expect(typeof kernel.RemoteViewRepository).toBe('function')
  })

  it('exports FieldOrchestrator', () => {
    expect(kernel.FieldOrchestrator).toBeDefined()
    expect(typeof kernel.FieldOrchestrator).toBe('function')
  })

  it('exports TableOrchestrator', () => {
    expect(kernel.TableOrchestrator).toBeDefined()
    expect(typeof kernel.TableOrchestrator).toBe('function')
  })

  it('exports ViewOrchestrator', () => {
    expect(kernel.ViewOrchestrator).toBeDefined()
    expect(typeof kernel.ViewOrchestrator).toBe('function')
  })
})
