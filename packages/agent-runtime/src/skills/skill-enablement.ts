/**
 * Skill 启用态判定（Agent 封闭携带集）。
 *
 * 定稿口径（含  过渡，勿再改回「workspace 一律严格 true」除非产品明确收口）：
 * - platform / app / user：仅 `enabledMap[key] === true` 才注入；
 *   `enabledMap` 为 null/undefined（无身份 / 未拉到快照）→ 全部关闭；缺键 → 关。
 * - device：无快照 → 关；有快照且缺键 → 默认放行；显式 false → 关。
 *   本机发现即代表当前设备具备该能力，不要求用户再逐个分配给 Agent。
 * - workspace：无快照 → 关；有快照且缺键 → 放行；显式 `false` → 关；显式 `true` → 开。
 *   过渡原因：升级后目录 Skill 尚未写入携带表时，避免静默从 Agent 消失。
 */

export function isDeviceSkillKey(
  skill: { canonicalKey: string; source?: string },
): boolean {
  if (skill.source === 'device') return true;
  return skill.canonicalKey.startsWith('device:');
}

export function isWorkspaceSkillKey(
  skill: { canonicalKey: string; source?: string; sourceType?: string },
): boolean {
  if (skill.sourceType === 'workspace' || skill.source === 'workspace') return true;
  return skill.canonicalKey.startsWith('workspace:');
}

/**
 * 判断一条 skill 是否应对当前 Agent / 工具可见。
 *
 * @param enabledMap `canonicalKey → enabled`；缺省对封闭集表示无携带快照。
 */
export function isSkillEnabledByMap(
  skill: { canonicalKey: string; source?: string; sourceType?: string },
  enabledMap: Record<string, boolean> | undefined | null,
): boolean {
  if (enabledMap == null) return false
  const flagged = enabledMap[skill.canonicalKey]
  if (flagged === true) return true
  if (flagged === false) return false
  // 本机发现与 workspace 目录 Skill 都采用 opt-out：有效快照缺键即默认可用。
  return isDeviceSkillKey(skill) || isWorkspaceSkillKey(skill)
}

export function filterSkillsByEnablement<
  T extends { canonicalKey: string; source?: string; sourceType?: string },
>(
  skills: readonly T[],
  enabledMap: Record<string, boolean> | undefined | null,
): T[] {
  return skills.filter((skill) => isSkillEnabledByMap(skill, enabledMap));
}

/**
 * 把 `/skills/config` 响应里的 configs 收成 `canonicalKey → enabled` map。
 * 宿主自行带 auth 拉 HTTP；此函数只做形态归一。
 */
export function configsToEnablementMap(
  configs: Record<string, { enabled?: boolean } | null | undefined> | undefined | null,
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  if (!configs) return map;
  for (const [key, cfg] of Object.entries(configs)) {
    map[key] = cfg?.enabled === true;
  }
  return map;
}

/**
 * 校验 `/agents/{agentId}/skills` 响应并归一为启用快照。
 *
 * 只有显式的空 `skills: []` 才代表空携带集；畸形 2xx 必须抛错，让缓存保留旧快照，
 * 不能把协议/代理故障伪装成「Agent 没有 Skill」。
 */
export function parseAgentSkillEnablementResponse(
  input: unknown,
): Record<string, boolean> {
  if (!input || typeof input !== 'object') {
    throw new Error('Agent Skill enablement request failed: invalid payload')
  }
  const data = (input as { data?: unknown }).data
  if (!data || typeof data !== 'object') {
    throw new Error('Agent Skill enablement request failed: invalid payload')
  }
  const skills = (data as { skills?: unknown }).skills
  if (!Array.isArray(skills)) {
    throw new Error('Agent Skill enablement request failed: invalid payload')
  }

  const enabledMap: Record<string, boolean> = {}
  skills.forEach((skill, index) => {
    if (!skill || typeof skill !== 'object') {
      throw new Error(
        `Agent Skill enablement request failed: invalid skill entry at index ${index}`,
      )
    }
    const entry = skill as {
      skill_canonical_key?: unknown
      enabled?: unknown
    }
    if (
      typeof entry.skill_canonical_key !== 'string'
      || !entry.skill_canonical_key.trim()
      || typeof entry.enabled !== 'boolean'
    ) {
      throw new Error(
        `Agent Skill enablement request failed: invalid skill entry at index ${index}`,
      )
    }
    enabledMap[entry.skill_canonical_key] = entry.enabled
  })
  return enabledMap
}

/**
 * 绑定到单个 Agent 的 Skill 启用态视图。
 *
 * Runtime 只消费这个无参接口，避免把 Workspace / 历史 Space 标识误传到
 * `/agents/{agentId}/skills`。
 */
export interface AgentSkillEnablement {
  getSync(): Record<string, boolean> | undefined
  refresh(opts?: { force?: boolean }): Promise<Record<string, boolean> | undefined>
  /** 当前缓存是否为权威新鲜结果；stale / 缺失 / 过期都不是。 */
  isAuthoritative(): boolean
  /** 标记快照过期；保留 last-good，下一次 refresh 原子替换。 */
  invalidate(): void
}

/**
 * 进程内 Agent 级 enablement 缓存。宿主为每个 runtime 先 `forAgent(agentId)`，
 * 再让 fetchSkills / tools 共用同一绑定视图。
 *
 * ：默认常驻（无时间 TTL）；面板变更走 `invalidate` / `invalidateAgent`。
 * `ttlMs` 仍可注入以便单测模拟过期；生产宿主应使用 Infinity（默认）。
 */
export class SkillEnablementMapCache {
  private readonly cache = new Map<
    string,
    { at: number; map: Record<string, boolean>; stale: boolean }
  >();
  private readonly refreshGeneration = new Map<string, number>()
  private readonly inFlightRefresh = new Map<
    string,
    Promise<Record<string, boolean> | undefined>
  >()

  constructor(
    private readonly fetchMap: (
      agentId: string,
    ) => Promise<Record<string, boolean>>,
    private readonly ttlMs = Number.POSITIVE_INFINITY,
    private readonly onFetchError?: (error: unknown, agentId: string) => void,
  ) {}

  forAgent(agentId: string): AgentSkillEnablement {
    const normalizedAgentId = agentId.trim()
    if (!normalizedAgentId) {
      throw new Error('SkillEnablementMapCache.forAgent: agentId is required')
    }
    return {
      getSync: () => this.getSync(normalizedAgentId),
      refresh: (opts) => this.refresh(normalizedAgentId, opts),
      isAuthoritative: () => this.isAuthoritative(normalizedAgentId),
      invalidate: () => this.invalidate(normalizedAgentId),
    }
  }

  private getSync(agentId: string): Record<string, boolean> | undefined {
    return this.cache.get(agentId)?.map
  }

  private isFresh(existing: { at: number }, now: number): boolean {
    if (!Number.isFinite(this.ttlMs)) return true
    return now - existing.at < this.ttlMs
  }

  private isAuthoritative(agentId: string): boolean {
    const existing = this.cache.get(agentId)
    if (!existing || existing.stale) return false
    return this.isFresh(existing, Date.now())
  }

  private async refresh(
    agentId: string,
    opts?: { force?: boolean },
  ): Promise<Record<string, boolean> | undefined> {
    const existing = this.cache.get(agentId)
    const now = Date.now()
    if (!opts?.force && existing && !existing.stale && this.isFresh(existing, now)) {
      return existing.map
    }
    const inFlight = this.inFlightRefresh.get(agentId)
    if (inFlight) return inFlight

    const generation = (this.refreshGeneration.get(agentId) ?? 0) + 1
    this.refreshGeneration.set(agentId, generation)
    const refreshPromise = (async () => {
      try {
        const map = await this.fetchMap(agentId)
        if (this.refreshGeneration.get(agentId) === generation) {
          this.cache.set(agentId, { at: Date.now(), map, stale: false })
          return map
        }
        return this.cache.get(agentId)?.map
      } catch (error) {
        this.onFetchError?.(error, agentId)
        if (this.refreshGeneration.get(agentId) !== generation) {
          return this.cache.get(agentId)?.map
        }
        const leftover = this.cache.get(agentId) ?? (existing ? { ...existing } : undefined)
        if (leftover) this.cache.set(agentId, { ...leftover, stale: true })
        return leftover?.map
      } finally {
        if (this.refreshGeneration.get(agentId) === generation) {
          this.inFlightRefresh.delete(agentId)
        }
      }
    })()
    this.inFlightRefresh.set(agentId, refreshPromise)
    return refreshPromise
  }

  /**
   * 配置变化只标记 stale，保留 last-good，避免刷新期间把 Skill 携带集清空。
   * 在途请求作废；后续 refresh 会基于新 generation 重新拉取并原子替换。
   */
  private invalidate(agentId: string): void {
    this.refreshGeneration.set(agentId, (this.refreshGeneration.get(agentId) ?? 0) + 1)
    this.inFlightRefresh.delete(agentId)
    const existing = this.cache.get(agentId)
    if (existing) this.cache.set(agentId, { ...existing, stale: true })
  }

  /** 配置域宽失效：所有已知 Agent 标记 stale，但不制造空快照窗口。 */
  invalidateAll(): string[] {
    const agentIds = new Set([
      ...this.cache.keys(),
      ...this.inFlightRefresh.keys(),
    ])
    for (const agentId of agentIds) this.invalidate(agentId)
    return [...agentIds]
  }

  /**
   * ：面板启用/停用/携带集变更后由宿主 IPC 调用。
   * 不传 agentId → 身份边界硬清空全部 Agent 槽位（登出/切换用户）。
   */
  invalidateAgent(agentId?: string | null): void {
    const normalized = agentId?.trim()
    if (normalized) {
      this.invalidate(normalized)
      return
    }
    const agentIds = new Set([
      ...this.cache.keys(),
      ...this.inFlightRefresh.keys(),
      ...this.refreshGeneration.keys(),
    ])
    for (const id of agentIds) {
      this.refreshGeneration.set(id, (this.refreshGeneration.get(id) ?? 0) + 1)
    }
    this.cache.clear()
    this.inFlightRefresh.clear()
  }
}
