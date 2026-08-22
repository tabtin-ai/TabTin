/**
 * HITL review 提示文案构造（从 useChatStore 抽出，供组合根与 bootstrap 端口共用）。
 * 纯函数：只依赖入参 + i18n 文案，不触碰 store。
 */
import type { ReviewRequiredEventData } from '@tabtin/chat-client'
import i18n from '@/i18n'

export function buildReviewMessage(data: ReviewRequiredEventData): string {
  const lines: string[] = []
  lines.push(i18n.t('chat:reviewPrompt.title'))

  if (data.message) {
    lines.push(data.message)
  }

  data.action_requests?.forEach((action, index) => {
    const toolName = action.tool_name || action.name || 'unknown'
    const title =
      action.description || i18n.t('chat:reviewPrompt.toolCall', { name: toolName })
    lines.push(`${index + 1}. ${title}`)
  })

  lines.push(i18n.t('chat:reviewPrompt.actionChoice'))
  return lines.join('\n')
}
