import type { ChatSession } from '@tabtin/chat-client'
import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest } from './apiBase'
import { PERSIST_KEYS } from '@/stores/persist-key-registry'
import { getChatSessionAccess } from '@/stores/chat/shared/storeAccessRegistry'
import {
  compareSessionReadState,
  compareLatestCompletedState,
  hasSessionReadContract,
  getLatestCompletedReadTarget,
  parseSessionReadState,
  type SessionReadState,
  type SessionWithReadContract,
} from '@/stores/chat/session/sessionReadProjection'

export interface SessionReadOutboxEntry {
  sessionId: string
  throughRunId: string
  throughRunSequence: number
  throughRevision: number
  mutationId: string
  rollbackHasUnread?: boolean
  rollbackReadState?: SessionReadState | null
}

function newMutationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `read-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function mergeSessionReadOutboxEntry(
  current: SessionReadOutboxEntry | undefined,
  incoming: SessionReadOutboxEntry,
): SessionReadOutboxEntry {
  if (!current) return incoming
  if (incoming.throughRunSequence !== current.throughRunSequence) {
    return incoming.throughRunSequence > current.throughRunSequence
      ? {
          ...incoming,
          rollbackHasUnread: current.rollbackHasUnread,
          rollbackReadState: current.rollbackReadState,
        }
      : current
  }
  return incoming.throughRevision > current.throughRevision
    ? {
        ...incoming,
        rollbackHasUnread: current.rollbackHasUnread,
        rollbackReadState: current.rollbackReadState,
      }
    : current
}

function readOutbox(): Record<string, SessionReadOutboxEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PERSIST_KEYS.sessionReadOutbox) || '{}') as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const valid: Record<string, SessionReadOutboxEntry> = {}
    for (const [sessionId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = raw as Partial<SessionReadOutboxEntry>
      if (
        entry.sessionId === sessionId
        && typeof entry.throughRunId === 'string'
        && entry.throughRunId.length > 0
        && Number.isSafeInteger(entry.throughRunSequence)
        && Number.isSafeInteger(entry.throughRevision)
        && typeof entry.mutationId === 'string'
      ) {
        valid[sessionId] = {
          ...(entry as SessionReadOutboxEntry),
          rollbackReadState:
            entry.rollbackReadState === null
              ? null
              : parseSessionReadState(entry.rollbackReadState),
        }
      }
    }
    return valid
  } catch {
    return {}
  }
}

function writeOutbox(outbox: Record<string, SessionReadOutboxEntry>): void {
  try {
    localStorage.setItem(PERSIST_KEYS.sessionReadOutbox, JSON.stringify(outbox))
  } catch {
    // 当前进程的乐观读态仍可用；存储不可用不阻断进入会话。
  }
}

function enqueue(entry: SessionReadOutboxEntry): void {
  const outbox = readOutbox()
  outbox[entry.sessionId] = mergeSessionReadOutboxEntry(outbox[entry.sessionId], entry)
  writeOutbox(outbox)
}

function applyAuthoritativeResult(sessionId: string, response: unknown): void {
  const body = (response as { data?: unknown })?.data
  const payload = body && typeof body === 'object' && 'data' in body
    ? (body as { data?: unknown }).data
    : body
  if (!payload || typeof payload !== 'object') return
  const raw = payload as Record<string, unknown>
  const readState = parseSessionReadState(raw.read_state)
  const fields: Partial<SessionWithReadContract> = {}
  if (readState) fields.read_state = readState
  if (typeof raw.has_unread_reply === 'boolean') {
    fields.has_unread_reply = raw.has_unread_reply
  }
  if (Object.keys(fields).length > 0) {
    getChatSessionAccess()?.setSessionFields(sessionId, fields as Partial<ChatSession>)
  }
}

export type SessionReadSendOutcome = 'success' | 'retry' | 'permanent'

export function classifySessionReadResponse(status: number | undefined): SessionReadSendOutcome {
  if (status !== undefined && status >= 200 && status < 300) return 'success'
  if (status !== undefined && status >= 400 && status < 500) return 'permanent'
  return 'retry'
}

async function sendEntry(entry: SessionReadOutboxEntry): Promise<SessionReadSendOutcome> {
  try {
    const response = await apiRequest({
      url: joinApiPath(
        API_CONFIG.baseURL,
        `/chat/sessions/${encodeURIComponent(entry.sessionId)}/read`,
      ),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': entry.mutationId,
      },
      body: JSON.stringify({
        through_run_id: entry.throughRunId,
        through_revision: entry.throughRevision,
        mutation_id: entry.mutationId,
      }),
    })
    const outcome = classifySessionReadResponse(response?.status)
    if (outcome === 'success') applyAuthoritativeResult(entry.sessionId, response)
    return outcome
  } catch (error) {
    const status = (error as {
      status?: unknown
      response?: { status?: unknown }
    })?.status
      ?? (error as { response?: { status?: unknown } })?.response?.status
    return classifySessionReadResponse(
      typeof status === 'number' ? status : undefined,
    )
  }
}

function rollbackPermanentFailure(entry: SessionReadOutboxEntry): void {
  const access = getChatSessionAccess()
  const current = access?.getSessionById(entry.sessionId) as SessionWithReadContract | undefined
  const currentRead = parseSessionReadState(current?.read_state)
  // 新事件已把游标推进得更远时，禁止用旧失败请求的 rollback 快照倒灌。
  if (
    currentRead
    && (
      compareSessionReadState(currentRead, {
      last_read_run_sequence: entry.throughRunSequence,
      last_read_terminal_revision: entry.throughRevision,
      read_at: null,
      latest_completed_run_id: entry.throughRunId,
      latest_completed_run_sequence: entry.throughRunSequence,
      latest_completed_terminal_revision: entry.throughRevision,
      }) > 0
      || compareLatestCompletedState(currentRead, {
        last_read_run_sequence: entry.throughRunSequence,
        last_read_terminal_revision: entry.throughRevision,
        read_at: null,
        latest_completed_run_id: entry.throughRunId,
        latest_completed_run_sequence: entry.throughRunSequence,
        latest_completed_terminal_revision: entry.throughRevision,
      }) > 0
    )
  ) {
    access?.refreshSessionFromServer?.(entry.sessionId)
    return
  }
  const rollbackFields: Partial<SessionWithReadContract> = {}
  if (typeof entry.rollbackHasUnread === 'boolean') {
    rollbackFields.has_unread_reply = entry.rollbackHasUnread
  }
  if (entry.rollbackReadState !== undefined) {
    rollbackFields.read_state = entry.rollbackReadState
  }
  if (Object.keys(rollbackFields).length > 0) {
    access?.setSessionFields(entry.sessionId, rollbackFields as Partial<ChatSession>)
  }
  access?.refreshSessionFromServer?.(entry.sessionId)
}

export async function flushSessionReadOutbox(): Promise<void> {
  const outbox = readOutbox()
  for (const entry of Object.values(outbox)) {
    const outcome = await sendEntry(entry)
    if (outcome !== 'retry') {
      const latest = readOutbox()
      const stillQueued = latest[entry.sessionId]
      if (
        stillQueued
        && stillQueued.mutationId === entry.mutationId
      ) {
        delete latest[entry.sessionId]
        writeOutbox(latest)
      }
      if (outcome === 'permanent') rollbackPermanentFailure(entry)
    }
  }
}

/**
 * 仅当服务端已经声明读态契约、且完成态内容已由调用方加载后 ACK。
 * 缺字段即旧后端：继续使用 useSessionReadStore 的本地时间戳，不探测新接口。
 */
export function acknowledgeSessionRead(sessionId: string): void {
  const access = getChatSessionAccess()
  const session = access?.getSessionById(sessionId)
  if (!session || !hasSessionReadContract(session)) return
  const readState = parseSessionReadState((session as SessionWithReadContract).read_state)
  if (!readState) return
  const target = getLatestCompletedReadTarget(readState)
  if (!target) return

  const receipt: SessionReadState = {
    ...readState,
    last_read_run_sequence: target.sequence,
    last_read_terminal_revision: target.revision,
    read_at: new Date().toISOString(),
  }
  if (compareSessionReadState(readState, receipt) >= 0) {
    if (!(session as SessionWithReadContract).has_unread_reply) return
  }

  const entry: SessionReadOutboxEntry = {
    sessionId,
    throughRunId: target.runId,
    throughRunSequence: target.sequence,
    throughRevision: target.revision,
    mutationId: newMutationId(),
    rollbackHasUnread: (session as SessionWithReadContract).has_unread_reply,
    rollbackReadState: readState,
  }
  enqueue(entry)
  access?.setSessionFields(sessionId, {
    has_unread_reply: false,
    read_state: receipt,
  } as Partial<ChatSession>)
  void flushSessionReadOutbox()
}
