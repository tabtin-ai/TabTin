/**
 * localArtifactActions — 本地产物「打开」相关的会话无关操作（非 React）。
 *
 * 收敛此前散落在 RichFile（create_file 卡）与 openLocalArtifactSystemApp 里的
 * 重复实现（各一份 resolveAgentWorkingDir / 各自的系统应用打开 / reveal /
 * 打开工作目录），让 create_file 卡与「本轮产物」卡走同一套打开语义。
 *
 * React 层的 toast / i18n / 遥控端拦截封装在 useArtifactOpenActions 里。
 */

import { parseResourcePointer } from '@tabtin/resource-router'
import { resolveLocalFilePath } from '@/services/localFileResourceResolver'
import { expandCanvasForScope, resolveSpaceIdForResourceLink } from '@/services/openResourceLink'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useFolderContextStore } from '@components/context-space/folder/useFolderStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import i18n from '@/i18n'

export interface ArtifactWorkingDir {
  spaceId: string
  workingDir: string
}

export type LocalArtifactActionResult =
  | { ok: true }
  | { ok: false; error: string }

/** 解析产物所属 Space 的执行工作目录（供绝对路径解析 / 打开工作目录复用）。 */
export function resolveArtifactWorkingDir(
  tabScopeKey?: string | null,
  executionSpaceId?: string | null,
): ArtifactWorkingDir | null {
  const state = useSpaceStore.getState()
  const spaceId = resolveSpaceIdForResourceLink(tabScopeKey, executionSpaceId)
  const space = state.spaces.find(s => s.id === spaceId)
    ?? (state.selectedSpace?.id === spaceId ? state.selectedSpace : null)
  const agentId = space?.execution_agent_id ?? space?.agent_id ?? null
  const agent = agentId
    ? (state.agentCache[agentId] ?? (state.selectedAgent?.id === agentId ? state.selectedAgent : null))
    : null
  const workingDir = space?.working_dir || agent?.working_dir
  if (!space?.id || !workingDir) return null
  return { spaceId: space.id, workingDir }
}

/** 把产物 href 解析成执行设备上的绝对路径；解析失败 / 文件不存在返回 null。 */
export async function resolveLocalArtifactAbsolutePath(
  href: string,
  tabScopeKey?: string | null,
  executionSpaceId?: string | null,
): Promise<string | null> {
  try {
    const pointer = parseResourcePointer(href)
    const resolved = await resolveLocalFilePath({
      pointer,
      workingDir: resolveArtifactWorkingDir(tabScopeKey, executionSpaceId)?.workingDir ?? null,
      pathExists: async (absolutePath) => {
        const pathExists = window.tabtin?.fileSystem?.pathExists
        if (!pathExists) throw new Error('当前环境不支持本地文件检查')
        return pathExists(absolutePath)
      },
    })
    return resolved?.absolutePath ?? null
  } catch {
    return null
  }
}

/** 在系统文件管理器中定位产物（Reveal in Finder）。 */
export async function revealArtifactInFinder(
  href: string,
  tabScopeKey?: string | null,
  executionSpaceId?: string | null,
): Promise<LocalArtifactActionResult> {
  const absolutePath = await resolveLocalArtifactAbsolutePath(href, tabScopeKey, executionSpaceId)
  if (!absolutePath) return { ok: false, error: '文件已删除或不可用' }
  const showItemInFolder = window.tabtin?.showItemInFolder
  const openPath = window.tabtin?.openPath
  try {
    const result = showItemInFolder
      ? await showItemInFolder(absolutePath)
      : await openPath?.(absolutePath)
    if (!result?.success) throw new Error(result?.error || 'unknown')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 在 Space 内打开产物所属工作目录，并定位到该文件。 */
export function openArtifactWorkspaceDir(
  href: string,
  tabScopeKey?: string | null,
  executionSpaceId?: string | null,
): void {
  const resolved = resolveArtifactWorkingDir(tabScopeKey, executionSpaceId)
  if (!resolved) return
  void resolveLocalArtifactAbsolutePath(href, tabScopeKey, executionSpaceId).then((absolutePath) => {
    const title = i18n.t('context:folder.labels.agentTitle', { defaultValue: '工作空间' })
    const folder = useFolderContextStore.getState().addSpaceFolder(resolved.spaceId, {
      rootPath: resolved.workingDir,
      kind: 'sandbox',
      title,
    })
    const scopeKey = tabScopeKey ?? resolveForegroundTabScopeKey(resolved.spaceId)
    useSpaceContextTabsStore.getState().openResourceTab(scopeKey, {
      type: 'tabfolder',
      id: folder.folderId,
      title,
      meta: {
        path: resolved.workingDir,
        kind: 'sandbox',
        ...(absolutePath ? { reveal_path: absolutePath } : {}),
      },
    })
    expandCanvasForScope(scopeKey)
  })
}
