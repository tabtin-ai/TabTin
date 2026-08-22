import codeEngineerAvatarUrl from '../../../../../../packages/agents/code-engineer/avatar.png'
import codeEngineerFunctionAvatarUrl from '../../../../../../packages/agents/code-engineer/avatar-function.png'
import dataAnalystAvatarUrl from '../../../../../../packages/agents/data-analyst/avatar.png'
import dataAnalystFunctionAvatarUrl from '../../../../../../packages/agents/data-analyst/avatar-function.png'
import docWriterAvatarUrl from '../../../../../../packages/agents/doc-writer/avatar.png'
import docWriterFunctionAvatarUrl from '../../../../../../packages/agents/doc-writer/avatar-function.png'
import generalAssistantAvatarUrl from '../../../../../../packages/agents/general-assistant/avatar.png'
import generalAssistantFunctionAvatarUrl from '../../../../../../packages/agents/general-assistant/avatar-function.png'
import officeSecretaryAvatarUrl from '../../../../../../packages/agents/office-secretary/avatar.png'
import officeSecretaryFunctionAvatarUrl from '../../../../../../packages/agents/office-secretary/avatar-function.png'
import slideDesignerAvatarUrl from '../../../../../../packages/agents/slide-designer/avatar.png'
import slideDesignerFunctionAvatarUrl from '../../../../../../packages/agents/slide-designer/avatar-function.png'
import webResearcherAvatarUrl from '../../../../../../packages/agents/web-researcher/avatar.png'
import webResearcherFunctionAvatarUrl from '../../../../../../packages/agents/web-researcher/avatar-function.png'

/** 新建分身沿用已发布的日常版默认值；新增预设不得改变它。 */
export const DEFAULT_AGENT_AVATAR_PRESET_KEY = 'general-assistant' as const

/** 已发布的首批头像 key。顺序与资源映射保持稳定，避免改变历史用户的展示。 */
export const LEGACY_AGENT_AVATAR_PRESET_KEYS = [
  DEFAULT_AGENT_AVATAR_PRESET_KEY,
  'code-engineer',
  'doc-writer',
  'data-analyst',
  'web-researcher',
  'slide-designer',
  'office-secretary',
] as const

/** 功能优先的几何简笔头像；使用独立 key，不替换首批头像。 */
export const FUNCTION_AGENT_AVATAR_PRESET_KEYS = [
  'function-general-assistant',
  'function-code-engineer',
  'function-doc-writer',
  'function-data-analyst',
  'function-web-researcher',
  'function-slide-designer',
  'function-office-secretary',
] as const

export const AGENT_AVATAR_PRESET_KEYS = [
  ...LEGACY_AGENT_AVATAR_PRESET_KEYS,
  ...FUNCTION_AGENT_AVATAR_PRESET_KEYS,
] as const

export type AgentAvatarPresetKey = (typeof AGENT_AVATAR_PRESET_KEYS)[number]

const AGENT_AVATAR_URL_BY_KEY: Record<AgentAvatarPresetKey, string> = {
  'general-assistant': generalAssistantAvatarUrl,
  'code-engineer': codeEngineerAvatarUrl,
  'doc-writer': docWriterAvatarUrl,
  'data-analyst': dataAnalystAvatarUrl,
  'web-researcher': webResearcherAvatarUrl,
  'slide-designer': slideDesignerAvatarUrl,
  'office-secretary': officeSecretaryAvatarUrl,
  'function-general-assistant': generalAssistantFunctionAvatarUrl,
  'function-code-engineer': codeEngineerFunctionAvatarUrl,
  'function-doc-writer': docWriterFunctionAvatarUrl,
  'function-data-analyst': dataAnalystFunctionAvatarUrl,
  'function-web-researcher': webResearcherFunctionAvatarUrl,
  'function-slide-designer': slideDesignerFunctionAvatarUrl,
  'function-office-secretary': officeSecretaryFunctionAvatarUrl,
}

export function isAgentAvatarPresetKey(value?: string | null): value is AgentAvatarPresetKey {
  return !!value && Object.hasOwn(AGENT_AVATAR_URL_BY_KEY, value)
}

export function resolveAgentAvatarPresetUrl(avatarKey?: string | null): string | null {
  const trimmed = avatarKey?.trim()
  return isAgentAvatarPresetKey(trimmed) ? AGENT_AVATAR_URL_BY_KEY[trimmed] : null
}
