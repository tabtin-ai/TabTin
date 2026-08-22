/**
 * ：本地产物用系统默认应用打开（Space 预览不支持时的降级）。
 * 与 RichFile「System app」同款：resolve working_dir 内绝对路径 → openPath。
 */

import { parseResourcePointer } from '@tabtin/resource-router'
import { resolveLocalFilePath } from '@/services/localFileResourceResolver'
import { resolveSpaceIdForResourceLink } from '@/services/openResourceLink'
import { useSpaceStore } from '@/stores/useSpaceStore'

export type OpenLocalArtifactSystemResult =
  | { ok: true; absolutePath: string }
  | { ok: false; error: string }

function resolveAgentWorkingDir(
  tabScopeKey?: string | null,
  executionSpaceId?: string | null,
): string | null {
  const state = useSpaceStore.getState()
  const spaceId = resolveSpaceIdForResourceLink(tabScopeKey, executionSpaceId)
  const space = state.spaces.find(s => s.id === spaceId)
    ?? (state.selectedSpace?.id === spaceId ? state.selectedSpace : null)
  const agentId = space?.execution_agent_id ?? space?.agent_id ?? null
  const agent = agentId
    ? (state.agentCache[agentId] ?? (state.selectedAgent?.id === agentId ? state.selectedAgent : null))
    : null
  return space?.working_dir || agent?.working_dir || null
}

export async function openLocalArtifactWithSystemApp(
  href: string,
  tabScopeKey?: string | null,
  executionSpaceId?: string | null,
): Promise<OpenLocalArtifactSystemResult> {
  try {
    const pointer = parseResourcePointer(href)
    const workingDir = resolveAgentWorkingDir(tabScopeKey, executionSpaceId)
    const resolved = await resolveLocalFilePath({
      pointer,
      workingDir,
      pathExists: async (absolutePath) => {
        const pathExists = window.tabtin?.fileSystem?.pathExists
        if (!pathExists) throw new Error('当前环境不支持本地文件检查')
        return pathExists(absolutePath)
      },
    })
    const absolutePath = resolved?.absolutePath
    if (!absolutePath) {
      return { ok: false, error: '文件已删除或不可用' }
    }
    const openPath = window.tabtin?.openPath
    if (!openPath) {
      return { ok: false, error: '当前环境不支持用系统应用打开' }
    }
    const result = await openPath(absolutePath)
    if (!result?.success) {
      return { ok: false, error: result?.error || '用系统默认应用打开失败' }
    }
    return { ok: true, absolutePath }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
