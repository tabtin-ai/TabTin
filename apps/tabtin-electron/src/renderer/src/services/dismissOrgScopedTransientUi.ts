/**
 * 切组织时的前台瞬时 UI + org 作用域 App 面板 teardown。
 *
 * 产品假设（切组织 ≈ 换租户前台）：
 * - 主动退出 App 全屏页（协作/技能等）并清空 Project 沉浸 / 任务焦点
 * - 剔除旧 org 的资源/文件夹桶，并对新 org `loadSpaces`（可能与既有批量加载重叠，可接受）
 * - 关 Dialog/Sheet/搜索、清 scene、广播手搓浮层自关
 * - ：清前台全局会话选中（`currentSessionId`），避免侧栏已换组织、正文仍挂旧会话
 * - Wave 3：不清登录、不清跨 org 的 chat/IM 缓存桶与 per-Space 会话记忆
 */

import { useProjectWorkspaceSelectionStore } from '@components/layout/projectWorkspaceSelectionStore'
import { useSharedSessionPreviewStore } from '@components/chat/shared-view/preview'
import { useAgentSettingsSheetStore } from '@stores/useAgentSettingsSheetStore'
import { useAppCollaborationStore } from '@stores/useAppCollaborationStore'
import { useAppPageStore } from '@stores/useAppPageStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { useCollections } from '@stores/useCollections'
import { useCreateSiteDialog } from '@stores/useCreateSiteDialog'
import { useSpaceAgentDialogStore } from '@stores/useSpaceAgentDialogStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useUIStore } from '@stores/useUIStore'
import { useUnifiedResources } from '@stores/useUnifiedResources'
import { useWorkbenchSceneStore } from '@stores/useWorkbenchSceneStore'

export const ORG_CONTEXT_RESET_EVENT = 'tabtin:organization-context-reset'

export type OrganizationContextResetDetail = {
  organizationId: string | null
  previousOrganizationId: string | null
}

export function dismissOrgScopedTransientUi(input: {
  organizationId: string | null
  previousOrganizationId: string | null
}): void {
  useSpaceAgentDialogStore.getState().close()
  useAgentSettingsSheetStore.getState().close()
  useSharedSessionPreviewStore.getState().close()
  // 协作弹窗持有 A 组织 sourceItem/contextBlocks；不关会按 B 的工作空间提交（跨组织泄漏）。
  useAppCollaborationStore.getState().close()
  useUIStore.getState().setGlobalSearchOpen(false)
  useUIStore.setState({ appFocusChatOverlayOpenByScopeKey: {} })

  if (useCreateSiteDialog.getState().isOpen) {
    useCreateSiteDialog.getState().close(null)
  }

  // ：退出协作/Project 沉浸与任务焦点，避免新组织仍挂旧 projectId / App 页。
  useAppPageStore.getState().closeAppPage()
  useProjectWorkspaceSelectionStore.getState().resetForOrganizationSwitch()

  // ：切组织必须同步清前台会话选中。只清全局指针，保留 per-Space 记忆与消息桶
  // （切回原组织仍可 restore）；否则侧栏已是新组织列表无高亮，正文仍读旧 session。
  useChatStore.getState().clearForegroundSessionSelection()

  if (input.previousOrganizationId) {
    useUnifiedResources.getState().clearOrganizationBuckets(input.previousOrganizationId)
    useCollections.getState().clearOrganization(input.previousOrganizationId)
  }

  if (input.organizationId) {
    void useSpaceStore.getState().loadSpaces(input.organizationId)
  }

  useWorkbenchSceneStore.getState().clearAllScenes()

  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<OrganizationContextResetDetail>(ORG_CONTEXT_RESET_EVENT, {
      detail: {
        organizationId: input.organizationId,
        previousOrganizationId: input.previousOrganizationId,
      },
    }),
  )
}
