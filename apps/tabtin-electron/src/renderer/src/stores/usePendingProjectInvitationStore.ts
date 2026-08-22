import { create } from 'zustand'

import { ProjectApiService } from '@/services/projectApi'
import type { PendingProjectInvitation } from '@/types/project'

interface PendingProjectInvitationState {
  invitations: PendingProjectInvitation[]
  isLoading: boolean
  refresh: () => Promise<PendingProjectInvitation[]>
  removeByProjectId: (projectId: string) => void
  clear: () => void
}

let refreshRequestId = 0

/** 当前账号待接受的 Project 邀请；供协作角标 / 待加入列表 / Toast 共用。 */
export const usePendingProjectInvitationStore = create<PendingProjectInvitationState>((set, get) => ({
  invitations: [],
  isLoading: false,

  refresh: async () => {
    const requestId = ++refreshRequestId
    set({ isLoading: true })
    try {
      const invitations = await ProjectApiService.listMyPendingInvitations()
      if (requestId !== refreshRequestId) return get().invitations
      set({ invitations, isLoading: false })
      return invitations
    } catch {
      if (requestId !== refreshRequestId) return get().invitations
      set({ isLoading: false })
      return get().invitations
    }
  },

  removeByProjectId: (projectId) => {
    set((state) => ({
      invitations: state.invitations.filter((item) => item.project_id !== projectId),
    }))
  },

  clear: () => {
    refreshRequestId += 1
    set({ invitations: [], isLoading: false })
  },
}))

export function countPendingProjectInvitations(
  invitations: PendingProjectInvitation[],
  organizationId: string | null,
): number {
  if (!organizationId) return 0
  return invitations.filter((item) => item.organization_id === organizationId).length
}
