import { toast } from '@components/ui'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { openResourceTabGuarded } from '@/components/context-space/restore/openResourceMembershipGuard'
import { ensureSpaceSelectedWithFeedback } from '@/services/spaceNavigation'
import { getProjectExecutionSpaceId } from '@/utils/projectExecutionTarget'

export interface OpenTeamSpaceTabdocParams {
  teamSpaceId: string
  documentId: string
  title?: string
  organizationId?: string | null
}

/**
 * 在当前用户的 Project 工作空间工作台打开 Project 内的 TabDoc。
 *
 * Project 本身不是 workspace，无法直接承载 tab；文档 API 仍按 teamSpaceId
 * 鉴权，因此 tab 落在 Project 工作空间，meta.spaceId 指向 Project。
 */
export async function openTeamSpaceTabdoc(params: OpenTeamSpaceTabdocParams): Promise<boolean> {
  const { teamSpaceId, documentId, title, organizationId } = params
  if (!teamSpaceId || !documentId) return false

  const spaces = useSpaceStore.getState().spaces
  const teamSpace = spaces.find(space => space.id === teamSpaceId)
  const executionSpaceId = getProjectExecutionSpaceId(teamSpace, spaces)
  const resolvedOrganizationId = organizationId ?? teamSpace?.organization_id ?? undefined

  if (!executionSpaceId) {
    toast({ title: '这个Project 还没有执行入口，暂时无法打开文档' })
    return false
  }

  useSettingsSpaceStore.getState().closeSettings()
  useMainNavStore.getState().setCurrentTab('agent')

  const ok = await ensureSpaceSelectedWithFeedback(executionSpaceId, {
    organizationId: resolvedOrganizationId,
    failureToast: {
      title: '无法打开文档',
      description: '执行 Space 暂不可见，或你没有访问权限',
      variant: 'destructive',
    },
  })
  if (!ok) return false

  // 标签桶已 scope 化：桶键走前台 scope key；meta.spaceId 仍指向
  // Project（teamSpaceId），文档 API 鉴权语义不变。
  // ：打开路径打 membership pending，避免 restore 索引滞后打回其它 App
  openResourceTabGuarded(
    resolveForegroundTabScopeKey(executionSpaceId),
    {
      type: 'tabdoc',
      id: documentId,
      title: title ?? '',
      meta: {
        spaceId: teamSpaceId,
        organizationId: resolvedOrganizationId,
      },
    },
    executionSpaceId,
  )
  return true
}
