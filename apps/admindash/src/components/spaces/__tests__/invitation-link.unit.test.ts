import { describe, expect, it } from 'vitest'

import {
  invitationTargetLabel,
  publicWebBaseFromHostname,
  resolveInvitationLink,
  resolvePublicInviteWebBase,
} from '../invitation-link'

describe('publicWebBaseFromHostname', () => {
  it('admin-test / api-test → web-test', () => {
    expect(publicWebBaseFromHostname('admin-test.example.com')).toBe(
      'https://web-test.example.com',
    )
    expect(publicWebBaseFromHostname('api-test.example.com')).toBe(
      'https://web-test.example.com',
    )
  })

  it('admin / api → web', () => {
    expect(publicWebBaseFromHostname('admin.example.com')).toBe('https://web.example.com')
    expect(publicWebBaseFromHostname('api.example.com')).toBe('https://web.example.com')
  })

  it('本地 → 127.0.0.1:5176', () => {
    expect(publicWebBaseFromHostname('localhost')).toBe('http://127.0.0.1:5176')
    expect(publicWebBaseFromHostname('127.0.0.1')).toBe('http://127.0.0.1:5176')
  })
})

describe('resolvePublicInviteWebBase', () => {
  it('优先用当前页面域名（测试）', () => {
    expect(
      resolvePublicInviteWebBase({
        pageHostname: 'admin-test.example.com',
        apiBaseUrl: 'http://127.0.0.1:6060/api',
        explicitBase: 'http://127.0.0.1:5176',
      }),
    ).toBe('https://web-test.example.com')
  })

  it('页面在本地时跟随 API 域名（lite → web-test）', () => {
    expect(
      resolvePublicInviteWebBase({
        pageHostname: 'localhost',
        apiBaseUrl: 'https://api-test.example.com/api',
        explicitBase: 'http://127.0.0.1:5176',
      }),
    ).toBe('https://web-test.example.com')
  })
})

describe('resolveInvitationLink', () => {
  const token = 'T7VhT-7qGmM_2SxLtvnckpJuKiQe7nf1uJnUisMh0PI'

  it('当前域名 + /invite/ + token', () => {
    expect(
      resolveInvitationLink(
        { invite_type: 'link', token, invite_url: '' },
        'https://web-test.example.com',
      ),
    ).toBe(`https://web-test.example.com/invite/${token}`)
  })

  it('正式环境同理', () => {
    expect(
      resolveInvitationLink({ invite_type: 'link', token }, 'https://web.example.com/'),
    ).toBe(`https://web.example.com/invite/${token}`)
  })

  it('拼不出时回退后端 invite_url', () => {
    expect(
      resolveInvitationLink(
        {
          invite_type: 'link',
          token: 'short',
          invite_url: 'https://web-test.example.com/invite/fallback_token_xx',
        },
        undefined,
      ),
    ).toBe('https://web-test.example.com/invite/fallback_token_xx')
  })
})

describe('invitationTargetLabel', () => {
  it('link 类型无完整链接时回退 token', () => {
    expect(
      invitationTargetLabel(
        { invite_type: 'link', token: 'bare_token_value_abcdefgh' },
        undefined,
      ),
    ).toBe('bare_token_value_abcdefgh')
  })
})
