import { HttpClient } from './http.js'
import { RealtimeClient } from './realtime.js'
import { TableHandle } from './table.js'
import type {
  ApiResponse,
  SqlQueryResult,
  TabTinClientOptions,
  TabTinError,
} from './types.js'

/**
 * TabTin SDK client.
 *
 * ```ts
 * import { createClient } from '@tabtin/sdk'
 *
 * const tabtin = createClient({
 *   baseURL: 'https://api.example.com',
 *   token: 'ttn_xxx_yyy',
 * })
 *
 * // Initialize inside one Space (recommended when resolving table names)
 * await tabtin.init('space-id')
 *
 * // Query — fluent chaining with field names
 * const { data } = await tabtin.from('任务').select('*').eq('状态', '进行中')
 *
 * // Or use table ID directly (no init required)
 * const { data } = await tabtin.from('table-uuid').select('*')
 *
 * // If you skip spaceId and duplicate table names exist across Spaces,
 * // the client will ask you to pass spaceId or use a table UUID.
 *
 * // Insert
 * await tabtin.from('任务').insert({ 标题: '新任务', 状态: '待处理' })
 *
 * // SQL
 * const { data } = await tabtin.sql('space-id', 'SELECT * FROM 任务')
 * ```
 */
export class TabTinClient {
  private http: HttpClient
  private _realtime: RealtimeClient | null = null
  private options: TabTinClientOptions
  private _spaceId: string | null = null
  /** Table name → table ID cache */
  private tableCache = new Map<string, string>()
  /** Names that collide across multiple Spaces and therefore cannot be resolved safely. */
  private ambiguousTableNames = new Set<string>()
  private initialized = false

  constructor(options: TabTinClientOptions) {
    this.options = options
    this._spaceId = options.spaceId || null
    this.http = new HttpClient(
      options.baseURL,
      options.token,
      options.timeout,
    )
  }

  /** Current Space ID (set via constructor or init()). */
  get spaceId(): string | null {
    return this._spaceId
  }

  /**
   * Get the realtime client for subscribing to table changes.
   *
   * ```ts
   * const realtime = tabtin.realtime
   * await realtime.connect()
   * realtime.on('table-uuid', 'INSERT', payload => console.log(payload))
   * ```
   */
  get realtime(): RealtimeClient {
    if (!this._realtime) {
      const wsURL = this.options.baseURL.replace(/^http/, 'ws')
      this._realtime = new RealtimeClient(wsURL, this.options.token)
    }
    return this._realtime
  }

  /**
   * Initialize the client by fetching the table list.
   * This enables using table names in `from()`.
   * Optional — you can skip this and use table UUIDs directly.
   */
  async init(spaceId?: string): Promise<this> {
    if (spaceId) {
      this._spaceId = spaceId
    }
    this.tableCache.clear()
    this.ambiguousTableNames.clear()
    const { data, error } = await this.listTables(this._spaceId || undefined)
    if (error) {
      throw error
    }
    if (data?.tables) {
      for (const table of data.tables) {
        this.cacheResolvedTable(table.name, table.id)
      }
    }
    this.initialized = true
    return this
  }

  /**
   * Get a table handle by name or ID.
   *
   * - UUID → used directly (no init required)
   * - Table name → resolved from cache (call init() first, or use resolveTable())
   */
  from(tableNameOrId: string): TableHandle {
    if (isUUID(tableNameOrId)) {
      return new TableHandle(this.http, tableNameOrId, this._spaceId)
    }

    if (this.ambiguousTableNames.has(tableNameOrId)) {
      throw new Error(
        `Table "${tableNameOrId}" exists in multiple spaces. Call tabtin.init(spaceId) or use a table UUID.`,
      )
    }

    const cached = this.tableCache.get(tableNameOrId)
    if (cached) {
      return new TableHandle(this.http, cached, this._spaceId)
    }

    if (!this.initialized) {
      throw new Error(
        `Table "${tableNameOrId}" not found. Call tabtin.init() first to enable table name lookup, or use a table UUID.`,
      )
    }
    throw new Error(`Table "${tableNameOrId}" not found. Available tables: ${[...this.tableCache.keys()].join(', ')}`)
  }

  /**
   * Resolve a table name to its ID. Fetches from server if not cached.
   * Returns a TableHandle for fluent chaining.
   */
  async resolveTable(name: string): Promise<TableHandle> {
    if (this.ambiguousTableNames.has(name)) {
      throw new Error(
        `Table "${name}" exists in multiple spaces. Call tabtin.init(spaceId) or use a table UUID.`,
      )
    }

    const cached = this.tableCache.get(name)
    if (cached) {
      return new TableHandle(this.http, cached, this._spaceId)
    }

    this.tableCache.clear()
    this.ambiguousTableNames.clear()
    const { data, error } = await this.listTables()
    if (error) {
      throw error
    }
    if (data?.tables) {
      for (const table of data.tables) {
        this.cacheResolvedTable(table.name, table.id)
      }
    }

    if (this.ambiguousTableNames.has(name)) {
      throw new Error(
        `Table "${name}" exists in multiple spaces. Call tabtin.init(spaceId) or use a table UUID.`,
      )
    }

    const tableId = this.tableCache.get(name)
    if (!tableId) {
      throw new Error(`Table "${name}" not found`)
    }
    return new TableHandle(this.http, tableId, this._spaceId)
  }

  private cacheResolvedTable(name: string, id: string): void {
    if (this.ambiguousTableNames.has(name)) {
      return
    }
    const existing = this.tableCache.get(name)
    if (existing && existing !== id) {
      this.tableCache.delete(name)
      this.ambiguousTableNames.add(name)
      return
    }
    this.tableCache.set(name, id)
  }

  /**
   * Execute a raw SQL query (read-only) on a Space.
   */
  async sql(
    spaceId: string,
    query: string,
    params?: unknown[],
  ): Promise<ApiResponse<SqlQueryResult>> {
    try {
      const result = await this.http.post<SqlQueryResult>(
        `/api/open/v1/spaces/${spaceId}/data/sql/query`,
        { sql: query, params: params || [] },
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /**
   * Execute a write SQL statement on a Space.
   */
  async sqlExecute(
    spaceId: string,
    query: string,
    params?: unknown[],
    options?: { allowDelete?: boolean },
  ): Promise<ApiResponse<SqlQueryResult>> {
    try {
      const result = await this.http.post<SqlQueryResult>(
        `/api/open/v1/spaces/${spaceId}/data/sql/execute`,
        {
          sql: query,
          params: params || [],
          allow_delete: options?.allowDelete ?? false,
        },
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /**
   * List all accessible Spaces for the current token.
   */
  async listSpaces(): Promise<ApiResponse<{ spaces: { id: string; name: string }[] }>> {
    try {
      const result = await this.http.get<{ spaces: { id: string; name: string }[] }>(
        '/api/open/v1/spaces',
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /**
   * List all tables accessible via the current token.
   * When spaceId is omitted, discover Spaces first and then aggregate tables.
   */
  async listTables(spaceId?: string): Promise<ApiResponse<{ tables: { id: string; name: string }[] }>> {
    try {
      if (spaceId) {
        const result = await this.http.get<{ tables: { id: string; name: string }[] }>(
          `/api/open/v1/spaces/${spaceId}/data/tables`,
        )
        return { data: result, error: null }
      }

      const spaces = await this.http.get<{ spaces: { id: string; name: string }[] }>(
        '/api/open/v1/spaces',
      )
      const tableMap = new Map<string, { id: string; name: string }>()

      for (const space of spaces.spaces ?? []) {
        const tables = await this.http.get<{ tables: { id: string; name: string }[] }>(
          `/api/open/v1/spaces/${space.id}/data/tables`,
        )
        for (const table of tables.tables ?? []) {
          tableMap.set(table.id, table)
        }
      }

      return { data: { tables: [...tableMap.values()] }, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }
}

function isUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)
}
