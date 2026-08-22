import { rawJson } from '@/api/raw-json'
import { getApiClient } from '@/api/tabtin-client'

export type MobilePlatform = 'ios' | 'android'

export interface MobileVersionPolicy {
  platform: MobilePlatform
  enabled: boolean
  soft_prompt_enabled: boolean
  min_supported_build: number
  latest_build: number
  min_supported_version: string
  latest_version: string
  store_url: string
  force_title: string
  force_message: string
  soft_title: string
  soft_message: string
  updated_at?: string | null
}

export interface MobileVersionPolicyListResponse {
  items: MobileVersionPolicy[]
}

export interface MobileVersionPolicySavePayload {
  enabled: boolean
  soft_prompt_enabled: boolean
  min_supported_build: number
  latest_build: number
  min_supported_version: string
  latest_version: string
  store_url: string
  force_title: string
  force_message: string
  soft_title: string
  soft_message: string
}

interface MobileVersionPolicyEnvelope {
  success: boolean
  message?: string
  data?: {
    item?: MobileVersionPolicy
    items?: MobileVersionPolicy[]
  }
}

export async function listMobileVersionPolicies(): Promise<MobileVersionPolicyListResponse> {
  return getApiClient().raw<MobileVersionPolicyListResponse>(
    'GET',
    '/auth/admin/mobile-version-policies'
  )
}

export async function saveMobileVersionPolicy(
  platform: MobilePlatform,
  payload: MobileVersionPolicySavePayload
): Promise<MobileVersionPolicy> {
  const envelope = await rawJson<MobileVersionPolicyEnvelope>(
    'PUT',
    `/auth/admin/mobile-version-policies/${encodeURIComponent(platform)}`,
    payload
  )
  const item = envelope.data?.item
  if (!item) throw new Error(envelope.message || '保存响应为空')
  return item
}
