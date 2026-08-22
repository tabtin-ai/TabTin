import { HttpClient } from './http.js'
import {
  TabTinError,
} from './types.js'
import type {
  ApiResponse,
  FilterCondition,
  FilterOperator,
  FilterSet,
  RecordFields,
  RecordListResult,
  RecordRow,
  SortItem,
} from './types.js'

/**
 * Fluent query builder for TabData tables.
 *
 * Usage:
 * ```ts
 * const { data, error } = await tabtin
 *   .from('任务')
 *   .select('标题, 状态')
 *   .eq('状态', '进行中')
 *   .order('创建时间', { ascending: false })
 *   .limit(10)
 *   .execute()
 * ```
 */
export class QueryBuilder {
  private http: HttpClient
  private pathPrefix: string
  private _select: string[] | null = null
  private _filters: FilterCondition[] = []
  private _sorts: SortItem[] = []
  private _page = 1
  private _pageSize = 100
  private _search: string | null = null

  constructor(http: HttpClient, pathPrefix: string) {
    this.http = http
    this.pathPrefix = pathPrefix
  }

  /** Select specific fields. Pass comma-separated string or array. */
  select(fields: string | string[]): this {
    if (typeof fields === 'string') {
      if (fields === '*') {
        this._select = null
      } else {
        this._select = fields.split(',').map(f => f.trim())
      }
    } else {
      this._select = fields
    }
    return this
  }

  // ── Filter shortcuts ─────────────────────────────────

  eq(field: string, value: unknown): this {
    return this.filter(field, 'equals', value)
  }

  neq(field: string, value: unknown): this {
    return this.filter(field, 'not_equals', value)
  }

  gt(field: string, value: unknown): this {
    return this.filter(field, 'greater_than', value)
  }

  gte(field: string, value: unknown): this {
    return this.filter(field, 'greater_than_or_equals', value)
  }

  lt(field: string, value: unknown): this {
    return this.filter(field, 'less_than', value)
  }

  lte(field: string, value: unknown): this {
    return this.filter(field, 'less_than_or_equals', value)
  }

  contains(field: string, value: string): this {
    return this.filter(field, 'contains', value)
  }

  notContains(field: string, value: string): this {
    return this.filter(field, 'not_contains', value)
  }

  like(field: string, pattern: string): this {
    return this.filter(field, 'like', pattern)
  }

  ilike(field: string, pattern: string): this {
    return this.filter(field, 'ilike', pattern)
  }

  in(field: string, values: unknown[]): this {
    return this.filter(field, 'in', values)
  }

  notIn(field: string, values: unknown[]): this {
    return this.filter(field, 'not_in', values)
  }

  hasAnyOf(field: string, values: unknown[]): this {
    return this.filter(field, 'has_any_of', values)
  }

  hasAllOf(field: string, values: unknown[]): this {
    return this.filter(field, 'has_all_of', values)
  }

  hasNoneOf(field: string, values: unknown[]): this {
    return this.filter(field, 'has_none_of', values)
  }

  isExactly(field: string, values: unknown[]): this {
    return this.filter(field, 'is_exactly', values)
  }

  isEmpty(field: string): this {
    return this.filter(field, 'is_empty')
  }

  isNotEmpty(field: string): this {
    return this.filter(field, 'is_not_empty')
  }

  filter(field: string, operator: FilterOperator, value?: unknown): this {
    this._filters.push({ field, operator, value })
    return this
  }

  // ── Sort ─────────────────────────────────────────────

  order(field: string, options?: { ascending?: boolean }): this {
    this._sorts.push({
      field,
      order: options?.ascending === false ? 'desc' : 'asc',
    })
    return this
  }

  // ── Pagination ───────────────────────────────────────

  limit(count: number): this {
    this._pageSize = Math.min(count, 2000)
    return this
  }

  page(num: number): this {
    this._page = num
    return this
  }

  // ── Search ───────────────────────────────────────────

  search(keyword: string): this {
    this._search = keyword
    return this
  }

  // ── Execute ──────────────────────────────────────────

  async execute(): Promise<ApiResponse<RecordListResult>> {
    const body: Record<string, unknown> = {
      field_key_type: 'name',
      page: this._page,
      page_size: this._pageSize,
    }

    if (this._select) {
      body.fields = this._select
    }

    if (this._filters.length > 0) {
      body.filter = {
        conjunction: 'and',
        filterSet: this._filters,
      } satisfies FilterSet
    }

    if (this._sorts.length > 0) {
      body.sort = this._sorts
    }

    if (this._search) {
      body.search = this._search
    }

    try {
      const result = await this.http.post<RecordListResult>(
        `${this.pathPrefix}/records/query`,
        body,
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /** Alias for execute() — allows `await tabtin.from('t').select('*')` without explicit .execute() */
  then<TResult1 = ApiResponse<RecordListResult>, TResult2 = never>(
    onfulfilled?: ((value: ApiResponse<RecordListResult>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }
}

// ── Insert / Update / Delete builders ─────────────────

export class InsertBuilder {
  private http: HttpClient
  private pathPrefix: string
  private records: RecordFields[]

  constructor(http: HttpClient, pathPrefix: string, data: RecordFields | RecordFields[]) {
    this.http = http
    this.pathPrefix = pathPrefix
    this.records = Array.isArray(data) ? data : [data]
  }

  async execute(): Promise<ApiResponse<{ created_count: number }>> {
    const isSingle = this.records.length === 1

    try {
      if (isSingle) {
        const result = await this.http.post<RecordRow>(
          `${this.pathPrefix}/records`,
          { fields: this.records[0], field_key_type: 'name' },
        )
        return { data: { created_count: result ? 1 : 0 }, error: null }
      }

      const result = await this.http.post<{ created_count: number }>(
        `${this.pathPrefix}/records/batch-create`,
        {
          records: this.records.map(fields => ({ fields })),
          field_key_type: 'name',
        },
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  then<TResult1 = ApiResponse<{ created_count: number }>, TResult2 = never>(
    onfulfilled?: ((value: ApiResponse<{ created_count: number }>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }
}

export class UpdateBuilder {
  private http: HttpClient
  private pathPrefix: string
  private _fields: RecordFields
  private _filters: FilterCondition[] = []
  private _recordId: string | null = null

  constructor(http: HttpClient, pathPrefix: string, fields: RecordFields) {
    this.http = http
    this.pathPrefix = pathPrefix
    this._fields = fields
  }

  /** Update a specific record by ID */
  matchId(recordId: string): this {
    this._recordId = recordId
    return this
  }

  eq(field: string, value: unknown): this {
    this._filters.push({ field, operator: 'equals', value })
    return this
  }

  async execute(): Promise<ApiResponse<{ updated_count: number }>> {
    try {
      if (this._recordId) {
        await this.http.patch<RecordRow>(
          `${this.pathPrefix}/records/${this._recordId}`,
          { fields: this._fields, field_key_type: 'name' },
        )
        return { data: { updated_count: 1 }, error: null }
      }

      const queryBody: Record<string, unknown> = {
        field_key_type: 'name',
        page: 1,
        page_size: 2000,
      }
      if (this._filters.length > 0) {
        queryBody.filter = { conjunction: 'and', filterSet: this._filters }
      }

      const queryResult = await this.http.post<RecordListResult>(
        `${this.pathPrefix}/records/query`,
        queryBody,
      )

      if (!queryResult.records.length) {
        return { data: { updated_count: 0 }, error: null }
      }

      const result = await this.http.post<{ updated_count: number }>(
        `${this.pathPrefix}/records/batch-update`,
        {
          records: queryResult.records.map(r => ({
            id: r.id,
            fields: this._fields,
          })),
          field_key_type: 'name',
        },
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  then<TResult1 = ApiResponse<{ updated_count: number }>, TResult2 = never>(
    onfulfilled?: ((value: ApiResponse<{ updated_count: number }>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }
}

export class UpsertBuilder {
  private http: HttpClient
  private pathPrefix: string
  private records: RecordFields[]
  private _onConflict: string[] = []

  constructor(http: HttpClient, pathPrefix: string, data: RecordFields | RecordFields[], options?: { onConflict: string | string[] }) {
    this.http = http
    this.pathPrefix = pathPrefix
    this.records = Array.isArray(data) ? data : [data]
    if (options?.onConflict) {
      this._onConflict = typeof options.onConflict === 'string'
        ? [options.onConflict]
        : options.onConflict
    }
  }

  async execute(): Promise<ApiResponse<{ created: number; updated: number }>> {
    if (this._onConflict.length === 0) {
      return {
        data: null,
        error: new TabTinError('onConflict field is required for upsert', 400, 'VALIDATION_ERROR'),
      }
    }

    try {
      const result = await this.http.post<{ created: number; updated: number }>(
        `${this.pathPrefix}/records/upsert`,
        {
          records: this.records.map(fields => ({ fields })),
          upsert_on: this._onConflict,
          field_key_type: 'name',
        },
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  then<TResult1 = ApiResponse<{ created: number; updated: number }>, TResult2 = never>(
    onfulfilled?: ((value: ApiResponse<{ created: number; updated: number }>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }
}

export class DeleteBuilder {
  private http: HttpClient
  private pathPrefix: string
  private _recordIds: string[] = []
  private _filters: FilterCondition[] = []

  constructor(http: HttpClient, pathPrefix: string) {
    this.http = http
    this.pathPrefix = pathPrefix
  }

  /** Delete specific records by ID */
  matchIds(ids: string[]): this {
    this._recordIds = ids
    return this
  }

  eq(field: string, value: unknown): this {
    this._filters.push({ field, operator: 'equals', value })
    return this
  }

  async execute(): Promise<ApiResponse<{ deleted_count: number }>> {
    try {
      let recordIds = this._recordIds

      if (recordIds.length === 0 && this._filters.length > 0) {
        const queryResult = await this.http.post<RecordListResult>(
          `${this.pathPrefix}/records/query`,
          {
            field_key_type: 'name',
            page: 1,
            page_size: 2000,
            filter: { conjunction: 'and', filterSet: this._filters },
          },
        )
        recordIds = queryResult.records.map(r => r.id)
      }

      if (recordIds.length === 0) {
        return { data: { deleted_count: 0 }, error: null }
      }

      if (recordIds.length === 1) {
        await this.http.delete(`${this.pathPrefix}/records/${recordIds[0]}`)
        return { data: { deleted_count: 1 }, error: null }
      }

      const result = await this.http.post<{ deleted_count: number }>(
        `${this.pathPrefix}/records/batch-delete`,
        { record_ids: recordIds },
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  then<TResult1 = ApiResponse<{ deleted_count: number }>, TResult2 = never>(
    onfulfilled?: ((value: ApiResponse<{ deleted_count: number }>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }
}
