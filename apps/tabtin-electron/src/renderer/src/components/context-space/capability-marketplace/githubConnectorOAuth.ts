/**
 * GitHub 连接器平台 OAuth（方案 A）：
 * Electron 生成 PKCE → Django 保管 secret 换票 → 一次性 ticket 领取令牌。
 */

import { createJsonApiClient } from '@/services/jsonApiClient'

export class GitHubConnectorOAuthError extends Error {
  statusCode: number
  errorCode?: string

  constructor(message: string, statusCode = 500, errorCode?: string) {
    super(message)
    this.name = 'GitHubConnectorOAuthError'
    this.statusCode = statusCode
    this.errorCode = errorCode
  }
}

const { request } = createJsonApiClient({
  base: '/integrations/github',
  loggerName: 'GitHubConnectorOAuth',
  makeError: (message, statusCode, errorCode) =>
    new GitHubConnectorOAuthError(message, statusCode, errorCode),
})

export type GitHubPkceSession = {
  state: string
  codeVerifier: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

/** 使用 Web Crypto，禁止 Math.random。 */
export async function generateGitHubPkce(): Promise<GitHubPkceSession> {
  const codeVerifier = randomBase64Url(32)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier),
  )
  return {
    state: randomBase64Url(32),
    codeVerifier,
    codeChallenge: bytesToBase64Url(new Uint8Array(digest)),
    codeChallengeMethod: 'S256',
  }
}

export async function getGitHubOAuthStatus(): Promise<{ configured: boolean }> {
  return request<{ configured?: boolean }>({
    path: '/oauth/status',
    method: 'GET',
  }).then(data => ({ configured: Boolean(data?.configured) }))
}

/**
 * 平台未配置 OAuth App 时（本机常见），改走粘贴 PAT，避免用户去注册 GitHub App。
 * 非平台 OAuth 连接器恒为 false。
 */
export async function shouldUseGitHubPatFallback(
  entry: { oauthHost?: string } | null | undefined,
): Promise<boolean> {
  if (entry?.oauthHost !== 'tabtin_backend') return false
  try {
    const status = await getGitHubOAuthStatus()
    return !status.configured
  } catch {
    // 探测失败时宁可走 PAT，也不要卡在「未配置 OAuth App」失败页
    return true
  }
}

export async function startGitHubConnectorOAuth(input: {
  organizationId: string
  pkce: GitHubPkceSession
  returnDeepLink?: string
}): Promise<string> {
  const data = await request<{ authorize_url?: string }>({
    path: '/oauth/start',
    method: 'POST',
    body: {
      organization_id: input.organizationId,
      state: input.pkce.state,
      code_challenge: input.pkce.codeChallenge,
      code_verifier: input.pkce.codeVerifier,
      code_challenge_method: input.pkce.codeChallengeMethod,
      return_deep_link: input.returnDeepLink ?? 'tabtin://integrations/github/oauth',
    },
  })
  const url = data?.authorize_url?.trim()
  if (!url) {
    throw new GitHubConnectorOAuthError('OAuth start missing authorize_url', 500)
  }
  return url
}

export type GitHubOAuthClaim = {
  accessToken: string
  tokenType: string
  scope: string
  login: string
  organizationId: string
}

export async function claimGitHubConnectorOAuth(ticket: string): Promise<GitHubOAuthClaim> {
  const data = await request<{
    access_token?: string
    token_type?: string
    scope?: string
    login?: string
    organization_id?: string
  }>({
    path: '/oauth/claim',
    method: 'POST',
    body: { ticket },
  })
  const accessToken = data?.access_token?.trim()
  if (!accessToken) {
    throw new GitHubConnectorOAuthError('OAuth claim missing access_token', 500)
  }
  return {
    accessToken,
    tokenType: data?.token_type || 'bearer',
    scope: data?.scope || '',
    login: data?.login || '',
    organizationId: data?.organization_id || '',
  }
}

/**
 * 完整授权：start → 应用内窗等 ticket → claim。
 * deep link 与窗口导航竞速，任一先拿到 ticket 即可。
 */
export async function runGitHubConnectorOAuth(input: {
  organizationId: string
  timeoutMs?: number
}): Promise<GitHubOAuthClaim> {
  const status = await getGitHubOAuthStatus()
  if (!status.configured) {
    throw new GitHubConnectorOAuthError(
      '服务端尚未配置 GitHub OAuth App（GITHUB_OAUTH_CLIENT_ID/SECRET）',
      503,
      'github_oauth_not_configured',
    )
  }

  const pkce = await generateGitHubPkce()
  const authorizeUrl = await startGitHubConnectorOAuth({
    organizationId: input.organizationId,
    pkce,
  })

  const timeoutMs = input.timeoutMs ?? 180_000
  const ticket = await raceGitHubOAuthTicket(authorizeUrl, timeoutMs)
  return claimGitHubConnectorOAuth(ticket)
}

function raceGitHubOAuthTicket(authorizeUrl: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanups: Array<() => void> = []

    const finish = (value: string | Error) => {
      if (settled) return
      settled = true
      try {
        void window.tabtin?.localMcp?.closePlatformOAuthWindow?.()
      } catch {
        // ignore
      }
      for (const cleanup of cleanups) {
        try {
          cleanup()
        } catch {
          // ignore
        }
      }
      if (value instanceof Error) reject(value)
      else resolve(value)
    }

    const timer = setTimeout(() => {
      finish(new Error('授权超时，请重试'))
    }, timeoutMs)
    cleanups.push(() => clearTimeout(timer))

    const unsub = window.tabtin?.deepLink?.onDeepLink?.((data: { path: string; url: string }) => {
      if (!data.path.includes('integrations/github/oauth') && !data.url.includes('integrations/github/oauth')) {
        return
      }
      try {
        const normalized = data.url.startsWith('tabtin://')
          ? data.url.replace(/^tabtin:\/\//, 'https://tabtin.local/')
          : data.url
        const ticket = new URL(normalized).searchParams.get('ticket')
        if (ticket && ticket.length >= 16) finish(ticket)
      } catch {
        // ignore
      }
    })
    if (typeof unsub === 'function') cleanups.push(unsub)

    const wait = window.tabtin?.localMcp?.waitForPlatformOAuthTicket
    if (!wait) {
      finish(new Error('本机客户端不支持平台 OAuth 窗口'))
      return
    }
    void wait({
      authorizeUrl,
      donePathIncludes: '/integrations/github/oauth/done',
      timeoutMs,
    })
      .then(result => {
        if (result?.ticket) finish(result.ticket)
        else finish(new Error('未收到授权凭证'))
      })
      .catch(err => {
        finish(err instanceof Error ? err : new Error(String(err)))
      })
  })
}
