import { describe, expect, it } from 'vitest'
import { TABTIN_APP_ICON_URL } from '@/constants/appIcon'
import { resolveSpaceAvatarUrl } from './resolveSpaceAvatar'

describe('resolveSpaceAvatarUrl', () => {
  it('无自定义头像时回退到 TabTin 应用图标', () => {
    expect(resolveSpaceAvatarUrl()).toBe(TABTIN_APP_ICON_URL)
    expect(resolveSpaceAvatarUrl('')).toBe(TABTIN_APP_ICON_URL)
    expect(resolveSpaceAvatarUrl('   ')).toBe(TABTIN_APP_ICON_URL)
  })

  it('有自定义头像时优先使用自定义地址', () => {
    expect(resolveSpaceAvatarUrl('https://cdn.example.com/space.png')).toBe(
      'https://cdn.example.com/space.png',
    )
  })
})
