/**
 * SyncApiClient — 对接 Django Open API 增量同步
 *
 * 路径前缀: /api/tabdata/open/v1
 *
 * fetchDelta: GET /tables/{tableId}/records?since_version=X&only_delta=true
 * pushChanges:
 *   - POST /tables/{tableId}/records/batch-create
 *   - POST /tables/{tableId}/records/batch-update
 *   - POST /tables/{tableId}/records/batch-delete
 */

import type { SyncDelta, SyncRecordChange, SyncChange, TableSchema } from '@tabtin/table-kernel'
import type { SyncApiClient } from '@tabtin/table-kernel-pglite'
import { joinApiPath } from '@tabtin/config'

export interface SyncApiClientConfig {
  baseUrl: string
  getAuthToken: () => Promise<string>
  refreshToken?: () => Promise<string | null>
  fieldKeyType?: 'id' | 'name' | 'dbFieldName'
  timeoutMs?: number
}

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

interface DjangoRecordResponse {
  records: Array<{
    id: string
    fields: Record<string, unknown>
    record_version?: number
  }>
  total: number
  latest_version?: number
  matched_total?: number
  page?: number
  page_size?: number
  delta?: boolean
}

interface DjangoSuccessEnvelope<T> {
  success?: boolean
  message?: string
  data?: T
}

interface DjangoBatchMutationResponse {
  created_count?: number
  updated_count?: number
  deleted_count?: number
  errors?: unknown[]
}

interface DjangoTableApiInfoResponse {
  table: {
    id: string
    name: string
    db_table_name: string
  }
  fields: Array<{
    id: string
    name: string
    type: string
    db_column_name: string
    is_primary?: boolean
  }>
}

interface DjangoFieldListResponse {
  fields: Array<{
    id: string
    name: string
    field_type: string
    is_required?: boolean
    is_primary?: boolean
    options?: unknown
  }>
  total: number
}

interface NotModifiedResponse {
  __notModified: true
}

interface FetchJsonOptions {
  allowNotModified?: boolean
}

export function createSyncApiClient(config: SyncApiClientConfig): SyncApiClient {
  const { apiBase, fetchJson } = createOpenApiFetcher(config)
  const fieldKeyType = config.fieldKeyType ?? 'id'

  return {
    async fetchDelta(tableId: string, sinceVersion: number): Promise<SyncDelta> {
      const allRecords: SyncRecordChange[] = []
      let page = 1
      const pageSize = 1000
      let latestVersion = sinceVersion

      while (true) {
        const params = new URLSearchParams({
          since_version: String(sinceVersion),
          only_delta: 'true',
          field_key_type: fieldKeyType,
          page: String(page),
          page_size: String(pageSize),
        })

        const url = joinApiPath(apiBase, `/tables/${tableId}/records?${params}`)
        const response = await fetchJson(url, {}, { allowNotModified: true })
        if (isNotModifiedResponse(response)) {
          break
        }
        const payload = unwrapSuccessData<DjangoRecordResponse>(response)
        const records = Array.isArray(payload.records) ? payload.records : []

        latestVersion = payload.latest_version ?? latestVersion

        for (const record of records) {
          const fields = record.fields ?? {}
          const rawAction = (record as any).action ?? (record as any).change_type
          const action: 'create' | 'update' | 'delete' =
            rawAction === 'delete' ? 'delete' :
            rawAction === 'create' ? 'create' : 'update'

          allRecords.push({
            id: record.id,
            action,
            data: action === 'delete' ? { id: record.id } : { id: record.id, ...fields },
            version: record.record_version ?? latestVersion,
          })
        }

        if (records.length < pageSize) break
        page++
      }

      return {
        version: latestVersion,
        records: allRecords,
      }
    },

    async pushChanges(
      tableId: string,
      changes: SyncChange[],
      options?: { idempotencyKey?: string },
    ): Promise<{ newVersion: number }> {
      const idempotencyKey = options?.idempotencyKey
      const creates = changes.filter((c) => c.action === 'create')
      const updates = changes.filter((c) => c.action === 'update')
      const deletes = changes.filter((c) => c.action === 'delete')
      const fieldKeyParam = `field_key_type=${fieldKeyType}`

      const makeHeaders = (actionSuffix: string) =>
        idempotencyKey
          ? {
              'Idempotency-Key': `${idempotencyKey}:${actionSuffix}`,
              'X-Change-Id': idempotencyKey,
            }
          : undefined

      if (creates.length > 0) {
        const payload = await fetchJson(joinApiPath(apiBase, `/tables/${tableId}/records/batch-create?${fieldKeyParam}`), {
          method: 'POST',
          headers: makeHeaders('create'),
          body: JSON.stringify({
            records: creates.map((c) => ({ id: c.id, fields: c.data })),
            field_key_type: fieldKeyType,
          }),
        })
        assertBatchMutationResult('create', creates.length, payload)
      }

      if (updates.length > 0) {
        const payload = await fetchJson(joinApiPath(apiBase, `/tables/${tableId}/records/batch-update?${fieldKeyParam}`), {
          method: 'POST',
          headers: makeHeaders('update'),
          body: JSON.stringify({
            records: updates.map((c) => ({ id: c.id, fields: c.data })),
            field_key_type: fieldKeyType,
          }),
        })
        assertBatchMutationResult('update', updates.length, payload)
      }

      if (deletes.length > 0) {
        const payload = await fetchJson(joinApiPath(apiBase, `/tables/${tableId}/records/batch-delete?${fieldKeyParam}`), {
          method: 'POST',
          headers: makeHeaders('delete'),
          body: JSON.stringify({
            record_ids: deletes.map((c) => c.id),
          }),
        })
        assertBatchMutationResult('delete', deletes.length, payload)
      }

      // Django batch API 不返回准确的 latest_version，用 -1 标记"需要 pull 对齐"
      return { newVersion: -1 }
    },
  }
}

export function createTableSchemaFetcher(
  config: SyncApiClientConfig,
): (tableId: string) => Promise<TableSchema> {
  const { apiBase, fetchJson } = createOpenApiFetcher(config)

  return async (tableId: string): Promise<TableSchema> => {
    const [apiInfo, fieldList] = await Promise.all([
      fetchJson(joinApiPath(apiBase, `/tables/${tableId}/api-info`)),
      fetchJson(joinApiPath(apiBase, `/tables/${tableId}/fields`)),
    ])

    const tableInfo = unwrapSuccessData<DjangoTableApiInfoResponse>(apiInfo)
    const fieldInfo = unwrapSuccessData<DjangoFieldListResponse>(fieldList)
    const detailById = new Map(
      (fieldInfo.fields ?? []).map((field) => [field.id, field]),
    )

    return {
      tableId,
      dbTableName: tableInfo.table.db_table_name,
      fields: (tableInfo.fields ?? []).map((field) => {
        const detail = detailById.get(field.id)
        return {
          id: field.id,
          name: detail?.name ?? field.name,
          fieldType: (detail?.field_type ?? field.type) as TableSchema['fields'][number]['fieldType'],
          dbColumnName: field.db_column_name || field.name,
          isPrimary: Boolean(field.is_primary ?? detail?.is_primary),
          isRequired: Boolean(detail?.is_required),
          options: isRecord(detail?.options) ? detail.options : undefined,
        }
      }),
    }
  }
}

// ── Shared authenticated fetch ──

interface AuthedFetchOptions {
  allowNotModified?: boolean
}

const DEFAULT_TIMEOUT_MS = 30_000

export function createAuthedFetcher(
  getAuthToken: () => Promise<string>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  refreshToken?: () => Promise<string | null>,
): (url: string, init?: RequestInit, opts?: AuthedFetchOptions) => Promise<unknown> {
  return async (url, init = {}, opts = {}) => {
    const doFetch = async (token: string) => {
      const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
      return fetch(url, {
        ...init,
        signal: init.signal ?? signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Client-Type': 'daemon',
          ...init.headers,
        },
      })
    }

    const token = await getAuthToken()
    let resp = await doFetch(token)

    if (resp.status === 401 && refreshToken) {
      const newToken = await refreshToken().catch(() => null)
      if (newToken && newToken !== token) {
        resp = await doFetch(newToken)
      }
    }

    if (resp.status === 401) {
      console.warn('[Auth] 401 received, token may have expired — url:', url)
    }

    if (resp.status === 304 && opts.allowNotModified) {
      return { __notModified: true }
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new ApiError(`API ${resp.status}: ${text}`, resp.status)
    }
    const ct = resp.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) return resp.json()
    return {}
  }
}

function createOpenApiFetcher(config: SyncApiClientConfig): {
  apiBase: string
  fetchJson: (url: string, options?: RequestInit, control?: FetchJsonOptions) => Promise<unknown | NotModifiedResponse>
} {
  const apiBase = `${config.baseUrl.replace(/\/+$/, '')}/api/tabdata/open/v1`
  const authedFetch = createAuthedFetcher(config.getAuthToken, config.timeoutMs, config.refreshToken)

  async function fetchJson(
    url: string,
    options: RequestInit = {},
    control: FetchJsonOptions = {},
  ): Promise<unknown | NotModifiedResponse> {
    return authedFetch(url, options, { allowNotModified: control.allowNotModified })
  }

  return { apiBase, fetchJson }
}

function unwrapSuccessData<T>(value: unknown): T {
  if (!value || typeof value !== 'object') {
    throw new ApiError('Malformed API response', 502)
  }
  const envelope = value as DjangoSuccessEnvelope<T>
  if (envelope.success === false) {
    throw new ApiError(envelope.message ?? 'API request failed', 502)
  }
  if (envelope.data === undefined) {
    throw new ApiError('Missing API response data', 502)
  }
  return envelope.data
}

function isNotModifiedResponse(value: unknown): value is NotModifiedResponse {
  return Boolean(value && typeof value === 'object' && '__notModified' in value)
}

function assertBatchMutationResult(
  action: 'create' | 'update' | 'delete',
  expectedCount: number,
  value: unknown,
): void {
  const payload = unwrapSuccessData<DjangoBatchMutationResponse>(value)
  const countKey =
    action === 'create'
      ? 'created_count'
      : action === 'update'
        ? 'updated_count'
        : 'deleted_count'
  const actualCount = Number(payload[countKey] ?? 0)
  const errors = normalizeErrors(payload.errors)
  if (errors.length > 0 || actualCount !== expectedCount) {
    const details = errors.length > 0
      ? errors.join('; ')
      : `${countKey}=${actualCount}, expected=${expectedCount}`
    throw new ApiError(`Batch ${action} failed: ${details}`, 409)
  }
}

function normalizeErrors(errors: unknown): string[] {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// ── RemoteApiClient factory for table-kernel DDD flows ──

import type { RemoteApiClient } from '@tabtin/table-kernel'

export function createRemoteApiClient(config: SyncApiClientConfig): RemoteApiClient {
  const apiRoot = `${config.baseUrl.replace(/\/+$/, '')}/api`
  const authedFetch = createAuthedFetcher(config.getAuthToken, config.timeoutMs, config.refreshToken)

  function call(path: string, init: RequestInit = {}): Promise<unknown> {
    return authedFetch(`${apiRoot}${path}`, init)
  }

  return {
    basePath: '/tabdata',
    async get(path: string): Promise<unknown> {
      return call(path, { method: 'GET' })
    },
    async post(path: string, data: unknown): Promise<unknown> {
      return call(path, { method: 'POST', body: JSON.stringify(data) })
    },
    async put(path: string, data: unknown): Promise<unknown> {
      return call(path, { method: 'PUT', body: JSON.stringify(data) })
    },
    async patch(path: string, data: unknown): Promise<unknown> {
      return call(path, { method: 'PATCH', body: JSON.stringify(data) })
    },
    async delete(path: string): Promise<unknown> {
      return call(path, { method: 'DELETE' })
    },
  }
}
