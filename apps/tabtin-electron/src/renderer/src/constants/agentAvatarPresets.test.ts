import { describe, expect, it } from 'vitest'
import { NIINII_MASCOT_URL } from './mascot'
import {
  AGENT_AVATAR_PRESET_KEYS,
  DEFAULT_AGENT_AVATAR_PRESET_KEY,
  FUNCTION_AGENT_AVATAR_PRESET_KEYS,
  LEGACY_AGENT_AVATAR_PRESET_KEYS,
  resolveAgentAvatarPresetUrl,
} from './agentAvatarPresets'

describe('agentAvatarPresets', () => {
  it('保留七个已发布 key，并追加七个功能简笔 key', () => {
    expect(DEFAULT_AGENT_AVATAR_PRESET_KEY).toBe('general-assistant')
    expect(LEGACY_AGENT_AVATAR_PRESET_KEYS).toEqual([
      'general-assistant',
      'code-engineer',
      'doc-writer',
      'data-analyst',
      'web-researcher',
      'slide-designer',
      'office-secretary',
    ])
    expect(FUNCTION_AGENT_AVATAR_PRESET_KEYS).toEqual([
      'function-general-assistant',
      'function-code-engineer',
      'function-doc-writer',
      'function-data-analyst',
      'function-web-researcher',
      'function-slide-designer',
      'function-office-secretary',
    ])
    expect(AGENT_AVATAR_PRESET_KEYS).toHaveLength(14)
    expect(new Set(AGENT_AVATAR_PRESET_KEYS).size).toBe(14)
  })

  it('每个随包 key 都能解析为资源 URL，未知 key 保持空结果', () => {
    for (const avatarKey of AGENT_AVATAR_PRESET_KEYS) {
      expect(resolveAgentAvatarPresetUrl(avatarKey)).toBeTruthy()
    }
    expect(resolveAgentAvatarPresetUrl('not-a-real-avatar')).toBeNull()
  })

  it('旧角色预设统一显示 NiiNii，功能简笔预设保持独立', () => {
    for (const avatarKey of LEGACY_AGENT_AVATAR_PRESET_KEYS) {
      expect(resolveAgentAvatarPresetUrl(avatarKey)).toBe(NIINII_MASCOT_URL)
    }
    for (const avatarKey of FUNCTION_AGENT_AVATAR_PRESET_KEYS) {
      expect(resolveAgentAvatarPresetUrl(avatarKey)).not.toBe(NIINII_MASCOT_URL)
    }
  })
})
