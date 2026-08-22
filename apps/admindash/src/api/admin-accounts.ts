import { rawJson } from './raw-json'

export interface AdminAccountItem {
  id: string
  user_id: string
  display_name: string
  email?: string | null
  phone?: string | null
  employee_no: string
  department: string
  position: string
  status: string
  admin_login_enabled: boolean
  role_codes: string[]
  last_admin_login_at?: string | null
  last_admin_login_ip?: string | null
  created_at: string
}

export interface AdminAccountListResponse {
  items: AdminAccountItem[]
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface AdminAccountMutationPayload {
  user_id: string
  display_name?: string
  employee_no?: string
  department?: string
  position?: string
  admin_login_enabled?: boolean
  role_codes?: string[]
  reason: string
  ticket_id?: string
}

export interface AdminAccountUpdatePayload {
  display_name?: string
  employee_no?: string
  department?: string
  position?: string
  admin_login_enabled?: boolean
  status?: string
  role_codes?: string[]
  reason: string
  ticket_id?: string
}

export function listAdminAccounts(
  params: {
    keyword?: string
    status?: string
    page?: number
    page_size?: number
  } = {}
) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const query = search.toString()
  return rawJson<AdminAccountListResponse>(
    'GET',
    `/auth/admin/admin-accounts${query ? `?${query}` : ''}`
  )
}

export function createAdminAccount(payload: AdminAccountMutationPayload) {
  return rawJson<AdminAccountItem>('POST', '/auth/admin/admin-accounts', payload)
}

export function updateAdminAccount(accountId: string, payload: AdminAccountUpdatePayload) {
  return rawJson<AdminAccountItem>('PUT', `/auth/admin/admin-accounts/${accountId}`, payload)
}
