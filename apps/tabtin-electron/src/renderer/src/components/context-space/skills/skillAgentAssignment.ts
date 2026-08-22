/**
 * Skill「配置给 Agent」携带判定与勾选播种策略。
 *
 * 产品语义：是否已配置给某 Agent = Agent 子开关携带，不是「总闸 ∧ 子开关」最终注入。
 */
import { normalizeSkillSource, type AgentSkillLinkItem } from '@/skills/types'

type CarryLink = Pick<AgentSkillLinkItem, 'skill_canonical_key' | 'enabled' | 'agent_enabled'>

type SkillImportRequestItem = {
  name?: string
  files?: Array<{ path: string; content: string; encoding?: 'base64' }>
  url?: string
}

type SkillEnableSpace = {
  id: string
  agent_id?: string | null
  execution_agent_id?: string | null
}

/**
 * 把用户勾选的执行现场解析为实际携带 Skill 的 Agent。
 *
 * Space picker 展示的是 Workspace，但服务端启用契约已经迁移为 Agent。这里必须逐项
 * 做映射，不能只拿页面当前 selectedAgent；市场页没有选中会话时 selectedAgent 可能为空，
 * 多选 Workspace 时也可能对应不同 Agent。任一目标尚未具备执行 Agent 就整体阻止提交，
 * 避免“创建成功并启用”的界面承诺与实际携带集不一致。
 */
export function resolveEnableAgentIdsForSpaces(params: {
  spaces: readonly SkillEnableSpace[]
  selectedSpaceIds: readonly string[]
  currentSpaceId: string
  selectedAgentId?: string | null
}): string[] | null {
  const { spaces, selectedSpaceIds, currentSpaceId, selectedAgentId } = params
  if (selectedSpaceIds.length === 0) return null

  const agentIds: string[] = []
  for (const spaceId of selectedSpaceIds) {
    const space = spaces.find(candidate => candidate.id === spaceId)
    const agentId = space?.execution_agent_id
      || space?.agent_id
      || (spaceId === currentSpaceId ? selectedAgentId : null)
    if (!agentId) return null
    if (!agentIds.includes(agentId)) agentIds.push(agentId)
  }
  return agentIds
}

/** 单点构造导入 items，防止某条导入路径漏传 enable_agent_ids。 */
export function buildSkillImportRequestItems<T extends SkillImportRequestItem>(
  items: readonly T[],
  enableAgentIds?: readonly string[],
): Array<T & { enable_agent_ids?: string[] }> {
  return items.map((item) => ({
    ...item,
    ...(enableAgentIds?.length
      ? { enable_agent_ids: [...enableAgentIds] }
      : {}),
  }))
}

/** Skill 变更只能携带当前组织的 Agent，避免组织切换期间复用旧选择。 */
export function resolveAgentIdForOrganization(
  agent: { id: string; organization_id: string } | null | undefined,
  organizationId: string | null | undefined,
): string | null {
  if (!agent || !organizationId) return null
  return agent.organization_id === organizationId ? agent.id : null
}

/** 启用结果中的 ID 是 Agent ID；命中当前 Agent 时展示人类可读名称。 */
export function resolveAgentLabel(
  agent: { id: string; name?: string; display_name?: string } | null | undefined,
  agentId: string,
): string {
  if (agent?.id !== agentId) return agentId
  return agent.display_name?.trim() || agent.name?.trim() || agentId
}

/** 是否算「已配置给该 Agent」（认 agent_enabled；旧响应回退 enabled）。 */
export function isAgentCarryingSkill(link: CarryLink): boolean {
  if (typeof link.agent_enabled === 'boolean') return link.agent_enabled
  return link.enabled === true
}

/** 按 skill_canonical_key → 已携带该 Skill 的 agentId 列表。 */
export function buildAgentIdsBySkillKey(
  agents: ReadonlyArray<{ id: string }>,
  skillLists: ReadonlyArray<ReadonlyArray<CarryLink> | undefined>,
): Map<string, string[]> {
  const result = new Map<string, string[]>()
  agents.forEach((agent, index) => {
    for (const link of skillLists[index] ?? []) {
      if (!isAgentCarryingSkill(link)) continue
      const ids = result.get(link.skill_canonical_key) ?? []
      ids.push(agent.id)
      result.set(link.skill_canonical_key, ids)
    }
  })
  return result
}

/**
 * 本机 Skill 默认挂在小Tin 上，即使还没有携带行。
 * 「技能-我的」管理弹层与卡片数量要把这份隐式挂载算进去。
 * 默认 Agent 已有携带行（含显式关闭）时不再回填，避免盖过用户选择。
 */
export function withImplicitDefaultAgentDeviceAssignments(
  agentIdsBySkillKey: Map<string, string[]>,
  agents: ReadonlyArray<{ id: string; is_default?: boolean }>,
  skills: ReadonlyArray<{ source?: string; skill_key?: string }>,
  defaultAgentLinkedKeys: ReadonlySet<string> = new Set(),
): Map<string, string[]> {
  const defaultAgentId = agents.find(agent => agent.is_default === true)?.id
  if (!defaultAgentId) return agentIdsBySkillKey

  const next = new Map(agentIdsBySkillKey)
  for (const skill of skills) {
    const key = skill.skill_key || ''
    const isDevice = normalizeSkillSource(skill.source || '') === 'device'
      || key.startsWith('device:')
    if (!isDevice || !key || defaultAgentLinkedKeys.has(key)) continue
    const ids = next.get(key) ?? []
    if (ids.includes(defaultAgentId)) continue
    next.set(key, [defaultAgentId, ...ids])
  }
  return next
}

/**
 * 默认 Agent 已携带的平台 / 内置 App / 本机 Skill 不允许从「管理 Agent」摘除。
 * canonical key 前缀优先，缺前缀时回退 source，与后端 Writer 保持一致。
 */
export function resolveLockedAssignedAgentIds(
  agents: ReadonlyArray<{ id: string; is_default?: boolean }>,
  assignedAgentIds: readonly string[],
  skillCanonicalKey: string,
  skillSource?: string,
): Set<string> {
  const prefix = skillCanonicalKey.trim().split(':', 1)[0]
  const source = prefix || skillSource || ''
  if (source !== 'platform' && source !== 'app' && source !== 'device') return new Set()

  const assigned = new Set(assignedAgentIds)
  return new Set(
    agents
      .filter(agent => agent.is_default === true && assigned.has(agent.id))
      .map(agent => agent.id),
  )
}

/**
 * 弹窗打开后只用服务端携带集播种一次；加载中或已播种后不再覆盖本地勾选，
 * 避免保存刷新把用户勾选冲空。
 */
export function shouldSeedSelectionFromAssignments(params: {
  open: boolean
  assignmentsLoading: boolean
  seededForOpen: boolean
}): boolean {
  return params.open && !params.assignmentsLoading && !params.seededForOpen
}
