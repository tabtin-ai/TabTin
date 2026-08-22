import { useSpaceStore } from '@stores/useSpaceStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('WorkspacePaths')

/**
 * 读取指定 spaceId 的执行根 working_dir。
 *
 *  / ：执行根挂在 Workspace 上，不再从 Agent / resolveEffectiveSpaceAgentId 推导。
 */
async function readAgentWorkingDirForSpace(spaceId: string): Promise<string> {
  const state = useSpaceStore.getState()
  const sp = state.spaces.find((s) => s.id === spaceId)
  if (!sp || sp.type !== 'workspace') return ''
  return sp.working_dir ?? ''
}

/**
 * 推送指定 spaceId 当前 working_dir 到 main 端。
 *
 * caller 应在 store mutation **之后**调用——zustand `set` 是同步的，
 * `getState()` 拿到的就是新值。
 */
export async function notifyWorkspacePathsForSpace(spaceId: string): Promise<void> {
  if (!spaceId) {
    log.warn('notifyWorkspacePathsForSpace 缺 spaceId，跳过推送')
    return
  }
  const workingDir = await readAgentWorkingDirForSpace(spaceId)
  try {
    await window.tabtin?.workspace?.notifyPathsChanged({
      spaceId,
      workingDir,
    })
    log.debug('workspace paths pushed:', { spaceId, hasWorkingDir: Boolean(workingDir) })
  } catch (err) {
    log.warn('notifyPathsChanged 推送失败:', err)
  }
}
