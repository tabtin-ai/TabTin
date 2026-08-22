import type { ChatSession } from '@tabtin/chat-client'
import { isTrackerRunSession } from '@/utils/chat-session-sort'

export function shouldShowTrackerSection(params: {
  sortedSessions: ChatSession[]
  extraTrackerRunSessions?: ChatSession[]
  trackerRunCount?: number | null
  trackerRunsLoading?: boolean
  trackerRunsError?: string | null
}): boolean {
  const inSessionsTrackerRuns = params.sortedSessions.filter(isTrackerRunSession)
  const extraCount = params.extraTrackerRunSessions?.length ?? 0
  const hasTrackerRunCount = typeof params.trackerRunCount === 'number' && params.trackerRunCount > 0
  return inSessionsTrackerRuns.length > 0
    || extraCount > 0
    || hasTrackerRunCount
    || (!!params.trackerRunsError && params.trackerRunsLoading === false)
}
