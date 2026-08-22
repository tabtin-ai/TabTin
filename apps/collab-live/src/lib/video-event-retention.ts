import type * as Y from "yjs";

export const MAX_VIDEO_EVENTS = 50;

function eventKeyTimestamp(key: string): number {
  const firstPart = key.split("-", 1)[0];
  const timestamp = Number(firstPart);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function pruneVideoEvents(
  events: Y.Map<unknown>,
  currentEventKey: string,
  maxEvents = MAX_VIDEO_EVENTS,
): void {
  const keys: string[] = [];
  events.forEach((_: unknown, k: string) => keys.push(k));
  if (keys.length <= maxEvents) return;

  const toDelete = keys
    .filter((k) => k !== currentEventKey)
    .sort((a, b) => eventKeyTimestamp(a) - eventKeyTimestamp(b) || a.localeCompare(b))
    .slice(0, keys.length - maxEvents);
  for (const k of toDelete) events.delete(k);
}
