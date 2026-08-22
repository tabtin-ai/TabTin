/**
 * McpCap 的宿主 fetcher（；#9463 常驻 + invalidate）。
 *
 * 工具清单缓存在 {@link CatalogStore}；LocalMcpService 仍为本机 Port。
 */

import {
  createMcpListingFetcherFromCatalog,
  type McpListingPorts,
} from '@tabtin/agent-host/state'
import type { McpListing } from '@tabtin/agent-host/capabilities'
import {
  getLocalMcpService,
  type LocalMcpService,
  type McpToolCacheInvalidation,
} from '../../services/LocalMcpService.js'
import { createLogger } from '../../logger.js'
import { resolveCatalogStore } from './cli-commands-materializer.js'

const log = createLogger('mcp-listing-fetcher')

let subscribedService: LocalMcpService | null = null
let unsubscribeInvalidation: (() => void) | null = null

export function resetMcpListingFetcherForTest(): void {
  resolveCatalogStore().resetMcpForTesting()
  unsubscribeInvalidation?.()
  unsubscribeInvalidation = null
  subscribedService = null
}

function ensureInvalidationSubscription(
  service: LocalMcpService,
  catalog: ReturnType<typeof resolveCatalogStore>,
): void {
  if (subscribedService === service) return
  unsubscribeInvalidation?.()
  subscribedService = service
  unsubscribeInvalidation = service.onToolCacheInvalidated(
    (event: McpToolCacheInvalidation) => {
      catalog.invalidateMcpCache(event)
      // ：失效后立刻重拉，保持宿主常驻目录热。
      const agentIds = event.agentIds?.length
        ? [...new Set(event.agentIds.map((id) => id.trim()).filter(Boolean))]
        : []
      for (const agentId of agentIds) {
        void createMcpListingFetcher(agentId)({}).catch((error) => {
          log.warn(
            `mcp rewarm after invalidate failed agent=${agentId}: ${String(error)}`,
          )
        })
      }
    },
  )
}

function buildMcpPorts(): McpListingPorts {
  const svc = getLocalMcpService()
  return {
    listAttachedServers: (agentId) => svc.listAttachedServers(agentId),
    listAttachedTools: (agentId) => svc.listAttachedTools(agentId),
  }
}

/**
 * agentId 是 per-runtime 会话执行身份，由 host 在
 * 装配期烘进工厂闭包，运行时不再从 fetch context 读——McpCap 只传 `query`。
 */
export function createMcpListingFetcher(agentId?: string): (context: {
  query?: string
}) => Promise<McpListing | null> {
  return async () => {
    const catalog = resolveCatalogStore()
    const svc = getLocalMcpService()
    ensureInvalidationSubscription(svc, catalog)
    return createMcpListingFetcherFromCatalog(
      catalog,
      agentId,
      buildMcpPorts(),
      (message) => log.warn(message),
    )({})
  }
}
