// SYNC: Backend build_precheck_error / build_budget_error (billed_call.py)
// Precheck returns: insufficient_credits | organization_insufficient_credits | budget_exceeded
// Member limit: member_monthly_limit | member_daily_limit | member_model_restricted
// Stream/other sources may also emit: quota | billing
// BYOK errors (v0.1): byok_provider_unavailable | byok_rate_limit_exceeded | byok_quota_exhausted | byok_invalid_key
export const BILLING_ERROR_CATEGORIES = new Set([
  'insufficient_credits', 'organization_insufficient_credits', 'budget_exceeded', 'quota', 'billing',
  'member_budget', 'member_monthly_limit', 'member_daily_limit', 'member_model_restricted',
  'byok_provider_unavailable', 'byok_rate_limit_exceeded', 'byok_quota_exhausted', 'byok_invalid_key',
])
