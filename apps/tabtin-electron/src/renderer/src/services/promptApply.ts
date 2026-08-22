/**
 * promptApply — 把 IM 指令卡的 prompt 正文应用到「新任务」草稿态。
 *
 * 复刻 openHandoffTakeOverInNewTask 的「跳新任务 + 预填」骨架但大幅简化：
 * 指令卡自包含正文、没有会话冻结快照，因此**不挂引用附件卡**。调用方先让
 * 用户选择 Workspace，本服务只做显式目标导航 → 写 composer 草稿 → 聚焦。
 *
 * 预填走 localStorage 草稿（setComposerDraftExternally），draftKey 用
 * resolveDraftKey(null, spaceId)——欢迎态 composer 发首条消息前恒读 draft scope
 * （见 newTaskDraftNavigation 注释 /  / ）。
 */

import { toast } from '@tabtin/smartsheet-ui'
import {
  resolveDraftKey,
  setComposerDraftExternally,
} from '@components/chat/composer/chatInputDraft'
import { MAX_MESSAGE_CHARS } from '@components/chat/composer/chatInputConstants'
import { navigateToNewTask } from '@/services/newTaskDraftNavigation'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'

const log = createLogger('PromptApply')

/** 纯函数：按发送上限截断 prompt 正文（供 applyPromptToNewTask 与单测复用）。 */
export function preparePromptDraftText(promptText: string): {
  text: string
  truncated: boolean
} {
  if (promptText.length <= MAX_MESSAGE_CHARS) {
    return { text: promptText, truncated: false }
  }
  return { text: promptText.slice(0, MAX_MESSAGE_CHARS), truncated: true }
}

export type ApplyPromptResult =
  | { ok: true; spaceId: string }
  | { ok: false; reason: string }

/**
 * 指令卡「使用」：进入用户明确选择的 Workspace，并把正文预填进新任务输入框。
 * 关闭 IM 面板由 navigateToNewTask 内部处理（closeIM + setCurrentConversation(null)）。
 */
export function applyPromptToNewTask(
  promptText: string,
  workspaceId: string,
): ApplyPromptResult {
  if (!promptText.trim()) {
    return {
      ok: false,
      reason: i18n.t('tabchat:promptApplyEmpty', { defaultValue: '指令内容为空，无法使用' }),
    }
  }

  if (!workspaceId) {
    return {
      ok: false,
      reason: i18n.t('tabchat:promptApplyNoWorkspace', {
        defaultValue: '找不到可用的个人 Workspace，无法打开新任务',
      }),
    }
  }

  const { text, truncated } = preparePromptDraftText(promptText)

  // 先导航进草稿 episode，再写草稿——与「新任务」按钮 / 交接接管同路径。
  navigateToNewTask(workspaceId, { executionWorkspaceId: workspaceId })

  const draftKey = resolveDraftKey(null, workspaceId)
  if (draftKey) {
    setComposerDraftExternally(draftKey, text)
  }

  if (truncated) {
    toast({
      title: i18n.t('tabchat:promptApplyTruncated', {
        defaultValue: '指令过长，已截断到发送上限',
      }),
    })
  }

  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('[data-chat-input-textarea="true"]')?.focus()
    })
  }

  log.info('prompt applied to new task', {
    spaceId: workspaceId,
    chars: text.length,
    truncated,
  })

  return { ok: true, spaceId: workspaceId }
}
