/**
 * 本机 HTTP 连接 → 组织 remote MCP 创建 payload（纯函数，main / renderer 共用）。
 * Authorization 走 credential_value（后端 Fernet）；其余 headers 进 config。
 */

import type { LocalMcpConnectionDetail, LocalMcpTransportConfig } from '../types/mcp'

export interface OrgMcpShareCreatePayload {
  name: string
  description?: string
  endpoint: string
  config?: Record<string, unknown>
  credential_value?: string | null
  credential_name?: string | null
  enabled?: boolean
}

export function assertHttpShareable(transportKind: string): void {
  if (transportKind !== 'http') {
    throw new Error('MCP_ERR:ONLY_HTTP_SHAREABLE')
  }
}

export function buildOrgSharePayloadFromHttpDetail(
  detail: Pick<LocalMcpConnectionDetail, 'name' | 'description' | 'transport'>,
): OrgMcpShareCreatePayload {
  assertHttpShareable(detail.transport.kind)
  if (detail.transport.kind !== 'http') {
    throw new Error('MCP_ERR:ONLY_HTTP_SHAREABLE')
  }

  const headers = { ...(detail.transport.headers ?? {}) }
  let credentialValue: string | undefined
  let credentialHeader: string | undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization' && value) {
      credentialValue = value
      credentialHeader = key
      delete headers[key]
      break
    }
  }

  const config: Record<string, unknown> = {}
  if (Object.keys(headers).length > 0) {
    config.headers = headers
  }
  if (credentialHeader) {
    config.credential_header = credentialHeader
  }

  return {
    name: detail.name.trim(),
    description: detail.description?.trim() || undefined,
    endpoint: detail.transport.url.trim(),
    config,
    credential_value: credentialValue,
    enabled: true,
  }
}

const REDACTED_SECRET = '***'

/** 回传 renderer 前剥离敏感 header 值（键名保留，便于 UI 展示）。 */
export function redactTransportSecrets(
  transport: LocalMcpTransportConfig,
): LocalMcpTransportConfig {
  if (transport.kind !== 'http' || !transport.headers) return transport
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(transport.headers)) {
    headers[key] = key.toLowerCase() === 'authorization' ? REDACTED_SECRET : value
  }
  return { ...transport, headers }
}
