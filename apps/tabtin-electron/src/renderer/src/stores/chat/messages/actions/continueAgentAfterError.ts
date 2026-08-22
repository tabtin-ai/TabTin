/**
 * 错误卡「重试」：同一会话再开一轮隐藏 turn，让 Agent 接着答。
 * 不回退、不重发用户原话。引擎仍收到续跑提示；用户时间线不展示。
 */

import { useChatStore } from '../../useChatStore'

export const CONTINUATION_TRIGGERED_BY = 'continuation' as const

export const ERROR_RETRY_CONTINUE_PROMPT =
  '上一轮回复失败了。请直接根据已有对话继续完成回复，不要让用户重复刚才的问题。'

export function continueAgentAfterError(sessionId: string) {
  return useChatStore.getState().sendMessage(
    ERROR_RETRY_CONTINUE_PROMPT,
    true,
    undefined,
    undefined,
    sessionId,
    {
      triggeredBy: CONTINUATION_TRIGGERED_BY,
      // 对用户可见面留空：侧栏预览、排队标题、失败回填都不露出续跑提示。
      displayMessage: '',
    },
  )
}
