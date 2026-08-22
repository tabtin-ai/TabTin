import { createHash, randomBytes } from 'node:crypto'

import {
  openAICodexFetch,
  type OpenAICodexFetch,
} from './openai-codex-http.js'

export const OPENAI_CODEX_PROVIDER_ID = 'openai-codex'

export type OpenAICodexOAuthCredential = {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
}

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const AUTH_BASE = 'https://auth.openai.com'
export const REDIRECT_URI = 'http://localhost:1455/auth/callback'
export const SCOPE = 'openid profile email offline_access'

const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize`
const TOKEN_URL = `${AUTH_BASE}/oauth/token`
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

export type OpenAICodexPKCE = {
  verifier: string
  challenge: string
  state: string
}

type TokenResponse = {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
}

export function extractChatgptAccountId(accessToken: string): string | null {
  try {
    const payload = accessToken.split('.')[1]
    if (!payload) return null
    const decoded = Buffer.from(payload, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as Record<string, unknown>
    const auth = parsed[JWT_CLAIM_PATH]
    if (!auth || typeof auth !== 'object') return null
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id
    return typeof accountId === 'string' && accountId.length > 0 ? accountId : null
  } catch {
    return null
  }
}

export function buildAuthorizeUrl(pkce: { challenge: string; state: string }): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', pkce.state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', 'tabtin')
  return url.toString()
}

export function generatePKCE(): OpenAICodexPKCE {
  const verifier = randomBytes(32).toString('base64url')
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url'),
  }
}

export async function exchangeAuthorizationCode(input: {
  code: string
  verifier: string
  redirectUri?: string
  signal?: AbortSignal
  fetchImpl?: OpenAICodexFetch
}): Promise<OpenAICodexOAuthCredential> {
  const response = await (input.fetchImpl ?? openAICodexFetch)(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri ?? REDIRECT_URI,
    }),
    signal: input.signal,
  })
  return parseTokenResponse(response, 'authorization code exchange')
}

export async function refreshOpenAICodexToken(
  refreshToken: string,
  signal?: AbortSignal,
  fetchImpl: OpenAICodexFetch = openAICodexFetch,
): Promise<OpenAICodexOAuthCredential> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
    signal,
  })
  return parseTokenResponse(response, 'refresh')
}

async function parseTokenResponse(
  response: Response,
  operation: string,
): Promise<OpenAICodexOAuthCredential> {
  if (!response.ok) {
    throw new Error(`OpenAI Codex token ${operation} failed (${response.status})`)
  }

  const token = (await response.json()) as TokenResponse
  if (
    typeof token.access_token !== 'string' ||
    typeof token.refresh_token !== 'string' ||
    typeof token.expires_in !== 'number' ||
    !Number.isFinite(token.expires_in)
  ) {
    throw new Error(`OpenAI Codex token ${operation} response is missing required fields`)
  }

  const accountId = extractChatgptAccountId(token.access_token)
  if (!accountId) {
    throw new Error('Failed to extract ChatGPT account ID from access token')
  }

  return {
    type: 'oauth',
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000,
    accountId,
  }
}
