import { isContentBlockEvent, StreamEvents } from '@tabtin/agent-wire'

const RELAY_OBSERVER_ONLY_TYPES: ReadonlySet<string> = new Set([
  StreamEvents.SUBAGENT_STREAM_EVENT,
])

export function isRelayTransientEvent(eventType: string): boolean {
  return isContentBlockEvent(eventType)
    || RELAY_OBSERVER_ONLY_TYPES.has(eventType)
}

export function filterRelayPersistableEvents<T extends { type: string }>(
  events: T[],
): T[] {
  return events.filter((event) => !isRelayTransientEvent(event.type))
}
