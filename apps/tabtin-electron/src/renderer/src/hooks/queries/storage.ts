/**
 * Storage analytics react-query hooks
 *
 * 替代 OrganizationStorageDashboard 中的 useState + useCallback + useEffect 手动数据管理。
 * query keys 通过 storageKeys 统一管理；billing:refresh 事件触发时由
 * membership.ts 中的 useBillingRefreshListener 统一 invalidate。
 */
import { useQuery } from '@tanstack/react-query'
import {
  StorageAnalyticsApi,
  type StorageOverview,
  type StorageModuleBreakdown,
  type StorageMemberBreakdown,
  type StorageFileTypeBreakdown,
  type StorageLargeFileItem,
} from '@services/storageApi'

const STORAGE_STALE_TIME = 30_000

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const storageKeys = {
  all: ['storage'] as const,
  overview: (wtId: string) => [...storageKeys.all, 'overview', wtId] as const,
  byModule: (wtId: string) => [...storageKeys.all, 'byModule', wtId] as const,
  byMember: (wtId: string) => [...storageKeys.all, 'byMember', wtId] as const,
  byFileType: (wtId: string) =>
    [...storageKeys.all, 'byFileType', wtId] as const,
  largeFiles: (wtId: string) =>
    [...storageKeys.all, 'largeFiles', wtId] as const,
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useStorageOverviewQuery(organizationId: string) {
  return useQuery<StorageOverview>({
    queryKey: storageKeys.overview(organizationId),
    queryFn: () => StorageAnalyticsApi.getOverview(organizationId),
    enabled: !!organizationId,
    staleTime: STORAGE_STALE_TIME,
    refetchOnWindowFocus: true,
  })
}

export function useStorageByModuleQuery(organizationId: string) {
  return useQuery<StorageModuleBreakdown[]>({
    queryKey: storageKeys.byModule(organizationId),
    queryFn: () => StorageAnalyticsApi.getByModule(organizationId),
    enabled: !!organizationId,
    staleTime: STORAGE_STALE_TIME,
    refetchOnWindowFocus: true,
  })
}

export function useStorageByMemberQuery(organizationId: string) {
  return useQuery<StorageMemberBreakdown[]>({
    queryKey: storageKeys.byMember(organizationId),
    queryFn: () => StorageAnalyticsApi.getByMember(organizationId),
    enabled: !!organizationId,
    staleTime: STORAGE_STALE_TIME,
    refetchOnWindowFocus: true,
  })
}

export function useStorageByFileTypeQuery(organizationId: string) {
  return useQuery<StorageFileTypeBreakdown[]>({
    queryKey: storageKeys.byFileType(organizationId),
    queryFn: () => StorageAnalyticsApi.getByFileType(organizationId),
    enabled: !!organizationId,
    staleTime: STORAGE_STALE_TIME,
    refetchOnWindowFocus: true,
  })
}

export function useStorageLargeFilesQuery(organizationId: string) {
  return useQuery<StorageLargeFileItem[]>({
    queryKey: storageKeys.largeFiles(organizationId),
    queryFn: () => StorageAnalyticsApi.getLargeFiles(organizationId),
    enabled: !!organizationId,
    staleTime: STORAGE_STALE_TIME,
    refetchOnWindowFocus: true,
  })
}
