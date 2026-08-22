import type {
  CommandResult,
  CreateViewInput,
  UpdateViewInput,
  ViewSnapshot,
  IViewRepository,
  RemoteApiClient,
} from '../../ports/index.js'
import { getViewColumnMeta } from '../../ports/index.js'
import { extractApiError, unwrapApiData } from '../shared/api-utils.js'

const DEFAULT_BASE_PATH = '/tabdata'

export class RemoteViewRepository implements IViewRepository {
  private readonly basePath: string

  constructor(private readonly apiClient: RemoteApiClient) {
    this.basePath = (apiClient.basePath ?? DEFAULT_BASE_PATH).replace(/\/+$/, '')
  }

  async createView(input: CreateViewInput): Promise<CommandResult<{ viewId: string }>> {
    try {
      const body: Record<string, unknown> = {
        table_id: input.tableId,
        name: input.name,
        view_type: input.viewType,
      }
      if (input.description !== undefined) body.description = input.description
      if (input.filter !== undefined) body.filter = input.filter
      if (input.sorts !== undefined) body.sorts = input.sorts
      if (input.visibleFields !== undefined) body.visible_fields = input.visibleFields
      if (input.fieldOrder !== undefined) body.field_order = input.fieldOrder
      const columnMeta = getViewColumnMeta(input)
      if (columnMeta !== undefined) body.column_meta = columnMeta
      if (input.config !== undefined) body.config = input.config

      const result = unwrapApiData<{ id: string }>(
        await this.apiClient.post(`${this.basePath}/views`, body),
      )
      return { success: true, data: { viewId: String(result.id) }, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async updateView(input: UpdateViewInput): Promise<CommandResult> {
    try {
      const payload: Record<string, unknown> = {}
      const { changes } = input
      if (changes.name !== undefined) payload.name = changes.name
      if (changes.description !== undefined) payload.description = changes.description
      if (changes.filter !== undefined) payload.filter = changes.filter
      if (changes.sorts !== undefined) payload.sorts = changes.sorts
      if (changes.groups !== undefined) payload.groups = changes.groups
      if (changes.visibleFields !== undefined) payload.visible_fields = changes.visibleFields
      if (changes.fieldOrder !== undefined) payload.field_order = changes.fieldOrder
      const columnMeta = getViewColumnMeta(changes)
      if (columnMeta !== undefined) payload.column_meta = columnMeta
      if (changes.config !== undefined) payload.config = changes.config
      if (changes.isShared !== undefined) payload.is_shared = changes.isShared
      if (changes.isLocked !== undefined) payload.is_locked = changes.isLocked

      if (Object.keys(payload).length === 0) {
        return { success: true, errors: [] }
      }

      const send = typeof this.apiClient.put === 'function'
        ? this.apiClient.put.bind(this.apiClient)
        : this.apiClient.patch.bind(this.apiClient)

      await send(`${this.basePath}/views/${input.viewId}`, payload)
      return { success: true, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async deleteView(viewId: string): Promise<CommandResult> {
    try {
      await this.apiClient.delete(`${this.basePath}/views/${viewId}`)
      return { success: true, errors: [] }
    } catch (err) {
      return { success: false, errors: [extractApiError(err)] }
    }
  }

  async getView(viewId: string): Promise<ViewSnapshot | null> {
    if (typeof this.apiClient.get !== 'function') return null
    try {
      const raw = unwrapApiData<Record<string, unknown>>(
        await this.apiClient.get(`${this.basePath}/views/${viewId}`),
      )
      return this.parseViewSnapshot(raw)
    } catch {
      return null
    }
  }

  async listViewsByTable(tableId: string): Promise<ViewSnapshot[]> {
    if (typeof this.apiClient.get !== 'function') return []
    try {
      const raw = unwrapApiData<{ views: Array<Record<string, unknown>> }>(
        await this.apiClient.get(`${this.basePath}/tables/${tableId}/views`),
      )
      return (raw.views ?? []).map((v) => this.parseViewSnapshot(v)).filter(Boolean) as ViewSnapshot[]
    } catch {
      return []
    }
  }

  async batchUpdateViews(updates: UpdateViewInput[]): Promise<CommandResult> {
    const errors: Array<{ code: string; message: string }> = []
    for (const input of updates) {
      const result = await this.updateView(input)
      if (!result.success) {
        errors.push(...result.errors)
      }
    }
    if (errors.length > 0) {
      return { success: false, errors }
    }
    return { success: true, errors: [] }
  }

  private parseViewSnapshot(raw: Record<string, unknown> | null | undefined): ViewSnapshot | null {
    if (!raw || !raw.id) return null
    return {
      viewId: String(raw.id),
      tableId: String(raw.table_id ?? ''),
      name: String(raw.name ?? ''),
      viewType: (raw.view_type as ViewSnapshot['viewType']) ?? 'grid',
      description: raw.description != null ? String(raw.description) : undefined,
      filter: raw.filter as Record<string, unknown> | null | undefined,
      sorts: raw.sorts as Array<Record<string, unknown>> | undefined,
      groups: raw.groups as Array<Record<string, unknown>> | undefined,
      visibleFields: raw.visible_fields as string[] | undefined,
      fieldOrder: raw.field_order as string[] | undefined,
      column_meta: (raw.column_meta ?? raw.columnMeta) as ViewSnapshot['column_meta'],
      config: raw.config as Record<string, unknown> | undefined,
      isShared: raw.is_shared as boolean | undefined,
      isLocked: raw.is_locked as boolean | undefined,
    }
  }
}
