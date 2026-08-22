/**
 * Platform approval bridge — 平台/沙箱操作审批的三档记忆（once / thread / always）。
 *
 * 统一 ApprovalPanel UI 后，浏览器写操作、终端、桌面操控等平台审批与 Agent 工具
 * 审批共用输入框上方 Panel，用户可选 once / thread / always。记忆语义：
 *
 * - once：不记忆。
 * - thread（本对话内允许）：按 chat sessionId 隔离的**进程内**缓存，只在该对话内
 *   命中；切换对话不生效；App 重启清空；session 销毁时 clearPlatformThreadApprovals
 *   清理（ 生命周期）。不进「已记住的授权」列表（临时授权）。
 * - always（一直允许）：写入该会话的 ApprovalMemoStore →（commit）Django
 *   ``agent_config.approval_memo``，与 Agent 工具 always **同源**：出现在「已记住的
 *   授权」列表、可撤销、跨设备同步（ 收口）。
 *
 * Key 约定（platform domain，与 Agent 工具 key space 前缀区分）：
 *   platform::{cacheKey}
 * 其中 cacheKey 与 ApprovalScopeCache.getCacheKey 口径一致（actionType 或
 * actionType:dirPrefix）。
 */

import { createLogger } from '../logger'
import { approvalScopeCache } from './ApprovalScopeCache'
import type { ApprovalMemoStore } from '@tabtin/agent-runtime/permissions'

const log = createLogger('PlatformApprovalBridge')

export type PlatformApprovalScope = 'once' | 'thread' | 'always'

/** thread scope：sessionId → 已允许的 memoKey 集合。进程内、按对话隔离。 */
const threadApprovalsBySession = new Map<string, Set<string>>()

/**
 * 会话 ApprovalMemoStore 解析器 —— 由 ElectronAgentHost 在启动时注入
 * （依赖注入而非静态 import，避免 host ↔ bridge 循环依赖，且便于单测桩位）。
 */
type MemoStoreResolver = (sessionId: string) => ApprovalMemoStore | null
let memoStoreResolver: MemoStoreResolver | null = null

export function registerPlatformMemoStoreResolver(resolver: MemoStoreResolver): void {
  memoStoreResolver = resolver
}

function cacheKey(actionType: string, detail?: string): string {
  return approvalScopeCache.getCacheKey(actionType, detail)
}

export function buildPlatformMemoKey(actionType: string, detail?: string): string {
  return `platform::${cacheKey(actionType, detail)}`
}

export function isPlatformActionApproved(
  actionType: string,
  isStrict: boolean,
  detail?: string,
  sessionId?: string | null,
): boolean {
  if (isStrict) return false
  if (!sessionId) return false

  const memoKey = buildPlatformMemoKey(actionType, detail)

  // always（跨对话，持久化 + 跨设备）——与 Agent 工具 always 同源
  const memoStore = getMemoStoreForSessionSync(sessionId)
  if (memoStore?.getAlways(memoKey)?.decision === 'allow') return true

  // thread（本对话内允许）——严格按当前 sessionId 隔离
  const set = threadApprovalsBySession.get(sessionId)
  if (set?.has(memoKey)) return true

  return false
}

export function recordPlatformApproval(
  actionType: string,
  scope: string | undefined,
  approved: boolean,
  detail?: string,
  sessionId?: string | null,
): void {
  if (!scope || scope === 'once' || !approved || !sessionId) return

  const memoKey = buildPlatformMemoKey(actionType, detail)

  if (scope === 'thread') {
    let set = threadApprovalsBySession.get(sessionId)
    if (!set) {
      set = new Set<string>()
      threadApprovalsBySession.set(sessionId, set)
    }
    set.add(memoKey)
    return
  }

  if (scope === 'always') {
    const memoStore = getMemoStoreForSessionSync(sessionId)
    if (!memoStore) {
      log.warn(`[recordPlatformApproval] no memo store for session=${sessionId}; always not persisted for key=${memoKey}`)
      return
    }
    const now = Date.now()
    memoStore.putAlways(memoKey, {
      decision: 'allow',
      createdAt: now,
      updatedAt: now,
      scope_description: buildScopeDescription(actionType, detail),
    })
  }
}

/** session 销毁 / 切换时清掉本对话的 thread 授权（ 生命周期）。 */
export function clearPlatformThreadApprovals(sessionId: string): void {
  threadApprovalsBySession.delete(sessionId)
}

function buildScopeDescription(actionType: string, detail?: string): string {
  const summary = detail?.trim()
  if (summary) {
    const short = summary.length > 60 ? `${summary.slice(0, 60)}…` : summary
    return `总是允许「${actionType}」：${short}`
  }
  return `总是允许「${actionType}」`
}

function getMemoStoreForSessionSync(sessionId: string): ApprovalMemoStore | null {
  return memoStoreResolver?.(sessionId) ?? null
}
