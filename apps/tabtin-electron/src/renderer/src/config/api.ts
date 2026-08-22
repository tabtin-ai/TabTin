/**
 * API 配置
 * 统一管理所有 API 相关配置，便于维护和跨模块使用
 */
import {
  API_ENDPOINTS as BASE_API_ENDPOINTS,
  buildPublicInviteBridgeUrl,
  getApiRuntimeConfig,
  type EnvLike,
} from '@tabtin/config'
import { logger } from '@/utils/logger'

// 环境判断
const isDevelopment = import.meta.env.DEV
const isProduction = import.meta.env.PROD

/**
 * API 基础 URL 配置
 */
const { apiBaseUrl, publicWebBaseUrl } = getApiRuntimeConfig(import.meta.env as unknown as EnvLike)

export const API_BASE_URL = apiBaseUrl
/** 账号设备控制面；构建配置由 TABTIN_DAEMON_CONTROL_API_BASE_URL 单向映射。 */
export const DAEMON_CONTROL_API_BASE_URL =
  import.meta.env.VITE_DAEMON_CONTROL_API_BASE_URL?.trim() || apiBaseUrl
export const PUBLIC_WEB_BASE_URL =
  publicWebBaseUrl
  ?? (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
    ? window.location.origin
    : undefined)
const configuredWebsiteBaseUrl = import.meta.env.VITE_WEBSITE_BASE_URL?.trim()
export const WEBSITE_BASE_URL = (configuredWebsiteBaseUrl || 'https://www.example.com').replace(/\/+$/, '')
export type PublicShareResourceType = 'doc' | 'table'

export function buildWebsiteUrl(pathname: string): string {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  return `${WEBSITE_BASE_URL}${normalizedPath}`
}

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
 * ``fileId`` 仅作协作未落库时的成员 ACL 短期 hint。
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

/** tabweb 默认拦私有 host；dev 的 PUBLIC_WEB（如 127.0.0.1:5176）需显式放行。 */
export function isTrustedPublicWebUrl(url: string): boolean {
  if (!PUBLIC_WEB_BASE_URL) return false
  try {
    const target = new URL(url.trim())
    const base = new URL(PUBLIC_WEB_BASE_URL)
    return target.origin === base.origin
  } catch {
    return false
  }
}

/**
 * Electron → tabweb 一次性登录交接。
 * 用 hash 携带 access token（不进 HTTP 请求）；SharedHtmlPage 读取后立刻 strip。
 */
export function withTabtinWebAuthHandoff(url: string, accessToken: string): string {
  const token = accessToken.trim()
  if (!token || !url.trim()) return url
  try {
    const parsed = new URL(url)
    parsed.hash = `tabtin_handoff=${encodeURIComponent(token)}`
    return parsed.toString()
  } catch {
    return url
  }
}

export function buildPublicInviteUrl(token: string): string {
  const url = buildPublicInviteBridgeUrl(PUBLIC_WEB_BASE_URL, token)
  if (!url) {
    throw new Error('Public web base URL is required to create invite links')
  }
  return url
}

/**
 * API 超时配置（毫秒）
 * 可通过环境变量 VITE_API_TIMEOUT 自定义
 */
export const API_TIMEOUT = parseInt(import.meta.env.VITE_API_TIMEOUT || '30000', 10)

/**
 * API 配置对象
 */
export const API_CONFIG = {
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT,
  headers: {
    'Content-Type': 'application/json',
  },
} as const

export const API_ENDPOINTS = {
  ...BASE_API_ENDPOINTS,
  AGENT_SPACE: BASE_API_ENDPOINTS.SPACE,
  DEVICE: {
    ...BASE_API_ENDPOINTS.DEVICE,
    /** @deprecated 设备绑定走 Space；兼容旧调用点 → BIND_SPACE */
    BIND_AGENT_SPACE: BASE_API_ENDPOINTS.DEVICE.BIND_SPACE,
  },
  TABLE: {
    ...BASE_API_ENDPOINTS.TABLE,
    LIST_BY_AGENT_SPACE: BASE_API_ENDPOINTS.TABLE.LIST_BY_SPACE,
    CREATE_IN_AGENT_SPACE: BASE_API_ENDPOINTS.TABLE.CREATE_IN_SPACE,
  },
  LLM: {
    // 草稿态预热到上游 provider 的连接，省首条消息 TCP+TLS 握手。
    WARMUP: '/llm/warmup',
  },
} as const

/**
 * Collab WS URL 配置
 * 各 App 统一从此处读取 WebSocket 地址，避免在各组件中分散硬编码
 */
const COLLAB_WS_BASE = import.meta.env.VITE_COLLAB_WS_BASE ?? 'ws://localhost:4100'

export const COLLAB_WS_URLS = {
  docs: import.meta.env.VITE_COLLAB_WS_URL ?? `${COLLAB_WS_BASE}/collaboration`,
  table: import.meta.env.VITE_TABLE_COLLAB_WS_URL ?? `${COLLAB_WS_BASE}/table-collaboration`,
  slide: import.meta.env.VITE_SLIDE_COLLAB_WS_URL ?? `${COLLAB_WS_BASE}/slide-collaboration`,
  video: import.meta.env.VITE_VIDEO_COLLAB_WS_URL ?? `${COLLAB_WS_BASE}/video-collaboration`,
  design: import.meta.env.VITE_DESIGN_COLLAB_WS_URL ?? `${COLLAB_WS_BASE}/design-collaboration`,
  canvas: import.meta.env.VITE_CANVAS_COLLAB_WS_URL ?? `${COLLAB_WS_BASE}/canvas-collaboration`,
} as const

/**
 * API 环境信息
 */
export const API_ENV = {
  isDevelopment,
  isProduction,
  baseURL: API_BASE_URL,
} as const

/**
 * 导出配置信息（用于调试）
 */
if (isDevelopment) {
  logger.debug('API 配置已加载:', {
    baseURL: API_BASE_URL,
    timeout: API_TIMEOUT,
    environment: isProduction ? 'production' : 'development',
  })
}
