import { buildPublicInviteBridgeUrl, resolveApiRuntimeConfig, joinApiPath } from '@tabtin/config'

const optionalEnv = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const getBrowserOrigin = (): string | undefined => {
  if (typeof window === 'undefined') return undefined
  if (!/^https?:$/.test(window.location.protocol)) return undefined
  return window.location.origin
}

const runtimeConfig =
  typeof window !== 'undefined' ? window.__TABTIN_RUNTIME_CONFIG__ : undefined
const runtimeCollabWsBase = optionalEnv(runtimeConfig?.COLLAB_WS_BASE)
const browserOrigin = getBrowserOrigin()

const resolvedApiBaseUrl =
  optionalEnv(runtimeConfig?.API_BASE_URL)
  ?? optionalEnv(import.meta.env.VITE_API_BASE_URL)
  ?? (browserOrigin ? `${browserOrigin}/api` : '/api')
const resolvedPublicWebBaseUrl =
  optionalEnv(runtimeConfig?.PUBLIC_WEB_BASE_URL)
  ?? optionalEnv(import.meta.env.VITE_PUBLIC_WEB_BASE_URL)
  ?? browserOrigin

let _apiBaseUrl: string = resolvedApiBaseUrl
let _chatApiBaseUrl: string = `${resolvedApiBaseUrl}/chat`
let _publicWebBaseUrl: string | undefined = resolvedPublicWebBaseUrl

try {
  const config = resolveApiRuntimeConfig({
    ...(import.meta.env as Record<string, string | undefined>),
    TABTIN_API_BASE_URL: resolvedApiBaseUrl,
    VITE_API_BASE_URL: resolvedApiBaseUrl,
    TABTIN_PUBLIC_WEB_BASE_URL: resolvedPublicWebBaseUrl,
    VITE_PUBLIC_WEB_BASE_URL: resolvedPublicWebBaseUrl,
  })
  _apiBaseUrl = config.apiBaseUrl
  _chatApiBaseUrl = config.chatApiBaseUrl
  _publicWebBaseUrl = config.publicWebBaseUrl ?? resolvedPublicWebBaseUrl
} catch {
  // Keep browser/runtime fallbacks available even if shared config validation rejects
  // an incomplete local setup.
}

export const API_BASE_URL = _apiBaseUrl
export const CHAT_API_BASE_URL = _chatApiBaseUrl
export const PUBLIC_WEB_BASE_URL =
  _publicWebBaseUrl
  ?? (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
    ? window.location.origin
    : undefined)

type PublicShareResourceType = 'doc' | 'table'

const PUBLIC_SHARE_PATHS: Record<PublicShareResourceType, string> = {
  doc: '/shared/docs/',
  table: '/shared/tables/',
}

export function buildPublicShareUrlPrefix(resourceType: PublicShareResourceType): string | undefined {
  if (!PUBLIC_WEB_BASE_URL) return undefined
  return `${PUBLIC_WEB_BASE_URL}${PUBLIC_SHARE_PATHS[resourceType]}`
}

/**
 * HTML 块「在浏览器打开」稳定地址。
 * 身份 = documentId + blockId；可选附带当前文档 share_id（外链鉴权用，密码不进 query）。
 * ``fileId`` 为协作未落库时的短期 hint（成员 ACL / 已校验 DocumentShare + FileUsage）。
 */
export function buildHtmlBlockBrowserUrl(
  documentId: string,
  blockId: string,
  shareId?: string | null,
  fileId?: string | null,
): string | undefined {
  if (!PUBLIC_WEB_BASE_URL) return undefined
  const base = PUBLIC_WEB_BASE_URL.replace(/\/$/, '')
  const path =
    `/shared/docs/${encodeURIComponent(documentId)}` +
    `/html/${encodeURIComponent(blockId)}`
  const params = new URLSearchParams()
  if (shareId) params.set('share_id', shareId)
  if (fileId) params.set('file_id', fileId)
  const query = params.toString()
  return query ? `${base}${path}?${query}` : `${base}${path}`
}

export function buildPublicInviteUrl(token: string): string {
  const url = buildPublicInviteBridgeUrl(PUBLIC_WEB_BASE_URL, token)
  if (!url) {
    throw new Error('Public web base URL is required to create invite links')
  }
  return url
}

export function buildApiUrl(path: string): string {
  return joinApiPath(API_BASE_URL || '/api', path)
}

export const COLLAB_WS_BASE =
  runtimeCollabWsBase
  ?? optionalEnv(import.meta.env.VITE_COLLAB_WS_BASE)
  ?? ''

export const CENTRIFUGO_WS_URL =
  optionalEnv(runtimeConfig?.CENTRIFUGO_WS_URL)
  ?? optionalEnv(import.meta.env.VITE_CENTRIFUGO_WS_URL)
  ?? ''

export const COLLAB_WS_URLS = {
  docs: runtimeCollabWsBase
    ? `${runtimeCollabWsBase}/collaboration`
    : optionalEnv(import.meta.env.VITE_COLLAB_WS_URL) ?? `${COLLAB_WS_BASE}/collaboration`,
  table: runtimeCollabWsBase
    ? `${runtimeCollabWsBase}/table-collaboration`
    : optionalEnv(import.meta.env.VITE_TABLE_COLLAB_WS_URL) ?? `${COLLAB_WS_BASE}/table-collaboration`,
} as const

export const TABLE_COLLAB_DISABLED =
  (import.meta.env.VITE_TABLE_COLLAB_DISABLED as string | undefined) === 'true'
