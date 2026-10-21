import { describe, expect, it } from 'vitest'
import { resolveAgentAvatarPresetUrl } from '@/constants/agentAvatarPresets'
import { NIINII_MASCOT_URL } from '@/constants/mascot'
import {
  extractAgentAvatarUrl,
  extractAgentCustomAvatarUrl,
  resolveAgentAvatarUrl,
} from '../resolveAgentAvatar'

describe('resolveAgentAvatar', () => {
  it('extractAgentAvatarUrl 自定义 URL 优先于品牌头像', () => {
    expect(extractAgentAvatarUrl(undefined)).toBeNull()
    expect(extractAgentAvatarUrl({ avatar_url: '  ' })).toBeNull()
    expect(extractAgentAvatarUrl({ avatar_key: 'code-engineer' })).toBe(
      resolveAgentAvatarPresetUrl('code-engineer'),
    )
    expect(extractAgentAvatarUrl({ avatar_key: 'unknown-avatar' })).toBeNull()
    expect(extractAgentAvatarUrl({ avatar_url: 'https://cdn.example.com/a.png' })).toBe(
      'https://cdn.example.com/a.png',
    )
    expect(extractAgentAvatarUrl({
      avatar_key: 'code-engineer',
      avatar_url: 'https://cdn.example.com/custom.png',
    })).toBe('https://cdn.example.com/custom.png')
    expect(extractAgentAvatarUrl({
      avatar_key: 'function-code-engineer',
      avatar_url: 'https://cdn.example.com/custom.png',
    })).toBe('https://cdn.example.com/custom.png')
  })

  it('extractAgentCustomAvatarUrl 不把品牌预设冒充成上传头像', () => {
    expect(extractAgentCustomAvatarUrl({ avatar_key: 'code-engineer' })).toBeNull()
    expect(extractAgentCustomAvatarUrl({
      avatar_key: 'code-engineer',
      avatar_url: ' https://cdn.example.com/custom.png ',
    })).toBe('https://cdn.example.com/custom.png')
  })

  it('resolveAgentAvatarUrl 无自定义时回退 NiiNii', () => {
    expect(resolveAgentAvatarUrl(null)).toBe(NIINII_MASCOT_URL)
    expect(resolveAgentAvatarUrl('')).toBe(NIINII_MASCOT_URL)
    expect(resolveAgentAvatarUrl('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png',
    )
  })
})
