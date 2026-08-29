import { describe, expect, it } from 'vitest'
import {
  TABTIN_DOWNLOAD_URL,
  buildDesktopInviteDeepLink,
  buildPublicInviteBridgeUrl,
  isSupportedInviteToken,
  resolveApiRuntimeConfig,
} from '@tabtin/config'

describe('invite link helpers', () => {
  it('builds HTTPS web bridge URL from public web base', () => {
    expect(buildPublicInviteBridgeUrl('https://tabtin.example.com/', 'abc_123-xyz-456789')).toBe(
      'https://tabtin.example.com/invite/abc_123-xyz-456789',
    )
  })

  it('allows localhost HTTP only for local development invite links', () => {
    expect(buildPublicInviteBridgeUrl('http://127.0.0.1:5176/', 'abc_123-xyz-456789')).toBe(
      'http://127.0.0.1:5176/invite/abc_123-xyz-456789',
    )
  })

  it.each([
    'http://10.0.0.8:5176',
    'http://172.16.0.8:5176',
    'http://172.31.255.8:5176',
    'http://192.168.0.10:5176',
    'http://169.254.10.8:5176',
    'http://[fd12:3456:789a::8]:5176',
    'http://[fe80::8]:5176',
  ])('allows private LAN HTTP invite web base %s', (baseUrl) => {
    expect(buildPublicInviteBridgeUrl(baseUrl, 'abc_123-xyz-456789')).toBe(
      `${baseUrl}/invite/abc_123-xyz-456789`,
    )
    expect(buildDesktopInviteDeepLink('abc_123-xyz-456789', baseUrl)).toBe(
      'tabtin-dev://invite/abc_123-xyz-456789',
    )
  })

  it('rejects public HTTP invite web bases only during link building', () => {
    expect(() => buildPublicInviteBridgeUrl('http://web-test.example.com', 'abc_123-xyz-456789')).toThrow(
      'Public invite links must use HTTPS web URLs outside localhost',
    )
    expect(resolveApiRuntimeConfig({
      TABTIN_API_BASE_URL: 'https://api.tabtin.example.com/api',
      VITE_API_BASE_URL: 'https://api.tabtin.example.com/api',
      VITE_PUBLIC_WEB_BASE_URL: 'http://web-test.example.com',
    }).publicWebBaseUrl).toBeUndefined()
  })

  it('builds fixed desktop invite deep link without accepting redirect input', () => {
    expect(buildDesktopInviteDeepLink('abc_123-xyz-456789')).toBe('tabtin://invite/abc_123-xyz-456789')
    expect(
      buildDesktopInviteDeepLink('abc_123-xyz-456789', 'https://web-test.example.com'),
    ).toBe('tabtin-preprod://invite/abc_123-xyz-456789')
    expect(
      buildDesktopInviteDeepLink('abc_123-xyz-456789', 'https://web.example.com'),
    ).toBe('tabtin://invite/abc_123-xyz-456789')
    expect(
      buildDesktopInviteDeepLink('abc_123-xyz-456789', 'http://127.0.0.1:5176'),
    ).toBe('tabtin-dev://invite/abc_123-xyz-456789')
    expect(isSupportedInviteToken('https://evil.example.com')).toBe(false)
    expect(() => buildPublicInviteBridgeUrl('https://tabtin.example.com', 'abc/../evil')).toThrow(
      'Invalid invitation token',
    )
  })

  it('keeps the official download URL centralized', () => {
    expect(TABTIN_DOWNLOAD_URL).toBe('https://www.example.com/download/')
  })
})
