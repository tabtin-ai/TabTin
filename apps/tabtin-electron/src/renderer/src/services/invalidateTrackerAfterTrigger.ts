/**
 * Tracker Run 后刷新任务元数据 + 侧栏执行记录（loadTrackerRunSessions force）。
 * 手动「立即执行」、WS tracker.progress（会话已建）与 Run 终态共用。
 */

import { useChatStore } from '@/stores/chat/useChatStore'
import { useTrackerStore } from '@/stores/useTrackerStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('Tracker')

/** 同一 Run 的 progress 可能连发；侧栏只要会话建好刷一次即可。 */
export const TRACKER_PROGRESS_SIDEBAR_COOLDOWN_MS = 15_000
const lastProgressSidebarRefreshAt = new Map<string, number>()

export function shouldRefreshSidebarOnProgress(
  event: { status: string; run_id: string },
  now = Date.now(),
): boolean {
  if (event.status !== 'running') return false
  const runId = event.run_id.trim()
  if (!runId) return false
  const previous = lastProgressSidebarRefreshAt.get(runId) ?? 0
  if (now - previous < TRACKER_PROGRESS_SIDEBAR_COOLDOWN_MS) return false
  lastProgressSidebarRefreshAt.set(runId, now)
  return true
}

function resolveSpaceId(trackerId: string, preferred?: string | null): string | null {
  if (preferred) return preferred
  const task = useTrackerStore.getState().tasks.find(t => t.id === trackerId)
  return task?.space_id ?? null
}

function resolveOrganizationId(spaceId: string): string | undefined {
  const space = useSpaceStore.getState().spaces.find(item => item.id === spaceId)
  return space?.organization_id
}

export async function invalidateTrackerAfterTrigger(
  trackerId: string,
  opts?: { spaceId?: string | null },
): Promise<void> {
  try {
    await useTrackerStore.getState().patchTaskFromWS(trackerId)
  } catch (err) {
    log.warn('invalidateTrackerAfterTrigger: patchTaskFromWS failed', { trackerId, err })
  }

  const spaceId = resolveSpaceId(trackerId, opts?.spaceId)
  if (!spaceId) {
    log.warn('invalidateTrackerAfterTrigger: no spaceId, skip run-session refresh', { trackerId })
    return
  }

  const organizationId = resolveOrganizationId(spaceId)
  if (!organizationId) {
    log.warn('invalidateTrackerAfterTrigger: missing resource organization, skip run-session refresh', {
      trackerId,
      spaceId,
    })
    return
  }
  try {
    await useChatStore.getState().loadTrackerRunSessions(spaceId, organizationId, { force: true })
  } catch (err) {
    log.warn('invalidateTrackerAfterTrigger: loadTrackerRunSessions failed', {
      trackerId,
      spaceId,
      err,
    })
  }
}
