/**
 * Marketplace AppDiscovery patterns bootstrap 客户端（PRD §5.4 B3 / N5）。
 *
 * 启动时从 `GET /api/marketplace/discovery-patterns` 拉取所有 marketplace App
 * 的 `embeddedWeb.urlPatterns` 聚合（**复用既有字段，不新增 discoveryPatterns**），
 * 通过既有 IPC 通道 `app-discovery:update-patterns` 推送给主进程
 * `AppDiscoveryService`，动态发现 marketplace App URL patterns。
 *
 * **设计要点**：
 * - 后端 endpoint 为 `auth=None`，可在登录前/无 token 状态下拉取，
 *   保证用户登录前打开 TabWeb 也能识别 marketplace App。
 * - **失败兜底 = 静默不推送任何 patterns**，符合 PRD §5.4 B3
 *   "完全 API 化"诉求；AppDiscoveryService 在无 patterns 时不弹任何横幅，
 *   避免误报。
 * - `sourceId='marketplace-api'` 让主进程的 `patternsBySource` 识别为同一来源，
 *   反复拉取（如重连/重试）能干净覆盖而不污染其他来源（Space 安装列表等）。
 */

import { joinApiPath } from '@tabtin/config'
import { apiRequest } from '@/adapters/api-adapter-instance'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { createLogger } from '@/utils/logger'

const log = createLogger('MarketplaceDiscovery')

interface DiscoveryPatternEntry {
  appId: string
  appName: string
  patterns: string[]
}

interface DiscoveryPatternsResponse {
  success?: boolean
  data?: { patterns?: DiscoveryPatternEntry[] }
  patterns?: DiscoveryPatternEntry[]
}

const SOURCE_ID = 'marketplace-api'

function isValidEntry(entry: unknown): entry is DiscoveryPatternEntry {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  if (typeof e.appId !== 'string' || !e.appId) return false
  if (typeof e.appName !== 'string') return false
  if (!Array.isArray(e.patterns)) return false
  return e.patterns.every((p) => typeof p === 'string' && p.length > 0)
}

/**
 * 解析返回值：必须是后端真正返回了 ``patterns`` 字段（哪怕空数组）才算"成功"。
 *
 * 关键不变量：
 * - HTTP 200 但 body ``{success: false, code: ...}``（无 ``patterns``）→ 返回 ``null``，
 *   调用方 **不可** 推送 IPC，否则空数组会清空 ``marketplace-api`` source 已合并 patterns。
 * - body 真正含 ``patterns: []`` → 返回 ``[]``（合法的"marketplace 当前无 App 需发现"），
 *   调用方应推送以覆盖旧 source 状态。
 */
function extractPatterns(payload: unknown): DiscoveryPatternEntry[] | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as DiscoveryPatternsResponse
  // 后端在 ``i18n/response.success_response`` 里显式置 ``success: true``；
  // 若 ``success === false`` 视为业务侧失败，不再用 patterns 字段覆盖。
  if (root.success === false) return null
  const candidates: unknown[] = [
    root.data?.patterns,
    root.patterns,
    (root as { data?: { data?: { patterns?: unknown } } }).data?.data?.patterns,
  ]
  for (const cand of candidates) {
    if (Array.isArray(cand)) {
      return cand.filter(isValidEntry)
    }
  }
  return null
}

/**
 * 启动期拉取一次 marketplace patterns 并推送给主进程。
 *
 * 调用方应在 renderer 启动入口 (`main.tsx`) 调用一次，fire-and-forget。
 * 不阻塞 UI、不抛错；失败时记录 console.warn 并静默退出。
 */
export async function bootstrapMarketplaceDiscoveryPatterns(): Promise<void> {
  // 仅在 Electron 环境（有 ipcRenderer）下生效；纯 web/mobile 渲染入口跳过。
  if (typeof window === 'undefined') return
  const ipc = window.electron?.ipcRenderer
  if (!ipc) return

  try {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.MARKETPLACE.DISCOVERY_PATTERNS}`)
    const response = await apiRequest({ url, method: 'GET' })
    if (!response || (typeof response.status === 'number' && response.status >= 400)) {
      log.warn('discovery-patterns API responded with status', response?.status)
      return
    }
    const patterns = extractPatterns(response.data ?? response)
    if (patterns === null) {
      // body 是 {success:false} 或缺失 patterns 字段 → 业务失败，不可推空数组覆盖 source
      log.warn('discovery-patterns response missing patterns field; skipping IPC push')
      return
    }
    // 真正的空数组 (patterns: []) 也要推送，覆盖此 source 残留旧状态。
    log.info(`pushing ${patterns.length} discovery pattern group(s) to main`)
    ipc.send('app-discovery:update-patterns', patterns, SOURCE_ID)
  } catch (err) {
    log.warn('failed to bootstrap discovery patterns; falling back to no-op', err)
  }
}

export const __test__ = { extractPatterns, isValidEntry, SOURCE_ID }
