import { TABTIN_APP_ICON_URL } from '@/constants/appIcon'
import { resolveAgentAvatarPresetUrl } from '@/constants/agentAvatarPresets'

export interface AgentAvatarSettings {
  avatar_key?: string | null
  avatar_url?: string | null
}

/** 只取用户上传的自定义头像 URL；品牌预设不在这里展开。 */
export function extractAgentCustomAvatarUrl(
  settings?: AgentAvatarSettings | null,
): string | null {
  const trimmed = settings?.avatar_url?.trim()
  return trimmed || null
}

/**
 * 从 Agent.settings 解析头像 URL。
 * 用户自定义 URL 优先；没有时使用平台品牌头像；均无则返回 null。
 */
export function extractAgentAvatarUrl(
  settings?: AgentAvatarSettings | null,
): string | null {
  return extractAgentCustomAvatarUrl(settings)
    || resolveAgentAvatarPresetUrl(settings?.avatar_key)
}

/**
 * 解析 Agent 身份头像展示 URL。
 * 有已解析头像时使用；否则回退 TabTin logo（与 Space 无头像兜底同源）。
 */
export function resolveAgentAvatarUrl(avatarUrl?: string | null): string {
  const trimmed = avatarUrl?.trim()
  return trimmed || TABTIN_APP_ICON_URL
}
