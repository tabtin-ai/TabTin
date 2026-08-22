/**
 * resolveSpaceExecutionPath — 解析当前 Space 的执行根路径
 *
 * workspace 类型 Space：只认 Space/Agent 的执行根，缺失时不静默回退 sandbox。
 * 非 workspace：保留 tab meta.path → sandbox 的 legacy fallback。
 */
import { parseSpaceSelectionId } from '@tabtin/app-shell'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useWorkbenchSceneStore, fromWorkbenchSceneId } from '@stores/useWorkbenchSceneStore'
import { useProjectWorkspaceSelectionStore } from '@components/layout/projectWorkspaceSelectionStore'

/**
 * 解析「当前应对齐会话列表 / 全局指针」的 Space id。
 *
 * 优先级：
 * 1. 工作台前台 scene（AppLayout 已同步时的权威值）
 * 2. useSpaceStore.selectedSpace（个人 Workspace 选中）
 * 3. 侧栏 useSpaceListStore 的 workspace / team 选中
 * 4. Project 选中（team_space；activateSelection('team') 会清空 useSpaceStore）
 *
 * dm / im-group 不是 Agent 会话列表上下文，不参与回退。
 */
export function resolveActiveSpaceId(): string | null {
  const foregroundSpaceId = fromWorkbenchSceneId(useWorkbenchSceneStore.getState().foregroundSceneId)
  if (foregroundSpaceId) return foregroundSpaceId

  const selectedSpaceId = useSpaceStore.getState().selectedSpace?.id ?? null
  if (selectedSpaceId) return selectedSpaceId

  const spaceList = useSpaceListStore.getState()
  const selectionId = spaceList.selectedSpaceId
  const selectionKind = spaceList.selectedSpaceKind
  if (selectionId && (selectionKind === 'workspace' || selectionKind === 'team')) {
    const { rawId } = parseSpaceSelectionId(selectionId)
    if (rawId) return rawId
  }

  return useProjectWorkspaceSelectionStore.getState().selectedProjectId ?? null
}

export async function resolveSpaceExecutionPath(): Promise<string | null> {
  try {
    const spaceId = resolveActiveSpaceId()
    if (!spaceId) {
      return null
    }

    const spaceStore = useSpaceStore.getState()
    const sp = spaceStore.spaces.find((s) => s.id === spaceId)

    if (sp?.type === 'workspace') {
      if (sp.working_dir) {
        return sp.working_dir
      }
      const agentId = sp.execution_agent_id ?? sp.agent_id ?? null
      const agent = agentId
        ? (spaceStore.agentCache[agentId] ?? (spaceStore.selectedAgent?.id === agentId ? spaceStore.selectedAgent : null))
        : null
      if (agent?.working_dir) {
        return agent.working_dir
      }
      // ：workspace 缺执行根时明确阻断，不回退 sandbox / tab path
      return null
    }

    try {
      const tabStore = useSpaceContextTabsStore.getState()
      const items = tabStore.itemsBySpace[spaceId] ?? {}
      const activeKey = tabStore.activeKeyBySpace[spaceId]
      const activeItem = activeKey ? items[activeKey] : null
      if (activeItem?.meta?.path && typeof activeItem.meta.path === 'string') {
        return activeItem.meta.path
      }
    } catch {
      // tab store 读取异常，继续兜底到 sandbox
    }

    const ensureSpaceSandbox = window.tabtin?.fileSystem?.ensureSpaceSandbox
    if (!ensureSpaceSandbox) {
      return null
    }
    const result = await ensureSpaceSandbox(spaceId)
    if (result?.path) {
      return result.path
    }
  } catch {
    // 路径解析整体失败——fail-soft 返回 null
  }
  return null
}
