import type {
  CommandError,
  CommandResult,
  FieldSchema,
  CreateRecordInput,
  UpdateRecordInput,
  DeleteRecordInput,
  BatchCreateRecordsInput,
  BatchUpdateRecordsInput,
  BatchDeleteRecordsInput,
  IChangeOutbox,
  ITableRecordQueryRepository,
  ITableRecordRepository,
  IUnitOfWork,
  IEventBus,
  OutboxChangeEnvelope,
} from '../../ports/index.js'
import { ErrorCodes } from '../../errors.js'
import {
  recordMutationToData,
  type RecordMutationSpec,
} from '../../domain/record/mutation-spec.js'
import type {
  DomainEvent,
} from '../../domain/record/events.js'
import { generateChangeId, generateEventId, generateRecordId } from '../../domain/record/id.js'
import { validateBatch, validateRecord } from './validator.js'
import { formatFieldValue } from '../../field-types/index.js'
import {
  RecordAggregate,
  RecordAggregateError,
  createRecordsBatchCreatedEvent,
  createRecordsBatchDeletedEvent,
  createRecordsBatchUpdatedEvent,
  type RecordAggregateDecision,
  type RecordAggregateEventMeta,
} from '../../domain/index.js'
import { FlowAbort, ensureSuccess, runWriteOp } from '../shared/flow-utils.js'

export interface RecordWriteFlowDeps {
  getFieldSchemas(tableId: string): FieldSchema[]
  recordRepository: ITableRecordRepository
  recordQueryRepository?: ITableRecordQueryRepository
  unitOfWork: IUnitOfWork
  outbox?: IChangeOutbox
  eventBus?: IEventBus
  recordIdFactory?: () => string
  changeIdFactory?: () => string
  eventIdFactory?: () => string
  now?: () => Date
}

export interface RecordWriteFlowOutput<T = unknown> {
  result: CommandResult<T>
  events: DomainEvent[]
  outboxChanges: OutboxChangeEnvelope[]
}

export class RecordWriteFlow {
  private readonly recordIdFactory: () => string
  private readonly changeIdFactory: () => string
  private readonly eventIdFactory: () => string
  private readonly now: () => Date

  constructor(private readonly deps: RecordWriteFlowDeps) {
    this.recordIdFactory = deps.recordIdFactory ?? generateRecordId
    this.changeIdFactory = deps.changeIdFactory ?? generateChangeId
    this.eventIdFactory = deps.eventIdFactory ?? generateEventId
    this.now = deps.now ?? (() => new Date())
  }

  async createRecord(input: CreateRecordInput): Promise<RecordWriteFlowOutput<{ recordId: string }>> {
    return this.runWriteOp(async () => {
      const fields = this.deps.getFieldSchemas(input.tableId)
      const errors = validateRecord(input.data, fields)
      if (errors.length > 0) return failure(errors)

      const formatted = formatData(input.data, fields)
      const recordId = this.recordIdFactory()
      if (await this.hasExistingRecord(input.tableId, recordId)) {
        return failure([{ code: ErrorCodes.ALREADY_EXISTS, message: `Record "${recordId}" already exists` }])
      }
      const decision = RecordAggregate.createNew(input.tableId, recordId).create(
        formatted,
        this.buildEventMeta(input.tableId),
      )
      const outboxChange = createOutboxChange(
        this.changeIdFactory(),
        input.tableId,
        recordId,
        'create',
        decision.mutation,
        mutationData(decision.mutation),
        this.now(),
      )

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.recordRepository.createRecord({
          tableId: input.tableId,
          recordId,
          data: mutationData(decision.mutation),
          mutation: decision.mutation,
        })
        ensureSuccess(repoResult)
        if (this.deps.outbox) {
          await this.deps.outbox.append(outboxChange)
        }
        return repoResult
      })
      const persistedRecordId = result.data?.recordId ?? recordId
      return {
        result: { success: true, data: { recordId: persistedRecordId }, errors: [] },
        events: [decision.event],
        outboxChanges: this.deps.outbox ? [outboxChange] : [],
      }
    })
  }

  async updateRecord(input: UpdateRecordInput): Promise<RecordWriteFlowOutput> {
    return this.runWriteOp(async () => {
      const fields = this.deps.getFieldSchemas(input.tableId)
      const relevantFields = fields.filter((f) => f.id in input.data)
      const errors = validateRecord(input.data, relevantFields)
      if (errors.length > 0) return failure(errors)

      const formatted = formatData(input.data, fields)
      if (Object.keys(formatted).length === 0) {
        return success()
      }
      const currentSnapshot = await this.loadSnapshot(input.tableId, input.recordId)
      if (this.deps.recordQueryRepository && currentSnapshot == null) {
        return failure([{ code: ErrorCodes.NOT_FOUND, message: `Record "${input.recordId}" not found` }])
      }
      const aggregate = currentSnapshot
        ? RecordAggregate.rehydrate({
            tableId: input.tableId,
            recordId: input.recordId,
            data: currentSnapshot,
          })
        : RecordAggregate.assumeExists(input.tableId, input.recordId)
      const decision = this.runAggregate(() => aggregate.update(
        formatted,
        this.buildEventMeta(input.tableId),
      ))
      if (!decision) {
        return success()
      }
      const outboxChange = createOutboxChange(
        this.changeIdFactory(),
        input.tableId,
        input.recordId,
        'update',
        decision.mutation,
        mutationData(decision.mutation),
        this.now(),
      )

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.recordRepository.updateRecord({
          tableId: input.tableId,
          recordId: input.recordId,
          data: mutationData(decision.mutation),
          mutation: decision.mutation,
        })
        ensureSuccess(repoResult)
        if (this.deps.outbox) {
          await this.deps.outbox.append(outboxChange)
        }
        return repoResult
      })
      return {
        result,
        events: [decision.event],
        outboxChanges: this.deps.outbox ? [outboxChange] : [],
      }
    })
  }

  async deleteRecord(input: DeleteRecordInput): Promise<RecordWriteFlowOutput> {
    return this.runWriteOp(async () => {
      const currentSnapshot = await this.loadSnapshot(input.tableId, input.recordId)
      if (this.deps.recordQueryRepository && currentSnapshot == null) {
        return failure([{ code: ErrorCodes.NOT_FOUND, message: `Record "${input.recordId}" not found` }])
      }
      const aggregate = currentSnapshot
        ? RecordAggregate.rehydrate({
            tableId: input.tableId,
            recordId: input.recordId,
            data: currentSnapshot,
          })
        : RecordAggregate.assumeExists(input.tableId, input.recordId)
      const decision = this.runAggregate(() => aggregate.delete(this.buildEventMeta(input.tableId)))
      if (!decision) {
        return success()
      }
      const outboxChange = createOutboxChange(
        this.changeIdFactory(),
        input.tableId,
        input.recordId,
        'delete',
        decision.mutation,
        undefined,
        this.now(),
      )

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.recordRepository.deleteRecord({
          tableId: input.tableId,
          recordId: input.recordId,
        })
        ensureSuccess(repoResult)
        if (this.deps.outbox) {
          await this.deps.outbox.append(outboxChange)
        }
        return repoResult
      })
      return {
        result,
        events: [decision.event],
        outboxChanges: this.deps.outbox ? [outboxChange] : [],
      }
    })
  }

  async batchCreateRecords(
    input: BatchCreateRecordsInput,
  ): Promise<RecordWriteFlowOutput<{ recordIds: string[]; count: number }>> {
    return this.runWriteOp(async () => {
      const fields = this.deps.getFieldSchemas(input.tableId)
      const batchErrors = validateBatch(input.records, fields)
      if (batchErrors.length > 0) {
        return failure(batchErrors.flatMap(({ recordIndex, errors }) =>
          errors.map((e) => ({ ...e, message: `Record ${recordIndex}: ${e.message}` })),
        ))
      }

      const records = input.records.map((record) => {
        const recordId = this.recordIdFactory()
        const formatted = formatData(record, fields)
        const decision = RecordAggregate.createNew(input.tableId, recordId).create(
          formatted,
          this.buildEventMeta(input.tableId),
        )
        return {
          tableId: input.tableId,
          recordId,
          data: mutationData(decision.mutation),
          mutation: decision.mutation,
          after: decision.after ?? {},
        }
      })
      const batchEvent = createRecordsBatchCreatedEvent({
        ...this.buildEventMeta(input.tableId),
        records: records.map((record) => ({
          recordId: record.recordId,
          after: record.after,
        })),
      })
      const events: DomainEvent[] = [batchEvent]
      const outboxChanges = records.map((record) =>
        createOutboxChange(
          this.changeIdFactory(),
          input.tableId,
          record.recordId,
          'create',
          record.mutation,
          record.data,
          this.now(),
        ),
      )

      const result = await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.recordRepository.batchCreateRecords({
          tableId: input.tableId,
          records,
        })
        ensureSuccess(repoResult)
        if (this.deps.outbox && outboxChanges.length > 0) {
          await this.deps.outbox.appendMany(outboxChanges)
        }
        return repoResult
      })
      const persistedRecordIds = result.data?.recordIds ?? records.map((r) => r.recordId)
      return {
        result: {
          success: true,
          data: { recordIds: persistedRecordIds, count: persistedRecordIds.length },
          errors: [],
        },
        events,
        outboxChanges: this.deps.outbox ? outboxChanges : [],
      }
    })
  }

  async batchUpdateRecords(
    input: BatchUpdateRecordsInput,
  ): Promise<RecordWriteFlowOutput<{ count: number }>> {
    return this.runWriteOp(async () => {
      const fields = this.deps.getFieldSchemas(input.tableId)
      const allErrors: CommandError[] = []
      for (let i = 0; i < input.records.length; i++) {
        const rec = input.records[i]
        const relevantFields = fields.filter((f) => f.id in rec.data)
        allErrors.push(
          ...validateRecord(rec.data, relevantFields).map((e) => ({
            ...e,
            message: `Record ${i} (${rec.id}): ${e.message}`,
          })),
        )
      }
      if (allErrors.length > 0) return failure(allErrors)

      const snapshots = await Promise.all(
        input.records.map((record) => this.loadSnapshot(input.tableId, record.id)),
      )
      const missingErrors = snapshots.flatMap((snapshot, index) =>
        this.deps.recordQueryRepository && snapshot == null
          ? [{
              code: ErrorCodes.NOT_FOUND,
              message: `Record ${index} (${input.records[index].id}): record not found`,
            }]
          : [],
      )
      if (missingErrors.length > 0) return failure(missingErrors)

      const records = input.records.flatMap((record, index) => {
        const formatted = formatData(record.data, fields)
        if (Object.keys(formatted).length === 0) return []
        const snapshot = snapshots[index]
        const aggregate = snapshot
          ? RecordAggregate.rehydrate({
              tableId: input.tableId,
              recordId: record.id,
              data: snapshot,
            })
          : RecordAggregate.assumeExists(input.tableId, record.id)
        const decision = this.runAggregate(() => aggregate.update(
          formatted,
          this.buildEventMeta(input.tableId),
        ))
        if (!decision) return []
        return [{
          tableId: input.tableId,
          recordId: record.id,
          data: mutationData(decision.mutation),
          mutation: decision.mutation,
          before: decision.before ?? {},
          after: decision.after ?? {},
          changes: decision.event.changes,
        }]
      })

      if (records.length === 0) {
        return { result: { success: true, data: { count: 0 }, errors: [] }, events: [], outboxChanges: [] }
      }

      const event = createRecordsBatchUpdatedEvent({
        ...this.buildEventMeta(input.tableId),
        records: records.map((record) => ({
          recordId: record.recordId,
          before: record.before,
          after: record.after,
          changes: record.changes,
        })),
      })
      const outboxChanges = records.map((record) =>
        createOutboxChange(
          this.changeIdFactory(),
          input.tableId,
          record.recordId,
          'update',
          record.mutation,
          record.data,
          this.now(),
        ),
      )

      await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.recordRepository.batchUpdateRecords({
          tableId: input.tableId,
          records,
        })
        ensureSuccess(repoResult)
        if (this.deps.outbox && outboxChanges.length > 0) {
          await this.deps.outbox.appendMany(outboxChanges)
        }
        return repoResult
      })
      return {
        result: { success: true, data: { count: records.length }, errors: [] },
        events: [event],
        outboxChanges: this.deps.outbox ? outboxChanges : [],
      }
    })
  }

  async batchDeleteRecords(
    input: BatchDeleteRecordsInput,
  ): Promise<RecordWriteFlowOutput<{ count: number }>> {
    return this.runWriteOp(async () => {
      if (input.recordIds.length === 0) {
        return failure([{ code: ErrorCodes.EMPTY_INPUT, message: 'No record IDs provided' }])
      }
      const snapshots = await Promise.all(
        input.recordIds.map((recordId) => this.loadSnapshot(input.tableId, recordId)),
      )
      const missingErrors = snapshots.flatMap((snapshot, index) =>
        this.deps.recordQueryRepository && snapshot == null
          ? [{
              code: ErrorCodes.NOT_FOUND,
              message: `Record ${index} (${input.recordIds[index]}): record not found`,
            }]
          : [],
      )
      if (missingErrors.length > 0) return failure(missingErrors)

      const decisions = input.recordIds.map((recordId, index) => {
        const snapshot = snapshots[index]
        const aggregate = snapshot
          ? RecordAggregate.rehydrate({
              tableId: input.tableId,
              recordId,
              data: snapshot,
            })
          : RecordAggregate.assumeExists(input.tableId, recordId)
        return this.runAggregate(() => aggregate.delete(this.buildEventMeta(input.tableId)))
      }) as Array<RecordAggregateDecision>

      const event = createRecordsBatchDeletedEvent({
        ...this.buildEventMeta(input.tableId),
        records: input.recordIds.map((recordId, index) => ({
          recordId,
          before: decisions[index]?.before ?? null,
        })),
      })
      const outboxChanges = input.recordIds.map((recordId, index) =>
        createOutboxChange(
          this.changeIdFactory(),
          input.tableId,
          recordId,
          'delete',
          decisions[index]?.mutation ?? buildEmptyMutation(input.tableId, recordId),
          undefined,
          this.now(),
        ),
      )

      await this.deps.unitOfWork.run(async () => {
        const repoResult = await this.deps.recordRepository.batchDeleteRecords(input)
        ensureSuccess(repoResult)
        if (this.deps.outbox && outboxChanges.length > 0) {
          await this.deps.outbox.appendMany(outboxChanges)
        }
        return repoResult
      })
      return {
        result: { success: true, data: { count: input.recordIds.length }, errors: [] },
        events: [event],
        outboxChanges: this.deps.outbox ? outboxChanges : [],
      }
    })
  }

  private async runWriteOp<T>(
    op: () => Promise<RecordWriteFlowOutput<T>>,
  ): Promise<RecordWriteFlowOutput<T>> {
    return runWriteOp(
      op,
      this.deps.eventBus,
      (result) => ({ result: result as CommandResult<T>, events: [], outboxChanges: [] }),
    )
  }

  private buildEventMeta(tableId: string): RecordAggregateEventMeta & { tableId: string; aggregateVersion: number } {
    return {
      eventId: this.eventIdFactory(),
      occurredAt: this.now().toISOString(),
      tableId,
      aggregateVersion: 0,
    }
  }

  private async loadSnapshot(
    tableId: string,
    recordId: string,
  ): Promise<Record<string, unknown> | null> {
    if (!this.deps.recordQueryRepository) return null
    let record: Record<string, unknown> | null
    try {
      record = await this.deps.recordQueryRepository.getRecord(tableId, recordId)
    } catch (err) {
      throw queryFailure(err)
    }
    if (!record) return null
    return stripRecordIdentity(record)
  }

  private async hasExistingRecord(tableId: string, recordId: string): Promise<boolean> {
    if (!this.deps.recordQueryRepository) return false
    try {
      return await this.deps.recordQueryRepository.hasRecord(tableId, recordId)
    } catch (err) {
      throw queryFailure(err)
    }
  }

  private runAggregate<TDecision extends RecordAggregateDecision | null>(
    fn: () => TDecision,
  ): TDecision {
    try {
      return fn()
    } catch (err) {
      if (err instanceof RecordAggregateError) {
        throw new FlowAbort({
          success: false,
          errors: [{ code: err.code, message: err.message }],
        })
      }
      throw err
    }
  }
}

function formatData(data: Record<string, unknown>, fields: FieldSchema[]): Record<string, unknown> {
  const fieldMap = new Map(fields.map((f) => [f.id, f]))
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    const field = fieldMap.get(key)
    if (!field) continue
    result[key] = formatFieldValue(field.fieldType, value, field.options)
  }
  return result
}

function createOutboxChange(
  changeId: string,
  tableId: string,
  recordId: string,
  action: 'create' | 'update' | 'delete',
  mutation: RecordMutationSpec,
  data: Record<string, unknown> | undefined,
  now: Date,
): OutboxChangeEnvelope {
  return {
    changeId,
    tableId,
    recordId,
    action,
    payload: {
      id: recordId,
      action,
      ...(data ? { data } : {}),
    },
    mutation,
    status: 'pending',
    attemptCount: 0,
    lastError: null,
    ackVersion: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

function buildEmptyMutation(tableId: string, recordId: string): RecordMutationSpec {
  return {
    tableId,
    recordId,
    mutations: [],
  }
}

function success<T = unknown>(data?: T): RecordWriteFlowOutput<T> {
  return {
    result: { success: true, data, errors: [] },
    events: [],
    outboxChanges: [],
  }
}

function failure<T = unknown>(errors: CommandError[]): RecordWriteFlowOutput<T> {
  return {
    result: { success: false, errors },
    events: [],
    outboxChanges: [],
  }
}

function mutationData(mutation: RecordMutationSpec): Record<string, unknown> {
  return recordMutationToData(mutation)
}

function stripRecordIdentity(record: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = record
  return rest
}

function queryFailure(err: unknown): FlowAbort {
  return new FlowAbort({
    success: false,
    errors: [{ code: ErrorCodes.DB_ERROR, message: String(err) }],
  })
}
