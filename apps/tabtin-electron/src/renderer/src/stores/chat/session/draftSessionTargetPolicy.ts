/**
 *  草稿会话目标策略（纯决策，无 store / HTTP / 副作用）
 *
 * 终态两态：草稿（可藏 0/1 条预建）→ 正式对话（同一 id 显形）。
 * 本模块集中：
 * - 每 Space 未使用空 session 单槽复用（避免  连点堆空行）
 * - prefetch 是否需要 create
 * - provision 是否 retainDraft / 是否写全局 current
 * - 首发应挂的真 session id（禁止把 local-pending 当 shell 目标）
 *
 * 编排与副作用见 `draftSessionCoordinator.ts` / `sessionPrefetchAction` /
 * `sessionLifecycleAction`；UI 钩子保持薄封装。
 */

export type DraftSessionLike = {
  id: string
  message_count?: number | null
  status?: string | null
}

export type DraftPrefetchDecision =
  | { action: 'skip'; reason: 'not_draft' | 'no_episode' | 'latched' }
  | { action: 'reuse_pointer'; sessionId: string }
  | { action: 'reuse_empty'; sessionId: string }
  | { action: 'create' }

/** 未使用空会话：message_count===0 且未归档 */
export function isReusableEmptyDraftSession(session: DraftSessionLike): boolean {
  if (session.status === 'archived') return false
  return (session.message_count ?? 0) === 0
}

/**
 * ：首发/预建是否允许从 foreign open episode 回收该 session。
 * 要求桶内仍是可复用空壳、本地无气泡；幽灵指针 / 已有消息不可 steal。
 */
export function isReclaimableDraftPrefetchShell(
  sessionId: string,
  state: {
    messagesBySessionId: Record<string, readonly unknown[] | undefined>
    sessionsBySpaceId: Record<string, readonly DraftSessionLike[] | undefined>
  },
): boolean {
  if (!sessionId || sessionId.startsWith('local-pending-')) return false
  if ((state.messagesBySessionId[sessionId] ?? []).length > 0) return false
  for (const list of Object.values(state.sessionsBySpaceId)) {
    const hit = list?.find((session) => session.id === sessionId)
    if (hit) return isReusableEmptyDraftSession(hit)
  }
  return false
}

/**
 * 每 Space 单槽：优先命中 preferSessionId，否则取桶内第一条空会话。
 * `sessions` 应为未经过侧栏过滤的 `sessionsBySpaceId[spaceId]`。
 * `excludeSessionIds`：外部历史已展开会话等，禁止被草稿预建吞掉。
 */
export function resolveReusableEmptySessionId(
  sessions: ReadonlyArray<DraftSessionLike>,
  options?: {
    preferSessionId?: string | null
    excludeSessionIds?: ReadonlySet<string> | null
  },
): string | null {
  const exclude = options?.excludeSessionIds
  const empties = sessions.filter((session) => (
    isReusableEmptyDraftSession(session)
    && !exclude?.has(session.id)
  ))
  if (empties.length === 0) return null
  const preferred = options?.preferSessionId
  if (preferred) {
    const hit = empties.find((session) => session.id === preferred)
    if (hit) return hit.id
  }
  return empties[0]?.id ?? null
}

export function decideDraftSessionPrefetch(input: {
  isDraftUi: boolean
  hasActiveDraftMessage: boolean
  prefetchLatchDone: boolean
  spacePointer: string | null | undefined
  spaceSessions: ReadonlyArray<DraftSessionLike>
  /** 禁止被草稿预建吞掉的会话（如外部历史已展开） */
  excludeSessionIds?: ReadonlySet<string> | null
}): DraftPrefetchDecision {
  if (!input.isDraftUi) {
    return { action: 'skip', reason: 'not_draft' }
  }
  if (!input.hasActiveDraftMessage) {
    return { action: 'skip', reason: 'no_episode' }
  }
  const reusablePointer = resolveReusablePointerSessionId({
    spacePointer: input.spacePointer,
    spaceSessions: input.spaceSessions,
    excludeSessionIds: input.excludeSessionIds,
  })
  if (reusablePointer) {
    return { action: 'reuse_pointer', sessionId: reusablePointer }
  }
  if (input.prefetchLatchDone) {
    return { action: 'skip', reason: 'latched' }
  }
  const reusableId = resolveReusableEmptySessionId(input.spaceSessions, {
    excludeSessionIds: input.excludeSessionIds,
  })
  if (reusableId) {
    return { action: 'reuse_empty', sessionId: reusableId }
  }
  return { action: 'create' }
}

/** prefetch 预建：保留欢迎态，不写全局 currentSessionId */
export function shouldRetainDraftOnProvision(input: {
  trigger?: string | null
  retainDraftMessage?: boolean
}): boolean {
  return Boolean(input.retainDraftMessage || input.trigger === 'prefetch')
}

/**
 * 是否把全局 current 切到新 session。
 * - retainDraft（预建）→ 永不切
 * - pre_send → 强制切（离开草稿壳， / ）
 * - 其余 → 仅当前前台 Space
 */
export function shouldSyncGlobalCurrentOnProvision(input: {
  trigger?: string | null
  isActiveSpace: boolean
  retainDraft: boolean
}): boolean {
  if (input.retainDraft) return false
  if (input.trigger === 'pre_send') return true
  return input.isActiveSpace
}

/**
 * 首发应挂的真 session：Space 指针优先，否则单槽空会话。
 * 返回 null 表示尚无本地候选，编排层应 await in-flight / ensure，
 * **不要**因此改走 local-pending 工作台。
 * `excludeSessionIds`：外部历史已展开会话等。草稿首发不能复用这些会话，
 * 否则「在此工作区新建任务」会把首条指令发进导入历史上下文。
 *
 * ：指针必须仍是桶内可复用空会话；归档 / 幽灵 / 已有消息的指针一律丢弃，
 * 避免首发认领到已被其它草稿占用或已失效的壳。
 */
export function resolveFirstSendExistingSessionId(input: {
  spacePointer: string | null | undefined
  spaceSessions: ReadonlyArray<DraftSessionLike>
  excludeSessionIds?: ReadonlySet<string> | null
}): string | null {
  const reusablePointer = resolveReusablePointerSessionId(input)
  if (reusablePointer) return reusablePointer
  return resolveReusableEmptySessionId(input.spaceSessions, {
    excludeSessionIds: input.excludeSessionIds,
  })
}

/** 指针命中且仍为可复用空会话时返回 id，否则 null（含幽灵指针）。 */
export function resolveReusablePointerSessionId(input: {
  spacePointer: string | null | undefined
  spaceSessions: ReadonlyArray<DraftSessionLike>
  excludeSessionIds?: ReadonlySet<string> | null
}): string | null {
  const pointer = input.spacePointer
  if (!pointer || input.excludeSessionIds?.has(pointer)) return null
  const pointed = input.spaceSessions.find((session) => session.id === pointer)
  if (!pointed || !isReusableEmptyDraftSession(pointed)) return null
  return pointed.id
}

/** provision 后是否立刻迁 shell（预建 retain 时延后到首发） */
export function shouldRehomeShellAfterProvision(retainDraft: boolean): boolean {
  return !retainDraft
}
