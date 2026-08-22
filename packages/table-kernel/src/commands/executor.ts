/**
 * 命令执行器 — 三种模式
 *
 * - DryRunExecutor: 只校验不写入（Agent 试算 / 预检）
 * - LocalExecutor:  在 PGlite 中直接执行写操作，适合单元测试或轻量场景
 * - RemoteExecutor: 转为 Django API 调用，用于前端 / CLI 直连后端
 *
 * ── LocalExecutor vs TableKernelService ──
 *
 * LocalExecutor 仅封装 RecordWriteFlow + LocalRecordRepository，不包含同步、
 * outbox、锁或 schema hydration，适合不需要远端同步的纯本地读写场景（如测试）。
 *
 * TableKernelService（apps/tabtin-daemon）在此之上叠加了：
 *   1. PGliteOutboxStore — durable outbox + OutboxFlusher 异步推送到 Django
 *   2. PGliteSyncService — 增量拉取 + 全量 reconcile
 *   3. 后台同步循环 + per-table 锁 + schema 自动 hydration
 * 因此 Daemon / CLI 场景应使用 TableKernelService 而非直接用 LocalExecutor。
 */

import type {
  CommandResult,
  FieldSchema,
  CreateRecordInput,
  UpdateRecordInput,
  DeleteRecordInput,
  BatchCreateRecordsInput,
  BatchUpdateRecordsInput,
  BatchDeleteRecordsInput,
} from '../ports/index.js'
import type { DomainEvent } from '../domain/record/events.js'
import type { RecordWriteFlowOutput } from '../application/record/RecordWriteFlow.js'
import { RecordWriteFlow } from '../application/record/RecordWriteFlow.js'
import {
  NoopUnitOfWork,
  type ITableRecordRepository,
  type ITableRecordQueryRepository,
} from '../ports/index.js'

export interface ICommandExecutor {
  createRecord(input: CreateRecordInput): Promise<CommandResult<{ recordId: string }>>
  updateRecord(input: UpdateRecordInput): Promise<CommandResult>
  deleteRecord(input: DeleteRecordInput): Promise<CommandResult>
  batchCreateRecords(input: BatchCreateRecordsInput): Promise<CommandResult<{ recordIds: string[]; count: number }>>
  batchUpdateRecords(input: BatchUpdateRecordsInput): Promise<CommandResult<{ count: number }>>
  batchDeleteRecords(input: BatchDeleteRecordsInput): Promise<CommandResult<{ count: number }>>
}

export interface ExecutorContext {
  getFieldSchemas(tableId: string): FieldSchema[]
}

export abstract class BaseExecutor {
  constructor(protected readonly ctx: ExecutorContext) {}

  protected getFields(tableId: string): FieldSchema[] {
    return this.ctx.getFieldSchemas(tableId)
  }
}

export abstract class EventEmittingExecutor extends BaseExecutor {
  protected events: DomainEvent[] = []

  getEvents(): DomainEvent[] {
    return [...this.events]
  }

  clearEvents(tableId?: string): void {
    if (tableId) {
      this.events = this.events.filter((event) => event.tableId !== tableId)
    } else {
      this.events = []
    }
  }

  protected async runFlow<T>(promise: Promise<RecordWriteFlowOutput<T>>): Promise<CommandResult<T>> {
    const output = await promise
    if (output.result.success && output.events.length > 0) {
      this.events.push(...output.events)
    }
    return output.result
  }
}

class DryRunRecordRepository implements ITableRecordRepository {
  async createRecord(input: { recordId: string }): Promise<CommandResult<{ recordId: string }>> {
    return { success: true, data: { recordId: input.recordId }, errors: [] }
  }

  async updateRecord(): Promise<CommandResult> {
    return { success: true, errors: [] }
  }

  async deleteRecord(): Promise<CommandResult> {
    return { success: true, errors: [] }
  }

  async batchCreateRecords(input: { records: Array<{ recordId: string }> }): Promise<CommandResult<{ recordIds: string[]; count: number }>> {
    return {
      success: true,
      data: {
        recordIds: input.records.map((record) => record.recordId),
        count: input.records.length,
      },
      errors: [],
    }
  }

  async batchUpdateRecords(input: { records: unknown[] }): Promise<CommandResult<{ count: number }>> {
    return { success: true, data: { count: input.records.length }, errors: [] }
  }

  async batchDeleteRecords(input: { recordIds: string[] }): Promise<CommandResult<{ count: number }>> {
    return { success: true, data: { count: input.recordIds.length }, errors: [] }
  }
}

export class DryRunExecutor extends EventEmittingExecutor implements ICommandExecutor {
  private readonly flow: RecordWriteFlow

  constructor(ctx: ExecutorContext) {
    super(ctx)
    this.flow = new RecordWriteFlow({
      getFieldSchemas: (tableId) => this.getFields(tableId),
      recordRepository: new DryRunRecordRepository(),
      unitOfWork: new NoopUnitOfWork(),
    })
  }

  async createRecord(input: CreateRecordInput): Promise<CommandResult<{ recordId: string }>> {
    return this.runFlow(this.flow.createRecord(input))
  }

  async updateRecord(input: UpdateRecordInput): Promise<CommandResult> {
    return this.runFlow(this.flow.updateRecord(input))
  }

  async deleteRecord(input: DeleteRecordInput): Promise<CommandResult> {
    return this.runFlow(this.flow.deleteRecord(input))
  }

  async batchCreateRecords(input: BatchCreateRecordsInput): Promise<CommandResult<{ recordIds: string[]; count: number }>> {
    return this.runFlow(this.flow.batchCreateRecords(input))
  }

  async batchUpdateRecords(input: BatchUpdateRecordsInput): Promise<CommandResult<{ count: number }>> {
    return this.runFlow(this.flow.batchUpdateRecords(input))
  }

  async batchDeleteRecords(input: BatchDeleteRecordsInput): Promise<CommandResult<{ count: number }>> {
    return this.runFlow(this.flow.batchDeleteRecords(input))
  }
}

export class RemoteExecutor extends BaseExecutor implements ICommandExecutor {
  private readonly flow: RecordWriteFlow

  constructor(ctx: ExecutorContext, repository: ITableRecordRepository) {
    super(ctx)
    this.flow = new RecordWriteFlow({
      getFieldSchemas: (tableId) => this.getFields(tableId),
      recordRepository: repository,
      unitOfWork: new NoopUnitOfWork(),
    })
  }

  async createRecord(input: CreateRecordInput): Promise<CommandResult<{ recordId: string }>> {
    return (await this.flow.createRecord(input)).result
  }

  async updateRecord(input: UpdateRecordInput): Promise<CommandResult> {
    return (await this.flow.updateRecord(input)).result
  }

  async deleteRecord(input: DeleteRecordInput): Promise<CommandResult> {
    return (await this.flow.deleteRecord(input)).result
  }

  async batchCreateRecords(input: BatchCreateRecordsInput): Promise<CommandResult<{ recordIds: string[]; count: number }>> {
    return (await this.flow.batchCreateRecords(input)).result
  }

  async batchUpdateRecords(input: BatchUpdateRecordsInput): Promise<CommandResult<{ count: number }>> {
    return (await this.flow.batchUpdateRecords(input)).result
  }

  async batchDeleteRecords(input: BatchDeleteRecordsInput): Promise<CommandResult<{ count: number }>> {
    return (await this.flow.batchDeleteRecords(input)).result
  }
}

export class LocalExecutor extends EventEmittingExecutor implements ICommandExecutor {
  private readonly repository: ITableRecordRepository
  private readonly flow: RecordWriteFlow

  constructor(
    ctx: ExecutorContext,
    repository: ITableRecordRepository,
    queryRepository?: ITableRecordQueryRepository,
  ) {
    super(ctx)
    this.repository = repository
    this.flow = new RecordWriteFlow({
      getFieldSchemas: (tableId) => this.getFields(tableId),
      recordRepository: this.repository,
      recordQueryRepository: queryRepository,
      unitOfWork: new NoopUnitOfWork(),
    })
  }

  async createRecord(input: CreateRecordInput): Promise<CommandResult<{ recordId: string }>> {
    return this.runFlow(this.flow.createRecord(input))
  }

  async updateRecord(input: UpdateRecordInput): Promise<CommandResult> {
    return this.runFlow(this.flow.updateRecord(input))
  }

  async deleteRecord(input: DeleteRecordInput): Promise<CommandResult> {
    return this.runFlow(this.flow.deleteRecord(input))
  }

  async batchCreateRecords(input: BatchCreateRecordsInput): Promise<CommandResult<{ recordIds: string[]; count: number }>> {
    return this.runFlow(this.flow.batchCreateRecords(input))
  }

  async batchUpdateRecords(input: BatchUpdateRecordsInput): Promise<CommandResult<{ count: number }>> {
    return this.runFlow(this.flow.batchUpdateRecords(input))
  }

  async batchDeleteRecords(input: BatchDeleteRecordsInput): Promise<CommandResult<{ count: number }>> {
    return this.runFlow(this.flow.batchDeleteRecords(input))
  }
}
