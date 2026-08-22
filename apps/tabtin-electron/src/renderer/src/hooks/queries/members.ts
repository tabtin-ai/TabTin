import { useQuery } from '@tanstack/react-query'
import { MemberApiService, type MemberSearchParams } from '@tabtin/app-shell'

export const memberKeys = {
  all: ['members'] as const,
  lists: (organizationId: string) => [...memberKeys.all, 'list', organizationId] as const,
  list: (organizationId: string, params?: MemberSearchParams) =>
    [...memberKeys.lists(organizationId), params] as const,
  identitySnapshots: (organizationId: string) =>
    [...memberKeys.lists(organizationId), 'identity-snapshots'] as const,
}

export function useMembersQuery(organizationId: string, params?: MemberSearchParams) {
  return useQuery({
    queryKey: memberKeys.list(organizationId, params),
    queryFn: () => MemberApiService.getMembers(organizationId, params),
    enabled: Boolean(organizationId),
    // 组织成员人数变化频繁；全局默认 refetchOnWindowFocus=false 会让设置页
    // 「成员」面板在切回窗口后继续展示最多 30s 的陈旧 total。
    staleTime: 0,
    refetchOnWindowFocus: true,
  })
}

export function useMemberIdentitySnapshotsQuery(organizationId: string) {
  return useQuery({
    queryKey: memberKeys.identitySnapshots(organizationId),
    queryFn: () => MemberApiService.getIdentitySnapshots(organizationId),
    enabled: Boolean(organizationId),
    staleTime: 30_000,
  })
}
