/**
 * Message Cache slice — 会话消息列表与会话列表缓存的写入权威（ 分层重构）。
 *
 * 承载从 useChatStore 顶层抽出的「消息缓存层」：
 *   - 双 LRU（会话消息 _sessionAccessOrder / Space 列表 _spaceAccessOrder）
 *   - 两个私有原语 setSessionMessages / updateSessionMessages（含 LRU 淘汰 +
 *     跨 store evict + /#7794 set 前不可变 hydrateSessionBlocksFromJson；
 *     blocks 响应式靠 Zustand set 本身，无独立 notify）
 *   - 20 个按业务事件命名的消息写 action（含 epoch 门控的 reconcileFromServer、
 *     回退权威替换 replaceFromRollback 等）
 *   - setSpaceSessions（Space 列表 LRU + 批量 evict）
 *
 * LRU 数组是 purge/reset 也要动的共享状态，故本模块导出 removeSessionsFromAccessOrder /
 * removeSpacesFromAccessOrder / resetCacheAccessOrder 供 useChatStore 的编排/生命周期
 * 路径调用——保证「LRU accessOrder 与缓存快照一致」的不变量只有本模块一处维护。
 */

import type { ChatMessage, ChatSession } from '@tabtin/chat-client'
import { sortMessagesForTimeline } from '@/stores/chat/domain/messageTimelineOrder'
import {
  getClientMessageId,
  sharesIdentity,
} from '@/stores/chat/domain/messageIdentity'
import { getSessionMessagesFacade } from '@/services/agentService/sessionMessages'
import { isSessionRestoring } from '@/services/agentService/messageWriteGate'
import { cacheMessages as cacheSessionMessages } from './messageCache'
import {
  applySessionRunStateSnapshot,
  isSessionBusy,
} from '../execution/sessionRunProjection'
import { hydrateSessionBlocksFromJson } from './messageBlocks'
import {
  evictChatStoreSessionData,
  evictChatStoreSessionDataBatch,
} from '../session/utils/evictSessionData'
import { useChatRuntimeStore } from '../../useChatRuntimeStore'
import { useWsConnectionStore } from '../../useWsConnectionStore'

// ─── LRU 上限与访问顺序（内存缓存淘汰）────────────────────────────────
const MAX_MEMORY_SESSIONS = 12
const _sessionAccessOrder: string[] = []
const MAX_CACHED_AGENT_SPACES = 10
const _spaceAccessOrder: string[] = []

/** purge：从会话消息 LRU 移除一批 sessionId（与 messagesBySessionId 删除同步）。 */
export function removeSessionsFromAccessOrder(sessionIds: Iterable<string>): void {
  const idSet = sessionIds instanceof Set ? sessionIds : new Set(sessionIds)
  for (let i = _sessionAccessOrder.length - 1; i >= 0; i -= 1) {
    if (idSet.has(_sessionAccessOrder[i])) _sessionAccessOrder.splice(i, 1)
  }
}

/** purge：从 Space 列表 LRU 移除一批 spaceId。 */
export function removeSpacesFromAccessOrder(spaceIds: Iterable<string>): void {
  const idSet = spaceIds instanceof Set ? spaceIds : new Set(spaceIds)
  for (let i = _spaceAccessOrder.length - 1; i >= 0; i -= 1) {
    if (idSet.has(_spaceAccessOrder[i])) _spaceAccessOrder.splice(i, 1)
  }
}

/** reset：清空两个 LRU 访问顺序。 */
export function resetCacheAccessOrder(): void {
  _sessionAccessOrder.length = 0
  _spaceAccessOrder.length = 0
}

/** 本 slice 读写的 root 形状（消息/会话列表 + busy/HITL/restoring 守卫字段）。 */
interface MessageCacheRootState {
  messagesBySessionId: Record<string, ChatMessage[]>
  sessions: ChatSession[]
  sessionsBySpaceId: Record<string, ChatSession[]>
  sessionsHydrated: boolean
  currentSessionId: string | null
  currentSessionIdBySpaceId: Record<string, string | null>
  draftSessionBySpaceId: Record<string, boolean>
  restoringSessionId: string | null
  pendingApprovalBySessionId: Record<string, unknown>
  pendingAskUserBySessionId: Record<string, unknown>
}

export interface MessageCacheStore {
  setSessionMessages: (sessionId: string | null, nextMessages: ChatMessage[]) => void
  updateSessionMessages: (sessionId: string | null, updater: (messages: ChatMessage[]) => ChatMessage[]) => void
  appendOutgoingMessage: (sessionId: string, message: ChatMessage) => void
  injectSystemMessage: (sessionId: string, message: ChatMessage) => void
  ensureAssistantMessage: (sessionId: string, message: ChatMessage) => void
  upsertMessage: (sessionId: string, message: ChatMessage) => void
  removeMessage: (sessionId: string, messageId: string) => void
  removeMessages: (sessionId: string, messageIds: readonly string[]) => void
  truncateFromMessage: (sessionId: string, anchor: { localMessageId?: string; clientMessageId?: string }) => void
  patchMessageById: (sessionId: string, messageId: string, patcher: (message: ChatMessage) => ChatMessage) => void
  linkServerMessageId: (sessionId: string, localMessageId: string, serverId: string) => void
  prependOlderMessages: (sessionId: string, older: ChatMessage[]) => void
  clearSessionMessages: (sessionId: string) => void
  hydrateFromCache: (sessionId: string, messages: ChatMessage[]) => void
  applyLoadedMessages: (sessionId: string, messages: ChatMessage[]) => void
  reconcileFromServer: (
    sessionId: string,
    fetchEpoch: number,
    fresh: ChatMessage[],
    opts?: { advanceWatermark?: boolean; syncWatermark?: string },
  ) => { changed: boolean; newCount: number; dropped: boolean }
  replaceFromRollback: (sessionId: string, serverMessages: ChatMessage[]) => ChatMessage[]
  applyRollbackTruncation: (sessionId: string, messages: ChatMessage[]) => void
  applyCheckpointDecisionSummary: (
    sessionId: string,
    locator: { messageId?: string; checkpointId?: string },
    decisionSummary: NonNullable<NonNullable<ChatMessage['checkpoint_record']>['context_summary']>['decision_summary'],
  ) => boolean
  injectErrorBubble: (sessionId: string, message: ChatMessage) => void
  upsertObservedUserMessage: (sessionId: string, message: ChatMessage) => void
  upsertHitlBubble: (sessionId: string, placeholderMessageId: string | null | undefined, bubble: ChatMessage) => void
  rebindMessageIds: (sessionId: string, idPairs: ReadonlyArray<readonly [oldId: string, newId: string]>) => void
  mergeSubagentMessages: (
    sessionId: string,
    toStoreMessage: (dm: ChatMessage) => ChatMessage,
    incoming: ChatMessage[],
    mode: 'live' | 'flush' | 'seed',
  ) => void
  setSpaceSessions: (spaceId: string, sessions: ChatSession[], syncCurrent?: boolean) => void
}

export function createMessageCacheActions<RootState extends MessageCacheRootState>(
  get: () => RootState,
  set: (partial: Partial<RootState> | ((state: RootState) => Partial<RootState>)) => void,
): MessageCacheStore {
  const resolveSessionMessages = (state: RootState, sessionId: string) => {
    return state.messagesBySessionId[sessionId] ?? []
  }

  const projectSubagentRuns = (sessionId: string): void => {
    // 消息规范化入 store 后立即从唯一 runtime blocks 读模型投影。
    // 首屏、缓存、服务端对账与分页均必须经过这一边界。
    void useChatRuntimeStore.getState().reconcileSubagentRunsFromArchive(sessionId)
  }

  const setSessionMessages = (sessionId: string | null, nextMessages: ChatMessage[]) => {
    if (!sessionId) return

    const accessIdx = _sessionAccessOrder.indexOf(sessionId)
    if (accessIdx >= 0) _sessionAccessOrder.splice(accessIdx, 1)
    _sessionAccessOrder.push(sessionId)

    //  方案 A：不可变 hydrate；有灌块时换新数组，保证订阅与列表引用一并醒。
    const hydrated = hydrateSessionBlocksFromJson(nextMessages)
    const toStore = hydrated.messages

    set((state) => {
      const next = { ...state.messagesBySessionId, [sessionId]: toStore }
      let runtimeEviction: Partial<RootState> = {}

      if (_sessionAccessOrder.length > MAX_MEMORY_SESSIONS) {
        const evictId = _sessionAccessOrder.shift()!
        const canEvict = evictId !== state.currentSessionId
          && !isSessionBusy(evictId)
          && !state.pendingApprovalBySessionId[evictId]
          && !state.pendingAskUserBySessionId[evictId]
          && evictId !== state.restoringSessionId
        if (canEvict) {
          delete next[evictId]
          runtimeEviction = evictChatStoreSessionData(state, evictId)
          useChatRuntimeStore.getState().evictSession(evictId)
          useWsConnectionStore.getState().removeSuspendedSession(evictId)
        } else {
          _sessionAccessOrder.unshift(evictId)
        }
      }

      return {
        messagesBySessionId: next,
        ...runtimeEviction,
      } as Partial<RootState>
    })
    projectSubagentRuns(sessionId)
  }

  const updateSessionMessages = (sessionId: string | null, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
    if (!sessionId) return
    set((state) => {
      const previous = resolveSessionMessages(state, sessionId)
      const nextMessages = updater(previous)
      const hydrated = hydrateSessionBlocksFromJson(nextMessages)
      // updater 返回原数组且无需灌块 → 无写；灌块则必须换新数组（不可原地 mutate）。
      if (!hydrated.changed && nextMessages === previous) return {}
      return {
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [sessionId]: hydrated.messages,
        },
      } as Partial<RootState>
    })
  }

  // —— 追加 / 注入 / upsert ——
  const appendOutgoingMessage = (sessionId: string, message: ChatMessage) =>
    updateSessionMessages(sessionId, (prev) => [...prev, message])

  const injectSystemMessage = (sessionId: string, message: ChatMessage) =>
    updateSessionMessages(sessionId, (prev) =>
      prev.some((m) => m.id === message.id) ? prev : [...prev, message])

  /** 流式建壳 / 观察端补齐：按 id 幂等，已存在则不动。 */
  const ensureAssistantMessage = (sessionId: string, message: ChatMessage) => {
    // ：回退管线进行中禁止新建空 assistant 壳（content-block 入口已挡一层；
    // 此处为防御，堵住其它调用方在 restoring 期间 append）。
    if (isSessionRestoring(sessionId)) return
    updateSessionMessages(sessionId, (prev) =>
      prev.some((m) => m.id === message.id) ? prev : [...prev, message])
  }

  const upsertMessage = (sessionId: string, message: ChatMessage) =>
    updateSessionMessages(sessionId, (prev) => {
      const idx = prev.findIndex((m) => m.id === message.id)
      if (idx < 0) return [...prev, message]
      const next = [...prev]
      next[idx] = message
      return next
    })

  // —— 删除 / 截断 ——
  const removeMessage = (sessionId: string, messageId: string) =>
    updateSessionMessages(sessionId, (prev) => prev.filter((m) => m.id !== messageId))

  const removeMessages = (sessionId: string, messageIds: readonly string[]) => {
    const ids = new Set(messageIds)
    updateSessionMessages(sessionId, (prev) => prev.filter((m) => !ids.has(m.id)))
  }

  /** 改口截断：撤回目标（本地 id 或 client 身份键命中）及其后全部内容。 */
  const truncateFromMessage = (
    sessionId: string,
    anchor: { localMessageId?: string; clientMessageId?: string },
  ) => updateSessionMessages(sessionId, (prev) => {
    const idx = prev.findIndex((m) => {
      if (anchor.localMessageId && m.id === anchor.localMessageId) return true
      return !!anchor.clientMessageId && (
        m.id === anchor.clientMessageId
        || getClientMessageId(m) === anchor.clientMessageId
      )
    })
    return idx < 0 ? prev : prev.slice(0, idx)
  })

  // —— 单条按 id patch ——
  const patchMessageById = (
    sessionId: string,
    messageId: string,
    patcher: (message: ChatMessage) => ChatMessage,
  ) => updateSessionMessages(sessionId, (prev) => {
    const idx = prev.findIndex((m) => m.id === messageId)
    if (idx < 0) return prev
    const next = [...prev]
    next[idx] = patcher(next[idx])
    return next
  })

  /** 落库 id 回填：给本地 runtime 消息补 metadata.message_id = 服务端 id。 */
  const linkServerMessageId = (
    sessionId: string,
    localMessageId: string,
    serverId: string,
  ) => updateSessionMessages(sessionId, (prev) => {
    const idx = prev.findIndex((m) => m.id === localMessageId)
    if (idx < 0) return prev
    const target = prev[idx]
    const metadata = (typeof target.metadata === 'object' && target.metadata !== null)
      ? target.metadata as Record<string, unknown>
      : {}
    if (metadata.message_id === serverId) return prev
    const next = [...prev]
    next[idx] = { ...target, metadata: { ...metadata, message_id: serverId } }
    return next
  })

  // —— 整表级业务写（加载 / 分页 / 清空）——
  const prependOlderMessages = (sessionId: string, older: ChatMessage[]) => {
    updateSessionMessages(sessionId, (prev) => {
      const existingIds = new Set(prev.map((m) => m.id))
      const deduped = older.filter((m) => !existingIds.has(m.id))
      if (deduped.length === 0) return prev
      return sortMessagesForTimeline([...deduped, ...prev])
    })
    projectSubagentRuns(sessionId)
  }

  const clearSessionMessages = (sessionId: string) => setSessionMessages(sessionId, [])

  const hydrateFromCache = (sessionId: string, messages: ChatMessage[]) =>
    setSessionMessages(sessionId, messages)

  /** 首屏加载 / 切会话落地已加载页。 */
  const applyLoadedMessages = (sessionId: string, messages: ChatMessage[]) =>
    setSessionMessages(sessionId, messages)

  /**
   * 服务端对账：读 current → upsert merge（ 唯一语义）→ epoch 门控写回 + 落库缓存。
   */
  const reconcileFromServer = (
    sessionId: string,
    fetchEpoch: number,
    fresh: ChatMessage[],
    opts: { advanceWatermark?: boolean; syncWatermark?: string } = {},
  ): { changed: boolean; newCount: number; dropped: boolean } => {
    const facade = getSessionMessagesFacade(sessionId)
    const existing = facade.getMessages()
    const merged = facade.mergeDelta(existing, fresh)
    const advance = opts.advanceWatermark !== false
    if (merged.changed) {
      const outcome = facade.commitServerMerge(fetchEpoch, () => {
        setSessionMessages(sessionId, merged.messages)
        if (advance) cacheSessionMessages(sessionId, merged.messages, opts.syncWatermark)
        else cacheSessionMessages(sessionId, merged.messages, undefined, { preserveSyncTimestamp: true })
      })
      if (outcome !== 'committed') return { changed: false, newCount: 0, dropped: true }
      return { changed: true, newCount: merged.newCount, dropped: false }
    }
    if (opts.syncWatermark && advance) {
      const outcome = facade.commitServerMerge(fetchEpoch, () => {
        cacheSessionMessages(sessionId, existing, opts.syncWatermark)
      })
      if (outcome !== 'committed') return { changed: false, newCount: 0, dropped: true }
    }
    return { changed: false, newCount: merged.newCount, dropped: false }
  }

  /**
   * 回退：权威整表替换——读 current → mergeAuthoritativeReplace（保未落库 runtime 消息）
   * + 登记结构性变更（作废在途 sync 写回）→ 写回，返回落地后的列表供调用方建 checkpoint 图。
   */
  const replaceFromRollback = (sessionId: string, serverMessages: ChatMessage[]): ChatMessage[] => {
    const facade = getSessionMessagesFacade(sessionId)
    const resolved = facade.mergeAuthoritativeReplace(facade.getMessages(), serverMessages)
    facade.recordStructuralMutation('rollback-authoritative-replace')
    setSessionMessages(sessionId, resolved)
    return resolved
  }

  /** 回退：截断后写回（含 rewind summary，截断集合由回退编排算好）。 */
  const applyRollbackTruncation = (sessionId: string, messages: ChatMessage[]) =>
    setSessionMessages(sessionId, messages)

  /**
   * 应用 checkpoint 决策摘要：按 messageId 或 checkpoint_id 定位目标消息，
   * ready 为终态不可覆盖，其余状态允许升级。返回是否命中。
   */
  const applyCheckpointDecisionSummary = (
    sessionId: string,
    locator: { messageId?: string; checkpointId?: string },
    decisionSummary: NonNullable<NonNullable<ChatMessage['checkpoint_record']>['context_summary']>['decision_summary'],
  ): boolean => {
    let matched = false
    updateSessionMessages(sessionId, (messages) => messages.map((msg) => {
      const cpRecord = msg.checkpoint_record
      if (!cpRecord) return msg
      const isTarget = locator.messageId
        ? msg.id === locator.messageId
        : cpRecord.checkpoint_id === locator.checkpointId
      if (!isTarget) return msg
      if (cpRecord.context_summary?.decision_summary?.status === 'ready') return msg
      matched = true
      return {
        ...msg,
        checkpoint_record: {
          ...cpRecord,
          context_summary: { ...cpRecord.context_summary, decision_summary: decisionSummary },
        },
      }
    }))
    return matched
  }

  /** 注入错误气泡（按 content + isErrorMessage 去重，防同错重复）。 */
  const injectErrorBubble = (sessionId: string, message: ChatMessage) =>
    updateSessionMessages(sessionId, (prev) => {
      const exists = prev.some((m) =>
        m.content === message.content
        && (m.metadata as { isErrorMessage?: boolean } | null | undefined)?.isErrorMessage === true)
      return exists ? prev : [...prev, message]
    })

  /**
   * 观察端 / runtime USER echo 注入。
   * identity 未命中 → 追加；命中 → 回写 runtime 权威 arrival_seq，
   * 禁止 no-op 把 loop 入口盖章挡在门外。
   */
  const upsertObservedUserMessage = (sessionId: string, message: ChatMessage) =>
    updateSessionMessages(sessionId, (prev) => {
      const index = prev.findIndex((candidate) => sharesIdentity(candidate, message))
      if (index < 0) return [...prev, message]

      const existing = prev[index]!
      const next: ChatMessage = {
        ...existing,
        id: existing.id,
        content: message.content || existing.content,
        created_at: message.created_at || existing.created_at,
        content_blocks_json: message.content_blocks_json ?? existing.content_blocks_json,
        // 丢弃旧 runtime blocks，强制 hydrate 从带权威 seq 的 json 重建
        blocks: undefined,
        client_event_id: existing.client_event_id ?? message.client_event_id,
        metadata: {
          ...(existing.metadata as Record<string, unknown> | null | undefined),
          ...(message.metadata as Record<string, unknown> | null | undefined),
        },
        ...(message.attachments_json ? { attachments_json: message.attachments_json } : {}),
      }
      const copy = prev.slice()
      copy[index] = next
      return copy
    })

  /** HITL 气泡：命中占位 assistant 则就地改写为该气泡，否则追加。 */
  const upsertHitlBubble = (
    sessionId: string,
    placeholderMessageId: string | null | undefined,
    bubble: ChatMessage,
  ) => updateSessionMessages(sessionId, (prev) => {
    if (placeholderMessageId && prev.some((m) => m.id === placeholderMessageId)) {
      return prev.map((m) => m.id === placeholderMessageId ? { ...m, id: bubble.id, content: bubble.content } : m)
    }
    if (prev.some((m) => m.id === bubble.id)) {
      return prev.map((m) => m.id === bubble.id ? { ...m, content: bubble.content } : m)
    }
    return [...prev, bubble]
  })

  /** 重绑消息 id（synthetic user 落库后 client_event_id → server_id 收敛）。 */
  const rebindMessageIds = (
    sessionId: string,
    idPairs: ReadonlyArray<readonly [oldId: string, newId: string]>,
  ) => {
    const map = new Map(idPairs.filter(([o, n]) => o !== n))
    if (map.size === 0) return
    updateSessionMessages(sessionId, (prev) => {
      let changed = false
      const next = prev.map((m) => {
        const oldId = m.id
        const newId = map.get(oldId)
        if (!newId) return m
        changed = true
        // ：runtime `local-*` → server UUID 重绑时回写 client_event_id，
        // 供权威 sync（collectPreservedLocalMessages）在最新页暂缺该行时保命；
        // 与  保住 ACK 后 user 气泡对称。已有 client_event_id 不覆盖。
        const preserveRuntimeClientEventId = !m.client_event_id
          && oldId.startsWith('local-')
        return {
          ...m,
          id: newId,
          ...(preserveRuntimeClientEventId ? { client_event_id: oldId } : {}),
          ...(m.role === 'user' ? { sendStatus: 'sent' as const } : {}),
        }
      })
      return changed ? next : prev
    })
  }

  /**
   * 子 Agent 消息并入父时间线（map 补身份）。三种 mode：
   * - live：流式同步——块长度守门后替换 + 追加缺页
   * - flush：终态快照——无条件替换已有 id，不追加（补齐末块文本）
   * - seed：冷恢复/详情归档——只追加缺页，绝不覆盖已有行（避免 local/server id
   *   体系错配与 live 被旧归档打回；）
   *
   * 仅在 messages 真变更时 projectSubagentRuns，避免详情反复 reconcile。
   */
  const mergeSubagentMessages = (
    sessionId: string,
    toStoreMessage: (dm: ChatMessage) => ChatMessage,
    incoming: ChatMessage[],
    mode: 'live' | 'flush' | 'seed',
  ) => {
    let didChange = false
    updateSessionMessages(sessionId, (prev) => {
      const dmById = new Map(incoming.map((dm) => [dm.id, dm]))
      let changed = false
      const seen = new Set<string>()
      const nextPrev = prev.map((m) => {
        const dm = dmById.get(m.id)
        if (!dm) return m
        seen.add(m.id)
        if (mode === 'seed') return m
        if (mode === 'live') {
          const prevLen = m.content_blocks_json?.length ?? 0
          const nextLen = dm.content_blocks_json?.length ?? 0
          if (prevLen === nextLen && m.stop_reason === dm.stop_reason && m.model_id === dm.model_id) return m
        }
        changed = true
        return toStoreMessage(dm)
      })
      const toAdd =
        mode === 'flush'
          ? []
          : incoming.filter((dm) => !seen.has(dm.id)).map(toStoreMessage)
      if (!changed && toAdd.length === 0) return prev
      didChange = true
      return [...nextPrev, ...toAdd]
    })
    if (didChange) projectSubagentRuns(sessionId)
  }

  const setSpaceSessions = (spaceId: string, nextSessions: ChatSession[], syncCurrent = true) => {
    // 冷启动 / SWR 列表写回前先喂统一运行投影。缺 run_state 的旧后端保持 no-op；
    // 重复或乱序快照由 sequence/revision reducer 拒绝。
    for (const session of nextSessions) {
      applySessionRunStateSnapshot(session)
    }

    const idx = _spaceAccessOrder.indexOf(spaceId)
    if (idx !== -1) _spaceAccessOrder.splice(idx, 1)
    _spaceAccessOrder.push(spaceId)

    set((state) => {
      const next = { ...state.sessionsBySpaceId, [spaceId]: nextSessions }
      let nextCurrentIds = state.currentSessionIdBySpaceId
      let nextDraftBySpaceId = state.draftSessionBySpaceId
      let nextMessages = state.messagesBySessionId
      const sessionIdsToEvict: string[] = []

      while (_spaceAccessOrder.length > MAX_CACHED_AGENT_SPACES) {
        const oldest = _spaceAccessOrder.shift()!
        if (oldest !== spaceId) {
          const evictedSessions = next[oldest]
          delete next[oldest]

          if (nextCurrentIds[oldest] !== undefined) {
            nextCurrentIds = { ...nextCurrentIds }
            delete nextCurrentIds[oldest]
          }
          if (nextDraftBySpaceId[oldest] !== undefined) {
            nextDraftBySpaceId = { ...nextDraftBySpaceId }
            delete nextDraftBySpaceId[oldest]
          }
          if (evictedSessions?.length) {
            nextMessages = { ...nextMessages }
            for (const s of evictedSessions) {
              if (s.id === state.currentSessionId || isSessionBusy(s.id) || s.id === state.restoringSessionId) continue
              delete nextMessages[s.id]
              sessionIdsToEvict.push(s.id)
              const orderIdx = _sessionAccessOrder.indexOf(s.id)
              if (orderIdx >= 0) _sessionAccessOrder.splice(orderIdx, 1)
            }
          }
        }
      }

      let batchEviction: Partial<RootState> = {}
      if (sessionIdsToEvict.length > 0) {
        batchEviction = evictChatStoreSessionDataBatch(state, sessionIdsToEvict)
        useChatRuntimeStore.getState().evictSessionBatch(sessionIdsToEvict)
        const wsStore = useWsConnectionStore.getState()
        for (const sid of sessionIdsToEvict) wsStore.removeSuspendedSession(sid)
      }

      return {
        sessions: syncCurrent ? nextSessions : state.sessions,
        sessionsBySpaceId: next,
        currentSessionIdBySpaceId: nextCurrentIds,
        draftSessionBySpaceId: nextDraftBySpaceId,
        messagesBySessionId: nextMessages,
        sessionsHydrated: true,
        ...batchEviction,
      } as Partial<RootState>
    })
  }

  return {
    setSessionMessages,
    updateSessionMessages,
    appendOutgoingMessage,
    injectSystemMessage,
    ensureAssistantMessage,
    upsertMessage,
    removeMessage,
    removeMessages,
    truncateFromMessage,
    patchMessageById,
    linkServerMessageId,
    prependOlderMessages,
    clearSessionMessages,
    hydrateFromCache,
    applyLoadedMessages,
    reconcileFromServer,
    replaceFromRollback,
    applyRollbackTruncation,
    applyCheckpointDecisionSummary,
    injectErrorBubble,
    upsertObservedUserMessage,
    upsertHitlBubble,
    rebindMessageIds,
    mergeSubagentMessages,
    setSpaceSessions,
  }
}
