import type { ResourceScope } from '@stores/useSpaceViewPrefsStore'

export const TRACKER_RESOURCE_TYPE = 'tabtracker'

export function getTrackerListSpaceId(spaceId: string, scope: ResourceScope): string | undefined {
  return scope === 'organization' ? undefined : spaceId
}

export function getTrackerTaskSpaceId(taskSpaceId: string | null | undefined, fallbackSpaceId: string): string {
  return taskSpaceId || fallbackSpaceId
}
