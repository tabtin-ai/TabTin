/**
 * Open API 信息查询 Service
 *
 * 提供 Space 级 DB 信息与数据库连接信息查询。
 */

import { requestJsonApi, translate } from '../http'

// ── Types ────────────────────────────────────────────

export interface DbTableInfo {
  id: string
  name: string
  db_table_name: string
  qualified_name: string
}

export interface DatabaseInfo {
  host: string
  port: number
  name: string
  engine: string
  note: string
}

export interface ProjectDbInfo {
  schema_name: string
  database: DatabaseInfo
  tables: DbTableInfo[]
}

// ── DB Connection Types ──────────────────────────────

export interface DbConnectionInfo {
  host: string
  port: number
  database: string
  username: string
  password: string
  schema: string
  connection_string: string
  created_at: string | null
}

export interface DbConnectionResponse {
  exists: boolean
  connection: DbConnectionInfo | null
}

// ── Endpoints ────────────────────────────────────────

const ENDPOINTS = {
  SPACE_DB_INFO: (spaceId: string) =>
    `/open/v1/spaces/${spaceId}/data/db-info`,
  DB_CONNECTION: (spaceId: string) =>
    `/open/v1/spaces/${spaceId}/data/db-connection`,
  DB_CONNECTION_RESET: (spaceId: string) =>
    `/open/v1/spaces/${spaceId}/data/db-connection/reset-password`,
} as const

const msg = (key: string, fallback: string) => translate(key, fallback)

// ── Service ──────────────────────────────────────────

export class OpenApiInfoService {
  /**
   * 获取 Space 级数据库概览信息
   */
  static async getSpaceDbInfo(spaceId: string): Promise<ProjectDbInfo> {
    const raw = await requestJsonApi<ProjectDbInfo>({
      endpoint: ENDPOINTS.SPACE_DB_INFO(spaceId),
      method: 'GET',
      fallbackError: msg('openApi:errors.fetchDbInfoFailed', '获取数据库信息失败'),
    })
    return raw!
  }

  /**
   * 获取 Space 级只读数据库连接
   */
  static async getDbConnection(spaceId: string): Promise<DbConnectionResponse> {
    const raw = await requestJsonApi<DbConnectionResponse>({
      endpoint: ENDPOINTS.DB_CONNECTION(spaceId),
      method: 'GET',
      fallbackError: msg('openApi:errors.fetchDbConnFailed', '获取数据库连接失败'),
    })
    return raw!
  }

  /**
   * 创建 Space 级只读数据库连接
   */
  static async createDbConnection(spaceId: string): Promise<{ connection: DbConnectionInfo }> {
    const raw = await requestJsonApi<{ connection: DbConnectionInfo }>({
      endpoint: ENDPOINTS.DB_CONNECTION(spaceId),
      method: 'POST',
      expectedStatus: [200, 201],
      fallbackError: msg('openApi:errors.createDbConnFailed', '创建数据库连接失败'),
    })
    return raw!
  }

  /**
   * 删除 Space 级只读数据库连接
   */
  static async deleteDbConnection(spaceId: string): Promise<void> {
    await requestJsonApi<void>({
      endpoint: ENDPOINTS.DB_CONNECTION(spaceId),
      method: 'DELETE',
      fallbackError: msg('openApi:errors.deleteDbConnFailed', '删除数据库连接失败'),
    })
  }

  /**
   * 重置 Space 级只读连接密码
   */
  static async resetDbConnectionPassword(spaceId: string): Promise<{ connection: DbConnectionInfo }> {
    const raw = await requestJsonApi<{ connection: DbConnectionInfo }>({
      endpoint: ENDPOINTS.DB_CONNECTION_RESET(spaceId),
      method: 'POST',
      fallbackError: msg('openApi:errors.resetDbConnFailed', '重置密码失败'),
    })
    return raw!
  }
}
