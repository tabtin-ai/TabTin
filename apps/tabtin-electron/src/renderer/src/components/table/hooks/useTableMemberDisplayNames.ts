import { useMemo } from 'react'
import { toOrganizationMembers } from '@tabtin/table-ui'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useUserProfileCache } from '@stores/useUserProfileCache'
import { useMemberIdentitySnapshotsQuery, useMembersQuery } from '@/hooks/queries/members'
import {
  buildRealtimeUserDisplayNameById,
  buildUserDisplayNameById,
  mergeUserDisplayNamesIntoMembers,
} from '../controller/userDisplayNameMap'

/**
 * 表格、看板等视图共用的成员展示名来源。
 *
 * 当前成员目录负责最新组织成员，身份快照补齐已离组的历史成员，实时资料则覆盖
 * 已确认的新昵称；所有视图必须共用这条优先级链路，避免同一成员跨视图显示不一致。
 */
export function useTableMemberDisplayNames() {
  const storedMembers = useOrganizationStore(state => state.members)
  const organizationId = useOrganizationStore(state => state.selectedOrganization?.id ?? '')
  const { data: currentMembersResponse } = useMembersQuery(organizationId)
  const { data: memberIdentitySnapshots } = useMemberIdentitySnapshotsQuery(organizationId)
  const currentMembers = currentMembersResponse?.members ?? storedMembers
  const baseOrganizationMembers = useMemo(
    () => toOrganizationMembers(currentMembers),
    [currentMembers],
  )
  const userProfiles = useUserProfileCache(state => state.profiles)
  const authoritativeProfileIds = useUserProfileCache(state => state.authoritativeIds)
  const realtimeUserDisplayNameById = useMemo(
    () => buildRealtimeUserDisplayNameById(userProfiles, authoritativeProfileIds),
    [authoritativeProfileIds, userProfiles],
  )
  const organizationMembers = useMemo(
    () => mergeUserDisplayNamesIntoMembers(baseOrganizationMembers, realtimeUserDisplayNameById),
    [baseOrganizationMembers, realtimeUserDisplayNameById],
  )
  const userDisplayNameById = useMemo(
    () => buildUserDisplayNameById(
      organizationMembers,
      memberIdentitySnapshots?.identities ?? [],
      realtimeUserDisplayNameById,
    ),
    [memberIdentitySnapshots?.identities, organizationMembers, realtimeUserDisplayNameById],
  )

  return { organizationMembers, userDisplayNameById }
}
