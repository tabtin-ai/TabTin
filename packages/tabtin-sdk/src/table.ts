import { HttpClient } from './http.js'
import {
  QueryBuilder,
  InsertBuilder,
  UpdateBuilder,
  UpsertBuilder,
  DeleteBuilder,
} from './query-builder.js'
import { StorageHandle } from './storage.js'
import type {
  ApiResponse,
  AggregationItem,
  FieldMapResult,
  RecordFields,
  RLSPolicy,
  RLSPolicyCreateInput,
  RLSPolicyUpdateInput,
  RLSStatus,
  TabTinError,
} from './types.js'

/**
 * Table handle — returned by `tabtin.from('tableName')`.
 *
 * Provides fluent CRUD operations on a single table.
 */
export class TableHandle {
  private http: HttpClient
  private tableId: string
  private _pathPrefix: string

  constructor(http: HttpClient, tableId: string, spaceId?: string | null) {
    this.http = http
    this.tableId = tableId
    this._pathPrefix = spaceId
      ? `/api/open/v1/spaces/${spaceId}/data/tables/${tableId}`
      : `/api/tabdata/open/v1/tables/${tableId}`
  }

  /** Get a storage handle for file upload/download/list/delete on this table. */
  get storage(): StorageHandle {
    return new StorageHandle(this.http, this._pathPrefix)
  }

  /** Start a SELECT query. Pass '*' for all fields, or comma-separated field names. */
  select(fields: string | string[] = '*'): QueryBuilder {
    return new QueryBuilder(this.http, this._pathPrefix).select(fields)
  }

  /** Insert one or more records. */
  insert(data: RecordFields | RecordFields[]): InsertBuilder {
    return new InsertBuilder(this.http, this._pathPrefix, data)
  }

  /** Update records. Chain with .matchId() or .eq() to target specific records. */
  update(fields: RecordFields): UpdateBuilder {
    return new UpdateBuilder(this.http, this._pathPrefix, fields)
  }

  /** Upsert (insert or update on conflict). */
  upsert(data: RecordFields | RecordFields[], options: { onConflict: string | string[] }): UpsertBuilder {
    return new UpsertBuilder(this.http, this._pathPrefix, data, options)
  }

  /** Delete records. Chain with .matchIds() or .eq() to target specific records. */
  delete(): DeleteBuilder {
    return new DeleteBuilder(this.http, this._pathPrefix)
  }

  /** Get field name → field ID mapping (useful for introspection). */
  async fieldMap(): Promise<ApiResponse<FieldMapResult>> {
    try {
      const result = await this.http.get<FieldMapResult>(
        `${this._pathPrefix}/field-map`,
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /** Run aggregation queries on this table. */
  async aggregate(items: AggregationItem[]): Promise<ApiResponse<Record<string, unknown>[]>> {
    try {
      const result = await this.http.post<Record<string, unknown>[]>(
        `${this._pathPrefix}/aggregation`,
        { items, field_key_type: 'name' },
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  // ── RLS (Row Level Security) ────────────────────────

  /** List all RLS policies and the RLS status for this table. */
  async listPolicies(): Promise<ApiResponse<RLSStatus>> {
    try {
      const result = await this.http.get<RLSStatus>(`${this._pathPrefix}/policies`)
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /** Create an RLS policy on this table. */
  async createPolicy(input: RLSPolicyCreateInput): Promise<ApiResponse<RLSPolicy>> {
    try {
      const result = await this.http.post<RLSPolicy>(`${this._pathPrefix}/policies`, input)
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /** Update an RLS policy. */
  async updatePolicy(policyId: string, input: RLSPolicyUpdateInput): Promise<ApiResponse<RLSPolicy>> {
    try {
      const result = await this.http.patch<RLSPolicy>(`${this._pathPrefix}/policies/${policyId}`, input)
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /** Delete an RLS policy. */
  async deletePolicy(policyId: string): Promise<ApiResponse<{ deleted: boolean }>> {
    try {
      const result = await this.http.delete<{ deleted: boolean }>(`${this._pathPrefix}/policies/${policyId}`)
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /**
   * Enable or disable RLS on this table.
   *
   * @param enabled - Whether to enable RLS
   * @param force - Whether JWT users (table owner) are also subject to RLS
   */
  async setRLS(enabled: boolean, force = false): Promise<ApiResponse<{ rls_enabled: boolean; rls_force: boolean }>> {
    try {
      const result = await this.http.patch<{ rls_enabled: boolean; rls_force: boolean }>(
        `${this._pathPrefix}/rls`,
        { rls_enabled: enabled, rls_force: force },
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }
}
