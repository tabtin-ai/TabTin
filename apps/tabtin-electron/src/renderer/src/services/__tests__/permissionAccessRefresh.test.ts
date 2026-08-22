/**
 * permission.changed → refreshOrganizationAccess 调度器测试
 *
 * 背景：所有权转让 / 角色变更只推 `agent.user.permission.changed`（成员集合
 * 没变，membership_changed 不触发），新 owner 的 zustand 角色要靠这条链路
 * 回读刷新。验证 debounce 合并与登出清理两个行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRefreshOrganizationAccess } = vi.hoisted(() => ({
  mockRefreshOrganizationAccess: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      refreshOrganizationAccess: mockRefreshOrganizationAccess,
    }),
  },
}))

import {
  schedulePermissionAccessRefresh,
  clearPendingPermissionAccessRefreshes,
} from '../permissionAccessRefresh'

describe('schedulePermissionAccessRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockRefreshOrganizationAccess.mockClear()
  })

  afterEach(() => {
    clearPendingPermissionAccessRefreshes()
    vi.useRealTimers()
  })

  it('refreshes the organization after the debounce window', () => {
    schedulePermissionAccessRefresh('org-1')
    expect(mockRefreshOrganizationAccess).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)

    expect(mockRefreshOrganizationAccess).toHaveBeenCalledTimes(1)
    expect(mockRefreshOrganizationAccess).toHaveBeenCalledWith('org-1')
  })

  it('coalesces bursts of events for the same organization into one refresh', () => {
    schedulePermissionAccessRefresh('org-1')
    vi.advanceTimersByTime(100)
    schedulePermissionAccessRefresh('org-1')
    vi.advanceTimersByTime(100)
    schedulePermissionAccessRefresh('org-1')

    vi.advanceTimersByTime(300)

    expect(mockRefreshOrganizationAccess).toHaveBeenCalledTimes(1)
  })

  it('keeps independent debounce timers per organization', () => {
    schedulePermissionAccessRefresh('org-1')
    schedulePermissionAccessRefresh('org-2')

    vi.advanceTimersByTime(300)

    expect(mockRefreshOrganizationAccess).toHaveBeenCalledTimes(2)
    expect(mockRefreshOrganizationAccess).toHaveBeenCalledWith('org-1')
    expect(mockRefreshOrganizationAccess).toHaveBeenCalledWith('org-2')
  })

  it('cancels pending refreshes on clear (logout path)', () => {
    schedulePermissionAccessRefresh('org-1')
    clearPendingPermissionAccessRefreshes()

    vi.advanceTimersByTime(1000)

    expect(mockRefreshOrganizationAccess).not.toHaveBeenCalled()
  })
})
