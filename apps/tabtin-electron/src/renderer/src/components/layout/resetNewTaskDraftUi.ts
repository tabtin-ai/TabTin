import { useCanvasLayoutStore } from '@stores/useCanvasLayoutStore'
import { useContextInjectionStore } from '@stores/useContextInjectionStore'
import { usePendingComposerAttachmentsStore } from '@stores/usePendingComposerAttachmentsStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useWorkbenchSurfaceStore } from '@stores/useWorkbenchSurfaceStore'
import { getDraftComposerPresetScopeId } from '@components/chat/composer-presets/scope'
import {
  clearComposerDraftExternally,
  resolveDraftKey,
} from '@components/chat/composer/chatInputDraft'

/**
 * 打开「新任务」草稿前清空该工作空间草稿 scope 的标签 / 画布 / 任务视图 /
 * composer 引用与待领取附件，并回到虚拟 home surface。
 *
 * 「新任务」语义 = 干净初始态：上一轮草稿 episode 未发送就被放弃时，
 * 挂在 `__draft__:{spaceId}` 的引用 chip / pending 截图附件是 store 态、
 * 会跨 episode 存活（ 二轮验收：新注释把上一轮注释一起带上；#6998 选区同理）——
 * 必须随标签/画布一起清，否则新任务「继承」旧引用。
 *
 * @param spaceId 执行工作空间 / Project conversation space id（不是 conversation:draft: 前缀）
 */
export function resetNewTaskDraftUi(spaceId: string): void {
  const scopeKey = `conversation:draft:${spaceId}`
  const inputDraftKey = resolveDraftKey(null, spaceId)
  if (inputDraftKey) clearComposerDraftExternally(inputDraftKey)
  useSpaceContextTabsStore.getState().clearSpaceTabs(scopeKey)
  useCanvasLayoutStore.getState().clearSpaceLayout(scopeKey)
  useSpaceViewPrefsStore.getState().clearTaskViewModeForScope(scopeKey)
  const draftComposerScopeId = getDraftComposerPresetScopeId(spaceId)
  useContextInjectionStore.getState().clearScope(draftComposerScopeId)
  usePendingComposerAttachmentsStore.getState().clearScope(draftComposerScopeId)
  // 清 tabs 还不够：restore coordinator 会按最后 surface=real_tab 把旧应用首页重新挂回。
  // 新任务必须显式回到虚拟 home surface，才能稳定保持原型的单焦点初始态。
  useWorkbenchSurfaceStore.getState().setLastActiveSurface(scopeKey, 'desktop')
}
