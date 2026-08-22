import { describe, expect, it } from 'vitest'
import {
  logoSettingsFromDraft,
  resolveOrgLogoDraftPreview,
} from './OrganizationAvatarUploader'

describe('OrganizationAvatarUploader draft helpers ', () => {
  it('prefers draft set URL over saved logo', () => {
    expect(
      resolveOrgLogoDraftPreview(
        { type: 'set', url: 'https://cdn.example.com/new.png' },
        'https://cdn.example.com/old.png',
      ),
    ).toBe('https://cdn.example.com/new.png')
  })

  it('clears preview when draft is clear', () => {
    expect(
      resolveOrgLogoDraftPreview(
        { type: 'clear' },
        'https://cdn.example.com/old.png',
      ),
    ).toBeUndefined()
  })

  it('merges logo_url into settings without dropping other keys', () => {
    expect(
      logoSettingsFromDraft(
        { type: 'set', url: 'https://cdn.example.com/logo.png' },
        { allow_member_yolo: true, keep_me: 1 },
      ),
    ).toEqual({
      settings: {
        allow_member_yolo: true,
        keep_me: 1,
        logo_url: 'https://cdn.example.com/logo.png',
      },
    })
  })

  it('writes empty logo_url on clear draft', () => {
    expect(
      logoSettingsFromDraft(
        { type: 'clear' },
        { logo_url: 'https://cdn.example.com/old.png', keep_me: true },
      ),
    ).toEqual({
      settings: {
        logo_url: '',
        keep_me: true,
      },
    })
  })

  it('returns empty patch when there is no draft', () => {
    expect(logoSettingsFromDraft(null, { keep_me: true })).toEqual({})
  })
})
