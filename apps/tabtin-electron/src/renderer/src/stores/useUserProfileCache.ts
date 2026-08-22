/** @store-category domain */

/**
 * 用户 Profile 缓存 — 按需批量加载，全局共享
 *
 * 核心思路：收集一个 microtask 周期内所有请求的 userId，合并为一次批量请求。
 *
 * ## Reactive Hooks（组件内使用）
 * - `useDisplayName(userId)` — 单用户昵称，profile 加载后自动更新
 * - `useAvatar(userId)` — 单用户头像，profile 加载后自动更新
 * - `useDisplayNames(userIds)` — 多用户昵称 Record，任一 profile 变化时更新
 *
 * ## 非 Reactive 函数（事件处理器 / store action 中使用）
 * - `getDisplayName` / `getAvatar` — 立即读取当前值，不触发组件重渲染
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { registerResetAction } from './sessionResetRegistry'
import * as tabchatApi from '@/services/tabchatApi'
import type { UserProfile } from '@/services/tabchatApi'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('UserProfileCache')

type UserProfileInput = Pick<UserProfile, 'id'> & Partial<Omit<UserProfile, 'id'>>

function withAvatarVersion(profile: UserProfile): UserProfile {
  if (!profile.avatar || !profile.avatar_version) return profile
  try {
    const url = new URL(profile.avatar)
    url.searchParams.set('v', profile.avatar_version)
    return { ...profile, avatar: url.toString() }
  } catch {
    const separator = profile.avatar.includes('?') ? '&' : '?'
    return { ...profile, avatar: `${profile.avatar}${separator}v=${encodeURIComponent(profile.avatar_version)}` }
  }
}

function normalizeProfile(profile: UserProfileInput): UserProfile {
  return withAvatarVersion({
    id: profile.id,
    nickname: profile.nickname ?? '',
    username: profile.username ?? '',
    avatar: profile.avatar ?? '',
    avatar_version: profile.avatar_version,
    revision: profile.revision ?? 0,
  })
}

function shouldReplaceProfile(current: UserProfile | undefined, incoming: UserProfile): boolean {
  return !current || (incoming.revision ?? 0) >= (current.revision ?? 0)
}

interface UserProfileCacheState {
  profiles: Record<string, UserProfile>
  /** 已由 TabTin 服务端确认的资料；实时提示不得覆盖。 */
  authoritativeIds: Set<string>
  loading: Set<string>
  ensureProfiles: (userIds: string[]) => void
  /** 丢弃并重新获取已缓存的资料，用于重连后的服务端对账。 */
  refreshProfiles: () => void
  /** 写入已知的最新公开资料（例如当前用户刚保存个人资料后）。 */
  upsertProfile: (profile: UserProfileInput) => void
  /** 写入实时消息携带的资料提示；仅补充未加载或尚无服务端版本的缓存。 */
  upsertProfileHint: (profile: UserProfileInput) => void
  /** 非 reactive — 在事件处理器/store action 中使用。组件内优先用 useDisplayName() */
  getDisplayName: (userId: string) => string
  /** 非 reactive — 在事件处理器/store action 中使用。组件内优先用 useAvatar() */
  getAvatar: (userId: string) => string
  reset: () => void
}

let pendingIds = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
// 清缓存后使仍在飞行中的旧 batch 响应失效，避免它重新灌回过期资料。
let cacheEpoch = 0

function scheduleBatchFetch() {
  if (flushTimer) return
  flushTimer = setTimeout(async () => {
    flushTimer = null
    const ids = Array.from(pendingIds)
    pendingIds = new Set()
    if (!ids.length) return

    const state = useUserProfileCache.getState()
    // 实时提示只负责抢先展示；只要服务端尚未确认，就继续后台校准。
    const missing = ids.filter((id) => !state.authoritativeIds.has(id) && !state.loading.has(id))
    if (!missing.length) return

    const nextLoading = new Set(state.loading)
    missing.forEach((id) => nextLoading.add(id))
    useUserProfileCache.setState({ loading: nextLoading })

    const cleanupLoading = () => {
      useUserProfileCache.setState((s) => {
        const cleaned = new Set(s.loading)
        for (const id of missing) cleaned.delete(id)
        return { loading: cleaned }
      })
    }

    try {
      const wsId = useOrganizationStore.getState().selectedOrganization?.id
      if (!wsId) {
        cleanupLoading()
        return
      }

      const requestEpoch = cacheEpoch
      const profiles = await tabchatApi.batchGetUsers(wsId, missing)
      useUserProfileCache.setState((s) => {
        if (requestEpoch !== cacheEpoch) return s
        const newProfiles = { ...s.profiles }
        const newAuthoritativeIds = new Set(s.authoritativeIds)
        const newLoading = new Set(s.loading)
        for (const p of profiles) {
          const normalized = normalizeProfile(p)
          if (shouldReplaceProfile(newProfiles[normalized.id], normalized)) {
            newProfiles[normalized.id] = normalized
          }
          newAuthoritativeIds.add(p.id)
          newLoading.delete(p.id)
        }
        for (const id of missing) {
          newLoading.delete(id)
        }
        // 未查到不是永久结论：不写空占位，让后续入群/消息事件能够重试。
        return {
          profiles: newProfiles,
          authoritativeIds: newAuthoritativeIds,
          loading: newLoading,
        }
      })
    } catch (err) {
      log.error('batch fetch failed', { error: err })
      cleanupLoading()
    }
  }, 0)
}

export const useUserProfileCache = create<UserProfileCacheState>((set, get) => ({
  profiles: {},
  authoritativeIds: new Set<string>(),
  loading: new Set<string>(),

  ensureProfiles: (userIds) => {
    const { authoritativeIds, loading } = get()
    const needed = userIds.filter((id) => id && !authoritativeIds.has(id) && !loading.has(id))
    if (!needed.length) return
    needed.forEach((id) => pendingIds.add(id))
    scheduleBatchFetch()
  },

  refreshProfiles: () => {
    const ids = Object.keys(get().profiles)
    cacheEpoch += 1
    pendingIds.clear()
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    set({ profiles: {}, authoritativeIds: new Set(), loading: new Set() })
    get().ensureProfiles(ids)
  },

  upsertProfile: (profile) => {
    if (!profile.id) return
    const normalized = normalizeProfile(profile)
    set((state) => {
      const authoritativeIds = new Set(state.authoritativeIds)
      authoritativeIds.add(normalized.id)
      return shouldReplaceProfile(state.profiles[normalized.id], normalized)
        ? {
            profiles: { ...state.profiles, [normalized.id]: normalized },
            authoritativeIds,
          }
        : { authoritativeIds }
    })
  },

  upsertProfileHint: (profile) => {
    if (!profile.id) return
    set((state) => {
      const current = state.profiles[profile.id]
      if (state.authoritativeIds.has(profile.id)) return state
      const normalized = normalizeProfile({
        ...current,
        id: profile.id,
        ...(profile.nickname !== undefined ? { nickname: profile.nickname } : {}),
        ...(profile.username !== undefined ? { username: profile.username } : {}),
        ...(profile.avatar !== undefined ? { avatar: profile.avatar } : {}),
        ...(profile.avatar_version !== undefined
          ? { avatar_version: profile.avatar_version }
          : {}),
        revision: 0,
      })
      return { profiles: { ...state.profiles, [profile.id]: normalized } }
    })
  },

  getDisplayName: (userId) => {
    const p = get().profiles[userId]
    return p?.nickname || p?.username || userId?.slice(0, 8) || ''
  },

  getAvatar: (userId) => {
    return get().profiles[userId]?.avatar || ''
  },

  reset: () => {
    cacheEpoch += 1
    pendingIds.clear()
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    set({ profiles: {}, authoritativeIds: new Set(), loading: new Set() })
  },
}))

// ---------------------------------------------------------------------------
// Reactive Hooks — profile 加载完成后自动触发组件重渲染
// ---------------------------------------------------------------------------

function resolveDisplayName(profiles: Record<string, UserProfile>, userId: string | null | undefined): string {
  if (!userId) return ''
  const p = profiles[userId]
  return p?.nickname || p?.username || userId.slice(0, 8)
}

/** Reactive：单用户公开资料。列表/头部需要区分「尚未加载」和「资料为空」时使用。 */
export function useUserProfile(userId: string | null | undefined): UserProfile | undefined {
  return useUserProfileCache((s) => (userId ? s.profiles[userId] : undefined))
}

/** Reactive：单用户昵称。profile 异步加载完成后自动更新。 */
export function useDisplayName(userId: string | null | undefined): string {
  return useUserProfileCache((s) => resolveDisplayName(s.profiles, userId))
}

/** Reactive：单用户头像。profile 异步加载完成后自动更新。 */
export function useAvatar(userId: string | null | undefined): string {
  return useUserProfileCache((s) => {
    if (!userId) return ''
    return s.profiles[userId]?.avatar || ''
  })
}

/** Reactive：多用户昵称 Record。任一用户 profile 变化时更新（shallow 比较）。 */
export function useDisplayNames(userIds: string[]): Record<string, string> {
  return useUserProfileCache(
    useShallow((state) => {
      const result: Record<string, string> = {}
      for (const id of userIds) {
        if (!id) continue
        result[id] = resolveDisplayName(state.profiles, id)
      }
      return result
    }),
  )
}

registerResetAction('user-profile-cache', 'reset', () => useUserProfileCache.getState().reset())
