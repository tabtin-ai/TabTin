import type { PersistedEntryOwner } from '@tabtin/agent-runtime'
import { describe, expect, it, vi } from 'vitest'

import {
  SingleFlight,
  assertRelayAck,
  buildRelayRequestPayload,
  parseRelayFailure,
  relayEventsWithRetry,
  type RelayWithRetryDeps,
} from '../src/delivery/relay-transport.js'

const OWNER: PersistedEntryOwner = {
  userId: 'user-1',
  organizationId: 'org-1',
}
const EVENTS = [{
  type: 'agent.stream.user',
  payload: { client_event_id: 'event-1' },
}]

function createDeps(
  overrides: Partial<RelayWithRetryDeps> = {},
): RelayWithRetryDeps {
  return {
    resolveOwnerBestEffort: async () => undefined,
    fallbackOrganizationId: () => OWNER.organizationId,
    sendOnce: vi.fn(async () => undefined),
    persistBatch: vi.fn(async () => undefined),
    log: { warn: vi.fn() },
    ...overrides,
  }
}

describe('relay transport', () => {
  it('serializes recovery metadata into the additive relay payload fields', () => {
    expect(buildRelayRequestPayload('session-1', EVENTS, {
      deliveryMode: 'recover',
      originalCreatedAtMs: 1_786_200_000_000,
    })).toEqual({
      session_id: 'session-1',
      events: EVENTS,
      delivery_mode: 'recover',
      original_created_at_ms: 1_786_200_000_000,
    })
  })

  it('fails closed for malformed and protocol-level NAKs', () => {
    expect(parseRelayFailure({ ok: false })).toEqual({
      errorCode: 'unknown',
      retryable: false,
    })
    expect(parseRelayFailure({
      ok: false,
      error: { code: 'UNRECOGNIZED_ERROR' },
    })).toEqual({
      errorCode: 'UNRECOGNIZED_ERROR',
      retryable: true,
    })
    expect(parseRelayFailure({
      ok: false,
      error: { code: 'WS_REQUEST_TIMEOUT', message: 'request timeout' },
    })).toEqual({
      errorCode: 'WS_REQUEST_TIMEOUT',
      retryable: true,
    })
    expect(parseRelayFailure({
      ok: false,
      error: { code: 'WS_1005_PERMISSION_DENIED', message: 'permission denied' },
    })).toEqual({
      errorCode: 'WS_1005_PERMISSION_DENIED',
      retryable: false,
    })
    expect(parseRelayFailure({
      ok: false,
      error: {
        code: 'WS_1014_REPLAY_GAP',
        message: 'replay buffer has an unresolved gap',
      },
    })).toEqual({
      errorCode: 'WS_1014_REPLAY_GAP',
      retryable: false,
    })
    expect(() => assertRelayAck({
      ok: false,
      payload: {
        error_code: 'sync_write_failed',
        retryable: true,
      },
    })).toThrow(
      'relay_events NAK: error_code=sync_write_failed retryable=true',
    )
  })

  it('persists a failed send under the effective owner', async () => {
    const persistBatch = vi.fn(async () => undefined)
    const deps = createDeps({
      sendOnce: async () => {
        throw new Error('offline')
      },
      persistBatch,
    })

    await relayEventsWithRetry(
      deps,
      OWNER,
      'session-1',
      EVENTS,
    )

    expect(persistBatch).toHaveBeenCalledWith(
      OWNER,
      'session-1',
      EVENTS,
    )
  })

  it('resolves owner before sending and clears a winning timeout timer', async () => {
    const clearTimeoutFn = vi.fn()
    const sendOnce = vi.fn(async () => undefined)
    const deps = createDeps({
      resolveOwnerBestEffort: async () => OWNER,
      sendOnce,
      setTimeoutFn: () => 'timer',
      clearTimeoutFn,
    })

    await relayEventsWithRetry(
      deps,
      undefined,
      'session-1',
      EVENTS,
      { timeoutMs: 2_500 },
    )

    expect(sendOnce).toHaveBeenCalledWith(
      OWNER.organizationId,
      'session-1',
      EVENTS,
    )
    expect(clearTimeoutFn).toHaveBeenCalledWith('timer')
  })

  it('coalesces concurrent recovery triggers', async () => {
    const singleFlight = new SingleFlight()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const work = vi.fn(async () => gate)

    const first = singleFlight.run(work)
    const second = singleFlight.run(work)
    expect(second).toBe(first)
    expect(singleFlight.active).toBe(true)

    release()
    await first
    expect(work).toHaveBeenCalledOnce()
    expect(singleFlight.active).toBe(false)
  })
})
