import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOrganizationMembershipNoticeStore } from './useOrganizationMembershipNoticeStore'

vi.mock('./sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

describe('useOrganizationMembershipNoticeStore', () => {
  beforeEach(() => {
    useOrganizationMembershipNoticeStore.setState({
      notice: null,
      dismissedNoticeIds: [],
    })
  })

  it('关闭过的同一组织成员变更通知不会被重复弹出', () => {
    const notice = {
      id: 'membership-removed-ws-A',
      kind: 'removed' as const,
      title: '已被移出「A」',
      description: '已切换到「B」',
    }

    useOrganizationMembershipNoticeStore.getState().showNotice(notice)
    expect(useOrganizationMembershipNoticeStore.getState().notice).toEqual(notice)

    useOrganizationMembershipNoticeStore.getState().dismissNotice()
    expect(useOrganizationMembershipNoticeStore.getState().notice).toBeNull()
    expect(useOrganizationMembershipNoticeStore.getState().dismissedNoticeIds).toContain(notice.id)

    useOrganizationMembershipNoticeStore.getState().showNotice(notice)
    expect(useOrganizationMembershipNoticeStore.getState().notice).toBeNull()
  })

  it('resetNotices 会清空当前弹窗和已关闭通知列表', () => {
    useOrganizationMembershipNoticeStore.getState().showNotice({
      id: 'membership-removed-ws-A',
      kind: 'removed',
      title: '已被移出「A」',
      description: '已切换到「B」',
    })
    useOrganizationMembershipNoticeStore.getState().dismissNotice()

    useOrganizationMembershipNoticeStore.getState().resetNotices()

    expect(useOrganizationMembershipNoticeStore.getState().notice).toBeNull()
    expect(useOrganizationMembershipNoticeStore.getState().dismissedNoticeIds).toEqual([])
  })
})
