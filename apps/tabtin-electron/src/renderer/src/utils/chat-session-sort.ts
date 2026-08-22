import { useMemo } from 'react'
import type { ChatSession } from '@tabtin/chat-client'

export const resolveSessionTimestamp = (value?: string | number | null): number => {
  if (!value) return 0
  const raw = typeof value === 'number' ? value : Date.parse(value)
  return Number.isNaN(raw) ? 0 : raw
}

/**
 * 会话"活跃时间"——决定排序和时间分组（今天 / 昨天 / 最近 7 天 / 最近 30 天）。
 *
 * 优先级：`last_message_at` > `updated_at` > `created_at`。
 *
 * 为什么不是 `updated_at`：后端 `update_last_message_time()` 用
 * ``save(update_fields=['last_message_at'])`` 显式只改 ``last_message_at``，
 * Django auto_now 不会顺带 bump ``updated_at``——若用 ``updated_at`` 分组，
 * 一个 5/9 创建、今天发了新消息的会话会被错误归到"最近 30 天"分组。
 * 后端列表查询口径已经是 ``Coalesce('last_message_at', 'updated_at')``，前端
 * 这里保持同源。
 */
export const getSessionActivityTs = (session: ChatSession): number => {
  const lastMessageAt = resolveSessionTimestamp(session.last_message_at)
  if (lastMessageAt > 0) return lastMessageAt
  const updatedAt = resolveSessionTimestamp(session.updated_at)
  if (updatedAt > 0) return updatedAt
  return resolveSessionTimestamp(session.created_at)
}

/** @deprecated 改名为 ``getSessionActivityTs``，保留是为了下游平滑迁移；行为已修复。 */
export const getSessionSortTs = getSessionActivityTs

/** 按活跃时间降序（最新在上）——侧栏 / 列表统一口径 */
export const sortSessionsByActivity = (sessions: ChatSession[]): ChatSession[] =>
  [...sessions].sort((a, b) => getSessionActivityTs(b) - getSessionActivityTs(a))

export const useSortedSessions = (sessions: ChatSession[]) =>
  useMemo(
    () => sortSessionsByActivity(sessions),
    [sessions],
  )

export type TimeGroupKey = 'today' | 'yesterday' | 'recent7d' | 'recent30d' | 'older'
/**
 * Wave 5 (charter v1.8 §6.7 表达点 #2 + 总控 §4 设计 C):
 * Tracker Run 关联的 ChatSession 在会话列表中独立分组,默认折叠避免周期 Tracker 刷屏。
 */
export type GroupKey = 'pinned' | 'trackerRuns' | TimeGroupKey

export const TIME_GROUP_ORDER: TimeGroupKey[] = ['today', 'yesterday', 'recent7d', 'recent30d', 'older']
// 顺序: 置顶 → 自动化 Run(独立分组,可折叠) → 时间分组
export const GROUP_ORDER: GroupKey[] = ['pinned', 'trackerRuns', ...TIME_GROUP_ORDER]

/** Wave 5: 判断 ChatSession 是不是 Tracker Run 的容器 */
export const isTrackerRunSession = (session: ChatSession): boolean => {
  return Boolean(session.tracker_run)
}

export const getTimeGroupKey = (dateStr?: string): TimeGroupKey => {
  if (!dateStr) return 'today'
  const ts = Date.parse(dateStr)
  if (Number.isNaN(ts)) return 'today'
  return getTimeGroupKeyFromTs(ts)
}

export interface SessionGroup {
  key: TimeGroupKey
  sessions: ChatSession[]
}

export function groupSessionsByTime(sessions: ChatSession[]): SessionGroup[] {
  const groupMap = new Map<TimeGroupKey, ChatSession[]>()
  for (const session of sessions) {
    const ts = getSessionActivityTs(session)
    const key = ts > 0 ? getTimeGroupKeyFromTs(ts) : 'today'
    const existing = groupMap.get(key)
    if (existing) existing.push(session)
    else groupMap.set(key, [session])
  }
  const result: SessionGroup[] = []
  for (const key of TIME_GROUP_ORDER) {
    const s = groupMap.get(key)
    if (s && s.length > 0) result.push({ key, sessions: s })
  }
  return result
}

function getTimeGroupKeyFromTs(ts: number): TimeGroupKey {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000
  const recent7Start = todayStart - 7 * 86400000
  const recent30Start = todayStart - 30 * 86400000
  if (ts >= todayStart) return 'today'
  if (ts >= yesterdayStart) return 'yesterday'
  if (ts >= recent7Start) return 'recent7d'
  if (ts >= recent30Start) return 'recent30d'
  return 'older'
}
