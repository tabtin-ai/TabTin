/**
 * requestAgentForSlide — 在 Slide 编辑器内"让 Agent 帮忙"的统一入口
 *
 * 触发场景：用户在 SlideEditorHost 工具栏点 "让 Agent 帮忙"按钮。
 *
 * 行为：
 *   1. 展开右侧 ChatSidePanel（如果折叠）——preset 卡片出现在副驾栏输入框上方，
 *      用户停留在 Slide 编辑器内（律 1「唤起不流放」，principle/workspace-project.md
 *      §7.2，；历史版本的 setActiveKey(spaceId, null) 已移除，理由见
 *      requestAgentForTable 文件头）
 *   2. 标记当前 space 为 draft 状态（首次发送才创建真 sessionId）
 *   3. 用 draft scope 注入 tabslide.createSlide preset 到 ChatInput 上方，
 *      并把当前 slide 的上下文塞进 triggerContext，让 Agent 知道是从哪一份 slide 触发的
 *   4. 如已有 preset 在输入框上方，弹 toast 提示用户原表单已被覆盖
 *
 * 设计原则：
 * - 入口劫持是反模式 — 用户从 "+ 新建 Slide" 应该直接进编辑器；这里只是
 *   编辑过程中的"AI 增强"按钮，不是必经之路
 * - 把 store / UI 操作集中在一个 helper 里，避免业务组件各自 import 多个 store
 */

import { toast } from '@tabtin/smartsheet-ui'
import i18n from '@/i18n'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useUIStore } from '@/stores/useUIStore'
import { useComposerPresetStore } from '@/stores/useComposerPresetStore'
import { getDraftComposerPresetScopeId } from '@/components/chat/composer-presets/scope'
import type { PresetTriggerContext } from '@/components/chat/composer-presets/registry/types'

export interface RequestAgentForSlideOptions {
  /** 当前 slide 的 server id；新建未保存时为 `new-XXX` 临时 ID */
  slideId?: string
  /** 当前 slide 的标题 */
  slideTitle?: string
  /** 触发来源标签（如 'editor_toolbar' / 'empty_state'），便于 Agent / 后端区分场景 */
  source?: string
  /** 透传到 preset 的初始字段值（编辑器侧可预填 topic 等） */
  initialState?: Record<string, unknown>
}

export function requestAgentForSlide(
  spaceId: string,
  options: RequestAgentForSlideOptions = {},
): void {
  const { slideId, slideTitle, source = 'editor_toolbar', initialState } = options

  // 1. 展开副驾栏（不切走画布——用户停留在 Slide 编辑器，见文件头「唤起不流放」）
  useUIStore.getState().setChatSidePanelCollapsed(false)

  // 2. 标记 draft session（不立刻创建真 session，等用户点发送）
  useChatStore.getState().startDraftSessionForSpace(spaceId)

  // 3. 注入 preset；triggerContext 透传当前 slide 上下文给 Agent
  const scopeId = getDraftComposerPresetScopeId(spaceId)
  const presetStore = useComposerPresetStore.getState()
  const existing = presetStore.getPresets(scopeId)
  if (existing.length > 0) {
    // 4. 已有 preset 时给用户提示，避免静默覆盖
    toast({
      title: i18n.t('tabslide:requestAgent.replacingPreset.title', {
        defaultValue: '已替换原本的预设表单',
      }),
      description: i18n.t('tabslide:requestAgent.replacingPreset.desc', {
        defaultValue: '上一份未发送的表单内容已被本次"让 Agent 帮忙"覆盖。',
      }),
    })
  }

  const triggerContext: PresetTriggerContext = {
    source,
    ...(slideId ? { current_slide_id: slideId } : {}),
    ...(slideTitle ? { current_slide_title: slideTitle } : {}),
  }

  presetStore.addPreset(scopeId, 'tabslide.createSlide', triggerContext, initialState)
}
