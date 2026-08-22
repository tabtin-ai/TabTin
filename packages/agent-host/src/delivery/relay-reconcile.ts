import * as fs from 'node:fs'
import * as readline from 'node:readline'

import {
  EventEmitter,
  computeRewindCommitPrefixLength,
  reconstructMessagesFromTranscriptEntries,
  type EventStorageEntry,
  type MessageBlockRecord,
  type TranscriptEntry,
} from '@tabtin/agent-runtime'
import { isExternalArchiveLocalOnlyMessage } from '@tabtin/agent-runtime/history'
import { StreamEvents } from '@tabtin/agent-wire'

import type { RelayEvent } from './relay-transport.js'

export type RelayBackfillEvent = RelayEvent

export interface ServerMessageRef {
  id: string
  client_event_id?: string | null
}

export interface RelayReconcileResult {
  planned: number
  sent: number
  skipped: number
}

export class SessionMessagesNotFoundError extends Error {
  readonly sessionId: string
  readonly httpStatus = 404

  constructor(sessionId: string) {
    super('fetch session messages failed: HTTP 404')
    this.name = 'SessionMessagesNotFoundError'
    this.sessionId = sessionId
  }
}

export interface RelayReconcileDeps {
  sessionId: string
  eventsFilePath: string
  transcriptEntries: TranscriptEntry[]
  blockRecords?: MessageBlockRecord[]
  fetchServerMessageRefs: () => Promise<ServerMessageRef[]>
  sendRelayEvents: (events: RelayBackfillEvent[]) => Promise<void>
}

export interface FetchServerMessageRefsDeps {
  apiBaseUrl: string
  sessionId: string
  getAccessToken: () => Promise<string | null>
  organizationId?: string
  fetchFn?: typeof fetch
  pageSize?: number
}

interface MessageListWireResponse {
  messages?: Array<{ id?: string; client_event_id?: string | null }>
  has_more?: boolean
  oldest_id?: string | null
}

const CHAT_SESSION_PREFIX = 'chat-session-'

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function readRelaySessionUuid(
  value: string | undefined | null,
): string | undefined {
  const trimmed = readNonEmptyString(value)
  if (!trimmed) return undefined
  if (trimmed.startsWith(CHAT_SESSION_PREFIX)) {
    return readNonEmptyString(trimmed.slice(CHAT_SESSION_PREFIX.length))
  }
  return trimmed.startsWith('prompt_') ? undefined : trimmed
}

export function resolveRelaySessionIdForReconcile(options: {
  mapKey: string
  businessThreadId?: string | null
}): string | undefined {
  return readRelaySessionUuid(options.businessThreadId)
    ?? readRelaySessionUuid(options.mapKey)
}

function unwrapEnvelopeData<T>(body: unknown): T {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    if (record.data !== undefined) return record.data as T
  }
  return body as T
}

export async function fetchAllServerMessageRefs(
  deps: FetchServerMessageRefsDeps,
): Promise<ServerMessageRef[]> {
  const token = await deps.getAccessToken()
  if (!token) return []

  const fetchImpl = deps.fetchFn ?? fetch
  const pageSize = deps.pageSize ?? 100
  const refs: ServerMessageRef[] = []
  const seenIds = new Set<string>()
  let before: string | undefined

  for (;;) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      expand_artifacts: 'true',
    })
    if (before) params.set('before', before)
    const base = deps.apiBaseUrl.replace(/\/$/, '')
    const response = await fetchImpl(
      `${base}/chat/sessions/${encodeURIComponent(deps.sessionId)}/messages?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(deps.organizationId
            ? { 'X-Organization-Id': deps.organizationId }
            : {}),
        },
      },
    )

    if (response.status === 404) {
      throw new SessionMessagesNotFoundError(deps.sessionId)
    }
    if (!response.ok) {
      throw new Error(
        `fetch session messages failed: HTTP ${response.status}`,
      )
    }

    const payload = unwrapEnvelopeData<MessageListWireResponse>(
      await response.json(),
    )
    const page = payload.messages ?? []
    for (const message of page) {
      const id = readNonEmptyString(message.id)
      if (!id || seenIds.has(id)) continue
      seenIds.add(id)
      refs.push({
        id,
        client_event_id:
          readNonEmptyString(message.client_event_id) ?? null,
      })
    }

    const nextBefore =
      payload.has_more && page.length > 0
        ? readNonEmptyString(payload.oldest_id)
        : undefined
    if (!nextBefore || nextBefore === before) break
    before = nextBefore
  }

  return refs
}

export function collectServerPersistedKeys(
  refs: ServerMessageRef[],
): Set<string> {
  const keys = new Set<string>()
  for (const ref of refs) {
    keys.add(ref.id)
    const clientEventId = readNonEmptyString(ref.client_event_id)
    if (clientEventId) keys.add(clientEventId)
  }
  return keys
}

export async function loadEventStorageEntries(
  filePath: string,
): Promise<EventStorageEntry[]> {
  if (!fs.existsSync(filePath)) return []

  const entries: EventStorageEntry[] = []
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  try {
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as EventStorageEntry
        if (
          parsed
          && typeof parsed.type === 'string'
          && parsed.payload !== undefined
        ) {
          entries.push(parsed)
        }
      } catch {
        // Malformed rows do not block recovery of later durable events.
      }
    }
  } finally {
    if (!stream.destroyed) stream.destroy()
  }
  return entries
}

function dedupKeyForRelayEvent(
  event: RelayBackfillEvent,
): string | undefined {
  if (event.type === StreamEvents.USER) {
    return readNonEmptyString(event.payload.client_event_id)
  }
  if (event.type !== StreamEvents.PERSIST_MESSAGE) return undefined
  if (event.payload.role === 'user') {
    return readNonEmptyString(event.payload.client_event_id)
      ?? readNonEmptyString(event.payload.message_id)
  }
  return readNonEmptyString(event.payload.message_id)
}

export function extractPersistableRelayEventsFromEventLog(
  entries: EventStorageEntry[],
): RelayBackfillEvent[] {
  const events: RelayBackfillEvent[] = []
  for (const entry of entries) {
    if (
      entry.type !== StreamEvents.USER
      && entry.type !== StreamEvents.PERSIST_MESSAGE
    ) {
      continue
    }
    if (
      !entry.payload
      || typeof entry.payload !== 'object'
      || Array.isArray(entry.payload)
    ) {
      continue
    }
    const payload = entry.payload as Record<string, unknown>
    if (
      entry.type === StreamEvents.USER
      && !readNonEmptyString(payload.client_event_id)
    ) {
      continue
    }
    if (
      entry.type === StreamEvents.PERSIST_MESSAGE
      && !readNonEmptyString(payload.message_id)
    ) {
      continue
    }
    if (entry.type === StreamEvents.PERSIST_MESSAGE) {
      const blocks = payload.blocks_json
      const errorInfo = payload.error_info_json ?? payload.error_info
      const hasErrorInfo = !!errorInfo
        && typeof errorInfo === 'object'
        && !Array.isArray(errorInfo)
      if (
        payload.role === 'assistant'
        && (!Array.isArray(blocks) || blocks.length === 0)
        && !hasErrorInfo
        && payload.message_kind !== 'hitl_interaction'
      ) {
        continue
      }
    }
    events.push({ type: entry.type, payload })
  }
  return events
}

function buildPersistMessageEvent(args: {
  messageId: string
  role: 'assistant' | 'user'
  blocks: unknown[]
  arrivalSeq?: number
  subagentRunId?: string
  messageKind?: string
  stopReason?: string
  partial?: boolean
  metadata?: Record<string, unknown>
}): RelayBackfillEvent {
  return {
    type: StreamEvents.PERSIST_MESSAGE,
    payload: {
      message_id: args.messageId,
      client_event_id: args.messageId,
      role: args.role,
      blocks_json: args.blocks,
      ...(typeof args.arrivalSeq === 'number'
        ? { arrival_seq: args.arrivalSeq }
        : {}),
      message_kind: args.messageKind ?? 'llm',
      ...(args.subagentRunId
        ? { subagent_run_id: args.subagentRunId }
        : {}),
      ...(args.stopReason ? { stop_reason: args.stopReason } : {}),
      ...(args.partial ? { partial: true } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    },
  }
}

function collectPersistMessageIds(
  events: RelayBackfillEvent[],
): Set<string> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type !== StreamEvents.PERSIST_MESSAGE) continue
    const messageId = readNonEmptyString(event.payload.message_id)
    if (messageId) ids.add(messageId)
  }
  return ids
}

function filterEventLogByPendingRewind(
  entries: EventStorageEntry[],
  transcriptEntries: TranscriptEntry[],
): EventStorageEntry[] {
  const prefixLength =
    computeRewindCommitPrefixLength(transcriptEntries)
  if (prefixLength === null) return entries

  const cutEntry = transcriptEntries[prefixLength]
  const cutTimestamp = cutEntry
    ? Date.parse(cutEntry.timestamp)
    : Number.NaN
  if (!Number.isFinite(cutTimestamp)) return []
  return entries.filter(
    (entry) =>
      typeof entry.timestamp === 'number'
      && entry.timestamp < cutTimestamp,
  )
}

export function buildAssistantPersistMessagesFromTranscript(
  entries: TranscriptEntry[],
  serverKeys: Set<string>,
  coveredPersistMessageIds: Set<string>,
): RelayBackfillEvent[] {
  const events: RelayBackfillEvent[] = []
  const reconstructed = reconstructMessagesFromTranscriptEntries(entries, {
    roles: ['assistant'],
  })
  for (const message of reconstructed) {
    if (
      !message.messageId
      || message.blocks.length === 0
      || serverKeys.has(message.messageId)
      || coveredPersistMessageIds.has(message.messageId)
      || isExternalArchiveLocalOnlyMessage({
        messageId: message.messageId,
        messageKind: message.messageKind,
      })
    ) {
      continue
    }
    events.push(buildPersistMessageEvent({
      messageId: message.messageId,
      role: 'assistant',
      blocks: message.blocks,
      arrivalSeq: message.arrivalSeq,
      subagentRunId: message.subagentRunId,
      messageKind: message.messageKind,
      stopReason: message.stopReason,
    }))
  }
  return events
}

export function buildBackfillEventsFromBlockRecords(
  records: MessageBlockRecord[],
): RelayBackfillEvent[] {
  const events: RelayBackfillEvent[] = []
  for (const record of records) {
    if (!record.message_id) continue
    if (isExternalArchiveLocalOnlyMessage({
      messageId: record.message_id,
      messageKind: record.message_kind,
    })) {
      continue
    }
    if (
      record.blocks_json.length === 0
      && record.message_kind !== 'hitl_interaction'
    ) {
      continue
    }
    if (
      record.role === 'user'
      && (record.message_kind || 'llm') === 'llm'
    ) {
      continue
    }
    events.push(buildPersistMessageEvent({
      messageId: record.message_id,
      // Relay wire 仍只承载 user/assistant；Django 在落库边界依据 kind/metadata
      // 恢复真实 system 作者角色。
      role: record.role === 'assistant' ? 'assistant' : 'user',
      blocks: record.blocks_json,
      messageKind: record.message_kind || 'llm',
      arrivalSeq: record.arrival_seq,
      stopReason: record.stop_reason,
      subagentRunId: record.subagent_run_id,
      partial: record.partial,
      metadata: record.metadata,
    }))
  }
  return events
}

export function planRelayBackfillEvents(
  eventLogEntries: EventStorageEntry[],
  transcriptEntries: TranscriptEntry[],
  serverKeys: Set<string>,
  blockRecords: MessageBlockRecord[] = [],
): { planned: RelayBackfillEvent[]; skipped: number } {
  const fromBlocks = buildBackfillEventsFromBlockRecords(blockRecords)
  const fromEventLog = extractPersistableRelayEventsFromEventLog(
    filterEventLogByPendingRewind(eventLogEntries, transcriptEntries),
  )
  const coveredPersistIds = collectPersistMessageIds([
    ...fromBlocks,
    ...fromEventLog,
  ])
  const fromTranscript = buildAssistantPersistMessagesFromTranscript(
    transcriptEntries,
    serverKeys,
    coveredPersistIds,
  )

  const planned: RelayBackfillEvent[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const event of [
    ...fromBlocks,
    ...fromEventLog,
    ...fromTranscript,
  ]) {
    const key = dedupKeyForRelayEvent(event)
    if (!key || serverKeys.has(key) || seen.has(key)) {
      skipped += 1
      continue
    }
    seen.add(key)
    planned.push(event)
  }
  return { planned, skipped }
}

export async function reconcileSessionRelay(
  deps: RelayReconcileDeps,
): Promise<RelayReconcileResult> {
  const eventLogEntries = await loadEventStorageEntries(deps.eventsFilePath)
  const serverKeys = collectServerPersistedKeys(
    await deps.fetchServerMessageRefs(),
  )
  const { planned, skipped } = planRelayBackfillEvents(
    eventLogEntries,
    deps.transcriptEntries,
    serverKeys,
    deps.blockRecords ?? [],
  )

  const recoveryEvents = new EventEmitter(undefined, {
    threadId: deps.sessionId,
    traceId: deps.sessionId,
    runId: deps.sessionId,
  })
  let sent = 0
  for (const event of planned) {
    await deps.sendRelayEvents([recoveryEvents.buildStream(event)])
    sent += 1
  }
  return { planned: planned.length, sent, skipped }
}
