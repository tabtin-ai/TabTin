/**
 * 主进程 API 配置
 * 统一管理所有 API 相关配置，便于维护和跨模块使用
 *
 * 注意：这是主进程（Node.js）的配置。开发态优先使用运行时 process.env；
 * 打包态从 Vite 构建时注入的 import.meta.env 读取 URL，避免用户从 Finder
 * 启动 packaged .app 时丢失 TABTIN_API_BASE_URL / VITE_API_BASE_URL。
 * 渲染进程使用 src/renderer/src/config/api.ts（使用 import.meta.env）。
 */
import { getApiRuntimeConfig, type EnvLike } from '@tabtin/config'
import { createLogger } from '../logger'

const log = createLogger('MainApiConfig')

type MainBuildEnv = EnvLike & {
  MODE?: string
  PROD?: string
  TABTIN_DAEMON_CONTROL_API_BASE_URL?: string
  VITE_DAEMON_CONTROL_ENABLED?: string
  VITE_DISTRIBUTION_KIND?: string
}

const rawBuildTimeEnv = ((import.meta as unknown as { env?: Record<string, unknown> }).env ?? {}) as Record<string, unknown>
const readBuildEnv = (key: string): string | undefined => {
  const value = rawBuildTimeEnv[key]
  return typeof value === 'string' ? value : undefined
}

const buildTimeEnv: MainBuildEnv = {
  MODE: readBuildEnv('MODE'),
  PROD: rawBuildTimeEnv.PROD === true ? 'true' : readBuildEnv('PROD'),
  TABTIN_API_BASE_URL: readBuildEnv('TABTIN_API_BASE_URL'),
  VITE_API_BASE_URL: readBuildEnv('VITE_API_BASE_URL'),
  TABTIN_DAEMON_CONTROL_API_BASE_URL: readBuildEnv('TABTIN_DAEMON_CONTROL_API_BASE_URL'),
  VITE_DAEMON_CONTROL_ENABLED: readBuildEnv('VITE_DAEMON_CONTROL_ENABLED'),
  VITE_DISTRIBUTION_KIND: readBuildEnv('VITE_DISTRIBUTION_KIND'),
  TABTIN_WS_BASE_URL: readBuildEnv('TABTIN_WS_BASE_URL'),
  VITE_WS_BASE_URL: readBuildEnv('VITE_WS_BASE_URL'),
  TABTIN_API_TIMEOUT: readBuildEnv('TABTIN_API_TIMEOUT'),
  VITE_API_TIMEOUT: readBuildEnv('VITE_API_TIMEOUT'),
}

const packagedDistributionKind: 'official' | 'community' =
  buildTimeEnv.VITE_DISTRIBUTION_KIND === 'community' ? 'community' : 'official'
const packagedApiBaseUrl = buildTimeEnv.TABTIN_API_BASE_URL ?? buildTimeEnv.VITE_API_BASE_URL

const apiRuntimeEnv: EnvLike = {
  ...buildTimeEnv,
  ...process.env,
  TABTIN_API_BASE_URL:
    packagedDistributionKind === 'community'
      ? packagedApiBaseUrl
      : process.env.TABTIN_API_BASE_URL
        ?? buildTimeEnv.TABTIN_API_BASE_URL
        ?? buildTimeEnv.VITE_API_BASE_URL,
  VITE_API_BASE_URL:
    packagedDistributionKind === 'community'
      ? packagedApiBaseUrl
      : process.env.VITE_API_BASE_URL
        ?? buildTimeEnv.VITE_API_BASE_URL
        ?? buildTimeEnv.TABTIN_API_BASE_URL,
  TABTIN_WS_BASE_URL:
    process.env.TABTIN_WS_BASE_URL
    ?? buildTimeEnv.TABTIN_WS_BASE_URL
    ?? buildTimeEnv.VITE_WS_BASE_URL,
  VITE_WS_BASE_URL:
    process.env.VITE_WS_BASE_URL
    ?? buildTimeEnv.VITE_WS_BASE_URL
    ?? buildTimeEnv.TABTIN_WS_BASE_URL,
}

/**
 * API 基础 URL 配置
 */
const { apiBaseUrl, wsBaseUrl } = getApiRuntimeConfig(apiRuntimeEnv)

export const API_BASE_URL = apiBaseUrl
export const DISTRIBUTION_KIND = packagedDistributionKind

/**
 * API 超时配置（毫秒）
 * 可通过环境变量 TABTIN_API_TIMEOUT 自定义
 */
export const API_TIMEOUT = parseInt(
  process.env.TABTIN_API_TIMEOUT
  || process.env.VITE_API_TIMEOUT
  || buildTimeEnv.TABTIN_API_TIMEOUT
  || buildTimeEnv.VITE_API_TIMEOUT
  || '30000',
  10
)

/**
 * API Key 配置
 * 可通过环境变量 TABTIN_API_KEY 自定义
 */
export const API_KEY = process.env.TABTIN_API_KEY || ''

/**
 * WebSocket 基础 URL
 * 自动从 API_BASE_URL 推导
 */
export const WS_BASE_URL = wsBaseUrl

/**
 * API 配置对象
 */
export const API_CONFIG = {
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT,
  apiKey: API_KEY,
  headers: {
    'Content-Type': 'application/json',
  },
} as const

/**
 * 环境判断
 */
export const isDevelopment = process.env.NODE_ENV === 'development' || buildTimeEnv.MODE === 'development'
export const isProduction =
  process.env.NODE_ENV === 'production' || buildTimeEnv.MODE === 'production' || buildTimeEnv.PROD === 'true'

/** 设备控制面地址；线上默认由 API 网关按路径转发，本地可直连独立服务。 */
export const DAEMON_CONTROL_API_BASE_URL =
  process.env.TABTIN_DAEMON_CONTROL_API_BASE_URL
  || buildTimeEnv.TABTIN_DAEMON_CONTROL_API_BASE_URL
  || API_BASE_URL

export const DAEMON_CONTROL_ENABLED =
  (process.env.DAEMON_CONTROL_ENABLED || buildTimeEnv.VITE_DAEMON_CONTROL_ENABLED) === 'true'

/**
 * API 环境信息
 */
export const API_ENV = {
  isDevelopment,
  isProduction,
  baseURL: API_BASE_URL,
  wsBaseURL: WS_BASE_URL,
  nodeEnv: process.env.NODE_ENV || 'development',
} as const

/**
 * 主进程常用 API 路径
 * 与渲染进程 API_ENDPOINTS 保持同步（仅包含主进程实际使用的子集）
 */
export const MAIN_API_PATHS = {
  ORGANIZATION_LIST: '/context/organizations',
} as const

/**
 * 导出配置信息（用于调试）
 */
if (isDevelopment) {
  // 仅打非敏感配置（不含 API_KEY）
  log.info('API 配置已加载:', {
    baseURL: API_BASE_URL,
    wsBaseURL: WS_BASE_URL,
    timeout: API_TIMEOUT,
    environment: process.env.NODE_ENV,
  })
}
