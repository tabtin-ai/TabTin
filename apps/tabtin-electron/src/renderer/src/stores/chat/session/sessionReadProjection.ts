import type { ChatSession } from '@tabtin/chat-client'

export interface SessionReadState {
  last_read_run_sequence: number
  last_read_terminal_revision: number
  read_at: string | null
  latest_completed_run_id: string | null
  latest_completed_run_sequence: number | null
  latest_completed_terminal_revision: number | null
}

export type SessionWithReadContract = ChatSession & {
  has_unread_reply?: boolean
  read_state?: SessionReadState | null
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function parseSessionReadState(value: unknown): SessionReadState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Record<string, unknown>
  const latestIsEmpty = state.latest_completed_run_id === null
    && state.latest_completed_run_sequence === null
    && state.latest_completed_terminal_revision === null
  const latestIsComplete = typeof state.latest_completed_run_id === 'string'
    && state.latest_completed_run_id.length > 0
    && isNonNegativeSafeInteger(state.latest_completed_run_sequence)
    && isNonNegativeSafeInteger(state.latest_completed_terminal_revision)
  if (
    !isNonNegativeSafeInteger(state.last_read_run_sequence)
    || !isNonNegativeSafeInteger(state.last_read_terminal_revision)
    || (state.read_at !== null && typeof state.read_at !== 'string')
    || (!latestIsEmpty && !latestIsComplete)
  ) {
    return null
  }
  return {
    last_read_run_sequence: state.last_read_run_sequence,
    last_read_terminal_revision: state.last_read_terminal_revision,
    read_at: state.read_at,
    latest_completed_run_id: state.latest_completed_run_id as string | null,
    latest_completed_run_sequence: state.latest_completed_run_sequence as number | null,
    latest_completed_terminal_revision:
      state.latest_completed_terminal_revision as number | null,
  }
}

export function hasSessionReadContract(session: ChatSession): boolean {
  return Object.prototype.hasOwnProperty.call(session, 'read_state')
}

export function resolveSessionHasUnreadReply(
  session: ChatSession | null | undefined,
  legacyUnread: boolean,
): boolean {
  if (!session) return legacyUnread
  if (!hasSessionReadContract(session)) return legacyUnread
  const value = (session as SessionWithReadContract).has_unread_reply
  return typeof value === 'boolean' ? value : legacyUnread
}

export function compareSessionReadState(
  left: SessionReadState,
  right: SessionReadState,
): number {
  if (left.last_read_run_sequence !== right.last_read_run_sequence) {
    return left.last_read_run_sequence - right.last_read_run_sequence
  }
  return left.last_read_terminal_revision - right.last_read_terminal_revision
}

export function selectNewerSessionReadState(
  current: SessionReadState | null,
  incoming: SessionReadState,
): SessionReadState {
  if (!current) return incoming
  const receiptWinner = compareSessionReadState(current, incoming) > 0 ? current : incoming
  const currentLatest = latestCompletedCursor(current)
  const incomingLatest = latestCompletedCursor(incoming)
  const latestWinner = compareNullableCursor(currentLatest, incomingLatest) > 0
    ? current
    : incoming
  return {
    last_read_run_sequence: receiptWinner.last_read_run_sequence,
    last_read_terminal_revision: receiptWinner.last_read_terminal_revision,
    read_at: receiptWinner.read_at,
    latest_completed_run_id: latestWinner.latest_completed_run_id,
    latest_completed_run_sequence: latestWinner.latest_completed_run_sequence,
    latest_completed_terminal_revision:
      latestWinner.latest_completed_terminal_revision,
  }
}

type Cursor = readonly [sequence: number, revision: number]

function latestCompletedCursor(state: SessionReadState): Cursor | null {
  return state.latest_completed_run_sequence === null
    || state.latest_completed_terminal_revision === null
    ? null
    : [
        state.latest_completed_run_sequence,
        state.latest_completed_terminal_revision,
      ]
}

function compareNullableCursor(left: Cursor | null, right: Cursor | null): number {
  if (!left) return right ? -1 : 0
  if (!right) return 1
  return left[0] === right[0] ? left[1] - right[1] : left[0] - right[0]
}

export function compareLatestCompletedState(
  left: SessionReadState,
  right: SessionReadState,
): number {
  return compareNullableCursor(latestCompletedCursor(left), latestCompletedCursor(right))
}

export function deriveHasUnreadReply(state: SessionReadState): boolean {
  const latest = latestCompletedCursor(state)
  if (!latest) return false
  return compareNullableCursor(
    latest,
    [state.last_read_run_sequence, state.last_read_terminal_revision],
  ) > 0
}

export interface LatestCompletedReadTarget {
  runId: string
  sequence: number
  revision: number
}

export function getLatestCompletedReadTarget(
  state: SessionReadState,
): LatestCompletedReadTarget | null {
  if (
    !state.latest_completed_run_id
    || state.latest_completed_run_sequence === null
    || state.latest_completed_terminal_revision === null
  ) return null
  return {
    runId: state.latest_completed_run_id,
    sequence: state.latest_completed_run_sequence,
    revision: state.latest_completed_terminal_revision,
  }
}

/**
 * list 与 ACK / WS 是并发通道。读游标只能前进；旧 ACK 只在覆盖当前 run 时
 * 才能清除未读，不能把新一轮服务端回复误清为已读。
 */
export function mergeSessionReadStateFields(
  serverSession: ChatSession,
  localSession: ChatSession | undefined,
): ChatSession {
  if (!localSession) return serverSession
  const server = serverSession as SessionWithReadContract
  const local = localSession as SessionWithReadContract
  const serverHasContract = hasSessionReadContract(serverSession)
  const localHasContract = hasSessionReadContract(localSession)
  if (!localHasContract) return serverSession
  if (!serverHasContract) {
    return {
      ...serverSession,
      has_unread_reply: local.has_unread_reply,
      read_state: local.read_state,
    } as ChatSession
  }

  const serverRead = parseSessionReadState(server.read_state)
  const localRead = parseSessionReadState(local.read_state)
  const chosenRead = serverRead && localRead
    ? selectNewerSessionReadState(serverRead, localRead)
    : localRead ?? serverRead
  const hasUnread = chosenRead
    ? deriveHasUnreadReply(chosenRead)
    : (typeof server.has_unread_reply === 'boolean'
        ? server.has_unread_reply
        : local.has_unread_reply)

  return {
    ...serverSession,
    has_unread_reply: hasUnread,
    read_state: chosenRead ?? null,
  } as ChatSession
}
