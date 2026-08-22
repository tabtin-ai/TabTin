import { expandCanvasForScope } from '@/services/openResourceLink'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import {
  SHARED_SESSION_FILE_ID_PREFIX,
  SHARED_SESSION_FILE_TAB_TYPE,
} from './sharedSessionFileTab'

export interface OpenSharedSessionFileTabRequest {
  tabScopeKey: string
  sessionId: string
  shareId: string
  relativePath: string
  title?: string
}

function resolveFileTitle(relativePath: string, title?: string): string {
  const explicitTitle = title?.trim()
  if (explicitTitle) return explicitTitle
  return relativePath.split('/').filter(Boolean).pop() ?? relativePath
}

export function openSharedSessionFileTab(
  request: OpenSharedSessionFileTabRequest,
): boolean {
  const tabScopeKey = request.tabScopeKey.trim()
  const sessionId = request.sessionId.trim()
  const shareId = request.shareId.trim()
  const relativePath = request.relativePath.trim()
  if (!tabScopeKey || !sessionId || !shareId || !relativePath) return false

  const title = resolveFileTitle(relativePath, request.title)
  const id = [
    SHARED_SESSION_FILE_ID_PREFIX,
    sessionId,
    shareId,
    encodeURIComponent(relativePath),
  ].join(':')

  useSpaceContextTabsStore.getState().openResourceTab(tabScopeKey, {
    type: SHARED_SESSION_FILE_TAB_TYPE,
    id,
    title,
    meta: {
      shared_session_id: sessionId,
      session_share_id: shareId,
      relative_path: relativePath,
      filename: title,
    },
  })
  expandCanvasForScope(tabScopeKey)
  return true
}
