import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MemberBudgetApiService } from '@/services/memberBudgetApi'
import type { BatchMemberBudgetItem, MemberBudgetPolicyUpsertInput } from '@/types/billing'
import { memberBudgetKeys } from './memberBudgetKeys'

export { memberBudgetKeys } from './memberBudgetKeys'

const STALE_TIME = 30_000

export function useMemberBudgetPolicies(organizationId: string, enabled = true) {
  return useQuery({
    queryKey: memberBudgetKeys.policies(organizationId),
    queryFn: () => MemberBudgetApiService.listPolicies(organizationId),
    enabled: !!organizationId && enabled,
    staleTime: STALE_TIME,
  })
}

export function useMemberUsageSummary(organizationId: string, enabled = true) {
  return useQuery({
    queryKey: memberBudgetKeys.usageSummary(organizationId),
    queryFn: () => MemberBudgetApiService.getMemberUsageSummary(organizationId),
    enabled: !!organizationId && enabled,
    staleTime: STALE_TIME,
  })
}

export function useMutateMemberBudgetPolicy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: MemberBudgetPolicyUpsertInput) =>
      MemberBudgetApiService.upsertPolicy(input),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: memberBudgetKeys.policies(variables.organization_id),
      })
      void queryClient.invalidateQueries({
        queryKey: memberBudgetKeys.usageSummary(variables.organization_id),
      })
    },
  })
}

export function useBatchSetMemberBudgets(organizationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (items: BatchMemberBudgetItem[]) =>
      MemberBudgetApiService.batchSetPolicies(organizationId, items),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: memberBudgetKeys.policies(organizationId),
      })
      void queryClient.invalidateQueries({
        queryKey: memberBudgetKeys.usageSummary(organizationId),
      })
    },
  })
}

export function useMyUsage(organizationId: string) {
  return useQuery({
    queryKey: memberBudgetKeys.myUsage(organizationId),
    queryFn: () => MemberBudgetApiService.getMyUsage(organizationId),
    enabled: !!organizationId,
    staleTime: STALE_TIME,
  })
}

export function useDeleteMemberBudgetPolicy(organizationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (policyId: string) =>
      MemberBudgetApiService.deletePolicy(policyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: memberBudgetKeys.policies(organizationId),
      })
      void queryClient.invalidateQueries({
        queryKey: memberBudgetKeys.usageSummary(organizationId),
      })
    },
  })
}
