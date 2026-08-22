import { describe, expect, it, vi } from 'vitest'

import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  extractChatgptAccountId,
  generatePKCE,
  refreshOpenAICodexToken,
} from '../openai-codex-oauth.js'

function accessTokenWithAccount(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url')
  return `header.${payload}.signature`
}

describe('OpenAI Codex OAuth', () => {
  it('从 access token 的 OpenAI claim 提取 ChatGPT account id', () => {
    expect(extractChatgptAccountId(accessTokenWithAccount('acct_123'))).toBe('acct_123')
    expect(extractChatgptAccountId('not-a-jwt')).toBeNull()
  })

  it('生成与 Codex CLI 对齐的 authorize URL', () => {
    const url = new URL(buildAuthorizeUrl({ challenge: 'challenge-value', state: 'state-value' }))

    expect(url.origin).toBe('https://auth.openai.com')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      redirect_uri: 'http://localhost:1455/auth/callback',
      scope: 'openid profile email offline_access',
      code_challenge: 'challenge-value',
      code_challenge_method: 'S256',
      state: 'state-value',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'tabtin',
    })
  })

  it('生成不泄露的 PKCE verifier、challenge 和 state', () => {
    const pkce = generatePKCE()

    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pkce.state).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pkce.verifier).not.toBe(pkce.challenge)
  })

  it('用授权码兑换并解析 OAuth 凭据', async () => {
    const accessToken = accessTokenWithAccount('acct_456')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: 'refresh-token',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )
    const before = Date.now()
    const credential = await exchangeAuthorizationCode({
      code: 'auth-code',
      verifier: 'verifier',
      fetchImpl: fetchMock,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    )
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(Object.fromEntries(request.body as URLSearchParams)).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      code: 'auth-code',
      code_verifier: 'verifier',
      redirect_uri: 'http://localhost:1455/auth/callback',
    })
    expect(credential).toMatchObject({
      type: 'oauth',
      access: accessToken,
      refresh: 'refresh-token',
      accountId: 'acct_456',
    })
    expect(credential.expires).toBeGreaterThanOrEqual(before + 3_599_000)
  })

  it('刷新时拒绝缺少 ChatGPT account id 的 token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'header.payload.signature',
          refresh_token: 'rotated-refresh-token',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )

    await expect(
      refreshOpenAICodexToken('refresh-token', undefined, fetchMock),
    ).rejects.toThrow('Failed to extract ChatGPT account ID from access token')
  })
})
