/**
 * 目录自带 Skill：无 Trust / unattended 闸；对所有 Agent 生效。
 * 本文件只断言路径边界与空根。
 */

import { describe, expect, it } from 'vitest'
import {
  collectWorkspaceSkillsForSession,
  getWorkspaceSkillsForTools,
  scanWorkspaceForSurface,
} from '../workspace-skills-context'

/** 不在用户 home 下，用于路径边界行为断言。 */
const OUT_OF_HOME_ROOT = '/var/empty-tabtin-workspace-skills-out-of-scope'

describe('目录 Skill 收集（路径边界）', () => {
  it('无 working_dir → 空', async () => {
    await expect(
      collectWorkspaceSkillsForSession({ workspaceRoot: undefined }),
    ).resolves.toEqual([])
    expect(getWorkspaceSkillsForTools(undefined)).toEqual([])
  })

  it('根越界 → scan null；collect / tools 为空', async () => {
    await expect(scanWorkspaceForSurface(OUT_OF_HOME_ROOT)).resolves.toBeNull()
    await expect(
      collectWorkspaceSkillsForSession({ workspaceRoot: OUT_OF_HOME_ROOT }),
    ).resolves.toEqual([])
    expect(getWorkspaceSkillsForTools(OUT_OF_HOME_ROOT)).toEqual([])
  })
})
