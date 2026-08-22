import type { TableKernelService } from '../../platform/table/table-kernel-service.js'
import { createAuthedFetcher } from '../../platform/table/sync-api-client.js'
import { joinApiPath } from '@tabtin/config'

import type { McpContentApiPort, McpTablePort } from '../../application/mcp/ports.js'

export function createMcpContentApiPort(config: {
  apiBaseUrl: string
  getAuthToken: () => Promise<string>
  refreshToken?: () => Promise<string | null>
}): McpContentApiPort {
  const origin = config.apiBaseUrl.replace(/\/+$/, '')
  const baseUrl = origin.endsWith('/api') ? origin : `${origin}/api`
  const fetcher = createAuthedFetcher(config.getAuthToken, undefined, config.refreshToken)
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const raw = await fetcher(joinApiPath(baseUrl, path), init) as Record<string, unknown>
    return raw && typeof raw === 'object' && 'success' in raw && 'data' in raw ? raw.data : raw
  }
  return { get: (path) => request(path), request }
}

export function createMcpTablePort(kernel: TableKernelService | null): McpTablePort | undefined {
  return kernel ?? undefined
}
