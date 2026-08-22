import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  MessageBlockRecord,
  PersistedEntryOwner,
  TranscriptEntry,
} from '@tabtin/agent-runtime'
import { StreamEvents } from '@tabtin/agent-wire'

import {
  RelaySessionOrchestrator,
  type RelaySessionStorageView,
} from '../src/delivery/relay-session-orchestrator.js'
import type { MessageDeliveryOutbox } from '../src/delivery/message-delivery-outbox.js'

const OWNER: PersistedEntryOwner = {
  userId: 'user-a',
  organizationId: 'org-a',
}

function createOutboxMock() {
  const send = vi.fn<
    Parameters<MessageDeliveryOutbox['send']>,
    ReturnType<MessageDeliveryOutbox['send']>
  >(async () => undefined)
  const activateOwner = vi.fn(() => true)
  const recover = vi.fn<[], Promise<void>>(async () => undefined)
  const outbox = {
    send,
    activateOwner,
    recover,
  } as unknown as MessageDeliveryOutbox
  return { outbox, send, activateOwner, recover }
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }
}

async function writeEventsFile(entries: Array<Record<string, unknown>>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-orch-'))
  const file = path.join(dir, 'events.jsonl')
  await fs.writeFile(
    file,
    entries.map((entry) => JSON.stringify(entry)).join('\n'),
    'utf-8',
  )
  return file
}

function makeStorageView(overrides: Partial<RelaySessionStorageView> & {
  mapKey: string
  eventsFilePath: string
}): RelaySessionStorageView {
  return {
    mapKey: overrides.mapKey,
    businessThreadId: overrides.businessThreadId,
    owner: overrides.owner ?? OWNER,
    eventsFilePath: overrides.eventsFilePath,
    loadTranscript: overrides.loadTranscript ?? (async () => [] as TranscriptEntry[]),
    loadBlockRecords: overrides.loadBlockRecords ?? (async () => [] as MessageBlockRecord[]),
  }
}

describe('RelaySessionOrchestrator', () => {
  it('activates owner and recovers on startup before backfilling active sessions', async () => {
    const { outbox, activateOwner, recover, send } = createOutboxMock()
    const eventsFilePath = await writeEventsFile([])
    const view = makeStorageView({
      mapKey: 'chat-session-3fa85f64-5717-4562-b3fc-2c963f66afa6',
      eventsFilePath,
    })

    const orchestrator = new RelaySessionOrchestrator({
      outbox,
      logger: createLogger(),
      listStorage: () => [view],
      getApiBaseUrl: () => 'https://api.example.test',
      resolveOwner: async () => OWNER,
      getAccessToken: async () => 'token',
    })

    // fetch mock returns empty (no server messages) → planned = 0 unless we
    // seed events; ensure recover / activate order.
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: { messages: [] } }), {
      status: 200,
    })) as unknown as typeof fetch
    try {
      await orchestrator.kickRecoverAndBackfill({ activateOwner: true })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(activateOwner).toHaveBeenCalledWith(OWNER)
    expect(recover).toHaveBeenCalledOnce()
    // No planned events (empty events file + server empty) → outbox.send untouched.
    expect(send).not.toHaveBeenCalled()
  })

  it('skips activate on reconnect kick but still calls recover + backfill', async () => {
    const { outbox, activateOwner, recover } = createOutboxMock()
    const orchestrator = new RelaySessionOrchestrator({
      outbox,
      logger: createLogger(),
      listStorage: () => [],
      getApiBaseUrl: () => 'https://api.example.test',
      resolveOwner: async () => OWNER,
      getAccessToken: async () => 'token',
    })

    await orchestrator.kickRecoverAndBackfill({ activateOwner: false })

    expect(activateOwner).not.toHaveBeenCalled()
    expect(recover).toHaveBeenCalledOnce()
  })

  it('skips backfill for sessions without a resolvable relay id', async () => {
    const { outbox, send } = createOutboxMock()
    const view = makeStorageView({
      mapKey: 'prompt_local',
      businessThreadId: 'prompt_forward-42',
      eventsFilePath: '/nonexistent',
    })

    const orchestrator = new RelaySessionOrchestrator({
      outbox,
      logger: createLogger(),
      listStorage: () => [view],
      getApiBaseUrl: () => 'https://api.example.test',
      resolveOwner: async () => OWNER,
      getAccessToken: async () => 'token',
    })

    await orchestrator.reconcileAllSessions()
    expect(send).not.toHaveBeenCalled()
  })

  it('normalizes chat-session prefix via businessThreadId', async () => {
    const { outbox, send } = createOutboxMock()
    const eventsFilePath = await writeEventsFile([
      {
        type: StreamEvents.USER,
        timestamp: 100,
        payload: { client_event_id: 'ev-1', content: 'hi' },
      },
    ])
    const view = makeStorageView({
      mapKey: 'prompt_forward-42',
      businessThreadId: 'chat-session-3fa85f64-5717-4562-b3fc-2c963f66afa6',
      eventsFilePath,
    })

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { messages: [] } }), {
      status: 200,
    })) as unknown as typeof fetch
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock
    let orchestrator: RelaySessionOrchestrator
    try {
      orchestrator = new RelaySessionOrchestrator({
        outbox,
        logger: createLogger(),
        listStorage: () => [view],
        getApiBaseUrl: () => 'https://api.example.test',
        resolveOwner: async () => OWNER,
        getAccessToken: async () => 'token',
      })
      await orchestrator.reconcileAllSessions()
    } finally {
      globalThis.fetch = originalFetch
    }

    // send should have been called once with the raw uuid (prefix stripped) as sessionId.
    expect(send).toHaveBeenCalledTimes(1)
    const [, sessionIdArg, , deliveryOptions] = send.mock.calls[0]
    expect(sessionIdArg).toBe('3fa85f64-5717-4562-b3fc-2c963f66afa6')
    expect(deliveryOptions).toEqual({
      deliveryMetadata: { deliveryMode: 'backfill' },
    })
  })

  it('single-flights concurrent reconcile calls', async () => {
    const { outbox } = createOutboxMock()
    let concurrent = 0
    let maxConcurrent = 0
    const view = makeStorageView({
      mapKey: 'chat-session-3fa85f64-5717-4562-b3fc-2c963f66afa6',
      eventsFilePath: await writeEventsFile([]),
    })

    const orchestrator = new RelaySessionOrchestrator({
      outbox,
      logger: createLogger(),
      listStorage: () => [view],
      getApiBaseUrl: () => 'https://api.example.test',
      resolveOwner: async () => OWNER,
      getAccessToken: async () => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((resolve) => setTimeout(resolve, 10))
        concurrent -= 1
        return 'token'
      },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: { messages: [] } }), {
      status: 200,
    })) as unknown as typeof fetch
    try {
      await Promise.all([
        orchestrator.reconcileAllSessions(),
        orchestrator.reconcileAllSessions(),
        orchestrator.reconcileAllSessions(),
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(maxConcurrent).toBe(1)
  })

  it('skips backfill when access token missing (unauthenticated)', async () => {
    const { outbox, send } = createOutboxMock()
    const view = makeStorageView({
      mapKey: 'chat-session-3fa85f64-5717-4562-b3fc-2c963f66afa6',
      eventsFilePath: await writeEventsFile([]),
    })
    const orchestrator = new RelaySessionOrchestrator({
      outbox,
      logger: createLogger(),
      listStorage: () => [view],
      getApiBaseUrl: () => 'https://api.example.test',
      resolveOwner: async () => OWNER,
      getAccessToken: async () => null,
    })
    await orchestrator.reconcileAllSessions()
    expect(send).not.toHaveBeenCalled()
  })

  it('swallows SessionMessagesNotFoundError as debug (does not break batch)', async () => {
    const { outbox, send } = createOutboxMock()
    const logger = createLogger()
    const view = makeStorageView({
      mapKey: 'chat-session-3fa85f64-5717-4562-b3fc-2c963f66afa6',
      eventsFilePath: await writeEventsFile([]),
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('missing', { status: 404 })) as unknown as typeof fetch
    try {
      const orchestrator = new RelaySessionOrchestrator({
        outbox,
        logger,
        listStorage: () => [view],
        getApiBaseUrl: () => 'https://api.example.test',
        resolveOwner: async () => OWNER,
        getAccessToken: async () => 'token',
      })
      await orchestrator.reconcileAllSessions()
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(send).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('does not throw when recover fails; still tries backfill', async () => {
    const { outbox, activateOwner, recover, send } = createOutboxMock()
    recover.mockRejectedValueOnce(new Error('boom'))
    const logger = createLogger()
    const orchestrator = new RelaySessionOrchestrator({
      outbox,
      logger,
      listStorage: () => [],
      getApiBaseUrl: () => 'https://api.example.test',
      resolveOwner: async () => OWNER,
      getAccessToken: async () => 'token',
    })

    await expect(orchestrator.kickRecoverAndBackfill({ activateOwner: true })).resolves.toBeUndefined()
    expect(activateOwner).toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
