/**
 * 目录自带 Skill 收集。
 *
 * 工作区目录 Skill：只要有 `working_dir` 即可发现；对话与自动化共用。
 * 发现范围归工作区；是否注入仍由 Agent 携带集控制。
 * 发现 IPC / 斜杠菜单 / 注入共用 {@link scanWorkspaceForSurface}（路径须在 home 下）。
 */

import { homedir } from 'node:os'
import type { LocalSkill } from '@tabtin/agent-runtime/skills'
import {
  getCachedWorkspaceSkills,
  isWorkspaceRootAllowed,
  scanWorkspaceSkillsGuarded,
  type WorkspaceScanResult,
} from '@tabtin/agent-host/skills'

function allowedScanRoots(): string[] {
  return [homedir()]
}

/** 发现 IPC / 注入共用；越界 → null。 */
export async function scanWorkspaceForSurface(
  workspaceRoot: string,
  options?: { force?: boolean; onWarn?: (msg: string) => void },
): Promise<WorkspaceScanResult | null> {
  return scanWorkspaceSkillsGuarded(workspaceRoot, {
    allowedRoots: allowedScanRoots(),
    force: options?.force,
    onWarn: options?.onWarn,
  })
}

export interface CollectWorkspaceSkillsParams {
  workspaceRoot: string | undefined
  onWarn?: (msg: string) => void
}

/** fetchSkills：扫 working_dir 目录 Skill；Agent 门控由合并后的 enablement 统一处理。 */
export async function collectWorkspaceSkillsForSession(
  params: CollectWorkspaceSkillsParams,
): Promise<LocalSkill[]> {
  const { workspaceRoot, onWarn } = params
  if (!workspaceRoot) return []
  try {
    const result = await scanWorkspaceForSurface(workspaceRoot, { onWarn })
    return result?.skills ?? []
  } catch (err) {
    onWarn?.(`目录自带 skill 扫描失败：${(err as Error).message}`)
    return []
  }
}

/** skills_read / skills_search / skill_invoke：读扫描缓存，口径同 collect。 */
export function getWorkspaceSkillsForTools(
  workspaceRoot: string | undefined,
): LocalSkill[] {
  if (!workspaceRoot) return []
  if (!isWorkspaceRootAllowed(workspaceRoot, allowedScanRoots())) return []
  return getCachedWorkspaceSkills(workspaceRoot)
}
