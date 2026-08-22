/**
 * Billing react-query hooks
 *
 * 提供计费/用量相关数据的 React Query hooks，替代面板中手动 useState + loadData 模式。
 * query keys 通过 billingKeys 统一管理；billing:refresh 事件触发时由
 * membership.ts 中的 useBillingRefreshListener 统一 invalidate。
 */
import { useQuery, useInfiniteQuery } from '@tanstack/react-query'
import { OrganizationBillingApiService } from '@/services/billingApi'

const BILLING_STALE_TIME = 30_000
const INVOICE_PAGE_SIZE = 30

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const billingKeys = {
  all: ['billing'] as const,
  summary: (organizationId: string) =>
    [...billingKeys.all, 'summary', organizationId] as const,
  invoiceOverview: (organizationId: string) =>
    [...billingKeys.all, 'invoiceOverview', organizationId] as const,
  invoices: (organizationId: string, status?: string) =>
    [...billingKeys.all, 'invoices', organizationId, status ?? 'all'] as const,
  invoiceDetail: (organizationId: string, invoiceId: string) =>
    [...billingKeys.all, 'invoiceDetail', organizationId, invoiceId] as const,
  storagePackages: () => [...billingKeys.all, 'storagePackages'] as const,
  usageDashboard: (organizationId: string, days?: number) =>
    [...billingKeys.all, 'usageDashboard', organizationId, days ?? 30] as const,
  memberUsage: (organizationId: string, days?: number) =>
    [...billingKeys.all, 'memberUsage', organizationId, days ?? 30] as const,
}

// ---------------------------------------------------------------------------
// Queries — Billing Panel
// ---------------------------------------------------------------------------

export function useBillingSummaryQuery(organizationId: string) {
  return useQuery({
    queryKey: billingKeys.summary(organizationId),
    queryFn: () =>
      OrganizationBillingApiService.getOrganizationSummary(organizationId, {
        days: 30,
        eventLimit: 20,
      }),
    enabled: !!organizationId,
    staleTime: BILLING_STALE_TIME,
  })
}

export function useInvoiceOverviewQuery(organizationId: string) {
  return useQuery({
    queryKey: billingKeys.invoiceOverview(organizationId),
    queryFn: () => OrganizationBillingApiService.getInvoiceOverview(organizationId, 6),
    enabled: !!organizationId,
    staleTime: BILLING_STALE_TIME,
  })
}

export function useStoragePackagesQuery() {
  return useQuery({
    queryKey: billingKeys.storagePackages(),
    queryFn: () => OrganizationBillingApiService.listStoragePackages(true),
    staleTime: 10 * 60_000,
  })
}

export function useInvoicesQuery(organizationId: string, statusFilter: string) {
  return useInfiniteQuery({
    queryKey: billingKeys.invoices(organizationId, statusFilter),
    queryFn: ({ pageParam }) =>
      OrganizationBillingApiService.listInvoices(organizationId, {
        limit: INVOICE_PAGE_SIZE,
        offset: pageParam,
        status: statusFilter === 'all' ? '' : statusFilter,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce(
        (sum, page) => sum + (page.invoices?.length || 0),
        0,
      )
      return loaded < (lastPage.total || 0) ? loaded : undefined
    },
    enabled: !!organizationId,
    staleTime: BILLING_STALE_TIME,
  })
}

export function useInvoiceDetailQuery(
  organizationId: string,
  invoiceId: string | null,
) {
  return useQuery({
    queryKey: billingKeys.invoiceDetail(organizationId, invoiceId ?? ''),
    queryFn: () =>
      OrganizationBillingApiService.getInvoiceDetail(organizationId, invoiceId!),
    enabled: !!organizationId && !!invoiceId,
    staleTime: BILLING_STALE_TIME,
  })
}

// ---------------------------------------------------------------------------
// Queries — Usage Dashboard
// ---------------------------------------------------------------------------

export function useUsageDashboardQuery(organizationId: string, days = 30) {
  return useQuery({
    queryKey: billingKeys.usageDashboard(organizationId, days),
    queryFn: () =>
      OrganizationBillingApiService.getUsageDashboard(organizationId, days),
    enabled: !!organizationId,
    staleTime: BILLING_STALE_TIME,
  })
}

export function useMemberUsageQuery(organizationId: string, days = 30) {
  return useQuery({
    queryKey: billingKeys.memberUsage(organizationId, days),
    queryFn: () => OrganizationBillingApiService.getMemberUsage(organizationId, days),
    enabled: !!organizationId,
    staleTime: BILLING_STALE_TIME,
  })
}
