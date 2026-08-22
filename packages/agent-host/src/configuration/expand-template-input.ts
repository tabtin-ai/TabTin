/**
 * 供 host-agent-tool 在 execute 前把 template_id 展开为通用 agent 入参。
 *
 * persona 不进 runtime 工具入参，由 createHostAgentTool 经
 * systemPromptProvider 承接。
 */

import {
  resolveTemplateSpawn,
  type TemplateSnapshotsGetter,
} from './subagent-template-resolver.js'

function readRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null
    ? input as Record<string, unknown>
    : {}
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 产品侧字段：不得透传给 runtime createAgentTool。 */
const HOST_ONLY_INPUT_KEYS = [
  'template_name',
  'template_version',
  'persona_prompt',
  'max_turns',
] as const

function stripHostOnlyFields(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...input }
  for (const key of HOST_ONLY_INPUT_KEYS) {
    delete next[key]
  }
  return next
}

/**
 * 三态语义（与 runtime `tool_domains` 契约一致，）：
 *   - `undefined` = 动态继承父工具（不物化成显式白名单，父工具变化时跟随）；
 *   - `[]`        = 不给子 Agent 任何工具；
 *   - 非空数组    = 显式子集。
 * 模板无工具约束（allow/deny 均空）时原样透传调用方语义；有约束时才以
 * 「显式子集 ?? 父工具快照」为基础做过滤（此时冻结快照是模板约束的应有语义）。
 */
function mergeToolDomains(
  explicitDomains: string[] | undefined,
  allowedTools: string[],
  deniedTools: string[],
  parentToolNames: string[],
): string[] | undefined {
  const hasTemplateConstraint = allowedTools.length > 0 || deniedTools.length > 0
  if (!hasTemplateConstraint) return explicitDomains

  let effective = explicitDomains ?? parentToolNames
  if (allowedTools.length > 0) {
    const allow = new Set(allowedTools)
    effective = effective.filter((name) => allow.has(name))
  }
  if (deniedTools.length > 0) {
    const deny = new Set(deniedTools)
    effective = effective.filter((name) => !deny.has(name))
  }
  return effective
}

export interface ExpandedHostAgentInput {
  /** 可直接交给 runtime `createAgentTool.execute` 的入参。 */
  input: Record<string, unknown>
  /** 模板 persona；由 host 注入子 system prompt。 */
  personaPrompt?: string
}

/** 命中 Space 模板时把差异写入通用 agent 入参；未命中则剥离无效 template_id。 */
export async function expandTemplateIntoAgentInput(
  input: unknown,
  getSnapshots: TemplateSnapshotsGetter,
  parentToolNames: string[],
): Promise<ExpandedHostAgentInput> {
  const parsed = stripHostOnlyFields(readRecord(input))
  const templateId = normalizeString(parsed.template_id)
  if (!templateId) {
    return { input: parsed }
  }

  const snapshots = await getSnapshots()
  const resolution = resolveTemplateSpawn(templateId, snapshots ? () => snapshots : undefined)
  if (!resolution) {
    const { template_id: _dropped, ...rest } = parsed
    return { input: rest }
  }

  const explicitToolDomains = Array.isArray(parsed.tool_domains)
    ? parsed.tool_domains.filter((item): item is string => typeof item === 'string')
    : undefined

  const expanded: Record<string, unknown> = {
    ...parsed,
    template_id: resolution.snapshot.id,
  }
  if (!normalizeString(parsed.model) && resolution.modelId) {
    expanded.model = resolution.modelId
  }
  if (parsed.readonly !== true && resolution.readonly) {
    expanded.readonly = true
  }
  if (typeof parsed.background !== 'boolean'
    && resolution.snapshot.defaultMode === 'background') {
    expanded.background = true
  }

  const mergedDomains = mergeToolDomains(
    explicitToolDomains,
    resolution.allowedTools,
    resolution.deniedTools,
    parentToolNames,
  )
  if (mergedDomains !== undefined) {
    expanded.tool_domains = mergedDomains
  } else {
    // undefined = 动态继承：不把父工具快照物化成显式白名单。
    delete expanded.tool_domains
  }

  return {
    input: expanded,
    personaPrompt: resolution.personaPrompt || undefined,
  }
}
