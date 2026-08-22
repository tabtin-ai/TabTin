/**
 * useTeamSpacePresence — Project 在场感订阅 + 读取
 *
 * 挂载时订阅 `space:{spaceId}` presence 频道（引用计数，多个挂载点共享），
 * 卸载时退订。返回当前在线的 userId 集合，UI 据此渲染在线点。
 *
 * 只对Project 生效——Workspace（bot space）没有"谁在房间里"的语义，
 * 后端 subscribe proxy 也只放行 team_space。
 */

import { useEffect, useMemo } from 'react'
import { useIMStore } from '@stores/useIMStore'
import { useSpacePresenceStore } from '@stores/useSpacePresenceStore'
import {
  subscribeSpacePresence,
  unsubscribeSpacePresence,
} from './useCentrifugoClient'

const EMPTY_COUNTS: Record<string, number> = {}

export function useTeamSpacePresence(
  spaceId: string | null | undefined,
  enabled: boolean = true,
): {
  onlineUserIds: string[]
  isUserOnline: (userId: string) => boolean
} {
  // Centrifugo 单例在 App 根部创建；若组件先于连接就绪挂载，
  // 订阅会失败——用连接状态作为依赖，连上后重试。
  const isConnected = useIMStore((s) => s.connectionStatus === 'connected')

  useEffect(() => {
    if (!enabled || !spaceId) return
    const subscribed = subscribeSpacePresence(spaceId)
    if (!subscribed) return
    return () => {
      unsubscribeSpacePresence(spaceId)
    }
  }, [spaceId, enabled, isConnected])

  const counts = useSpacePresenceStore((s) =>
    spaceId ? s.connectionsBySpace[spaceId] || EMPTY_COUNTS : EMPTY_COUNTS,
  )

  const onlineUserIds = useMemo(
    () => Object.keys(counts).filter((uid) => (counts[uid] || 0) > 0),
    [counts],
  )

  const isUserOnline = useMemo(
    () => (userId: string) => (counts[userId] || 0) > 0,
    [counts],
  )

  return { onlineUserIds, isUserOnline }
}
