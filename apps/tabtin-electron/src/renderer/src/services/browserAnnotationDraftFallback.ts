/**
 * browserAnnotationDraftFallback — 工作台浏览器注释/截图「无对话可注入」兜底
 *
 * 场景：用户从工作台全屏打开浏览器（desktop scope，无对话 composer），点「网页注释」
 * 或「截图」。emitBrowserAnnotationInject 无人消费时走本兜底：
 *   1. 自动进入「新任务」草稿态（与侧栏新任务一致，不建空 session）
 *   2. 注释引用与截图附件都落草稿 composer scope（`__draft__:{spaceId}`）
 *   3. 在草稿对话 scope 按同 URL 重开当前页面（分屏渲染；draft→session 的
 *      标签收养走首发发送路径 useChatCallbacks.ensureScopeInitializedFromLegacy，
 *      禁止依赖 AppLayout 在「进入任意会话」时从 draft 拷贝，见 ）
 *
 * ⚠️ 不要在 session prefetch 落地时把引用/附件迁到 session scope（live 验证抓过雷）：
 * 欢迎态 composer 的 scope 按**全局** currentSessionId 解析（发第一条消息前始终
 * 为 null → `__draft__:{spaceId}`）；prefetch 只写 per-space 指针、不动全局指针。
 * 提前迁移 = 从 composer 正在读的 scope 里把引用抽走，chip 当场消失。
 * 引用在发送第一条消息时由 composer 自己收进 contextBlocks，无需迁移。
 *
 * 分屏打开失败不回滚：引用是核心交付，分屏是辅助。
 */

import { useContextInjectionStore } from '@stores/useContextInjectionStore'
import { usePendingComposerAttachmentsStore } from '@stores/usePendingComposerAttachmentsStore'
import { getDraftComposerPresetScopeId } from '@components/chat/composer-presets/scope'
import { revokeAttachmentPreview, type ChatAttachment, type ContextRef } from '@components/chat/types'
import {
  navigateToNewTask,
  resolvePersonalNewTaskSpaceId,
} from '@/services/newTaskDraftNavigation'
import { openWebTabInSpace } from '@/services/openWebTabInSpace'
import { createLogger } from '@/utils/logger'

const log = createLogger('BrowserAnnotationDraftFallback')

export interface BrowserAnnotationDraftFallbackInput {
  contextRef: ContextRef
  attachment?: ChatAttachment
  /** 注释来源页面，用于在新任务分屏里按同 URL 重开 */
  sourceUrl: string
  sourceTitle?: string
}

/**
 * 自动创建新任务草稿并携带注释引用。
 *
 * @returns true = 已进入新任务草稿且引用注入成功（分屏失败不影响返回值）；
 *          false = 找不到可用个人工作空间，未做任何导航。
 */
export function fallbackBrowserAnnotationToDraft(
  input: BrowserAnnotationDraftFallbackInput,
): boolean {
  const spaceId = resolvePersonalNewTaskSpaceId()
  if (!spaceId) {
    log.error('no personal workspace available for annotation fallback', {
      url: input.sourceUrl,
    })
    if (input.attachment) revokeAttachmentPreview(input.attachment)
    return false
  }

  navigateToNewTask(spaceId)

  const draftScopeId = getDraftComposerPresetScopeId(spaceId)
  const injection = useContextInjectionStore.getState()
  injection.addRefToScope(draftScopeId, input.contextRef)
  injection.setActiveScope(draftScopeId)

  if (input.attachment) {
    // 草稿 composer 挂载后由 useChatInputPendingAttachmentClaim 响应式领取
    usePendingComposerAttachmentsStore.getState().enqueue(draftScopeId, input.attachment)
  }

  void openWebTabInSpace(spaceId, input.sourceUrl, {
    title: input.sourceTitle,
    tabScopeKey: `conversation:draft:${spaceId}`,
  }).then(result => {
    if (!result.ok) {
      // 分屏是辅助交付：失败只记日志，引用已在草稿 composer 里
      log.warn('open split browser tab failed after fallback', {
        spaceId,
        url: input.sourceUrl,
        error: result.error,
      })
    }
  })

  log.info('annotation routed to new task draft', {
    spaceId,
    url: input.sourceUrl,
    hasAttachment: Boolean(input.attachment),
  })
  return true
}
