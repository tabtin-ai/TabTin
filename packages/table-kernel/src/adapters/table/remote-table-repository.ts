import type {
  CommandResult,
  CreateTableInput,
  UpdateTableInput,
  TableSnapshot,
  ITableRepository,
  RemoteApiClient,
} from '../../ports/index.js'
import { extractApiError, unwrapApiData } from '../shared/api-utils.js'

const DEFAULT_BASE_PATH = '/tabdata'

export class RemoteTableRepository implements ITableRepository {
  private readonly basePath: string

  constructor(private readonly apiClient: RemoteApiClient) {
    this.basePath = (apiClient.basePath ?? DEFAULT_BASE_PATH).replace(/\/+$/, '')
  }

  async createTable(input: CreateTableInput): Promise<CommandResult<{ tableId: string }>> {
    try {
      const result = unwrapApiData<{ id: string }>(await this.apiClient.post(
        `${this.basePath}/tables`,
        {
          space_id: input.spaceId,
          name: input.name,
          description: input.description,
          icon: input.icon,
        },
      ))
      return { success: true, data: { tableId: result.id }, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async updateTable(input: UpdateTableInput): Promise<CommandResult> {
    try {
      const payload: Record<string, unknown> = {}
      if (input.changes.name !== undefined) payload.name = input.changes.name
      if (input.changes.description !== undefined) payload.description = input.changes.description
      if (input.changes.icon !== undefined) payload.icon = input.changes.icon
      if (Object.keys(payload).length === 0) {
        return { success: true, errors: [] }
      }
      const send = typeof this.apiClient.put === 'function'
        ? this.apiClient.put.bind(this.apiClient)
        : this.apiClient.patch.bind(this.apiClient)
      await send(`${this.basePath}/tables/${input.tableId}`, payload)
      return { success: true, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async deleteTable(tableId: string): Promise<CommandResult> {
    try {
      await this.apiClient.delete(`${this.basePath}/tables/${tableId}`)
      return { success: true, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async archiveTable(tableId: string): Promise<CommandResult> {
    try {
      await this.apiClient.post(`${this.basePath}/tables/${tableId}/archive`, {})
      return { success: true, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async restoreTable(tableId: string): Promise<CommandResult> {
    try {
      await this.apiClient.post(`${this.basePath}/tables/${tableId}/restore`, {})
      return { success: true, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async getTable(tableId: string): Promise<TableSnapshot | null> {
    try {
      if (typeof this.apiClient.get !== 'function') {
        return null
      }
      const raw = unwrapApiData<Record<string, unknown>>(
        await this.apiClient.get(`${this.basePath}/tables/${tableId}`),
      )
      return {
        tableId: String(raw.id ?? tableId),
        name: String(raw.name ?? ''),
        description: raw.description != null ? String(raw.description) : undefined,
        icon: raw.icon != null ? String(raw.icon) : undefined,
        status: raw.is_archived === true ? 'archived' : 'active',
      }
    } catch {
      return null
    }
  }
}
