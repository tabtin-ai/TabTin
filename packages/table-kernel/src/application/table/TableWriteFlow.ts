import type {
  CommandError,
  CommandResult,
  CreateTableInput,
  UpdateTableInput,
  ITableRepository,
  IUnitOfWork,
  IEventBus,
  TableSnapshot,
} from '../../ports/index.js'
import { ErrorCodes } from '../../errors.js'
import {
  TableAggregate,
  TableAggregateError,
  type TableAggregateDecision,
  type TableAggregateEventMeta,
} from '../../domain/table/TableAggregate.js'
import type { TableDomainEvent } from '../../domain/table/events.js'
import { generateEventId } from '../../domain/shared/id.js'
import { FlowAbort, ensureSuccess, runWriteOp } from '../shared/flow-utils.js'

export interface TableWriteFlowDeps {
  tableRepository: ITableRepository
  unitOfWork: IUnitOfWork
  eventBus?: IEventBus
  eventIdFactory?: () => string
  now?: () => Date
}

export interface TableWriteFlowOutput<T = unknown> {
  result: CommandResult<T>
  events: TableDomainEvent[]
}

export class TableWriteFlow {
  private readonly eventIdFactory: () => string
  private readonly now: () => Date

  constructor(private readonly deps: TableWriteFlowDeps) {
    this.eventIdFactory = deps.eventIdFactory ?? generateEventId
    this.now = deps.now ?? (() => new Date())
  }

  async createTable(input: CreateTableInput): Promise<TableWriteFlowOutput<{ tableId: string }>> {
    return this.runWriteOp(async () => {
      if (!input.name || input.name.trim().length === 0) {
        return failure([{ code: ErrorCodes.VALIDATION_REQUIRED, message: 'Table name is required' }])
      }
      if (!input.spaceId || input.spaceId.trim().length === 0) {
        return failure([{ code: ErrorCodes.VALIDATION_REQUIRED, message: 'Space ID is required' }])
      }

      const aggregate = TableAggregate.createNew()
      const decision = aggregate.create(
        { name: input.name, description: input.description, icon: input.icon },
        this.buildMeta(),
      )

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.tableRepository.createTable(input)
        ensureSuccess(repoResult)
        return repoResult
      })

      const tableId = result.data?.tableId ?? aggregate.tableId
      return {
        result: { success: true, data: { tableId }, errors: [] },
        events: [decision.event],
      }
    })
  }

  async updateTable(input: UpdateTableInput): Promise<TableWriteFlowOutput> {
    return this.runWriteOp(async () => {
      const snapshot = await this.loadSnapshot(input.tableId)
      if (!snapshot) {
        return failure([{ code: ErrorCodes.NOT_FOUND, message: `Table "${input.tableId}" not found` }])
      }

      const aggregate = TableAggregate.rehydrate(snapshot)
      const decision = this.runAggregate(() => aggregate.update(input.changes, this.buildMeta()))
      if (!decision) {
        return success()
      }

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.tableRepository.updateTable(input)
        ensureSuccess(repoResult)
        return repoResult
      })

      return { result, events: [decision.event] }
    })
  }

  async deleteTable(tableId: string): Promise<TableWriteFlowOutput> {
    return this.runWriteOp(async () => {
      const snapshot = await this.loadSnapshot(tableId)
      if (!snapshot) {
        return failure([{ code: ErrorCodes.NOT_FOUND, message: `Table "${tableId}" not found` }])
      }

      const aggregate = TableAggregate.rehydrate(snapshot)
      const decision = this.runAggregate(() => aggregate.delete(this.buildMeta()))

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.tableRepository.deleteTable(tableId)
        ensureSuccess(repoResult)
        return repoResult
      })

      return { result, events: [decision.event] }
    })
  }

  async archiveTable(tableId: string): Promise<TableWriteFlowOutput> {
    return this.runWriteOp(async () => {
      const snapshot = await this.loadSnapshot(tableId)
      if (!snapshot) {
        return failure([{ code: ErrorCodes.NOT_FOUND, message: `Table "${tableId}" not found` }])
      }

      const aggregate = TableAggregate.rehydrate(snapshot)
      const decision = this.runAggregate(() => aggregate.archive(this.buildMeta()))

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.tableRepository.archiveTable(tableId)
        ensureSuccess(repoResult)
        return repoResult
      })

      return { result, events: [decision.event] }
    })
  }

  async restoreTable(tableId: string): Promise<TableWriteFlowOutput> {
    return this.runWriteOp(async () => {
      const snapshot = await this.loadSnapshot(tableId)
      if (!snapshot) {
        return failure([{ code: ErrorCodes.NOT_FOUND, message: `Table "${tableId}" not found` }])
      }

      const aggregate = TableAggregate.rehydrate(snapshot)
      const decision = this.runAggregate(() => aggregate.restore(this.buildMeta()))

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.tableRepository.restoreTable(tableId)
        ensureSuccess(repoResult)
        return repoResult
      })

      return { result, events: [decision.event] }
    })
  }

  private async runWriteOp<T>(
    op: () => Promise<TableWriteFlowOutput<T>>,
  ): Promise<TableWriteFlowOutput<T>> {
    return runWriteOp(
      op,
      this.deps.eventBus,
      (result) => ({ result: result as CommandResult<T>, events: [] }),
    )
  }

  private buildMeta(): TableAggregateEventMeta {
    return {
      eventId: this.eventIdFactory(),
      occurredAt: this.now().toISOString(),
    }
  }

  private async loadSnapshot(tableId: string): Promise<TableSnapshot | null> {
    try {
      return await this.deps.tableRepository.getTable(tableId)
    } catch (err) {
      throw new FlowAbort({
        success: false,
        errors: [{ code: ErrorCodes.DB_ERROR, message: String(err) }],
      })
    }
  }

  private runAggregate<TDecision extends TableAggregateDecision | null>(
    fn: () => TDecision,
  ): TDecision {
    try {
      return fn()
    } catch (err) {
      if (err instanceof TableAggregateError) {
        throw new FlowAbort({
          success: false,
          errors: [{ code: err.code, message: err.message }],
        })
      }
      throw err
    }
  }
}

function success<T = unknown>(data?: T): TableWriteFlowOutput<T> {
  return { result: { success: true, data, errors: [] }, events: [] }
}

function failure<T = unknown>(errors: CommandError[]): TableWriteFlowOutput<T> {
  return { result: { success: false, errors }, events: [] }
}
