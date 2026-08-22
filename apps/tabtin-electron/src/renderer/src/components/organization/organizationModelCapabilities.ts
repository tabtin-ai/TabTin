import type { OrganizationLlmModel } from '@/types/llm-organization'

export function ensureCustomChatJsonCapability(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const current = config ?? {}
  const currentJsonMode = current.json_mode
  const jsonMode = currentJsonMode && typeof currentJsonMode === 'object' && !Array.isArray(currentJsonMode)
    ? currentJsonMode as Record<string, unknown>
    : {}
  const currentModes = Array.isArray(jsonMode.modes) ? jsonMode.modes : []
  const modes = currentModes.includes('json_object')
    ? [...currentModes]
    : [...currentModes, 'json_object']
  return {
    ...current,
    supports_json_mode: true,
    json_mode: {
      ...jsonMode,
      modes,
    },
  }
}


export function isJsonModeEnabled(config: Record<string, unknown> | undefined): boolean {
  if (!config) return false
  if (config.supports_json_mode === true) return true
  const jsonMode = config.json_mode
  if (!jsonMode || typeof jsonMode !== 'object' || Array.isArray(jsonMode)) return false
  const modes = (jsonMode as Record<string, unknown>).modes
  return Array.isArray(modes) && modes.length > 0
}

export function setJsonModeEnabled(
  config: Record<string, unknown> | undefined,
  enabled: boolean,
): Record<string, unknown> {
  const current = config ?? {}
  const currentJsonMode = current.json_mode
  const jsonMode = currentJsonMode && typeof currentJsonMode === 'object' && !Array.isArray(currentJsonMode)
    ? currentJsonMode as Record<string, unknown>
    : {}
  return {
    ...current,
    supports_json_mode: enabled,
    json_mode: {
      ...jsonMode,
      modes: enabled ? ['json_object'] : [],
    },
  }
}

export function canUseAsWorkspaceDefault(
  model: Partial<OrganizationLlmModel>,
): boolean {
  const domain = model.capability_domain ?? model.mode
  const legacyScopeAllowed = model.provider_scope !== 'user'
  return (model.can_set_as_default ?? legacyScopeAllowed)
    && model.provider_routing_enabled !== false
    && (model.wave_status == null || model.wave_status === '' || model.wave_status === 'ready')
    && model.is_active !== false
    && model.provider_is_active !== false
    && domain === 'chat'
}

export function canUseAsPersonalDefault(
  model: Partial<OrganizationLlmModel>,
): boolean {
  const domain = model.capability_domain ?? model.mode
  return (model.can_set_as_user_default ?? true)
    && model.provider_routing_enabled !== false
    && (model.wave_status == null || model.wave_status === '' || model.wave_status === 'ready')
    && model.is_active !== false
    && model.provider_is_active !== false
    && domain === 'chat'
}
