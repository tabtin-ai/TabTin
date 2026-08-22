/** @store-category domain */

/**
 * FE-62：Settings 面板已全面迁移至 React Query，此 Store 的数据获取方法无调用方。
 * 保留 clearMembership 供 sessionResetRegistry（退出登录）使用；
 * 已移除 persist 中间件，防止 stale membershipStatus 持久化到 localStorage 影响新 session。
 * 原 localStorage key "tabtin-membership-store" 中的历史残留由 clearMembership 在退出时清理。
 */
import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'
import type {
  CreditPackage,
  MembershipStatus,
  MembershipTier,
  OrganizationMembershipStatus,
  OrganizationWalletInfo,
} from '@/types/membership'

interface MembershipStoreState {
  membershipStatus: MembershipStatus | OrganizationMembershipStatus | null
  activeOrganizationId: string | null
  isLoaded: boolean

  walletInfo: OrganizationWalletInfo | null
  tiers: MembershipTier[]
  packages: CreditPackage[]
  billingLoading: boolean
  billingError: string

  clearMembership: () => void
}

export const useMembershipStore = create<MembershipStoreState>()(
  (set) => ({
    membershipStatus: null,
    activeOrganizationId: null,
    isLoaded: false,

    walletInfo: null,
    tiers: [],
    packages: [],
    billingLoading: false,
    billingError: '',

    clearMembership: () => {
      // 同步清理历史残留 localStorage key（兼容旧版本遗留数据）
      try {
        localStorage.removeItem('tabtin-membership-store')
      } catch { /* 浏览器限制时静默处理 */ }
      set({
        membershipStatus: null,
        activeOrganizationId: null,
        isLoaded: false,
        walletInfo: null,
        tiers: [],
        packages: [],
        billingLoading: false,
        billingError: '',
      })
    },
  })
)

registerResetAction('membership', 'reset', () => useMembershipStore.getState().clearMembership())
