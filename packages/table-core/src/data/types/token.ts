/**
 * Open API Token 类型定义
 */

// ── Scope ──────────────────────────────────────────────

export const TOKEN_SCOPES = {
  // 表格
  'table:read': '读取表格',
  'table:create': '创建表格',
  'table:update': '更新表格',
  'table:delete': '删除表格',
  // 记录
  'record:read': '读取记录',
  'record:create': '创建记录',
  'record:update': '更新记录',
  'record:delete': '删除记录',
  // 字段
  'field:read': '读取字段',
  'field:create': '创建字段',
  'field:update': '更新字段',
  'field:delete': '删除字段',
  // 视图
  'view:read': '读取视图',
  'view:create': '创建视图',
  'view:update': '更新视图',
  'view:delete': '删除视图',
  // 存储
  'storage:read': '读取文件与附件',
  'storage:write': '上传与删除文件',
  // 高级
  'aggregation:read': '聚合查询',
  'import:write': '数据导入',
  'export:read': '数据导出',
  'webhook:manage': '管理 Webhook',
  'db_connection:manage': '管理数据库连接',
  // Agent SQL
  'sql:query': 'SQL 只读查询',
  'sql:execute': 'SQL 写入执行',
  // RLS / Token / Connector / Analytics
  'policy:read': '读取策略',
  'policy:manage': '管理策略',
  'token:read': '读取 Token',
  'token:manage': '管理 Token',
  'connector:read': '读取连接器',
  'connector:manage': '管理连接器',
  'analytics:read': '读取分析数据',
} as const

export type TokenScope = keyof typeof TOKEN_SCOPES

export const SCOPE_PRESETS = {
  readonly: {
    label: '只读',
    description: '仅读取表格、字段、记录、视图与文件，支持 SQL 只读查询',
    scopes: [
      'table:read', 'record:read', 'field:read', 'view:read',
      'aggregation:read', 'sql:query', 'storage:read',
    ] as TokenScope[],
  },
  readwrite: {
    label: '读写',
    description: '读写表格、记录与文件，支持导入导出和 SQL',
    scopes: [
      'table:read', 'table:create', 'table:update',
      'record:read', 'record:create', 'record:update', 'record:delete',
      'field:read', 'field:create', 'field:update',
      'view:read', 'view:create', 'view:update',
      'aggregation:read',
      'import:write', 'export:read',
      'sql:query', 'sql:execute',
      'storage:read', 'storage:write',
    ] as TokenScope[],
  },
  full: {
    label: '完全访问',
    description: '包含全部权限，包括策略、连接器与 Token 管理',
    scopes: Object.keys(TOKEN_SCOPES) as TokenScope[],
  },
} as const

export type ScopePreset = keyof typeof SCOPE_PRESETS

// ── Token 数据 ──────────────────────────────────────────

export interface ApiToken {
  id: string
  name: string
  description: string
  tokenPrefix: string       // ttn_{token_id}
  spaceId: string | null       // FK: Token 归属的 Space
  scopes: TokenScope[]
  spaceIds: string[] | null  // 权限范围（可访问的 Space 列表）
  tableIds: string[] | null
  rateLimit: number
  expiredAt: string | null
  lastUsedAt: string | null
  useCount: number
  isActive: boolean
  createdAt: string
}

// ── 请求 ──────────────────────────────────────────────

export interface CreateTokenRequest {
  name: string
  description?: string
  scopes: TokenScope[]
  scope_preset?: ScopePreset
  space_id?: string            // FK: Token 归属的 Space
  space_ids?: string[]   // 权限范围（可访问的 Space 列表）
  table_ids?: string[]
  rate_limit?: number
  expires_in_days?: number | null
}

export interface UpdateTokenRequest {
  name?: string
  description?: string
  scopes?: TokenScope[]
  space_ids?: string[]
  table_ids?: string[]
  rate_limit?: number
  is_active?: boolean
}

// ── 响应 ──────────────────────────────────────────────

export interface CreateTokenResponse {
  token: ApiToken
  plainToken: string   // 一次性明文
}

export interface TokenListResponse {
  tokens: ApiToken[]
}

export interface AvailableScopeDefinition {
  key: TokenScope
  group_key: string
  label_key: string
  default_label: string
}

export interface AvailableScopeGroupDefinition {
  key: string
  label_key: string
  default_label: string
  scopes: TokenScope[]
}

export interface AvailableScopePresetDefinition {
  label_key: string
  default_label: string
  description_key: string
  default_description: string
  scopes: TokenScope[]
}

export interface AvailableScopesResponse {
  scopes: AvailableScopeDefinition[]
  groups: AvailableScopeGroupDefinition[]
  presets: Record<ScopePreset, AvailableScopePresetDefinition>
}
