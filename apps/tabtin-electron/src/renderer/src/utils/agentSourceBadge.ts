/**
 * AI 分身来源角标。
 *
 * - 系统默认 Agent（settings.provision_source=system_default）：列表「默认」；
 *   详情不重复标「自建」（由独立 defaultBadge 承担）
 * - 历史误标 is_default、无 system provenance：不按「默认」展示，走模板/自建
 * - 模板实例：模板名（或「模板」兜底）；若名称已经包含同一角色名则省略，
 *   避免「冲浪版 / 冲浪版」或历史「user_3017冲浪版 / 冲浪版」重复
 * - 空白自建：自建
 */

export const SYSTEM_DEFAULT_PROVISION_SOURCE = 'system_default'

export type AgentSourceBadgeInput = {
  is_default?: boolean | null
  template_id?: string | null
  settings?: {
    provision_source?: string | null
    [key: string]: unknown
  } | null
}

export type AgentSourceBadgeLabels = {
  defaultBadge: string
  customBadge: string
  templateBadgeFallback: string
}

export type AgentSourceBadgeMode = 'list' | 'detail'

export function isSystemDefaultAgentSource(agent: AgentSourceBadgeInput): boolean {
  const source = agent.settings?.provision_source
  return source === SYSTEM_DEFAULT_PROVISION_SOURCE
}

export function resolveAgentSourceBadge(
  agent: AgentSourceBadgeInput,
  labels: AgentSourceBadgeLabels,
  templateName?: string | null,
  mode: AgentSourceBadgeMode = 'list',
  agentName?: string | null,
): string | null {
  const templateId = (agent.template_id || '').trim()
  const resolvedTemplateName = (templateName || '').trim()
    || (templateId ? labels.templateBadgeFallback : '')
  const resolvedAgentName = (agentName || '').trim()

  // 只认系统 provenance，避免 ensure 前误标默认分身显示「默认」
  if (isSystemDefaultAgentSource(agent)) {
    if (mode === 'detail') {
      return templateId ? resolvedTemplateName : null
    }
    return labels.defaultBadge
  }

  if (templateId) {
    if (
      resolvedTemplateName
      && resolvedAgentName
      && (
        resolvedAgentName === resolvedTemplateName
        || resolvedAgentName.endsWith(resolvedTemplateName)
      )
    ) {
      return null
    }
    return resolvedTemplateName || labels.templateBadgeFallback
  }
  return labels.customBadge
}
