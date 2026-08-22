export interface InvitePagination {
  total: number
  page: number
  page_size: number
  total_pages: number
}

export type InviteCodeStatus = 'available' | 'disabled' | 'expired' | 'scheduled' | 'exhausted'

export interface InviteCodeItem {
  id: string
  code: string
  description: string
  channel: string
  campaign: string
  is_active: boolean
  status: InviteCodeStatus
  starts_at?: string | null
  expires_at?: string | null
  usage_limit?: number | null
  used_count: number
  remaining_uses?: number | null
  created_by_display_name: string
  created_at: string
  updated_at: string
  disabled_at?: string | null
}

export interface InviteCodeSummary {
  total_codes: number
  active_codes: number
  available_codes: number
  used_count: number
  recent_7d_redemptions: number
}

export interface InviteCodeListResponse {
  items: InviteCodeItem[]
  pagination: InvitePagination
  summary: InviteCodeSummary
}

export interface InviteCodeCreatePayload {
  code?: string
  generate_count: number
  code_length: number
  description: string
  channel: string
  campaign: string
  is_active: boolean
  starts_at?: string | null
  expires_at?: string | null
  usage_limit?: number | null
}

export type InviteCodeUpdatePayload = Partial<
  Pick<
    InviteCodeCreatePayload,
    'description' | 'channel' | 'campaign' | 'is_active' | 'starts_at' | 'expires_at' | 'usage_limit'
  >
>

export interface InviteCodeMutationResponse {
  success: boolean
  message: string
  items: InviteCodeItem[]
}

export interface InviteRedemptionItem {
  id: string
  user_id: string
  user_display_name: string
  user_email?: string | null
  user_phone?: string | null
  identifier_hash: string
  entrypoint: string
  ip_address?: string | null
  user_agent: string
  consumed_at: string
}

export interface InviteRedemptionListResponse {
  items: InviteRedemptionItem[]
  pagination: InvitePagination
}
