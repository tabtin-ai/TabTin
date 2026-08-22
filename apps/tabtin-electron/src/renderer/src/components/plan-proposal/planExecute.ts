/**
 * planExecute — plan「执行」的共享逻辑
 *
 * PlanProposalCard 卡片按钮与 TabFiles 里 .plan.md 预览的执行按钮共用同一套语义：
 *   1. 本地标记已执行（keyed by plan_ref，重启保留）；
 *   2. 切 agent 模式；
 *   3. 发一句短指令 + 一张「计划」context 引用卡（type='plan'）到目标会话——
 *      plan 只带指针，Agent 执行前按 ref 重读最新内容。
 */

import type { PlanRef } from '@tabtin/agent-wire'
import { planRefKey } from '@tabtin/agent-wire'
import { useChatStore } from '@/stores/chat/useChatStore'
import { markPlanExecuted } from './planExecutedStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('planExecute')

export async function sendPlanExecution(args: {
  ref: PlanRef
  planName?: string
  sessionId: string
  spaceId: string | null
}): Promise<boolean> {
  const { ref, planName, sessionId, spaceId } = args
  // 切 agent 必须在发送前——否则这条继续消息仍以 plan 模式被处理，Agent 不会真正执行。
  // ：按本 Plan 所属 session 写入，避免与 currentSessionId 不一致时写错 map。
  try {
    useChatStore.getState().setAgentMode('agent', { sessionId })
  } catch (err) {
    log.warn('setAgentMode after plan execute failed', err)
  }
  const planBlock: Record<string, unknown> = {
    type: 'plan',
    plan_ref: ref,
    plan_name: planName || '',
    preview: planName || '',
    ...(ref.kind === 'file' ? { file_path: ref.path } : { doc_id: ref.document_id }),
    ...(spaceId ? { space_id: spaceId } : {}),
  }
  const refWord = ref.kind === 'file' ? 'plan 文件' : 'plan 文档'
  const continuation =
    `请按已批准的 Plan${planName ? `「${planName}」` : ''}开始执行。` +
    `plan 已作为上下文附在本条消息；执行前先读一遍${refWord}确认最新内容再动手。`
  try {
    await useChatStore
      .getState()
      .sendMessage(continuation, true, undefined, [planBlock], sessionId)
    // 仅在发送成功后才标记已执行：发送失败不锁死 executed，用户可重试。
    markPlanExecuted(planRefKey(ref))
    return true
  } catch (err) {
    log.warn('sendMessage after plan execute failed', err)
    return false
  }
}
