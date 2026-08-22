import { API_ENDPOINTS } from '@tabtin/config'
import type { FieldType, ViewType } from '@tabtin/table-kernel'
import { McpDomainSupport } from './domain-support.js'
interface DjangoTableEntry { id: string; name: string; description?: string; fields?: unknown[]; record_count?: number }
interface DjangoTableListPayload { tables?: DjangoTableEntry[]; items?: DjangoTableEntry[] }
interface DjangoRecordQueryPayload { records?: unknown[]; total?: number }
export class TableMcpDomain extends McpDomainSupport {
  async toolTableList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const spaceId = args.space_id as string | undefined
    const source: DjangoTableEntry[] = []

    if (spaceId) {
      const data = await this.get(
        API_ENDPOINTS.OPEN_API.SPACE_TABLES(spaceId),
      ) as DjangoTableListPayload
      source.push(...(data.tables ?? data.items ?? []))
    } else {
      const spaces = await this.get(API_ENDPOINTS.OPEN_API.SPACES) as {
        spaces?: Array<{ id: string }>
      }
      const dedup = new Map<string, DjangoTableEntry>()
      const results = await Promise.all(
        (spaces.spaces ?? []).map((space) =>
          this.get(API_ENDPOINTS.OPEN_API.SPACE_TABLES(space.id)) as Promise<DjangoTableListPayload>,
        ),
      )
      for (const data of results) {
        for (const table of data.tables ?? data.items ?? []) {
          dedup.set(table.id, table)
        }
      }
      source.push(...dedup.values())
    }

    const tables = source.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description || '',
      field_count: t.fields?.length ?? 0,
      record_count: t.record_count ?? 0,
    }))
    return {
      content: [{ type: 'text', text: JSON.stringify(tables, null, 2) }],
    }
  }

  async toolTableQuery(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tableId = args.table_id as string
    const page = (args.page as number) || 1
    const pageSize = Math.min((args.page_size as number) || 100, 1000)
    const fieldKeyType = (args.field_key_type as string) || 'name'

    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      field_key_type: fieldKeyType,
    })

    if (args.filters && typeof args.filters === 'object') {
      params.set('filter', JSON.stringify(args.filters))
    }
    if (Array.isArray(args.sorts) && args.sorts.length > 0) {
      const first = args.sorts[0] as Record<string, unknown>
      const fieldRef = (first.field_id ?? first.field ?? first.fieldId) as string | undefined
      if (fieldRef) {
        params.set('sort_by', fieldRef)
        params.set('sort_order', (first.order as string) || 'asc')
      }
    }

    // 后端 open API 实际前缀是 /open/v1（非 /tabdata/open/v1），但此处
    // 保留原路径以兼容可能的 tabdata-level token API（需后端确认后修正）。
    const tableRecordsPath = `/tabdata/open/v1/tables/${tableId}/records`
    const data = await this.get(`${tableRecordsPath}?${params}`) as DjangoRecordQueryPayload
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          records: data.records ?? [],
          total: data.total ?? 0,
          page,
          page_size: pageSize,
        }, null, 2),
      }],
    }
  }

  async toolTableCreate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'space_id', 'name')
    const kernel = this.requireTable()
    const result = await kernel.createTable({
      spaceId: args.space_id as string,
      name: args.name as string,
      description: args.description as string | undefined,
    })
    return this.formatResult(result)
  }

  async toolTableUpdate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'table_id')
    const kernel = this.requireTable()
    const changes: Record<string, unknown> = {}
    if (args.name != null) changes.name = args.name
    if (args.description != null) changes.description = args.description
    if (args.icon != null) changes.icon = args.icon
    const result = await kernel.updateTable({
      tableId: args.table_id as string,
      changes: changes as Partial<{ name: string; description: string; icon: string }>,
    })
    return this.formatResult(result)
  }

  async toolTableDelete(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'table_id')
    const kernel = this.requireTable()
    const result = await kernel.deleteTable(args.table_id as string)
    return this.formatResult(result)
  }

  async toolTableArchive(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'table_id')
    const kernel = this.requireTable()
    const result = await kernel.archiveTable(args.table_id as string)
    return this.formatResult(result)
  }

  async toolTableRestore(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'table_id')
    const kernel = this.requireTable()
    const result = await kernel.restoreTable(args.table_id as string)
    return this.formatResult(result)
  }

  async toolFieldCreate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'table_id', 'name', 'field_type')
    const kernel = this.requireTable()
    const result = await kernel.createField({
      tableId: args.table_id as string,
      name: args.name as string,
      fieldType: args.field_type as FieldType,
      options: args.options as Record<string, unknown> | undefined,
    })
    return this.formatResult(result)
  }

  async toolFieldUpdate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'table_id', 'field_id')
    const kernel = this.requireTable()
    const changes: Record<string, unknown> = {}
    if (args.name != null) changes.name = args.name
    if (args.options != null) changes.options = args.options
    const result = await kernel.updateField({
      tableId: args.table_id as string,
      fieldId: args.field_id as string,
      changes: changes as Partial<{ name: string; options: Record<string, unknown> }>,
    })
    return this.formatResult(result)
  }

  async toolFieldDelete(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'table_id', 'field_id')
    const kernel = this.requireTable()
    const result = await kernel.deleteField({
      tableId: args.table_id as string,
      fieldId: args.field_id as string,
    })
    return this.formatResult(result)
  }

  async toolViewCreate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'table_id', 'name', 'view_type')
    const kernel = this.requireTable()
    const result = await kernel.createView({
      tableId: args.table_id as string,
      name: args.name as string,
      viewType: args.view_type as ViewType,
    })
    return this.formatResult(result)
  }

  async toolViewUpdate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'view_id')
    const kernel = this.requireTable()
    const changes: Record<string, unknown> = {}
    if (args.name != null) changes.name = args.name
    if (args.config != null) changes.config = args.config as Record<string, unknown>
    const result = await kernel.updateView({
      viewId: args.view_id as string,
      changes,
    })
    return this.formatResult(result)
  }

  async toolViewDelete(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'view_id')
    const kernel = this.requireTable()
    const result = await kernel.deleteView(args.view_id as string)
    return this.formatResult(result)
  }

  // ── Record 写工具 ──

  async toolRecordCreate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'table_id', 'data')
    const kernel = this.requireTable()
    const result = await kernel.createRecord({
      tableId: args.table_id as string,
      data: args.data as Record<string, unknown>,
    })
    return this.formatResult(result)
  }

  async toolRecordUpdate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'table_id', 'record_id', 'data')
    const kernel = this.requireTable()
    const result = await kernel.updateRecord({
      tableId: args.table_id as string,
      recordId: args.record_id as string,
      data: args.data as Record<string, unknown>,
    })
    return this.formatResult(result)
  }

  async toolRecordDelete(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'table_id', 'record_id')
    const kernel = this.requireTable()
    const result = await kernel.deleteRecord({
      tableId: args.table_id as string,
      recordId: args.record_id as string,
    })
    return this.formatResult(result)
  }

  async toolRecordBatch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'table_id', 'action')
    const kernel = this.requireTable()
    const tableId = args.table_id as string
    const action = args.action as string

    switch (action) {
      case 'create': {
        const records = args.records as Record<string, unknown>[]
        if (!Array.isArray(records) || records.length === 0) throw new Error('records array required for create')
        const result = await kernel.batchCreateRecords({ tableId, records })
        return this.formatResult(result)
      }
      case 'update': {
        const records = args.records as Array<{ id: string; data: Record<string, unknown> }>
        if (!Array.isArray(records) || records.length === 0) throw new Error('records array required for update')
        const result = await kernel.batchUpdateRecords({ tableId, records })
        return this.formatResult(result)
      }
      case 'delete': {
        const recordIds = args.record_ids as string[]
        if (!Array.isArray(recordIds) || recordIds.length === 0) throw new Error('record_ids array required for delete')
        const result = await kernel.batchDeleteRecords({ tableId, recordIds })
        return this.formatResult(result)
      }
      default:
        throw new Error(`Unknown batch action: ${action}. Use create, update, or delete.`)
    }
  }

  // ── TabDoc write tools (Django API) ──

}
