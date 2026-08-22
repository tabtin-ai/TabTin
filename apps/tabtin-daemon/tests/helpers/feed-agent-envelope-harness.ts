/**
 * 测试 harness：模拟 DaemonAgentHost.feedAgentEnvelope + AgentHost command 分发。
 * 真实路径经 DaemonAgentTransport → AgentRealtime → commands.*；单测不拉起完整 Host。
 */
import {
  PromptCancelPayloadSchema,
  SubagentCancelPayloadSchema,
} from '@tabtin/agent-wire'
import { extractAbortIdentityCandidates } from '@tabtin/agent-host/conversation'

export interface FeedHarnessHost {
  handleAbort?: (id: string) => { success: boolean }
  cancelSubagentById?: (childId: string) => boolean
  routeForward?: (envelope: Record<string, unknown>) => unknown
}

export interface FeedHarnessLogger {
  info: (message: string) => void
  warn: (message: string) => void
}

export function createFeedAgentEnvelope(
  host: FeedHarnessHost,
  logger: FeedHarnessLogger,
) {
  return (envelope: Record<string, unknown>) => {
    if (envelope.type === 'agent.prompt.forward') {
      return host.routeForward?.(envelope)
    }

    if (envelope.type === 'agent.prompt.cancel') {
      const parsed = PromptCancelPayloadSchema.safeParse(envelope.payload ?? {})
      if (!parsed.success) {
        logger.warn(`[Daemon] Invalid prompt.cancel payload: ${parsed.error.message}`)
        return
      }
      const candidates = extractAbortIdentityCandidates(envelope)
      if (candidates.length === 0) {
        logger.warn('[Daemon] prompt.cancel without task_id or thread_id — ignored')
        return
      }
      for (const id of candidates) {
        const result = host.handleAbort?.(id)
        if (result?.success) {
          logger.info(`[Daemon] prompt.cancel routed to local runtime: id=${id.slice(0, 16)}`)
          return
        }
      }
      logger.warn(
        `[Daemon] prompt.cancel failed: candidates=${candidates.map((c) => c.slice(0, 16)).join(', ')}`,
      )
      return
    }

    if (envelope.type === 'agent.subagent.cancel') {
      const parsed = SubagentCancelPayloadSchema.safeParse(envelope.payload ?? {})
      if (!parsed.success) {
        logger.warn(`[Daemon] Invalid subagent.cancel payload: ${parsed.error.message}`)
        return
      }
      const childId = parsed.data.child_id
      const ok = host.cancelSubagentById?.(childId) ?? false
      if (ok) {
        logger.info(`[Daemon] subagent.cancel routed to local runtime: child=${childId.slice(0, 8)}`)
      } else {
        logger.warn(
          `[Daemon] subagent.cancel not matched (already done / wrong process): child=${childId.slice(0, 8)}`,
        )
      }
    }
  }
}
