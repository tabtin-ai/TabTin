/** @store-category session */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'

export type OrganizationMembershipNoticeKind = 'removed' | 'access_denied' | 'removed_all'

export interface OrganizationMembershipNotice {
  id: string
  kind: OrganizationMembershipNoticeKind
  title: string
  description: string
}

interface OrganizationMembershipNoticeStore {
  notice: OrganizationMembershipNotice | null
  dismissedNoticeIds: string[]
  showNotice: (notice: OrganizationMembershipNotice) => void
  dismissNotice: () => void
  resetNotices: () => void
}

export const useOrganizationMembershipNoticeStore = create<OrganizationMembershipNoticeStore>((set) => ({
  notice: null,
  dismissedNoticeIds: [],
  showNotice: (notice) => set((state) => (
    state.dismissedNoticeIds.includes(notice.id)
      ? state
      : { notice }
  )),
  dismissNotice: () => set((state) => ({
    notice: null,
    dismissedNoticeIds: state.notice
      ? Array.from(new Set([...state.dismissedNoticeIds, state.notice.id]))
      : state.dismissedNoticeIds,
  })),
  resetNotices: () => set({
    notice: null,
    dismissedNoticeIds: [],
  }),
}))

registerResetAction('organization-membership-notice', 'reset', () =>
  useOrganizationMembershipNoticeStore.getState().resetNotices(),
)
