/**
 * Platform approval facade.
 *
 * The approval UI, pending resolver and conversation identity are owned by the
 * runtime/agent-host HITL hook. This module retains only Electron's approval
 * preference IPC and the action-semantic facade used by platform services.
 */

import { ipcMain, net, type IpcMainInvokeEvent } from 'electron'
import { requestPlatformApproval } from '@tabtin/agent-runtime'
import { joinApiPath } from '@tabtin/config'

import { TokenManager } from '../auth'
import { API_BASE_URL } from '../config/api'
import { createLogger } from '../logger'
import { guardedOn } from '../utils/guarded-handle'
import { approvalScopeCache } from './ApprovalScopeCache'
import type { ScopeEntry } from './ApprovalScopeCache'

const log = createLogger('ApprovalManager')

export interface ApprovalResult {
  approved: boolean
  scope?: string
}

export interface ApprovalRequest {
  actionType: string
  detail: string
  mode?: string
  reason?: string
  isStrict?: boolean
  agentName?: string
  timeoutMs?: number
}

export function requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
  return requestPlatformApproval({
    actionType: request.actionType,
    detail: request.detail,
    reason: request.reason,
    timeoutMs: request.timeoutMs,
    isStrict: request.isStrict,
  })
}

export function cleanupApprovalManager(): void {
  approvalScopeCache.clearSession()
}

const APPROVAL_PREFS_PATH = '/auth/profile/approval-preferences'

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await TokenManager.getAccessToken()
  const url = joinApiPath(API_BASE_URL, path)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  return net.fetch(url, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> ?? {}) },
  })
}

export async function syncApprovalPreferencesFromRemote(): Promise<void> {
  try {
    const response = await authedFetch(APPROVAL_PREFS_PATH)
    if (!response.ok) {
      log.warn(`Failed to fetch remote approval preferences: HTTP ${response.status}`)
      return
    }
    const body = await response.json() as {
      success?: boolean
      data?: Record<string, ScopeEntry>
    }
    const remote = body?.data ?? body as Record<string, ScopeEntry>
    if (remote && typeof remote === 'object') {
      approvalScopeCache.syncFromRemote(remote)
    }
  } catch (error) {
    log.debug('syncApprovalPreferencesFromRemote failed (non-blocking):', error)
  }
}

export function handleRemoteApprovalPreferencesChanged(
  preferences: Record<string, ScopeEntry>,
): void {
  if (!preferences || typeof preferences !== 'object') return
  approvalScopeCache.syncFromRemote(preferences)
  log.info('Applied remote approval preferences update from another device')
}

type ApprovalSyncIpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any

export const approvalSyncHandlers = {
  'sandbox:sync-approval-preferences': async () => {
    await syncApprovalPreferencesFromRemote()
    return approvalScopeCache.getStats()
  },
} satisfies Record<string, ApprovalSyncIpcHandler>

let cacheHandlersRegistered = false

function registerCacheHandlers(): void {
  if (cacheHandlersRegistered) return
  cacheHandlersRegistered = true
  ipcMain.handle('sandbox:clear-approval-cache', (_event, target?: string) => {
    if (target === 'session') approvalScopeCache.clearSession()
    else if (target === 'persisted') approvalScopeCache.clearPersisted()
    else approvalScopeCache.clearAll()
    return approvalScopeCache.getStats()
  })
  ipcMain.handle('sandbox:get-approval-cache-stats', () => approvalScopeCache.getStats())
  ipcMain.handle('sandbox:clear-approval-by-action-type', (_event, actionType: string) => {
    approvalScopeCache.clearByActionType(actionType)
    return approvalScopeCache.getStats()
  })
}

function registerApprovalEventListeners(): void {
  guardedOn(
    'sandbox:remote-approval-preferences-changed',
    (_event, preferences: Record<string, ScopeEntry>) => {
      handleRemoteApprovalPreferencesChanged(preferences)
    },
  )
}

export function registerApprovalSyncHandlers(): void {
  for (const channel of Object.keys(approvalSyncHandlers)) {
    try { ipcMain.removeHandler(channel) } catch { /* not registered */ }
  }
  for (const [channel, handler] of Object.entries(approvalSyncHandlers)) {
    ipcMain.handle(channel, handler as ApprovalSyncIpcHandler)
  }
  registerCacheHandlers()
  registerApprovalEventListeners()
}

export function registerApprovalSyncEventListeners(): void {
  registerApprovalEventListeners()
}

export function initApprovalSync(): void {
  registerCacheHandlers()
  syncApprovalPreferencesFromRemote().catch(() => {})
}
