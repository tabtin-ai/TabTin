import type {
  CommandError,
  CommandResult,
  CreateFieldInput,
  UpdateFieldInput,
  DeleteFieldInput,
  IFieldRepository,
  IUnitOfWork,
  IEventBus,
  FieldSnapshot,
} from '../../ports/index.js'
import { ErrorCodes } from '../../errors.js'
import {
  FieldAggregate,
  FieldAggregateError,
  type FieldAggregateDecision,
  type FieldAggregateEventMeta,
} from '../../domain/field/FieldAggregate.js'
import type { FieldDomainEvent } from '../../domain/field/events.js'
import { generateFieldId } from '../../domain/field/id.js'
import { generateEventId } from '../../domain/shared/id.js'
import { FlowAbort, ensureSuccess, runWriteOp } from '../shared/flow-utils.js'

export interface FieldWriteFlowDeps {
  fieldRepository: IFieldRepository
  unitOfWork: IUnitOfWork
  eventBus?: IEventBus
  fieldIdFactory?: () => string
  eventIdFactory?: () => string
  now?: () => Date
}

export interface FieldWriteFlowOutput<T = unknown> {
  result: CommandResult<T>
  events: FieldDomainEvent[]
}

export class FieldWriteFlow {
  private readonly fieldIdFactory: () => string
  private readonly eventIdFactory: () => string
  private readonly now: () => Date

  constructor(private readonly deps: FieldWriteFlowDeps) {
    this.fieldIdFactory = deps.fieldIdFactory ?? generateFieldId
    this.eventIdFactory = deps.eventIdFactory ?? generateEventId
    this.now = deps.now ?? (() => new Date())
  }

  async createField(input: CreateFieldInput): Promise<FieldWriteFlowOutput<{ fieldId: string }>> {
    return this.runWriteOp(async () => {
      if (!input.name || input.name.trim().length === 0) {
        return failure([{ code: ErrorCodes.VALIDATION_REQUIRED, message: 'Field name is required' }])
      }

      const aggregate = FieldAggregate.createNew(input.tableId)
      const decision = aggregate.create(
        {
          name: input.name,
          fieldType: input.fieldType,
          defaultValue: input.defaultValue,
          options: input.options,
        },
        this.buildMeta(),
      )

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.fieldRepository.createField({
          tableId: input.tableId,
          name: input.name,
          fieldType: input.fieldType,
          defaultValue: input.defaultValue,
          options: input.options,
        })
        ensureSuccess(repoResult)
        return repoResult
      })

      const fieldId = result.data?.fieldId ?? aggregate.fieldId
      return {
        result: { success: true, data: { fieldId }, errors: [] },
        events: [decision.event],
      }
    })
  }

  async updateField(input: UpdateFieldInput): Promise<FieldWriteFlowOutput> {
    return this.runWriteOp(async () => {
      const snapshot = await this.loadSnapshot(input.tableId, input.fieldId)
      if (!snapshot) {
        return failure([{ code: ErrorCodes.NOT_FOUND, message: `Field "${input.fieldId}" not found` }])
      }

      const aggregate = FieldAggregate.rehydrate(snapshot)
      const decision = this.runAggregate(() => aggregate.update(input.changes, this.buildMeta()))
      if (!decision) {
        return success()
      }

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.fieldRepository.updateField({
          ...input,
          changes: decision.event.changes,
        })
        ensureSuccess(repoResult)
        return repoResult
      })

      return {
        result,
        events: [decision.event],
      }
    })
  }

  async deleteField(input: DeleteFieldInput): Promise<FieldWriteFlowOutput> {
    return this.runWriteOp(async () => {
      const snapshot = await this.loadSnapshot(input.tableId, input.fieldId)
      if (!snapshot) {
        return failure([{ code: ErrorCodes.NOT_FOUND, message: `Field "${input.fieldId}" not found` }])
      }

      const aggregate = FieldAggregate.rehydrate(snapshot)
      const decision = this.runAggregate(() => aggregate.delete(this.buildMeta()))
      if (!decision) {
        return success()
      }

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.fieldRepository.deleteField(input)
        ensureSuccess(repoResult)
        return repoResult
      })

      return {
        result,
        events: [decision.event],
      }
    })
  }

  private async runWriteOp<T>(
    op: () => Promise<FieldWriteFlowOutput<T>>,
  ): Promise<FieldWriteFlowOutput<T>> {
    return runWriteOp(
      op,
      this.deps.eventBus,
      (result) => ({ result: result as CommandResult<T>, events: [] }),
    )
  }

  private buildMeta(): FieldAggregateEventMeta {
    return {
      eventId: this.eventIdFactory(),
      occurredAt: this.now().toISOString(),
    }
  }

  private async loadSnapshot(tableId: string, fieldId: string): Promise<FieldSnapshot | null> {
    try {
      return await this.deps.fieldRepository.getField(tableId, fieldId)
    } catch (err) {
      throw new FlowAbort({
        success: false,
        errors: [{ code: ErrorCodes.DB_ERROR, message: String(err) }],
      })
    }
  }

  private runAggregate<TDecision extends FieldAggregateDecision | null>(
    fn: () => TDecision,
  ): TDecision {
    try {
      return fn()
    } catch (err) {
      if (err instanceof FieldAggregateError) {
        throw new FlowAbort({
          success: false,
          errors: [{ code: err.code, message: err.message }],
        })
      }
      throw err
    }
  }
}

function success<T = unknown>(data?: T): FieldWriteFlowOutput<T> {
  return { result: { success: true, data, errors: [] }, events: [] }
}

function failure<T = unknown>(errors: CommandError[]): FieldWriteFlowOutput<T> {
  return { result: { success: false, errors }, events: [] }
}
