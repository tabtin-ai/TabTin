/**
 * ：把子 run 交付物 enrich 进父 agent tool_result / 完成事件 / 后台通知。
 *
 * 实现挂在 host；runtime 只发纯 summary 的 SUBAGENT_COMPLETED。
 */

import type { EnqueueSubagentCompletion, SubagentCompletionInfo } from '@tabtin/agent-runtime'
import type { SessionConfig } from '@tabtin/agent-runtime/engine'
import {
  appendDeliverablesToToolResultContent,
  collectChildDeliverables,
  type ChildDeliverable,
} from './child-deliverables.js'

export interface ChildDeliverablesEnricherDeps {
  sessionConfig: SessionConfig
  /** 与 host SessionStorage 同实例的 block 缓冲 flush */
  flushParentMessageBlocks?: () => Promise<void>
}

export async function collectDeliverablesForChild(
  deps: ChildDeliverablesEnricherDeps,
  childId: string,
): Promise<ChildDeliverable[]> {
  try {
    return await collectChildDeliverables(deps.sessionConfig, childId, {
      flushParentMessageBlocks: deps.flushParentMessageBlocks,
    })
  } catch {
    return []
  }
}

function readOpaqueDeliverables(info: SubagentCompletionInfo): ChildDeliverable[] {
  const raw = info.deliverables
  if (!Array.isArray(raw) || raw.length === 0) return []
  return raw as ChildDeliverable[]
}

/** wait_agent_ids 汇总行：在默认 summary 行后追加交付物 tag。 */
export function formatSettledChildCompletionLineWithDeliverables(
  info: SubagentCompletionInfo,
): string {
  const summary = info.summary.trim() || '（无结果摘要）'
  const base = `- ${info.label}（${info.status}）：${summary}`
  const deliverables = readOpaqueDeliverables(info)
  if (deliverables.length === 0) return base
  return appendDeliverablesToToolResultContent(base, deliverables)
}

/**
 * 包装 SubagentManager 完成回调：先 collect 交付物再 enqueue。
 * collect/flush 失败仍 enqueue 原始 info，避免后台完成通知丢失。
 */
export function wrapEnqueueSubagentCompletionWithDeliverables(
  originalEnqueue: EnqueueSubagentCompletion,
  deps: ChildDeliverablesEnricherDeps,
): EnqueueSubagentCompletion {
  return (info) => {
    void (async () => {
      const deliverables = await collectDeliverablesForChild(deps, info.subagent_run_id)
      originalEnqueue({
        ...info,
        ...(deliverables.length > 0 ? { deliverables } : {}),
      })
    })()
    return true
  }
}
