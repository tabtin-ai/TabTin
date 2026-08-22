import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest, getAuthHeaders, unwrapData } from '@/services/apiBase'
import { electronFetch } from '@/services/electronFetch'
import { resolveBillingExportErrorMessage } from '@/services/billingApi'
import i18n from '@/i18n'
import type {
  BatchMemberBudgetItem,
  BatchMemberBudgetResult,
  MemberBudgetPolicy,
  MemberBudgetPolicyUpsertInput,
  MemberUsageSummaryData,
  MyUsageData,
} from '@/types/billing'

const BILLING_BASE = joinApiPath(API_CONFIG.baseURL, `/services/billing`)

export class MemberBudgetApiService {
  static async listPolicies(organizationId: string): Promise<MemberBudgetPolicy[]> {
    const fullUrl = `${BILLING_BASE}/member-budget-policies?organization_id=${encodeURIComponent(organizationId)}`
    const response = await apiRequest({ url: fullUrl, method: 'GET' })
    const data = unwrapData<unknown>(response, i18n.t('settings:memberBudget.errors.loadFailed'))
    if (!Array.isArray(data)) {
      throw new Error(i18n.t('settings:memberBudget.errors.loadFailed'))
    }
    return data as MemberBudgetPolicy[]
  }

  static async upsertPolicy(input: MemberBudgetPolicyUpsertInput): Promise<MemberBudgetPolicy> {
    const fullUrl = `${BILLING_BASE}/member-budget-policies`
    const response = await apiRequest({
      url: fullUrl,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return unwrapData<MemberBudgetPolicy>(response, i18n.t('settings:memberBudget.errors.saveFailed'))
  }

  static async batchSetPolicies(
    organizationId: string,
    items: BatchMemberBudgetItem[],
  ): Promise<BatchMemberBudgetResult> {
    const fullUrl = `${BILLING_BASE}/organizations/${encodeURIComponent(organizationId)}/member-budgets`
    const response = await apiRequest({
      url: fullUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    })
    return unwrapData<BatchMemberBudgetResult>(response, i18n.t('settings:memberBudget.errors.saveFailed'))
  }

  static async deletePolicy(policyId: string): Promise<MemberBudgetPolicy> {
    const fullUrl = `${BILLING_BASE}/member-budget-policies/${encodeURIComponent(policyId)}`
    const response = await apiRequest({ url: fullUrl, method: 'DELETE' })
    return unwrapData<MemberBudgetPolicy>(response, i18n.t('settings:memberBudget.errors.deleteFailed'))
  }

  static async deletePolicyByUser(organizationId: string, userId: string): Promise<MemberBudgetPolicy> {
    const fullUrl = `${BILLING_BASE}/organizations/${encodeURIComponent(organizationId)}/member-budgets/${encodeURIComponent(userId)}`
    const response = await apiRequest({ url: fullUrl, method: 'DELETE' })
    return unwrapData<MemberBudgetPolicy>(response, i18n.t('settings:memberBudget.errors.deleteFailed'))
  }

  static async getMemberUsageSummary(organizationId: string): Promise<MemberUsageSummaryData> {
    const fullUrl = `${BILLING_BASE}/member-usage-summary?organization_id=${encodeURIComponent(organizationId)}`
    const response = await apiRequest({ url: fullUrl, method: 'GET' })
    return unwrapData<MemberUsageSummaryData>(response, i18n.t('settings:memberBudget.errors.loadFailed'))
  }

  static async getMyUsage(organizationId: string): Promise<MyUsageData> {
    const fullUrl = `${BILLING_BASE}/my-usage?organization_id=${encodeURIComponent(organizationId)}`
    const response = await apiRequest({ url: fullUrl, method: 'GET' })
    return unwrapData<MyUsageData>(response, i18n.t('settings:memberBudget.errors.loadFailed'))
  }

  static async updateExemptRoles(organizationId: string, exemptRoles: string[]): Promise<void> {
    const fullUrl = `${BILLING_BASE}/member-budget-exempt-roles`
    await apiRequest({
      url: fullUrl,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: organizationId, exempt_roles: exemptRoles }),
    })
  }

  static async downloadExport(
    organizationId: string,
    startDate: string,
    endDate: string,
  ): Promise<void> {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
    })
    const url = `${BILLING_BASE}/organizations/${encodeURIComponent(organizationId)}/billing/export?${params.toString()}`
    const authHeaders = await getAuthHeaders()
    const response = await electronFetch(url, {
      method: 'GET',
      headers: authHeaders,
    })
    if (!response.ok) {
      throw new Error(await resolveBillingExportErrorMessage(response))
    }
    const blob = await response.blob()
    const downloadUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = downloadUrl
    a.download = `member-usage-${startDate}-${endDate}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(downloadUrl)
  }
}
