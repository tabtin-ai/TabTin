export interface DeviceSnapshot {
  id: string
  device_id: string
  device_name: string
  version: string
  install_status: 'installed' | 'stale' | 'missing'
  last_seen_at: string
  extra: Record<string, unknown>
}

export interface AppInstallItem {
  id: string
  organization_id: string
  app_id: string
  app_source: 'core' | 'marketplace'
  installed_by: string | null
  created_at: string
  updated_at: string
  device_snapshots: DeviceSnapshot[]
  device_count: number
}

// 注意：以下 ListResponse 类型表示后端 envelope 内部 `data` 部分。
// `getApiClient().raw<T>()` 会自动 unwrap `{success, data}` 信封，所以泛型 T 写的就是这一层。
export interface AppInstallListResponse {
  items: AppInstallItem[]
  total: number
  pagination: { page: number; page_size: number; total_pages: number }
  summary: { total_installs: number; core_count: number; marketplace_count: number }
}

export interface CliAuditItem {
  id: string
  organization_id: string | null
  thread_id: string | null
  agent_id: string | null
  user_id: string | null
  binary: string
  inner_binary: string | null
  domain: string
  verb: string
  risk_level: string
  rule_decision: string
  hitl_required: boolean
  hitl_user_decision: string | null
  exit_code: number | null
  bypass: boolean
  created_at: string
  executed_at: string | null
  finished_at: string | null
}

export interface CliAuditListResponse {
  items: CliAuditItem[]
  total: number
  pagination: { page: number; page_size: number; total_pages: number }
}

export interface PermissionAuditItem {
  id: string
  organization_id: string
  agent_id: string
  thread_id: string
  session_id: string
  batch_id: string | null
  request_id: string
  tool_call_id: string
  tool_name: string
  tool_namespace: string
  tool_input_preview: string
  decision: string
  source: string
  reason_type: string | null
  scope: string
  runtime_mode: string
  rejection_message: string
  created_at: string
}

export interface PermissionAuditListResponse {
  items: PermissionAuditItem[]
  total: number
  pagination: { page: number; page_size: number; total_pages: number }
}

export interface AppAuthorizationItem {
  id: string
  space_id: string
  space_name: string
  user_id: string
  allow_all: boolean
  tools: string[]
  apps: string[]
  disabled_apps: string[]
  created_at: string
  updated_at: string
}

export interface AppAuthorizationListResponse {
  items: AppAuthorizationItem[]
  total: number
  pagination: { page: number; page_size: number; total_pages: number }
}

export interface ConnectItem {
  id: string
  organization_id: string | null
  user_id: string | null
  app_id: string
  auth_type: string
  status: string
  scope: string[]
  external_user_ref: string | null
  last_used_at: string | null
  expires_at: string | null
  revoke_reason: string | null
  created_at: string
  updated_at: string
}

export interface ConnectListResponse {
  items: ConnectItem[]
  total: number
  pagination: { page: number; page_size: number; total_pages: number }
}

export interface AuditTimelineEntry {
  id: string
  action: string
  actor_user_id: string | null
  actor_role: string
  payload_json: Record<string, unknown>
  created_at: string
}

export interface ConnectAuditTimelineResponse {
  connect_id: string
  app_id: string
  status: string
  timeline: AuditTimelineEntry[]
}
