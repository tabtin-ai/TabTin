import { rawJson } from '@/api/raw-json'
import type {
  InviteCodeCreatePayload,
  InviteCodeListResponse,
  InviteCodeMutationResponse,
  InviteCodeUpdatePayload,
  InviteRedemptionListResponse,
} from '@/invite-code-management/types'

export interface InviteCodeQuery {
  keyword?: string
  status?: string
  channel?: string
  expired?: string
  page?: number
  page_size?: number
}

function withQuery(path: string, query: InviteCodeQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

export function getInviteCodes(query: InviteCodeQuery): Promise<InviteCodeListResponse> {
  return rawJson<InviteCodeListResponse>('GET', withQuery('/auth/admin/invite-codes', query))
}

export function createInviteCodes(
  payload: InviteCodeCreatePayload
): Promise<InviteCodeMutationResponse> {
  return rawJson<InviteCodeMutationResponse>('POST', '/auth/admin/invite-codes', payload)
}

export function updateInviteCode(
  id: string,
  payload: InviteCodeUpdatePayload
): Promise<InviteCodeMutationResponse> {
  return rawJson<InviteCodeMutationResponse>('PATCH', `/auth/admin/invite-codes/${id}`, payload)
}

export function disableInviteCode(
  id: string,
  payload: { reason: string; ticket_id?: string }
): Promise<InviteCodeMutationResponse> {
  return rawJson<InviteCodeMutationResponse>(
    'POST',
    `/auth/admin/invite-codes/${id}/disable`,
    payload
  )
}

export function getInviteRedemptions(
  id: string,
  query: Pick<InviteCodeQuery, 'page' | 'page_size'>
): Promise<InviteRedemptionListResponse> {
  return rawJson<InviteRedemptionListResponse>(
    'GET',
    withQuery(`/auth/admin/invite-codes/${id}/redemptions`, query)
  )
}
