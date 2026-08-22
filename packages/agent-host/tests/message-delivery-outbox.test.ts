import { describe, expect, it, vi } from 'vitest'
import {
  InMemoryPersistentQueue,
  type PersistedEntryOwner,
} from '@tabtin/agent-runtime'
import { MessageDeliveryOutbox } from '../src/delivery/message-delivery-outbox.js'
import type { RelayBatch } from '../src/delivery/relay-retry-queue.js'

const OWNER_A: PersistedEntryOwner = {
  userId: 'user-a',
  organizationId: 'org-a',
}
const OWNER_B: PersistedEntryOwner = {
  userId: 'user-b',
  organizationId: 'org-b',
}
const EVENTS = [
  {
    type: 'agent.stream.user',
    payload: { client_event_id: 'event-1' },
  },
]

function createHarness(options?: {
  persistenceEnabled?: boolean
  currentOwner?: PersistedEntryOwner
}) {
  let currentOwner = options?.currentOwner ?? OWNER_A
  const queues = new Map<string, InMemoryPersistentQueue<RelayBatch>>()
  const sendOnce = vi.fn<(
    organizationId: string,
    sessionId: string,
    events: typeof EVENTS,
  ) => Promise<void>>(async () => undefined)
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  }
  const sendRecoveredOnce = vi.fn(
    (_owner: PersistedEntryOwner, sessionId: string, events: typeof EVENTS) =>
      sendOnce(_owner.organizationId, sessionId, events),
  )
  const coordinator = new MessageDeliveryOutbox({
    isPersistenceEnabled: () => options?.persistenceEnabled ?? true,
    getSyncRoot: () => '/virtual/agent-sync',
    resolveOwnerBestEffort: () => currentOwner,
    fallbackOrganizationId: () => currentOwner.organizationId,
    sendOnce,
    sendRecoveredOnce,
    logger,
    createPersistentQueue: (owner) => {
      const key = `${owner.userId}|${owner.organizationId}`
      const queue = new InMemoryPersistentQueue<RelayBatch>()
      queues.set(key, queue)
      return queue
    },
  })
  coordinator.activateOwner(currentOwner)
  return {
    coordinator,
    queues,
    sendOnce,
    sendRecoveredOnce,
    logger,
    setCurrentOwner(owner: PersistedEntryOwner) {
      currentOwner = owner
    },
  }
}

describe('MessageDeliveryOutbox', () => {
  it('persists a failed send and recovers it through the same owner transport', async () => {
    const harness = createHarness()
    harness.sendOnce.mockRejectedValueOnce(new Error('offline'))

    await harness.coordinator.send(OWNER_A, 'session-1', EVENTS)

    const queue = harness.queues.get('user-a|org-a')
    expect(queue?.size()).toBe(1)

    await harness.coordinator.recover()

    expect(harness.sendOnce).toHaveBeenLastCalledWith(
      'org-a',
      'session-1',
      EVENTS,
    )
    expect(queue?.size()).toBe(0)
  })

  it('forwards recovered delivery metadata to the platform transport', async () => {
    const harness = createHarness()
    await harness.coordinator.persist(OWNER_A, 'session-recovered', EVENTS)

    await harness.coordinator.recover()

    expect(harness.sendRecoveredOnce).toHaveBeenCalledWith(
      OWNER_A,
      'session-recovered',
      EVENTS,
      expect.objectContaining({
        deliveryMode: 'recover',
        originalCreatedAtMs: expect.any(Number),
      }),
    )
  })

  it('deduplicates concurrent recovery runs', async () => {
    const harness = createHarness()
    await harness.coordinator.persist(OWNER_A, 'session-1', EVENTS)

    let release!: () => void
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    harness.sendOnce.mockImplementation(
      () => new Promise<void>((resolve) => {
        release = resolve
        signalStarted()
      }),
    )

    const first = harness.coordinator.recover()
    const second = harness.coordinator.recover()

    await started
    release()
    await Promise.all([first, second])
    expect(harness.sendOnce).toHaveBeenCalledTimes(1)
  })

  it('allows Daemon-style recovery to scope replay to the current owner', async () => {
    const harness = createHarness({
      currentOwner: OWNER_A,
    })
    await harness.coordinator.persist(OWNER_A, 'session-a', EVENTS)
    await harness.coordinator.persist(OWNER_B, 'session-b', EVENTS)

    await harness.coordinator.recover()

    expect(harness.sendOnce).toHaveBeenCalledTimes(1)
    expect(harness.sendOnce).toHaveBeenCalledWith('org-a', 'session-a', EVENTS)
    expect(harness.queues.get('user-b|org-b')?.size()).toBe(1)
  })

  it('never replays a historical owner with the current account credentials', async () => {
    const harness = createHarness({
      currentOwner: OWNER_A,
    })
    await harness.coordinator.persist(OWNER_A, 'session-a', EVENTS)
    await harness.coordinator.persist(OWNER_B, 'session-b', EVENTS)

    await harness.coordinator.recover()

    expect(harness.sendOnce).toHaveBeenCalledOnce()
    expect(harness.sendOnce).toHaveBeenCalledWith('org-a', 'session-a', EVENTS)
    expect(harness.queues.get('user-a|org-a')?.size()).toBe(0)
    expect(harness.queues.get('user-b|org-b')?.size()).toBe(1)
  })

  it('persists a send that exceeds the configured timeout', async () => {
    const harness = createHarness()
    harness.sendOnce.mockImplementation(() => new Promise<void>(() => undefined))

    await harness.coordinator.send(OWNER_A, 'session-timeout', EVENTS, {
      timeoutMs: 1,
    })

    expect(harness.queues.get('user-a|org-a')?.size()).toBe(1)
  })

  it('warns instead of silently dropping when persistence is disabled', async () => {
    const harness = createHarness({ persistenceEnabled: false })

    await harness.coordinator.persist(OWNER_A, 'session-1', EVENTS)

    expect(harness.queues.size).toBe(0)
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('persistence disabled'),
    )
  })

  it('blocks late writes for the reset owner until that owner is authenticated again', async () => {
    const harness = createHarness()
    await harness.coordinator.persist(OWNER_A, 'session-a', EVENTS)
    await harness.coordinator.persist(OWNER_B, 'session-b', EVENTS)
    const oldOwnerAQueue = harness.queues.get('user-a|org-a')
    const dispose = vi.spyOn(oldOwnerAQueue!, 'dispose')

    await harness.coordinator.disposeOwner(OWNER_A)
    await harness.coordinator.send(OWNER_A, 'late-direct-session-a', EVENTS)
    harness.coordinator.onExhausted(OWNER_A, 'late-session-a', EVENTS)
    await Promise.resolve()

    expect(dispose).toHaveBeenCalledOnce()
    expect(harness.sendOnce).not.toHaveBeenCalled()
    expect(harness.queues.get('user-a|org-a')).toBe(oldOwnerAQueue)
    expect(harness.queues.get('user-b|org-b')?.size()).toBe(1)

    harness.setCurrentOwner(OWNER_A)
    harness.coordinator.activateOwner(OWNER_A)
    await harness.coordinator.recover()
    await harness.coordinator.persist(OWNER_A, 'session-a-new', EVENTS)

    expect(harness.queues.get('user-a|org-a')).not.toBe(oldOwnerAQueue)
  })

  it('does not reactivate a reset owner from a reconnect recovery', async () => {
    const harness = createHarness()
    await harness.coordinator.persist(OWNER_A, 'session-a', EVENTS)
    await harness.coordinator.disposeOwner(OWNER_A)

    await harness.coordinator.recover()

    expect(harness.sendOnce).not.toHaveBeenCalled()
    expect(harness.queues.get('user-a|org-a')?.size()).toBe(0)
  })

  it.each([
    { name: 'owner disposal', dispose: (outbox: MessageDeliveryOutbox) => outbox.disposeOwner(OWNER_A) },
    { name: 'host disposal', dispose: (outbox: MessageDeliveryOutbox) => outbox.dispose() },
  ])('waits for in-flight recovery before $name completes', async ({ dispose }) => {
    const harness = createHarness()
    await harness.coordinator.persist(OWNER_A, 'session-a', EVENTS)
    let release!: () => void
    const started = new Promise<void>((resolveStarted) => {
      harness.sendOnce.mockImplementationOnce(
        () => new Promise<void>((resolveSend) => {
          release = resolveSend
          resolveStarted()
        }),
      )
    })
    const recovery = harness.coordinator.recover()
    await started
    let disposalCompleted = false

    const disposal = dispose(harness.coordinator).then(() => {
      disposalCompleted = true
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(disposalCompleted).toBe(false)

    release()
    await Promise.all([recovery, disposal])
    expect(disposalCompleted).toBe(true)
  })

  it('runs recovery independently when the authenticated owner changes', async () => {
    const harness = createHarness({ currentOwner: OWNER_A })
    await harness.coordinator.persist(OWNER_A, 'session-a', EVENTS)
    await harness.coordinator.persist(OWNER_B, 'session-b', EVENTS)

    let releaseOwnerA!: () => void
    harness.sendOnce.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseOwnerA = resolve }),
    )
    const ownerARecovery = harness.coordinator.recover()
    await vi.waitFor(() => expect(harness.sendOnce).toHaveBeenCalledOnce())

    harness.setCurrentOwner(OWNER_B)
    harness.coordinator.activateOwner(OWNER_B)
    const ownerBRecovery = harness.coordinator.recover()
    expect(ownerBRecovery).not.toBe(ownerARecovery)
    await vi.waitFor(() => expect(harness.sendOnce).toHaveBeenCalledTimes(2))

    releaseOwnerA()
    await Promise.all([ownerARecovery, ownerBRecovery])
    expect(harness.queues.get('user-b|org-b')?.size()).toBe(0)
  })

  it('onExhausted without an owner is explicit and does not create a queue', () => {
    const harness = createHarness()

    harness.coordinator.onExhausted(undefined, 'session-1', EVENTS)

    expect(harness.queues.size).toBe(0)
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no owner'),
    )
  })

  it('does not recreate an owner queue after host disposal', async () => {
    const harness = createHarness()
    await harness.coordinator.dispose()

    harness.coordinator.onExhausted(OWNER_A, 'late-session', EVENTS)
    await Promise.resolve()

    expect(harness.queues.size).toBe(0)
  })
})
