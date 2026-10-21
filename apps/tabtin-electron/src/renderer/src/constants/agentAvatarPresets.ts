import { NIINII_MASCOT_URL } from './mascot'
import codeEngineerFunctionAvatarUrl from '../../../../../../packages/agents/code-engineer/avatar-function.png'
import dataAnalystFunctionAvatarUrl from '../../../../../../packages/agents/data-analyst/avatar-function.png'
import docWriterFunctionAvatarUrl from '../../../../../../packages/agents/doc-writer/avatar-function.png'
import generalAssistantFunctionAvatarUrl from '../../../../../../packages/agents/general-assistant/avatar-function.png'
import officeSecretaryFunctionAvatarUrl from '../../../../../../packages/agents/office-secretary/avatar-function.png'
import slideDesignerFunctionAvatarUrl from '../../../../../../packages/agents/slide-designer/avatar-function.png'
import webResearcherFunctionAvatarUrl from '../../../../../../packages/agents/web-researcher/avatar-function.png'

/** 新建分身沿用已发布的日常版默认值；新增预设不得改变它。 */
export const DEFAULT_AGENT_AVATAR_PRESET_KEY = 'general-assistant' as const

/** 已发布的首批头像 key 与顺序保持稳定；角色形象统一使用 NiiNii。 */
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
  'general-assistant': NIINII_MASCOT_URL,
  'code-engineer': NIINII_MASCOT_URL,
  'doc-writer': NIINII_MASCOT_URL,
  'data-analyst': NIINII_MASCOT_URL,
  'web-researcher': NIINII_MASCOT_URL,
  'slide-designer': NIINII_MASCOT_URL,
  'office-secretary': NIINII_MASCOT_URL,
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
