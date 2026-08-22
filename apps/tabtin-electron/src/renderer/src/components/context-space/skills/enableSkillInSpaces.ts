/**
 * 在多个 Space 上启用同一 Skill（串行，失败不阻断其余）。
 * 返回成功启用的 Space id 列表。
 */
import type { AgentDefinition, SkillIndexEntry } from '@/skills/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('Skills')

export interface EnableSkillInSpacesArgs {
  spaceIds: string[]
  canonicalKey: string
  skill: SkillIndexEntry
  enable: (args: {
    canonicalKey: string
    spaceId: string
    skill?: SkillIndexEntry
    agents?: AgentDefinition[]
  }) => Promise<unknown>
  agents?: AgentDefinition[]
}

export async function enableSkillInSpaces(
  args: EnableSkillInSpacesArgs,
): Promise<{ okSpaceIds: string[]; failedSpaceIds: string[] }> {
  const okSpaceIds: string[] = []
  const failedSpaceIds: string[] = []
  for (const spaceId of args.spaceIds) {
    try {
      await args.enable({
        canonicalKey: args.canonicalKey,
        spaceId,
        skill: args.skill,
        agents: args.agents,
      })
      okSpaceIds.push(spaceId)
    } catch (err) {
      log.warn('批量启用 Skill 失败', { canonicalKey: args.canonicalKey, spaceId }, err)
      failedSpaceIds.push(spaceId)
    }
  }
  return { okSpaceIds, failedSpaceIds }
}
