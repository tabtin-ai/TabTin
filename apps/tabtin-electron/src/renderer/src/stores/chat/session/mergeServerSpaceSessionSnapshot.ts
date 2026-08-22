/**
 * 将服务端 Space 会话 list 与本地桶按 sessionId 合并。
 *
 * 规则（与网盘资源桶同类的「按 id 权威」口径）：
 * 1. 服务端返回的会话：字段以服务端为准；
 * 2. 从未被成功 list 观察过的本地会话：保留（覆盖「本地 upsert 后 list 尚未含该 id」）；
 * 3. 曾被服务端观察、本次 list 缺失：视为服务端侧已移除（归档/删除/他端操作），丢弃；
 * 4. tombstone / overlay 由调用方注入，合并后统一过滤与钉回。
 */

import type { ChatSession } from '@tabtin/chat-client'
import { sortSessionsByActivity } from '@/utils/chat-session-sort'
import { withPreservedLocalCodexModelSelection } from '@/utils/preserveLocalCodexModelSelection'
import {
  isChatSessionRunState,
  selectNewerSessionRunState,
} from '../execution/sessionRunProjectionReducer'
import { mergeSessionReadStateFields } from './sessionReadProjection'
import { restoreSessionLocalModelPreference } from './sessionLocalModelPreference'

export interface MergeServerSpaceSessionSnapshotInput {
  serverSessions: readonly ChatSession[]
  localSessions: readonly ChatSession[]
  observedServerIds: ReadonlySet<string>
  tombstoneIds: ReadonlySet<string>
  /** 同 Space 未过期的 overlay 副本（查看归档 / 恢复钉住等）。 */
  overlaySessions: readonly ChatSession[]
}

export interface MergeServerSpaceSessionSnapshotResult {
  sessions: ChatSession[]
  nextObservedServerIds: Set<string>
}

/**
 * list 请求与用户级 run_state 增量是两条并发通道。普通字段仍以 list 为准，
 * 只有自带 sequence/revision 的 run_state 做单调合并，避免飞行中的旧 HTTP
 * 响应覆盖刚收到的终态事件。
 */
export function mergeSessionRunStateField(
  serverSession: ChatSession,
  localSession: ChatSession | undefined,
): ChatSession {
  if (!localSession) return serverSession
  const serverHasField = Object.prototype.hasOwnProperty.call(serverSession, 'run_state')
  const localHasField = Object.prototype.hasOwnProperty.call(localSession, 'run_state')
  if (!localHasField) return serverSession
  if (!serverHasField) {
    return { ...serverSession, run_state: localSession.run_state }
  }

  const serverRunState = serverSession.run_state
  const localRunState = localSession.run_state
  if (!isChatSessionRunState(localRunState)) return serverSession
  if (!isChatSessionRunState(serverRunState)) {
    return { ...serverSession, run_state: localRunState }
  }
  return {
    ...serverSession,
    run_state: selectNewerSessionRunState(localRunState, serverRunState),
  }
}

export function mergeServerSpaceSessionSnapshot(
  input: MergeServerSpaceSessionSnapshotInput,
): MergeServerSpaceSessionSnapshotResult {
  const {
    serverSessions,
    localSessions,
    observedServerIds,
    tombstoneIds,
    overlaySessions,
  } = input

  const byId = new Map<string, ChatSession>()
  const localById = new Map<string, ChatSession>()
  for (const session of localSessions) {
    if (!tombstoneIds.has(session.id)) localById.set(session.id, session)
  }

  for (const session of serverSessions) {
    if (tombstoneIds.has(session.id)) continue
    // Django 不持久化本机 Codex model id；list 刷新时保留本地选择。
    byId.set(
      session.id,
      withPreservedLocalCodexModelSelection(
        localById.get(session.id),
        mergeSessionReadStateFields(
          mergeSessionRunStateField(
            restoreSessionLocalModelPreference(session),
            localById.get(session.id),
          ),
          localById.get(session.id),
        ),
      ),
    )
  }

  for (const session of localSessions) {
    if (tombstoneIds.has(session.id)) continue
    if (byId.has(session.id)) continue
    // 本地新建、尚未被任何成功 list 确认 → 保留，防止陈旧/滞后 list 抹掉。
    if (!observedServerIds.has(session.id)) {
      byId.set(session.id, session)
    }
  }

  for (const overlay of overlaySessions) {
    if (tombstoneIds.has(overlay.id)) continue
    const current = byId.get(overlay.id)
    byId.set(
      overlay.id,
      withPreservedLocalCodexModelSelection(
        current,
        mergeSessionReadStateFields(
          mergeSessionRunStateField(overlay, current),
          current,
        ),
      ),
    )
  }

  const nextObservedServerIds = new Set<string>()
  for (const session of serverSessions) {
    if (!tombstoneIds.has(session.id)) {
      nextObservedServerIds.add(session.id)
    }
  }

  return {
    sessions: sortSessionsByActivity([...byId.values()]),
    nextObservedServerIds,
  }
}
