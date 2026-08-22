import { describe, expect, it } from 'vitest'
import { identityAvatarColor, identityAvatarInitial } from '../identity-avatar.js'

describe('identity avatar', () => {
  it('uses the immutable identity as a stable color seed', () => {
    expect(identityAvatarColor('user-1')).toBe(identityAvatarColor('user-1'))
    expect(identityAvatarColor('user-1')).not.toBe(identityAvatarColor('user-2'))
  })

  it('uses the first visible character as the fallback label', () => {
    expect(identityAvatarInitial('晨曦')).toBe('晨')
    expect(identityAvatarInitial('😂 tester')).toBe('😂')
    expect(identityAvatarInitial('')).toBe('?')
  })
})
