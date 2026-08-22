import {
  SkillEnablementMapCache,
  isSkillEnabledByMap,
  mergeSkillListsForRuntime,
  mergeWorkspaceSkillsForRuntime,
  type LocalSkill,
} from '@tabtin/agent-runtime/skills'

export type SkillEnablementFetchMap = (
  agentId: string,
) => Promise<Record<string, boolean>>

export interface SkillAvailabilityCatalog {
  /** false 表示 Registry 尚未就绪；已知条目可用，但未知 key 不能判为不存在。 */
  readonly authoritative?: boolean
  readonly registrySkills: readonly LocalSkill[]
  readonly personalPluginSkills?: readonly LocalSkill[]
  readonly workspaceSkills?: readonly LocalSkill[]
}

export type SkillAvailabilityResolution =
  | { status: 'available'; skill: LocalSkill }
  | { status: 'disabled'; skill: LocalSkill }
  | { status: 'not_ready'; retryable: true }
  | { status: 'not_installed' }
  | { status: 'not_found' }

export interface SkillAvailabilitySnapshot {
  readonly agentId: string
  readonly enabledMap: Readonly<Record<string, boolean>> | undefined
  readonly catalogAuthoritative: boolean
  readonly availableSkills: readonly LocalSkill[]
  resolve(canonicalKey: string): SkillAvailabilityResolution
}

export interface SkillRunSnapshotOptions {
  force?: boolean
  catalog?: SkillAvailabilityCatalog
}

const EMPTY_SKILLS: readonly LocalSkill[] = Object.freeze([])

function freezeSkill(skill: LocalSkill): LocalSkill {
  return Object.freeze({ ...skill })
}

function createSnapshot(
  agentId: string,
  enabledMap: Readonly<Record<string, boolean>> | undefined,
  catalog?: SkillAvailabilityCatalog,
): SkillAvailabilitySnapshot {
  const registrySkills = [...(catalog?.registrySkills ?? EMPTY_SKILLS)]
  const personalPluginSkills = [...(catalog?.personalPluginSkills ?? EMPTY_SKILLS)]
  const workspaceSkills = [...(catalog?.workspaceSkills ?? EMPTY_SKILLS)]
  const catalogAuthoritative = catalog?.authoritative ?? Boolean(catalog)
  const merged = mergeSkillListsForRuntime(registrySkills, personalPluginSkills)
  const contextualSkills = mergeWorkspaceSkillsForRuntime(
    merged,
    workspaceSkills,
  ).skills.map(freezeSkill)
  const skillsByKey = Object.freeze(Object.fromEntries(
    contextualSkills.map(skill => [skill.canonicalKey, skill]),
  )) as Readonly<Record<string, LocalSkill>>
  const availableSkills = Object.freeze(
    enabledMap
      ? contextualSkills.filter(skill => isSkillEnabledByMap(skill, enabledMap))
      : [],
  )

  return Object.freeze({
    agentId,
    enabledMap,
    catalogAuthoritative,
    availableSkills,
    resolve: (canonicalKey: string): SkillAvailabilityResolution => {
      const skill = skillsByKey[canonicalKey]
      if (!skill) {
        if (enabledMap?.[canonicalKey] === true) {
          return { status: 'not_installed' }
        }
        return catalogAuthoritative
          ? { status: 'not_found' }
          : { status: 'not_ready', retryable: true }
      }
      if (!enabledMap) return { status: 'not_ready', retryable: true }
      return isSkillEnabledByMap(skill, enabledMap)
        ? { status: 'available', skill }
        : { status: 'disabled', skill }
    },
  })
}

/**
 * Agent Skill enablement 常驻缓存容器（ Phase 4；#9463 去时间 TTL）。
 */
export class SkillsStore {
  readonly enablement: SkillEnablementMapCache
  private readonly runLeases = new Map<string, SkillAvailabilitySnapshot>()

  constructor(
    fetchMap: SkillEnablementFetchMap,
    ttlMs: number = Number.POSITIVE_INFINITY,
    onFetchError?: (error: unknown, agentId: string) => void,
  ) {
    this.enablement = new SkillEnablementMapCache(fetchMap, ttlMs, onFetchError)
  }

  /**
   * 为一次 Agent Run 获取不可变携带集。
   *
   * 只有权威刷新成功才把 map 交给新 Run。last-good 只留给已经 begin 的
   * lease，避免刷新失败时把已失效配置继续授权给下一轮。
   */
  async acquire(
    agentId: string,
    options?: SkillRunSnapshotOptions,
  ): Promise<SkillAvailabilitySnapshot> {
    const normalizedAgentId = agentId.trim()
    if (!normalizedAgentId) {
      throw new Error('SkillsStore.acquire: agentId is required')
    }
    const view = this.enablement.forAgent(normalizedAgentId)
    const current = await view.refresh({ force: options?.force })
    if (!view.isAuthoritative() || !current) {
      return createSnapshot(normalizedAgentId, undefined, options?.catalog)
    }
    return createSnapshot(
      normalizedAgentId,
      Object.freeze({ ...current }),
      options?.catalog,
    )
  }

  async beginRun(
    runId: string,
    agentId: string,
    options?: SkillRunSnapshotOptions,
  ): Promise<SkillAvailabilitySnapshot> {
    const normalizedRunId = runId.trim()
    if (!normalizedRunId) {
      throw new Error('SkillsStore.beginRun: runId is required')
    }
    const snapshot = await this.acquire(agentId, options)
    this.runLeases.set(normalizedRunId, snapshot)
    return snapshot
  }

  endRun(runId: string): void {
    const normalizedRunId = runId.trim()
    if (normalizedRunId) this.runLeases.delete(normalizedRunId)
  }

  peekRun(runId: string | undefined | null): SkillAvailabilitySnapshot | undefined {
    const normalizedRunId = runId?.trim()
    if (!normalizedRunId) return undefined
    return this.runLeases.get(normalizedRunId)
  }
}
