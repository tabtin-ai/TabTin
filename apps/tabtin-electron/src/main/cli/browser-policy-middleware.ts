import { AsyncLocalStorage } from 'node:async_hooks'
import {
  collectBrowserActionIdsForPolicy,
  evaluateBrowserRoutePolicy,
} from '@tabtin/browser-core'
import { PERMISSION_TIMEOUTS } from '@tabtin/agent-wire'
import { runWithHumanInteractionContext } from '@tabtin/agent-runtime'
import { requestApproval } from '../services/ApprovalManager'
import { isScheduledRuntimeThread } from '../agent/policy/interaction-mode-context'
import { shouldBypassConfirmApproval } from '../agent/policy/approval-mode-context'

type BrowserCLIPolicyAllow = {
  action: 'allow'
  preapprovedActionIds: string[]
}

export type BrowserCLIPolicyDeny = {
  action: 'deny'
  status: number
  code: 'POLICY_BLOCKED' | 'APPROVAL_DENIED'
  message: string
  detail?: Record<string, unknown>
}

export type BrowserCLIPolicyResult = BrowserCLIPolicyAllow | BrowserCLIPolicyDeny

// Browser write actions are often approved from mobile after WS fanout + render.
// Keep the approval window aligned with interactive HITL (PERMISSION_TIMEOUTS.FINAL_MS);
// the actual browser action still has its own shorter execution timeout.
export const BROWSER_CLI_APPROVAL_TIMEOUT_MS = PERMISSION_TIMEOUTS.FINAL_MS

const preapprovedBrowserActions = new AsyncLocalStorage<ReadonlySet<string>>()
const browserApprovalContext = new AsyncLocalStorage<{ threadId?: string }>()

export async function runWithBrowserPolicyPreapproval<T>(
  actionIds: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  if (actionIds.length === 0) return fn()
  const parent = preapprovedBrowserActions.getStore()
  const merged = new Set(parent ? [...parent] : [])
  for (const id of actionIds) merged.add(id)
  return preapprovedBrowserActions.run(merged, fn)
}

export function isBrowserPolicyPreapproved(actionId: string): boolean {
  return preapprovedBrowserActions.getStore()?.has(actionId) === true
}

export function getBrowserApprovalThreadId(): string | undefined {
  return browserApprovalContext.getStore()?.threadId
}

export function extractBrowserApprovalThreadId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const direct = record._thread_id ?? record.thread_id ?? record.threadId
  if (typeof direct === 'string' && direct.trim()) return direct.trim()

  const context = record.context
  if (context && typeof context === 'object' && !Array.isArray(context)) {
    const nested = (context as Record<string, unknown>).threadId ?? (context as Record<string, unknown>).thread_id
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
  }
  return undefined
}

export async function runWithBrowserApprovalContext<T>(
  body: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const threadId = extractBrowserApprovalThreadId(body)
  if (!threadId) return fn()
  return browserApprovalContext.run(
    { threadId },
    () => runWithHumanInteractionContext(
      { threadId, interactionMode: 'interactive' },
      fn,
    ),
  )
}

export async function evaluateElectronBrowserCLIPolicy(
  url: string,
  body: unknown,
): Promise<BrowserCLIPolicyResult> {
  const decision = evaluateBrowserRoutePolicy(url, body)
  if (!decision || decision.action === 'allow') {
    return { action: 'allow', preapprovedActionIds: [] }
  }

  if (decision.action === 'block') {
    return {
      action: 'deny',
      status: 403,
      code: decision.code,
      message: decision.message,
      detail: decision.ruleName ? { ruleName: decision.ruleName } : undefined,
    }
  }

  const threadId = extractBrowserApprovalThreadId(body)
  if (!threadId) {
    return {
      action: 'deny',
      status: 403,
      code: 'APPROVAL_DENIED',
      message: '该浏览器操作缺少对话上下文，已拒绝执行',
    }
  }
  if (isScheduledRuntimeThread(threadId)) {
    return {
      action: 'allow',
      preapprovedActionIds: collectBrowserActionIdsForPolicy(url, body),
    }
  }

  // ：统一审批档口径——生效档为 auto / full_access 时旁路浏览器 confirm 级审批
  // （与 runtime judge step 3 同源；硬红线 block 已在上方 return，不受影响）。
  // 修「切自动通过/全部允许后，浏览器打开页面仍弹授权框」。
  if (shouldBypassConfirmApproval(threadId)) {
    return {
      action: 'allow',
      preapprovedActionIds: collectBrowserActionIdsForPolicy(url, body),
    }
  }

  const approval = await runWithHumanInteractionContext(
    { threadId, interactionMode: 'interactive' },
    () => requestApproval({
      actionType: `browser.${decision.actionType}`,
      detail: decision.detail,
      reason: decision.reason,
      timeoutMs: BROWSER_CLI_APPROVAL_TIMEOUT_MS,
    }),
  )
  if (!approval.approved) {
    return {
      action: 'deny',
      status: 403,
      code: 'APPROVAL_DENIED',
      message: '用户拒绝或未确认该浏览器操作',
      detail: { actionType: decision.actionType, reason: decision.reason },
    }
  }

  return {
    action: 'allow',
    preapprovedActionIds: collectBrowserActionIdsForPolicy(url, body),
  }
}
