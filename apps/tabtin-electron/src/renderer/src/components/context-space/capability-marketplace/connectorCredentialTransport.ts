import type { LocalMcpTransportConfig } from '@shared/types/mcp'

const PLACEHOLDER_RE_SOURCE = 'YOUR_[A-Z0-9_]+'

function hasCredentialPlaceholder(value: string): boolean {
  return new RegExp(PLACEHOLDER_RE_SOURCE).test(value)
}

/**
 * 把用户粘贴的 API Key 写进推荐货架的 stdio transport：
 * - 替换 args 里的 `YOUR_*` 占位
 * - `--header Authorization:…` / `X-api-key:…` 的值段整体换成密钥
 */
export function applyApiKeyToTransport(
  transport: LocalMcpTransportConfig,
  apiKey: string,
): LocalMcpTransportConfig {
  const trimmed = apiKey.trim()
  if (transport.kind !== 'stdio' || !trimmed) return transport

  const args = [...(transport.args ?? [])]
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--header' && args[i + 1]) {
      const header = args[i + 1]
      const colon = header.indexOf(':')
      if (colon > 0) {
        args[i + 1] = `${header.slice(0, colon + 1)}${trimmed}`
      } else if (hasCredentialPlaceholder(header)) {
        args[i + 1] = header.replace(/YOUR_[A-Z0-9_]+/g, trimmed)
      }
      i += 1
      continue
    }
    if (hasCredentialPlaceholder(arg)) {
      args[i] = arg.replace(/YOUR_[A-Z0-9_]+/g, trimmed)
    }
  }

  return { ...transport, args }
}

/** 钉钉等企业应用：写入 Client ID / Secret 到 env。 */
export function applyAppCredentialsToTransport(
  transport: LocalMcpTransportConfig,
  credentials: { clientId: string; clientSecret: string },
): LocalMcpTransportConfig {
  if (transport.kind !== 'stdio') return transport
  const clientId = credentials.clientId.trim()
  const clientSecret = credentials.clientSecret.trim()
  return {
    ...transport,
    env: {
      ...(transport.env ?? {}),
      DINGTALK_Client_ID: clientId,
      DINGTALK_Client_Secret: clientSecret,
    },
  }
}

/** GitHub 等平台 OAuth / PAT：HTTP Bearer；stdio 则写 Authorization header 参数。 */
export function applyBearerTokenToTransport(
  transport: LocalMcpTransportConfig,
  accessToken: string,
): LocalMcpTransportConfig {
  const trimmed = accessToken.trim()
  if (!trimmed) return transport
  // 已带 Bearer / token 前缀则原样写入；否则补 Bearer（GitHub MCP 约定）
  const bearer = /^(Bearer|token)\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`

  if (transport.kind === 'http') {
    return {
      ...transport,
      headers: {
        ...(transport.headers ?? {}),
        Authorization: bearer,
      },
    }
  }

  const args = [...(transport.args ?? [])]
  let replaced = false
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--header' && args[i + 1]) {
      const header = args[i + 1]
      if (/^Authorization:/i.test(header) || hasCredentialPlaceholder(header)) {
        args[i + 1] = `Authorization:${bearer}`
        replaced = true
        i += 1
      }
    }
  }
  if (!replaced) {
    args.push('--header', `Authorization:${bearer}`)
  }
  return { ...transport, args }
}

/**
 * 粘贴密钥写入 transport。
 * - stdio：替换 YOUR_* / --header 值段（天眼查等）
 * - http：写入 Authorization Bearer（GitHub PAT 本机回退）
 */
export function applyCredentialSecretToTransport(
  transport: LocalMcpTransportConfig,
  secret: string,
): LocalMcpTransportConfig {
  if (transport.kind === 'http') {
    return applyBearerTokenToTransport(transport, secret)
  }
  return applyApiKeyToTransport(transport, secret)
}

export function transportHasCredentialPlaceholder(transport: LocalMcpTransportConfig): boolean {
  if (transport.kind === 'http') {
    return Object.values(transport.headers ?? {}).some(value => hasCredentialPlaceholder(value))
  }
  const argsHit = (transport.args ?? []).some(arg => hasCredentialPlaceholder(arg))
  const envHit = Object.values(transport.env ?? {}).some(
    value => !value.trim() || hasCredentialPlaceholder(value),
  )
  return argsHit || envHit
}
