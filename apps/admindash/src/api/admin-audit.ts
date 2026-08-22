import { rawJson } from './raw-json'

export interface AdminSensitiveActionItem {
  id: string
  actor_user_id?: string | null
  actor_admin_account_id?: string | null
  actor_display_name: string
  permission_code: string
  action: string
  target_type: string
  target_id: string
  reason: string
  ticket_id: string
  before_json: Record<string, unknown>
  after_json: Record<string, unknown>
  ip?: string | null
  request_id: string
  created_at: string
}

export interface AdminSensitiveActionListResponse {
  items: AdminSensitiveActionItem[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface AdminLoginLogItem {
  id: string
  admin_account_id?: string | null
  user_id: string
  display_name: string
  ip?: string | null
  login_method: string
  success: boolean
  fail_reason: string
  created_at: string
}

export interface AdminLoginLogListResponse {
  items: AdminLoginLogItem[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export function listAdminSensitiveActions(
  params: {
    action?: string
    permission_code?: string
    target_type?: string
    actor_admin_account_id?: string
    actor_user_id?: string
    organization_id?: string
    start_at?: string
    end_at?: string
    page?: number
    page_size?: number
  } = {}
) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const query = search.toString()
  return rawJson<AdminSensitiveActionListResponse>(
    'GET',
    `/auth/admin/admin-sensitive-actions${query ? `?${query}` : ''}`
  )
}

export function listAdminLoginLogs(
  params: {
    success?: boolean
    page?: number
    page_size?: number
  } = {}
) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const query = search.toString()
  return rawJson<AdminLoginLogListResponse>(
    'GET',
    `/auth/admin/admin-login-logs${query ? `?${query}` : ''}`
  )
}
