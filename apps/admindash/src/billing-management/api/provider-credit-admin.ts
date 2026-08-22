import { getApiClient } from '@/api/tabtin-client'

type Params = Record<string, string | number | boolean | undefined | null>

export interface ProviderCreditPagination {
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface ProviderCreditCampaign {
  id: string
  code: string
  name: string
  provider_key: string
  eligible_model_ids: string[]
  grant_credits: string
  credits_amount: string
  total_budget_credits: string
  granted_credits: string
  enabled: boolean
  trigger_type: 'manual' | 'new_org' | 'membership' | string
  membership_plan_codes: string[]
  status: 'draft' | 'active' | 'paused' | 'ended' | string
  start_at: string | null
  end_at: string | null
  expire_days: number
  metadata: Record<string, unknown>
  created_at: string | null
  updated_at: string | null
}

export interface ProviderCreditCampaignWrite {
  code: string
  name: string
  provider_key: string
  eligible_model_ids: string[]
  grant_credits: string
  total_budget_credits: string
  expire_days: number
  trigger_type: string
  membership_plan_codes: string[]
  start_at?: string
  end_at?: string
  enabled: boolean
}

export interface ProviderCreditGrant {
  id: string
  organization: {
    id: string
    name: string
  }
  organization_id: string
  campaign: {
    id: string
    code: string
    name: string
  }
  campaign_id: string
  campaign_code: string
  provider_key: string
  eligible_model_ids: string[]
  total_credits: string
  consumed_credits: string
  remaining_credits: string
  status: string
  grant_source: string
  trigger_type: 'manual' | 'new_org' | 'membership' | null
  effective_at: string | null
  expire_at: string | null
  metadata: Record<string, unknown>
  created_at: string | null
  updated_at: string | null
}

export interface ProviderCreditTransaction {
  id: string
  grant_id: string
  grant: {
    id: string
    campaign_code: string
    campaign_name?: string
    provider_key: string
  }
  organization?: {
    id: string
    name: string
  }
  organization_id: string
  transaction_type: 'grant' | 'consume' | 'expire' | 'refund' | 'adjust' | string
  amount: string
  balance_after: string
  reference_type: string
  reference_id: string
  idempotency_key: string
  metadata: Record<string, unknown>
  created_at: string | null
}

export interface ProviderCreditCampaignReport {
  campaign: string | null
  provider: string
  granted: string
  total_granted: string
  initial_granted: string
  positive_adjustments: string
  negative_adjustments: string
  consumed: string
  total_consumed: string
  remaining: string
  expired: string
  organizations: number
  active_users: number
  usage_count: number
}

export async function listProviderCreditCampaigns(params?: Params) {
  return getApiClient().raw<{ items: ProviderCreditCampaign[] } & ProviderCreditPagination>(
    'GET',
    '/services/billing/admin/billing/provider-credit/campaigns',
    { params }
  )
}

export async function createProviderCreditCampaign(body: ProviderCreditCampaignWrite) {
  return getApiClient().raw<{ campaign: ProviderCreditCampaign }>(
    'POST',
    '/services/billing/admin/billing/provider-credit/campaigns',
    { body }
  )
}

export async function updateProviderCreditCampaign(
  campaignCode: string,
  body: Partial<ProviderCreditCampaignWrite>
) {
  return getApiClient().raw<{ campaign: ProviderCreditCampaign }>(
    'PUT',
    `/services/billing/admin/billing/provider-credit/campaigns/${encodeURIComponent(campaignCode)}`,
    { body }
  )
}

export async function listProviderCreditGrants(params?: Params) {
  return getApiClient().raw<{ items: ProviderCreditGrant[] } & ProviderCreditPagination>(
    'GET',
    '/services/billing/admin/billing/provider-credit/grants',
    { params }
  )
}

export async function grantProviderCredit(body: {
  organization_id: string
  campaign_code: string
  reason: string
}) {
  return getApiClient().raw<{ grant: ProviderCreditGrant }>(
    'POST',
    '/services/billing/admin/billing/provider-credit/grants',
    { body }
  )
}

export async function adjustProviderCreditGrant(
  grantId: string,
  body: { amount: string; reason: string; idempotency_key?: string }
) {
  return getApiClient().raw<{
    grant: ProviderCreditGrant
    transaction: ProviderCreditTransaction
  }>(
    'POST',
    `/services/billing/admin/billing/provider-credit/grants/${encodeURIComponent(grantId)}/adjust`,
    { body }
  )
}

export async function revokeProviderCreditGrant(grantId: string, body: { reason: string }) {
  return getApiClient().raw<{
    grant: ProviderCreditGrant
    transaction: ProviderCreditTransaction | null
  }>(
    'POST',
    `/services/billing/admin/billing/provider-credit/grants/${encodeURIComponent(grantId)}/revoke`,
    { body }
  )
}

export async function listProviderCreditTransactions(params?: Params) {
  return getApiClient().raw<{ items: ProviderCreditTransaction[] } & ProviderCreditPagination>(
    'GET',
    '/services/billing/admin/billing/provider-credit/transactions',
    { params }
  )
}

export async function getProviderCreditCampaignReport(campaignCode: string) {
  return getApiClient().raw<ProviderCreditCampaignReport>(
    'GET',
    `/services/billing/admin/billing/provider-credit/reports/campaign/${encodeURIComponent(
      campaignCode
    )}`
  )
}
