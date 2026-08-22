/**
 * CliCap listing 的 media 可用性门控。
 *
 * 问题：`media image generate` 等命令无条件注入 system / relevant_cli，组织关闭
 * `enable_media_image` 或后端无 image_gen 模型时，Agent 仍首轮承诺「能生图」，
 * 失败后再用 SVG / 占位图冒充交付。
 *
 * 本模块包装 `createCliListingFetcher()`：有 organizationId 时查两路信号
 * （service-catalog 开关 ∧ media catalog 模型非空），不可用则从 listing 剔除
 * 对应 `media image *` / `media video *`；两者都不可用时连 `media` 组入口 /
 * `media list` / `media catalog` 一并剔除。
 *
 * **fail-open**：任一信号查询失败 → 视为可用，返回原始 listing（绝不因门控
 * 故障把真实可用能力藏掉）。有旧缓存时优先用旧判定抗抖动。
 */

import { joinApiPath } from '@tabtin/config'
import type { CliCapFetcher, CliListing, CliCommandInfo } from '@tabtin/agent-host/capabilities'
import { TokenManager } from '../../auth.js'
import { API_BASE_URL } from '../../config/api.js'
import { createLogger } from '../../logger.js'
import { createCliListingFetcher } from './cli-listing-fetcher.js'

const log = createLogger('cli-listing-gate')

/** ：门控判定常驻缓存；组织服务目录变更时走 invalidate。 */
const FETCH_TIMEOUT_MS = 8_000

const IMAGE_TASK_TYPES = new Set(['text2image', 'image2image', 'image_edit', 'image'])
const VIDEO_TASK_TYPES = new Set(['text2video', 'image2video', 'video_edit', 'video'])

export interface MediaGateDecision {
  imageAvailable: boolean
  videoAvailable: boolean
}

interface GateCacheEntry {
  at: number
  decision: MediaGateDecision
}

const gateCache = new Map<string, GateCacheEntry>()

export interface GatedCliListingFetcherDeps {
  /** 底层 listing fetcher；缺省用 `createCliListingFetcher()`。 */
  baseFetch?: CliCapFetcher
  getAccessToken?: () => Promise<string | null>
  fetchImpl?: typeof fetch
  now?: () => number
}

function isMediaImageCommand(name: string): boolean {
  return name === 'media image' || name.startsWith('media image ')
}

function isMediaVideoCommand(name: string): boolean {
  return name === 'media video' || name.startsWith('media video ')
}

/**
 * ：统一 Resolver 上线前，临时不向 Agent 提示这些命令域。
 * 这是 listing / system prompt 的止血，不承担 Shell / Go CLI 的执行拦截。
 * memo 与 ContextRegistry / hidden-skills 的 tabmemo 止血对齐。
 */
function isTemporarilyHiddenCommand(name: string): boolean {
  return name === 'site'
    || name.startsWith('site ')
    || name === 'memo'
    || name.startsWith('memo ')
    || name === 'tabtin-demo-app'
    || name.startsWith('tabtin-demo-app ')
    || isMediaVideoCommand(name)
}

/** image+video 都不可用时一并剔除的组级入口。 */
function isMediaGroupEntry(name: string): boolean {
  return name === 'media' || name === 'media list' || name === 'media catalog'
}

/** 按门控判定过滤 commands（纯函数，便于单测）。 */
export function filterCliListingByMediaGate(
  listing: CliListing,
  decision: MediaGateDecision,
): CliListing {
  const { imageAvailable, videoAvailable } = decision
  const dropGroup = !imageAvailable && !videoAvailable
  const commands = listing.commands.filter((cmd: CliCommandInfo) => {
    const name = cmd.name
    if (isTemporarilyHiddenCommand(name)) return false
    if (!imageAvailable && isMediaImageCommand(name)) return false
    if (!videoAvailable && isMediaVideoCommand(name)) return false
    if (dropGroup && isMediaGroupEntry(name)) return false
    return true
  })

  const removed = listing.commands.length - commands.length
  if (removed > 0) {
    log.info(
      `cli listing gate filtered removed=${removed} image=${imageAvailable} video=${videoAvailable}`,
    )
  }
  return removed === 0 ? listing : { commands }
}

async function fetchJson(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const resp = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`)
  }
  return resp.json()
}

function parseServiceEnabled(payload: unknown): { image: boolean; video: boolean } {
  const root = payload as { data?: { services?: unknown } } | null
  const services = root?.data?.services
  if (!Array.isArray(services)) {
    throw new Error('service-catalog: missing data.services')
  }

  let image = true
  let video = true
  let sawImage = false
  let sawVideo = false
  for (const item of services) {
    if (!item || typeof item !== 'object') continue
    const svc = item as { service_key?: unknown; enabled?: unknown }
    if (svc.service_key === 'media.image') {
      sawImage = true
      image = svc.enabled !== false
    } else if (svc.service_key === 'media.video') {
      sawVideo = true
      video = svc.enabled !== false
    }
  }
  // 目录缺项时按后端默认开（policy 缺省 True），不因字段漂移误关。
  if (!sawImage) image = true
  if (!sawVideo) video = true
  return { image, video }
}

function parseModelAvailability(payload: unknown): { image: boolean; video: boolean } {
  const root = payload as { models?: unknown; success?: unknown } | null
  if (!root || !Array.isArray(root.models)) {
    throw new Error('media catalog: missing models[]')
  }
  let image = false
  let video = false
  for (const m of root.models) {
    if (!m || typeof m !== 'object') continue
    const taskType = (m as { task_type?: unknown }).task_type
    if (typeof taskType !== 'string') continue
    if (IMAGE_TASK_TYPES.has(taskType)) image = true
    if (VIDEO_TASK_TYPES.has(taskType)) video = true
    if (image && video) break
  }
  return { image, video }
}

async function resolveMediaGateDecision(
  organizationId: string,
  deps: Required<Pick<GatedCliListingFetcherDeps, 'getAccessToken' | 'fetchImpl' | 'now'>>,
): Promise<MediaGateDecision> {
  const cached = gateCache.get(organizationId)
  if (cached) {
    return cached.decision
  }

  try {
    const token = await deps.getAccessToken()
    if (!token) {
      throw new Error('no access token')
    }

    const serviceUrl = joinApiPath(
      API_BASE_URL,
      `/services/billing/organizations/${encodeURIComponent(organizationId)}/service-catalog`,
    )
    const mediaUrl = joinApiPath(API_BASE_URL, '/services/media/catalog')

    const [servicePayload, mediaPayload] = await Promise.all([
      fetchJson(serviceUrl, token, deps.fetchImpl),
      fetchJson(mediaUrl, token, deps.fetchImpl),
    ])

    const enabled = parseServiceEnabled(servicePayload)
    const models = parseModelAvailability(mediaPayload)
    // 两路 AND：开关开 且 有对应模型 才算可用。
    const decision: MediaGateDecision = {
      imageAvailable: enabled.image && models.image,
      videoAvailable: enabled.video && models.video,
    }
    gateCache.set(organizationId, { at: deps.now(), decision })
    return decision
  } catch (e) {
    // 入口已命中常驻缓存则不会进这里；无缓存时 fail-open。
    log.warn(
      `media gate signal failed org=${organizationId}, fail-open: ${String(e)}`,
    )
    return { imageAvailable: true, videoAvailable: true }
  }
}

/**
 * 包装底层 CLI listing fetcher，按组织 media 可用性剔除不可用命令。
 * 无 organizationId 时不做门控（直接透传）。
 *
 * ：organizationId 是 per-runtime 常量（切 Space 重建 runtime），由
 * host 在装配期烘进工厂闭包，运行时不再从 fetch context 读——CliCap 只传 `query`。
 */
export function createGatedCliListingFetcher(
  organizationId?: string,
  deps: GatedCliListingFetcherDeps = {},
): CliCapFetcher {
  const baseFetch = deps.baseFetch ?? createCliListingFetcher()
  const getAccessToken = deps.getAccessToken ?? (() => TokenManager.getAccessToken())
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const bakedOrganizationId = organizationId?.trim()

  return async (context) => {
    const listing = await baseFetch(context)
    if (!listing) return null

    if (!bakedOrganizationId) {
      return filterCliListingByMediaGate(listing, {
        imageAvailable: true,
        videoAvailable: true,
      })
    }

    const decision = await resolveMediaGateDecision(bakedOrganizationId, {
      getAccessToken,
      fetchImpl,
      now,
    })
    return filterCliListingByMediaGate(listing, decision)
  }
}

/** 组织服务目录 / media 可用性变更后失效门控（不传则全清）。 */
export function invalidateCliListingGateCache(organizationId?: string): void {
  const org = organizationId?.trim()
  if (org) {
    gateCache.delete(org)
    return
  }
  gateCache.clear()
}

/** 测试用：清空门控判定缓存。 */
export function __resetCliListingGateCacheForTesting(): void {
  gateCache.clear()
}
