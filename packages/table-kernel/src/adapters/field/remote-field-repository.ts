import type {
  CommandResult,
  CreateFieldInput,
  UpdateFieldInput,
  DeleteFieldInput,
  FieldSnapshot,
  IFieldRepository,
  RemoteApiClient,
} from '../../ports/index.js'
import type { FieldType, FieldOptions } from '../../types/field.js'
import { extractApiError, unwrapApiData } from '../shared/api-utils.js'

const DEFAULT_BASE_PATH = '/tabdata'

export class RemoteFieldRepository implements IFieldRepository {
  private readonly basePath: string

  constructor(private readonly apiClient: RemoteApiClient) {
    this.basePath = (apiClient.basePath ?? DEFAULT_BASE_PATH).replace(/\/+$/, '')
  }

  async createField(input: CreateFieldInput): Promise<CommandResult<{ fieldId: string }>> {
    try {
      const result = unwrapApiData<{ id: string }>(await this.apiClient.post(
        `${this.basePath}/fields`,
        {
          table_id: input.tableId,
          name: input.name,
          field_type: input.fieldType,
          options: input.options,
          default_value: input.defaultValue,
        },
      ))
      return { success: true, data: { fieldId: result.id }, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async updateField(input: UpdateFieldInput): Promise<CommandResult> {
    try {
      const payload: Record<string, unknown> = {}
      if (input.changes.name !== undefined) payload.name = input.changes.name
      if (input.changes.options !== undefined) payload.options = input.changes.options
      if (input.changes.defaultValue !== undefined) payload.default_value = input.changes.defaultValue
      if (Object.keys(payload).length === 0) {
        return { success: true, errors: [] }
      }
      const send = typeof this.apiClient.put === 'function'
        ? this.apiClient.put.bind(this.apiClient)
        : this.apiClient.patch.bind(this.apiClient)
      await send(`${this.basePath}/fields/${input.fieldId}`, payload)
      return { success: true, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async deleteField(input: DeleteFieldInput): Promise<CommandResult> {
    try {
      await this.apiClient.delete(`${this.basePath}/fields/${input.fieldId}`)
      return { success: true, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async getField(tableId: string, fieldId: string): Promise<FieldSnapshot | null> {
    try {
      if (typeof this.apiClient.get !== 'function') {
        return null
      }
      const raw = unwrapApiData<Record<string, unknown>>(
        await this.apiClient.get(`${this.basePath}/fields/${fieldId}`),
      )
      return this.parseFieldSnapshot(raw, tableId, fieldId)
    } catch {
      return null
    }
  }

  async listFieldsByTable(tableId: string): Promise<FieldSnapshot[]> {
    if (typeof this.apiClient.get !== 'function') return []
    try {
      const raw = unwrapApiData<{ fields: Array<Record<string, unknown>> }>(
        await this.apiClient.get(`${this.basePath}/tables/${tableId}/fields`),
      )
      return (raw.fields ?? [])
        .map((f) => this.parseFieldSnapshot(f, tableId))
        .filter(Boolean) as FieldSnapshot[]
    } catch {
      return []
    }
  }

  private parseFieldSnapshot(
    raw: Record<string, unknown> | null | undefined,
    tableId: string,
    fieldId?: string,
  ): FieldSnapshot | null {
    if (!raw) return null
    const id = String(raw.id ?? fieldId ?? '')
    if (!id) return null
    return {
      tableId: String(raw.table_id ?? raw.tableId ?? tableId),
      fieldId: id,
      name: String(raw.name ?? ''),
      fieldType: (raw.field_type ?? raw.fieldType ?? 'text') as FieldType,
      isPrimary: Boolean(raw.is_primary ?? raw.isPrimary ?? false),
      defaultValue: (raw.default_value ?? raw.defaultValue ?? null) as FieldSnapshot['defaultValue'],
      options: (raw.options ?? undefined) as FieldOptions | undefined,
    }
  }
}
