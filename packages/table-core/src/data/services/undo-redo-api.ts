/**
 * UndoRedoApiService - 撤销/重做 & 记录历史 API 服务
 *
 * 对应后端 api_undo_redo.py 的端点。
 * 注意：`BatchUndoRedoResponse` / `UndoRedoResponse` 是裸业务体（自身带
 * `success`/`message`，无外层 `data`）。unwrap 必须保留业务字段（见 ），
 * 不能把 `success: true` 且无 `data` 一律剥成 `{}`。
 */

import {
  getOptionalWindowIdHeader,
  requestJsonApi,
  translate,
} from '../http'
import { getTableDataClientConfig } from '../config'
import type {
  UndoRedoRequest,
  UndoRedoResponse,
  BatchUndoRedoResponse,
  UndoStackResponse,
  RedoStackResponse,
  RecordHistoryResponse,
  TableHistoryResponse,
  RecordHistoryQuery,
  TableHistoryQuery,
  RecordSnapshotResponse,
  TableSnapshotResponse,
  RestoreRecordRequest,
  RestoreRecordResponse,
  RestoreTableRequest,
  RestoreTableResponse,
  TableNamedVersion,
  CreateTableNamedVersionRequest,
  RenameTableNamedVersionRequest,
} from '../types/undo-redo'

const msg = (key: string, fallback: string) => translate(key, fallback)

/**
 * 构建 query string 后缀（含 '?'）；无参数时返回空字符串。
 */
const buildQuerySuffix = (params: URLSearchParams): string => {
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export class UndoRedoApiService {
  // ── Record-level operations ──

  /** 撤销单条记录的最近一次操作 */
  static async undoRecord(
    recordId: string,
    data: UndoRedoRequest = {}
  ): Promise<UndoRedoResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<UndoRedoResponse>({
      method: 'POST',
      endpoint: endpoints.UNDO_REDO.RECORD_UNDO(recordId),
      body: data,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.undoRecordFailed', '撤销操作失败'),
    })
  }

  /** 重做单条记录的最近一次已撤销操作 */
  static async redoRecord(
    recordId: string,
    data: UndoRedoRequest = {}
  ): Promise<UndoRedoResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<UndoRedoResponse>({
      method: 'POST',
      endpoint: endpoints.UNDO_REDO.RECORD_REDO(recordId),
      body: data,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.redoRecordFailed', '重做操作失败'),
    })
  }

  /** 获取单条记录的变更历史 */
  static async getRecordHistory(
    recordId: string,
    params: RecordHistoryQuery = {}
  ): Promise<RecordHistoryResponse> {
    const { endpoints } = getTableDataClientConfig()
    const queryParams = new URLSearchParams()
    if (params.cursor) queryParams.set('cursor', params.cursor)
    if (params.startDate) queryParams.set('startDate', params.startDate)
    if (params.endDate) queryParams.set('endDate', params.endDate)
    if (params.include_undone !== undefined) queryParams.set('include_undone', String(params.include_undone))
    if (params.limit) queryParams.set('limit', String(Math.min(params.limit, 200)))

    const endpoint = `${endpoints.UNDO_REDO.RECORD_HISTORY(recordId)}${buildQuerySuffix(queryParams)}`

    return requestJsonApi<RecordHistoryResponse>({
      method: 'GET',
      endpoint,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.getRecordHistoryFailed', '获取记录历史失败'),
    })
  }

  // ── Table-level operations ──

  /** 获取表格范围内的变更历史 */
  static async getTableHistory(
    tableId: string,
    params: TableHistoryQuery = {}
  ): Promise<TableHistoryResponse> {
    const { endpoints } = getTableDataClientConfig()
    const queryParams = new URLSearchParams()
    if (params.cursor) queryParams.set('cursor', params.cursor)
    if (params.startDate) queryParams.set('startDate', params.startDate)
    if (params.endDate) queryParams.set('endDate', params.endDate)
    if (params.include_undone !== undefined) queryParams.set('include_undone', String(params.include_undone))
    if (params.only_my_operations !== undefined) queryParams.set('only_my_operations', String(params.only_my_operations))
    if (params.limit) queryParams.set('limit', String(Math.min(params.limit, 200)))

    const endpoint = `${endpoints.UNDO_REDO.TABLE_HISTORY(tableId)}${buildQuerySuffix(queryParams)}`

    return requestJsonApi<TableHistoryResponse>({
      method: 'GET',
      endpoint,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.getTableHistoryFailed', '获取表格历史失败'),
    })
  }

  /** 撤销表级别的最近一次操作（可能影响多条记录） */
  static async undoTable(
    tableId: string,
    data: UndoRedoRequest = {}
  ): Promise<BatchUndoRedoResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<BatchUndoRedoResponse>({
      method: 'POST',
      endpoint: endpoints.UNDO_REDO.TABLE_UNDO(tableId),
      body: data,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.undoTableFailed', '撤销操作失败'),
    })
  }

  /** 重做表级别的最近一次已撤销操作 */
  static async redoTable(
    tableId: string,
    data: UndoRedoRequest = {}
  ): Promise<BatchUndoRedoResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<BatchUndoRedoResponse>({
      method: 'POST',
      endpoint: endpoints.UNDO_REDO.TABLE_REDO(tableId),
      body: data,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.redoTableFailed', '重做操作失败'),
    })
  }

  // ── Stack queries ──

  /** 获取表的可撤销操作栈 */
  static async getUndoStack(
    tableId: string,
    params: { only_my_operations?: boolean; limit?: number } = {}
  ): Promise<UndoStackResponse> {
    const { endpoints } = getTableDataClientConfig()
    const queryParams = new URLSearchParams()
    if (params.only_my_operations) queryParams.set('only_my_operations', 'true')
    if (params.limit) queryParams.set('limit', String(Math.min(params.limit, 100)))

    const endpoint = `${endpoints.UNDO_REDO.TABLE_UNDO_STACK(tableId)}${buildQuerySuffix(queryParams)}`

    return requestJsonApi<UndoStackResponse>({
      method: 'GET',
      endpoint,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.getUndoStackFailed', '获取撤销栈失败'),
    })
  }

  /** 获取表的可重做操作栈 */
  static async getRedoStack(
    tableId: string,
    params: { only_my_operations?: boolean; limit?: number } = {}
  ): Promise<RedoStackResponse> {
    const { endpoints } = getTableDataClientConfig()
    const queryParams = new URLSearchParams()
    if (params.only_my_operations) queryParams.set('only_my_operations', 'true')
    if (params.limit) queryParams.set('limit', String(Math.min(params.limit, 100)))

    const endpoint = `${endpoints.UNDO_REDO.TABLE_REDO_STACK(tableId)}${buildQuerySuffix(queryParams)}`

    return requestJsonApi<RedoStackResponse>({
      method: 'GET',
      endpoint,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.getRedoStackFailed', '获取重做栈失败'),
    })
  }

  // ── Snapshot & Restore ──

  /** 获取记录在指定历史时间点的数据快照 */
  static async getRecordSnapshot(
    recordId: string,
    historyId: string,
  ): Promise<RecordSnapshotResponse> {
    const { endpoints } = getTableDataClientConfig()
    const endpoint = `${endpoints.UNDO_REDO.RECORD_SNAPSHOT(recordId)}?history_id=${encodeURIComponent(historyId)}`

    return requestJsonApi<RecordSnapshotResponse>({
      method: 'GET',
      endpoint,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.getSnapshotFailed', '获取记录快照失败'),
    })
  }

  /** 获取表格在指定历史时间点的数据快照 */
  static async getTableSnapshot(
    tableId: string,
    historyId: string,
  ): Promise<TableSnapshotResponse> {
    const { endpoints } = getTableDataClientConfig()
    const endpoint = `${endpoints.UNDO_REDO.TABLE_SNAPSHOT(tableId)}?history_id=${encodeURIComponent(historyId)}`

    return requestJsonApi<TableSnapshotResponse>({
      method: 'GET',
      endpoint,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.getSnapshotFailed', '获取表格快照失败'),
    })
  }

  /** 还原记录到指定历史版本 */
  static async restoreRecord(
    recordId: string,
    data: RestoreRecordRequest,
  ): Promise<RestoreRecordResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<RestoreRecordResponse>({
      method: 'POST',
      endpoint: endpoints.UNDO_REDO.RECORD_RESTORE(recordId),
      body: data,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.restoreFailed', '还原记录失败'),
    })
  }

  /** 还原整张表格到指定历史版本 */
  static async restoreTable(
    tableId: string,
    data: RestoreTableRequest,
  ): Promise<RestoreTableResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<RestoreTableResponse>({
      method: 'POST',
      endpoint: endpoints.UNDO_REDO.TABLE_RESTORE(tableId),
      body: data,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.restoreFailed', '还原表格失败'),
    })
  }

  // ── 命名版本（手动保存）──

  /** 列出表格的命名版本 */
  static async listTableNamedVersions(
    tableId: string,
    limit = 50,
  ): Promise<TableNamedVersion[]> {
    const { endpoints } = getTableDataClientConfig()
    const endpoint = `${endpoints.UNDO_REDO.TABLE_NAMED_VERSIONS(tableId)}?limit=${Math.max(1, limit)}`
    const result = await requestJsonApi<{ versions: TableNamedVersion[] }>({
      method: 'GET',
      endpoint,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.listVersionsFailed', '获取版本列表失败'),
    })
    return Array.isArray(result.versions) ? result.versions : []
  }

  /** 创建表格命名版本 */
  static async createTableNamedVersion(
    tableId: string,
    data: CreateTableNamedVersionRequest = {},
  ): Promise<TableNamedVersion> {
    const { endpoints } = getTableDataClientConfig()
    const result = await requestJsonApi<{ version: TableNamedVersion }>({
      method: 'POST',
      endpoint: endpoints.UNDO_REDO.TABLE_NAMED_VERSIONS(tableId),
      body: data,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.createVersionFailed', '保存版本失败'),
    })
    return result.version
  }

  /** 重命名表格命名版本 */
  static async renameTableNamedVersion(
    tableId: string,
    versionId: string,
    data: RenameTableNamedVersionRequest,
  ): Promise<TableNamedVersion> {
    const { endpoints } = getTableDataClientConfig()
    const result = await requestJsonApi<{ version: TableNamedVersion }>({
      method: 'PATCH',
      endpoint: endpoints.UNDO_REDO.TABLE_NAMED_VERSION_DETAIL(tableId, versionId),
      body: data,
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.renameVersionFailed', '重命名版本失败'),
    })
    return result.version
  }

  /** 删除表格命名版本 */
  static async deleteTableNamedVersion(
    tableId: string,
    versionId: string,
  ): Promise<void> {
    const { endpoints } = getTableDataClientConfig()
    await requestJsonApi<{ deleted: boolean }>({
      method: 'DELETE',
      endpoint: endpoints.UNDO_REDO.TABLE_NAMED_VERSION_DETAIL(tableId, versionId),
      extraHeaders: getOptionalWindowIdHeader(),
      fallbackError: msg('undoRedo:apiErrors.deleteVersionFailed', '删除版本失败'),
    })
  }
}
