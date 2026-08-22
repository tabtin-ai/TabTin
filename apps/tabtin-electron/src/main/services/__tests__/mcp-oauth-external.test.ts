import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({
  openExternal: vi.fn<() => Promise<void>>(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/tabtin-oauth-test') },
  shell: { openExternal },
}))

import {
  consumePlatformOAuthDeepLink,
  openConnectorOAuthWindow,
  waitForPlatformOAuthTicket,
} from '../mcp-oauth-window'

describe('connector oauth external browser', () => {
  beforeEach(() => {
    openExternal.mockReset()
    openExternal.mockResolvedValue(undefined)
  })

  it('opens standard MCP OAuth in the system browser', async () => {
    openConnectorOAuthWindow('https://api.supabase.com/v1/oauth/authorize?state=secret')
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    expect(openExternal).toHaveBeenCalledWith(
      'https://api.supabase.com/v1/oauth/authorize?state=secret',
    )
  })

  it('resolves platform OAuth from the tabtin deep link', async () => {
    const pending = waitForPlatformOAuthTicket({
      authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=test',
      timeoutMs: 1_000,
    })
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))

    expect(consumePlatformOAuthDeepLink(
      'tabtin://integrations/github/oauth?ticket=1234567890abcdef&login=octocat',
    )).toBe(true)
    await expect(pending).resolves.toEqual({ ticket: '1234567890abcdef', login: 'octocat' })
  })

  it('does not consume unrelated deep links', async () => {
    const pending = waitForPlatformOAuthTicket({
      authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=test',
      timeoutMs: 1_000,
    })
    expect(consumePlatformOAuthDeepLink('tabtin://invite/example')).toBe(false)
    expect(consumePlatformOAuthDeepLink(
      'tabtin://integrations/github/oauth?ticket=abcdef1234567890',
    )).toBe(true)
    await expect(pending).resolves.toEqual({ ticket: 'abcdef1234567890' })
  })
})
