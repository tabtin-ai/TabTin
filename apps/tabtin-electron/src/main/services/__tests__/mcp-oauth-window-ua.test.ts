import { describe, expect, it } from 'vitest'
import { oauthPageLooksUnsupported } from '../mcp-oauth-compat'

describe('oauthPageLooksUnsupported', () => {
  it('detects Notion incompatible browser page', () => {
    expect(
      oauthPageLooksUnsupported(
        'Your browser is not compatible with Notion. Please upgrade to the latest browser version',
      ),
    ).toBe(true)
  })

  it('ignores normal authorize copy', () => {
    expect(
      oauthPageLooksUnsupported('Allow TabTin to access your Notion workspace?'),
    ).toBe(false)
  })
})
