import { recordMutationToData } from '../../domain/record/mutation-spec.js'
import type {
  CommandResult,
  BatchRecordDeleteInput,
  BatchRecordPersistInput,
  ITableRecordRepository,
  RecordPersistInput,
  RemoteApiClient,
} from '../../ports/index.js'
import { extractApiError, unwrapApiData } from '../shared/api-utils.js'

const DEFAULT_BASE_PATH = '/tabdata/open/v1/tables'

export class RemoteRecordRepository implements ITableRecordRepository {
  private readonly basePath: string

  constructor(private readonly apiClient: RemoteApiClient) {
    this.basePath = (apiClient.basePath ?? DEFAULT_BASE_PATH).replace(/\/+$/, '')
  }

  async createRecord(input: RecordPersistInput): Promise<CommandResult<{ recordId: string }>> {
    try {
      const fields = recordMutationToData(input.mutation)
      const result = unwrapApiData<{ id: string }>(await this.apiClient.post(
        `${this.basePath}/${input.tableId}/records`,
        {
          fields,
          field_key_type: 'id',
        },
      ))
      return { success: true, data: { recordId: result.id }, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async updateRecord(input: RecordPersistInput): Promise<CommandResult> {
    try {
      const fields = recordMutationToData(input.mutation)
      await this.apiClient.patch(
        `${this.basePath}/${input.tableId}/records/${input.recordId}`,
        {
          fields,
          field_key_type: 'id',
        },
      )
      return { success: true, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async deleteRecord(input: { tableId: string; recordId: string }): Promise<CommandResult> {
    try {
      await this.apiClient.delete(
        `${this.basePath}/${input.tableId}/records/${input.recordId}`,
      )
      return { success: true, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async batchCreateRecords(input: BatchRecordPersistInput): Promise<CommandResult<{ recordIds: string[]; count: number }>> {
    try {
      const recordIds = input.records.map((record) => record.recordId)
      const payload = await this.apiClient.post(
        `${this.basePath}/${input.tableId}/records/batch-create`,
        {
          records: input.records.map((record) => ({
            id: record.recordId,
            fields: recordMutationToData(record.mutation),
          })),
          field_key_type: 'id',
        },
      )
      assertBatchMutationResult('create', payload, input.records.length)
      return {
        success: true,
        data: { recordIds, count: recordIds.length },
        errors: [],
      }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async batchUpdateRecords(input: BatchRecordPersistInput): Promise<CommandResult<{ count: number }>> {
    try {
      const payload = await this.apiClient.post(
        `${this.basePath}/${input.tableId}/records/batch-update`,
        {
          records: input.records.map((record) => ({
            id: record.recordId,
            fields: recordMutationToData(record.mutation),
          })),
          field_key_type: 'id',
        },
      )
      assertBatchMutationResult('update', payload, input.records.length)
      return { success: true, data: { count: input.records.length }, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async batchDeleteRecords(input: BatchRecordDeleteInput): Promise<CommandResult<{ count: number }>> {
    try {
      const payload = await this.apiClient.post(
        `${this.basePath}/${input.tableId}/records/batch-delete`,
        { record_ids: input.recordIds },
      )
      assertBatchMutationResult('delete', payload, input.recordIds.length)
      return { success: true, data: { count: input.recordIds.length }, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }
}

function normalizeApiErrors(errors: unknown): string[] {
  if (!Array.isArray(errors)) return []
  return errors
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object' && 'message' in entry) {
        return String((entry as { message: unknown }).message)
      }
      return JSON.stringify(entry) ?? String(entry)
    })
    .filter((message) => message.length > 0)
}

function assertBatchMutationResult(
  action: 'create' | 'update' | 'delete',
  payload: unknown,
  expectedCount: number,
): void {
  const data = unwrapApiData<Record<string, unknown>>(payload)
  const countKey =
    action === 'create'
      ? 'created_count'
      : action === 'update'
        ? 'updated_count'
        : 'deleted_count'
  const actualCount = Number(data[countKey] ?? 0)
  const errors = normalizeApiErrors(data.errors)
  if (errors.length > 0 || actualCount !== expectedCount) {
    const details = errors.length > 0 ? errors.join('; ') : `${countKey}=${actualCount}, expected=${expectedCount}`
    throw new Error(`Batch ${action} failed: ${details}`)
  }
}
