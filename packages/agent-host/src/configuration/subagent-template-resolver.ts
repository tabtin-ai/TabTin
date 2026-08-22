/**
 * SubAgent Template Resolver—— **host 产品语义**。
 *
 * 把 Space 配置的 SubAgentTemplate 快照解析成 spawn 配置；runtime 只消费
 * 展开后的通用 agent 工具入参（model / readonly / tool_domains 等）。
 *
 * 设计约束：
 *   - 主 Agent **只**用 `template_id`（UUID）指定模板；`role` 只是 UI 标签。
 *   - 解析失败 → null，调用方静默走 ad-hoc。
 */

/** SubAgentTemplate 的 host 侧快照（从 Django CRUD 结果映射）。 */
export interface SubAgentTemplateSnapshot {
  id: string
  name: string
  description: string
  systemPrompt: string
  /** explore（只读探索）/ plan（只读规划）/ execute（可写执行）。 */
  subagentType: 'explore' | 'plan' | 'execute'
  /** 工具名白名单（空数组 = 不加白名单，仅在此基础上去黑名单）。 */
  allowedTools: string[]
  /** 工具名黑名单。 */
  deniedTools: string[]
  /** 首选模型 id（空串 = 跟父）。 */
  modelId: string
  /** 思考级别（空串 = 跟父）。 */
  thinkingLevel: string
  /** wait（前台同步）/ background（后台异步）。 */
  defaultMode: 'wait' | 'background'
  version: number
  isEnabled: boolean
}

/**
 * 把 Django `/spaces/{id}/subagent-templates` CRUD 返回的一条原始记录映射成
 * host 侧快照。缺 id / name → null。字段与 Django `_serialize` 对齐。
 */
export function mapRawTemplateToSnapshot(
  raw: Record<string, unknown>,
): SubAgentTemplateSnapshot | null {
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!id || !name) return null

  const rawType = typeof raw.subagent_type === 'string' ? raw.subagent_type : 'execute'
  const subagentType: SubAgentTemplateSnapshot['subagentType'] =
    rawType === 'explore' || rawType === 'plan' ? rawType : 'execute'

  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

  return {
    id,
    name,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    systemPrompt: typeof raw.system_prompt === 'string' ? raw.system_prompt : '',
    subagentType,
    allowedTools: strArr(raw.allowed_tools),
    deniedTools: strArr(raw.denied_tools),
    modelId: typeof raw.model_id === 'string' ? raw.model_id : '',
    thinkingLevel: typeof raw.thinking_level === 'string' ? raw.thinking_level : '',
    defaultMode: raw.default_mode === 'background' ? 'background' : 'wait',
    version: typeof raw.version === 'number' ? raw.version : 1,
    isEnabled: raw.is_enabled !== false,
  }
}

function isReadonlyType(type: SubAgentTemplateSnapshot['subagentType']): boolean {
  return type === 'explore' || type === 'plan'
}

/** spawn 时从模板派生的规范化解析结果（host 内部）。 */
export interface TemplateSpawnResolution {
  snapshot: SubAgentTemplateSnapshot
  personaPrompt: string
  readonly: boolean
  modelId: string
  allowedTools: string[]
  deniedTools: string[]
}

export function resolveTemplateSpawn(
  templateId: string | undefined,
  getSnapshots:
    | (() => Map<string, SubAgentTemplateSnapshot> | undefined)
    | undefined,
): TemplateSpawnResolution | null {
  const id = typeof templateId === 'string' ? templateId.trim() : ''
  if (!id || !getSnapshots) return null

  const snapshots = getSnapshots()
  if (!snapshots) return null

  const snapshot = snapshots.get(id)
  if (!snapshot || snapshot.isEnabled === false) return null

  return {
    snapshot,
    personaPrompt: (snapshot.systemPrompt ?? '').trim(),
    readonly: isReadonlyType(snapshot.subagentType),
    modelId: (snapshot.modelId ?? '').trim(),
    allowedTools: Array.isArray(snapshot.allowedTools) ? snapshot.allowedTools : [],
    deniedTools: Array.isArray(snapshot.deniedTools) ? snapshot.deniedTools : [],
  }
}

export type TemplateSnapshotsGetter = () =>
  | Map<string, SubAgentTemplateSnapshot>
  | undefined
  | Promise<Map<string, SubAgentTemplateSnapshot> | undefined>
