import { UAPool, DESKTOP_UA_POOL, MOBILE_UA_POOL, TABLET_UA_POOL, ProxyHealthChecker, type ProxyHealthResult } from '@tabtin/anti-detect'
import { ToolErrorCode, ToolErrorFactory, type ToolError } from '../types/errors'
import { t } from '../i18n'

export interface GetRandomUAInput {
  platform?: 'desktop' | 'mobile' | 'tablet'
  userAgents?: string[]
  rotation?: 'random' | 'sequential'
}

export interface GetRandomUAOutput {
  success: boolean
  data?: { userAgent: string }
  error?: ToolError
}

export interface CheckProxyHealthInput {
  proxy: any
  timeoutMs?: number
}

export interface CheckProxyHealthOutput {
  success: boolean
  data?: {
    healthy: boolean
    health?: 'healthy' | 'degraded' | 'unhealthy'
    latencyMs?: number
    httpDiagnostics?: string
  }
  error?: ToolError
}

/**
 * AntiDetectToolImpl - 轻量封装 UA 池与代理健康检查
 */
export class AntiDetectToolImpl {
  private uaPools = new Map<string, UAPool>()

  private resolveUAList(platform?: string, userAgents?: string[]): string[] | undefined {
    if (userAgents && userAgents.length > 0) return userAgents
    switch (platform) {
      case 'desktop': return [...DESKTOP_UA_POOL]
      case 'mobile': return [...MOBILE_UA_POOL]
      case 'tablet': return [...TABLET_UA_POOL]
      default: return undefined
    }
  }

  getRandomUA(input: GetRandomUAInput): GetRandomUAOutput {
    try {
      const key = `${input.platform || 'all'}-${input.rotation || 'random'}`
      if (!this.uaPools.has(key)) {
        const uaList = this.resolveUAList(input.platform, input.userAgents)
        const pool = new UAPool(uaList, input.rotation)
        this.uaPools.set(key, pool)
      }
      const ua = this.uaPools.get(key)!.next()
      return { success: true, data: { userAgent: ua } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: ToolErrorFactory.fatal(ToolErrorCode.UNKNOWN_ERROR, message) }
    }
  }

  async checkProxyHealth(input: CheckProxyHealthInput): Promise<CheckProxyHealthOutput> {
    try {
      const checker = new ProxyHealthChecker()
      const result = await checker.check(input.proxy, input.timeoutMs)
      if (!result.healthy) {
        const message = result.error || result.httpDiagnostics || t('errors.proxyUnavailable')
        return {
          success: false,
          error: ToolErrorFactory.retriable(ToolErrorCode.NETWORK_ERROR, message),
        }
      }
      return {
        success: true,
        data: { healthy: true, health: result.health, latencyMs: result.latencyMs }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        error: ToolErrorFactory.retriable(ToolErrorCode.NETWORK_ERROR, message),
      }
    }
  }
}

let sharedImpl: AntiDetectToolImpl | null = null
export function getSharedAntiDetectToolImpl(): AntiDetectToolImpl {
  if (!sharedImpl) {
    sharedImpl = new AntiDetectToolImpl()
  }
  return sharedImpl
}
