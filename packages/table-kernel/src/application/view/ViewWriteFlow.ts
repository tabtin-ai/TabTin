import type {
  CommandError,
  CommandResult,
  CreateViewInput,
  UpdateViewInput,
  IViewRepository,
  IUnitOfWork,
  IEventBus,
  ViewSnapshot,
} from '../../ports/index.js'
import { getViewColumnMeta } from '../../ports/index.js'
import { ErrorCodes } from '../../errors.js'
import {
  ViewAggregate,
  ViewAggregateError,
  type ViewAggregateDecision,
  type ViewAggregateEventMeta,
} from '../../domain/view/ViewAggregate.js'
import type { ViewDomainEvent } from '../../domain/view/events.js'
import { generateEventId } from '../../domain/shared/id.js'
import { FlowAbort, ensureSuccess, runWriteOp } from '../shared/flow-utils.js'

export interface ViewWriteFlowDeps {
  viewRepository: IViewRepository
  unitOfWork: IUnitOfWork
  eventBus?: IEventBus
  eventIdFactory?: () => string
  now?: () => Date
}

export interface ViewWriteFlowOutput<T = unknown> {
  result: CommandResult<T>
  events: ViewDomainEvent[]
}

export class ViewWriteFlow {
  private readonly eventIdFactory: () => string
  private readonly now: () => Date

  constructor(private readonly deps: ViewWriteFlowDeps) {
    this.eventIdFactory = deps.eventIdFactory ?? generateEventId
    this.now = deps.now ?? (() => new Date())
  }

  async createView(input: CreateViewInput): Promise<ViewWriteFlowOutput<{ viewId: string }>> {
    return this.runWriteOp(async () => {
      if (!input.name || input.name.trim().length === 0) {
        return failure([{ code: ErrorCodes.VALIDATION_REQUIRED, message: 'View name is required' }])
      }

      const aggregate = ViewAggregate.createNew(input.tableId)
      const decision = aggregate.create(
        {
          name: input.name,
          viewType: input.viewType,
          description: input.description,
          filter: input.filter,
          sorts: input.sorts,
          visibleFields: input.visibleFields,
          fieldOrder: input.fieldOrder,
          column_meta: getViewColumnMeta(input),
          config: input.config,
        },
        this.buildMeta(),
      )

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.viewRepository.createView(input)
        ensureSuccess(repoResult)
        return repoResult
      })

      const viewId = result.data?.viewId ?? aggregate.viewId
      return {
        result: { success: true, data: { viewId }, errors: [] },
        events: [decision.event],
      }
    })
  }

  async updateView(input: UpdateViewInput): Promise<ViewWriteFlowOutput> {
    return this.runWriteOp(async () => {
      const snapshot = await this.loadSnapshot(input.viewId)
      if (!snapshot) {
        return failure([{ code: ErrorCodes.NOT_FOUND, message: `View "${input.viewId}" not found` }])
      }

      const aggregate = ViewAggregate.rehydrate(snapshot)
      const decision = this.runAggregate(() => aggregate.update(input.changes, this.buildMeta()))
      if (!decision) {
        return success()
      }

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.viewRepository.updateView(input)
        ensureSuccess(repoResult)
        return repoResult
      })

      return { result, events: [decision.event] }
    })
  }

  async deleteView(viewId: string): Promise<ViewWriteFlowOutput> {
    return this.runWriteOp(async () => {
      const snapshot = await this.loadSnapshot(viewId)
      if (!snapshot) {
        return failure([{ code: ErrorCodes.NOT_FOUND, message: `View "${viewId}" not found` }])
      }

      const aggregate = ViewAggregate.rehydrate(snapshot)
      const decision = this.runAggregate(() => aggregate.delete(this.buildMeta()))

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.viewRepository.deleteView(viewId)
        ensureSuccess(repoResult)
        return repoResult
      })

      return { result, events: [decision.event] }
    })
  }

  private async runWriteOp<T>(
    op: () => Promise<ViewWriteFlowOutput<T>>,
  ): Promise<ViewWriteFlowOutput<T>> {
    return runWriteOp(
      op,
      this.deps.eventBus,
      (result) => ({ result: result as CommandResult<T>, events: [] }),
    )
  }

  private buildMeta(): ViewAggregateEventMeta {
    return {
      eventId: this.eventIdFactory(),
      occurredAt: this.now().toISOString(),
    }
  }

  private async loadSnapshot(viewId: string): Promise<ViewSnapshot | null> {
    try {
      return await this.deps.viewRepository.getView(viewId)
    } catch (err) {
      throw new FlowAbort({
        success: false,
        errors: [{ code: ErrorCodes.DB_ERROR, message: String(err) }],
      })
    }
  }

  private runAggregate<TDecision extends ViewAggregateDecision | null>(
    fn: () => TDecision,
  ): TDecision {
    try {
      return fn()
    } catch (err) {
      if (err instanceof ViewAggregateError) {
        throw new FlowAbort({
          success: false,
          errors: [{ code: err.code, message: err.message }],
        })
      }
      throw err
    }
  }
}

function success<T = unknown>(data?: T): ViewWriteFlowOutput<T> {
  return { result: { success: true, data, errors: [] }, events: [] }
}

function failure<T = unknown>(errors: CommandError[]): ViewWriteFlowOutput<T> {
  return { result: { success: false, errors }, events: [] }
}
