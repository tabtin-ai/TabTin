/**
 * ApprovalGate — host 侧平台审批的 memo + ask 编排。
 *
 * 本模块统一「记不记得 / 要不要问人」；是否 confirm 的风险判定仍在
 * browser-policy / LocalSandboxPolicy 等入口（P2 再收）。硬拦截（block）
 * 仍在入口策略层先行。ask 经 AgentHost.requestPlatformApproval 发事件，
 * 前端 ApprovalPanel 响应。
 */

import type {
  HumanInteractionContext,
  PlatformApprovalRequest,
  PlatformApprovalResult,
} from '@tabtin/agent-runtime/permissions'

export interface ApprovalActionDescriptor {
  actionType: string
  detail: string
  reason?: string
  isStrict?: boolean
  timeoutMs?: number
}

export interface ApprovalGateResult {
  approved: boolean
  scope?: 'once' | 'thread' | 'always'
}

export interface ApprovalGateMemoPort {
  isApproved(
    sessionId: string,
    actionType: string,
    detail: string | undefined,
    isStrict: boolean,
  ): boolean
  record(
    sessionId: string,
    actionType: string,
    scope: string | undefined,
    approved: boolean,
    detail: string | undefined,
  ): void
}

export interface ApprovalGateDeps {
  ask(
    context: HumanInteractionContext,
    request: PlatformApprovalRequest,
  ): Promise<PlatformApprovalResult>
  memo: ApprovalGateMemoPort
  /** threadId（可含 chat-session- 前缀）→ session UUID；无效时返回空串 */
  toSessionId(threadId: string): string
}

/** threadId → session UUID（与 AgentHost.requestPlatformApproval 同口径）。 */
export function approvalGateSessionId(threadId: string): string {
  const trimmed = threadId.trim()
  if (!trimmed) return ''
  const raw = trimmed.startsWith('chat-session-')
    ? trimmed.slice('chat-session-'.length)
    : trimmed
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : ''
}

export class ApprovalGate {
  constructor(private readonly deps: ApprovalGateDeps) {}

  async request(
    context: HumanInteractionContext,
    descriptor: ApprovalActionDescriptor,
  ): Promise<ApprovalGateResult> {
    const sessionId = this.deps.toSessionId(context.threadId)
    const isStrict = descriptor.isStrict === true

    if (
      sessionId
      && this.deps.memo.isApproved(
        sessionId,
        descriptor.actionType,
        descriptor.detail,
        isStrict,
      )
    ) {
      // memo 命中：bridge 不区分 thread/always 的回报口径，与历史 hooks 一致用 always
      return { approved: true, scope: 'always' }
    }

    const result = await this.deps.ask(context, {
      actionType: descriptor.actionType,
      detail: descriptor.detail,
      reason: descriptor.reason,
      timeoutMs: descriptor.timeoutMs,
      isStrict,
    })

    if (!isStrict && sessionId) {
      this.deps.memo.record(
        sessionId,
        descriptor.actionType,
        result.scope,
        result.approved,
        descriptor.detail,
      )
    }

    return { approved: result.approved, scope: result.scope }
  }
}

export function createApprovalGate(options: {
  ask: ApprovalGateDeps['ask']
  memo: ApprovalGateMemoPort
  toSessionId?: (threadId: string) => string
}): ApprovalGate {
  return new ApprovalGate({
    ask: options.ask,
    memo: options.memo,
    toSessionId: options.toSessionId ?? approvalGateSessionId,
  })
}
