/**
 * Membership react-query hooks
 *
 * 替代 useMembershipStore 中的数据获取逻辑。
 * Tiers/Packages 使用长 staleTime（配置型目录；运营改名后靠打开弹窗强制 refetch）。
 * Wallet/Membership 使用中等 staleTime，支持 billing:refresh 事件触发 invalidation。
 * 套餐目录（plans）在打开「选择套餐」时必须始终打网，避免 Admin 改名后仍吃 60s 缓存。
 */
import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { MembershipApiService } from '@/services/membershipApi'
import { billingKeys } from './billing'
import { memberBudgetKeys } from './memberBudgetKeys'
import { storageKeys } from './storage'
import { syncBillingBlockedFromWallet } from '@/lib/billingGuardSync'
import type { WalletTransactionType } from '@/types/membership'

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const membershipKeys = {
  all: ['membership'] as const,
  status: (organizationId?: string) =>
    [...membershipKeys.all, 'status', organizationId ?? '__personal__'] as const,
  overview: (organizationId: string) =>
    [...membershipKeys.all, 'overview', organizationId] as const,
  plans: (organizationId: string) =>
    [...membershipKeys.all, 'plans', organizationId] as const,
  wallet: (organizationId: string) =>
    [...membershipKeys.all, 'wallet', organizationId] as const,
  cashWallet: (organizationId: string) =>
    [...membershipKeys.all, 'cash-wallet', organizationId] as const,
  tiers: () => [...membershipKeys.all, 'tiers'] as const,
  packages: () => [...membershipKeys.all, 'packages'] as const,
  addonPackages: () => [...membershipKeys.all, 'addon-packages'] as const,
  transactions: (organizationId: string, filter?: string) =>
    [...membershipKeys.all, 'transactions', organizationId, filter ?? 'all'] as const,
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useMembershipStatusQuery(organizationId?: string) {
  return useQuery({
    queryKey: membershipKeys.status(organizationId),
    queryFn: () => MembershipApiService.getOrganizationMembership(organizationId!),
    enabled: !!organizationId,
    staleTime: 60_000,
  })
}

export function useSubscriptionOverviewQuery(organizationId?: string) {
  return useQuery({
    queryKey: membershipKeys.overview(organizationId ?? ''),
    queryFn: () => MembershipApiService.getSubscriptionOverview(organizationId!),
    enabled: !!organizationId,
    staleTime: 30_000,
  })
}

export function useSubscriptionPlansQuery(
  organizationId?: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: membershipKeys.plans(organizationId ?? ''),
    queryFn: () => MembershipApiService.getSubscriptionPlans(organizationId!),
    enabled: !!organizationId && options?.enabled !== false,
    // 展示名可由 AdminDash 随时改写；打开弹窗时勿复用 stale 缓存
    staleTime: 30_000,
    refetchOnMount: 'always',
  })
}

export function useWalletQuery(organizationId: string | null) {
  const query = useQuery({
    queryKey: membershipKeys.wallet(organizationId ?? ''),
    queryFn: () => MembershipApiService.getOrganizationWallet(organizationId!),
    enabled: !!organizationId,
    // FE-64: LLM 密集调用时余额实时性要求较高；
    // WS billing:refresh 是主动刷新路径，此 staleTime 仅兜底轮询间隔。
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  useEffect(() => {
    if (!organizationId || !query.data) return
    if (query.data.organization_id !== organizationId) return
    let cancelled = false
    syncBillingBlockedFromWallet(organizationId, () => !cancelled)
    return () => {
      cancelled = true
    }
  }, [organizationId, query.data])

  return query
}

export function useCashWalletQuery(organizationId: string | null) {
  return useQuery({
    queryKey: membershipKeys.cashWallet(organizationId ?? ''),
    queryFn: () => MembershipApiService.getOrganizationCashWallet(organizationId!),
    enabled: !!organizationId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

export function useTiersQuery() {
  return useQuery({
    queryKey: membershipKeys.tiers(),
    queryFn: () => MembershipApiService.listMembershipTiers(true),
    staleTime: 10 * 60_000,
  })
}

export function usePackagesQuery() {
  return useQuery({
    queryKey: membershipKeys.packages(),
    queryFn: () => MembershipApiService.listCreditPackages(true),
    staleTime: 10 * 60_000,
  })
}

export function useAddonPackagesQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: membershipKeys.addonPackages(),
    queryFn: () => MembershipApiService.listAddonPackages(true),
    enabled: options?.enabled !== false,
    initialData: [],
    staleTime: 10 * 60_000,
  })
}

export function useOrganizationTransactionsQuery(
  organizationId: string,
  options?: {
    type?: WalletTransactionType
    limit?: number
    offset?: number
    created_after?: string
    created_before?: string
    search?: string
    order_by?: string
    enabled?: boolean
  },
) {
  return useQuery({
    queryKey: [
      ...membershipKeys.transactions(organizationId, options?.type),
      {
        offset: options?.offset ?? 0,
        limit: options?.limit ?? 20,
        created_after: options?.created_after,
        created_before: options?.created_before,
        search: options?.search,
        order_by: options?.order_by,
      },
    ],
    queryFn: () =>
      MembershipApiService.getOrganizationTransactions(organizationId, {
        type: options?.type,
        limit: options?.limit ?? 20,
        offset: options?.offset ?? 0,
        created_after: options?.created_after,
        created_before: options?.created_before,
        search: options?.search,
        order_by: options?.order_by,
      }),
    enabled: options?.enabled !== false,
    staleTime: 30_000,
  })
}

// ---------------------------------------------------------------------------
// billing:refresh auto-invalidation hook (React Query 面板使用)
// ---------------------------------------------------------------------------

const BILLING_REFRESH_DEBOUNCE_MS = 300

export function useBillingRefreshListener() {
  const queryClient = useQueryClient()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const handler = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void queryClient.invalidateQueries({ queryKey: membershipKeys.all })
        void queryClient.invalidateQueries({ queryKey: billingKeys.all })
        void queryClient.invalidateQueries({ queryKey: storageKeys.all })
        void queryClient.invalidateQueries({ queryKey: memberBudgetKeys.all })
      }, BILLING_REFRESH_DEBOUNCE_MS)
    }
    window.addEventListener('billing:refresh', handler)
    return () => {
      window.removeEventListener('billing:refresh', handler)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [queryClient])
}

// ---------------------------------------------------------------------------
// billing:refresh callback hook（手动管理状态的面板使用，统一监听入口，FE-66）
// ---------------------------------------------------------------------------

/**
 * 供非 React Query 面板使用：监听 billing:refresh 事件，触发自定义回调。
 * 使用 ref 持有最新回调，避免重复注册监听器。
 */
export function useBillingRefreshCallback(callback: () => void) {
  const callbackRef = useRef(callback)
  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    const handler = () => { callbackRef.current() }
    window.addEventListener('billing:refresh', handler)
    return () => window.removeEventListener('billing:refresh', handler)
  }, [])
}

// ---------------------------------------------------------------------------
// Imperative invalidation (for payment success callbacks etc.)
// ---------------------------------------------------------------------------

export function invalidateBillingData(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: membershipKeys.all })
  void queryClient.invalidateQueries({ queryKey: billingKeys.all })
  void queryClient.invalidateQueries({ queryKey: storageKeys.all })
}

/** 群组用量（max_groups）变化后刷新组织权益缓存，避免设置页仍显示旧「已用数」。 */
export function invalidateMembershipQuotaUsage(
  queryClient: QueryClient,
  organizationId?: string | null,
) {
  if (organizationId) {
    void queryClient.invalidateQueries({ queryKey: membershipKeys.status(organizationId) })
    return
  }
  void queryClient.invalidateQueries({ queryKey: membershipKeys.all })
}

// ---------------------------------------------------------------------------
// FE-65: 预填充 organization billing 数据（在 organization 切换时调用，减少 Settings 面板首次加载闪烁）
// ---------------------------------------------------------------------------

export function prefetchOrganizationBillingData(qc: QueryClient, organizationId: string) {
  void qc.prefetchQuery({
    queryKey: membershipKeys.status(organizationId),
    queryFn: () => MembershipApiService.getOrganizationMembership(organizationId),
    staleTime: 60_000,
  })
  void qc.prefetchQuery({
    queryKey: membershipKeys.wallet(organizationId),
    queryFn: () => MembershipApiService.getOrganizationWallet(organizationId),
    staleTime: 30_000,
  })
  void qc.prefetchQuery({
    queryKey: billingKeys.summary(organizationId),
    queryFn: () =>
      import('@/services/billingApi').then(m =>
        m.OrganizationBillingApiService.getOrganizationSummary(organizationId, { days: 30, eventLimit: 20 }),
      ),
    staleTime: 30_000,
  })
}
