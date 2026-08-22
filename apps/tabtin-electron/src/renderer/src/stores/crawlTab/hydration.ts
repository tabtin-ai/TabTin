/**
 * Crawl Tab Store — hydration & merge pure functions.
 *
 * These are used by the zustand `persist.merge` callback to normalize
 * data from localStorage and derive transient state (cold-start flags,
 * config index, context cache).
 *
 * Also contains `readPersistedSeedsFromStorage` — a direct localStorage
 * fallback used by CrawlspaceWorkspace when zustand hydration hasn't
 * completed yet.
 */

import i18n from '@/i18n'
import type {
  CrawlTab,
  CrawlTabKind,
  CrawlspaceConfig,
  CrawlspaceContextCache,
  CrawlspacePersistedViewSeed,
} from './types'
import { PERSIST_KEYS } from '../persist-key-registry'
import { buildSessionPartition, getPartitionForSpaceSync } from '../browserEnvSnapshot'
import type { OpenIntentHints } from '@shared/open-intent'

// ---------------------------------------------------------------------------
// readPersistedSeedsFromStorage — direct localStorage fallback
// ---------------------------------------------------------------------------

export function readPersistedSeedsFromStorage(crawlspaceId: string): CrawlspacePersistedViewSeed[] {
  try {
    const raw = localStorage.getItem(PERSIST_KEYS.crawlTabs)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const state = parsed?.state ?? parsed
    const seeds = state?.crawlspacePersistedViews?.[crawlspaceId]
    if (!Array.isArray(seeds)) return []
    return seeds.filter((s: any) => typeof s?.viewId === 'string' && s.viewId)
  } catch {
    return []
  }
}

function normalizeOpenIntentHints(raw: unknown): OpenIntentHints | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const hints: OpenIntentHints = {}
  if (typeof value.filename === 'string' && value.filename.trim()) {
    hints.filename = value.filename
  }
  if (typeof value.mimeType === 'string' && value.mimeType.trim()) {
    hints.mimeType = value.mimeType
  }
  if (typeof value.assetId === 'string' && value.assetId.trim()) {
    hints.assetId = value.assetId
  }
  return Object.keys(hints).length > 0 ? hints : undefined
}

// ---------------------------------------------------------------------------
// merge() hydration helpers
// ---------------------------------------------------------------------------

export function ensureDate(value: any): Date {
  if (value instanceof Date) return value
  const parsed = value ? new Date(value) : new Date()
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

export function normalizeTabs(rawTabs: any[]): CrawlTab[] {
  return rawTabs.map((tab: any, index: number) => {
    const rawUrl = tab?.url
    const rawName = tab?.name
    const rawKind = tab?.kind

    const normalizedUrl =
      typeof rawUrl === 'string'
        ? rawUrl
        : rawUrl && typeof rawUrl === 'object'
          ? String((rawUrl as any).url ?? '')
          : ''

    const normalizedName =
      typeof rawName === 'string'
        ? rawName
        : rawName && typeof rawName === 'object'
          ? String((rawName as any).name ?? i18n.t('context:label.untitledTab'))
          : i18n.t('context:label.untitledTab')

    const hasWorkspaceConfig = Boolean(
      tab?.metadata?.crawlspaceConfig &&
      typeof tab?.metadata?.crawlspaceConfig === 'object',
    )
    const normalizedKind: CrawlTabKind =
      rawKind === 'temporary' || rawKind === 'normal' || rawKind === 'workspace'
        ? rawKind
        : hasWorkspaceConfig
          ? 'workspace'
          : 'normal'

    const normalizedTab: CrawlTab = {
      ...tab,
      id: tab?.id || `tab-${Date.now()}-${index}`,
      name: normalizedName,
      url: normalizedUrl,
      createdAt: ensureDate(tab?.createdAt),
      updatedAt: ensureDate(tab?.updatedAt),
      temporary: Boolean(tab?.temporary),
      autoClose: Boolean(tab?.autoClose),
      kind: normalizedKind,
    } as CrawlTab

    if (normalizedKind === 'workspace') {
      const rawConfig = (normalizedTab.metadata as any)?.crawlspaceConfig
      if (rawConfig && typeof rawConfig === 'object') {
        const config = { ...rawConfig }
        config.crawlspaceId = normalizedTab.id
        if (config.sessionName) {
          // BR-29：命名 session 是隔离的浏览器身份，partition 必须始终是
          // 由 crawlspaceId 推导的独立 session partition——无条件覆盖。
          //   - 修复后落盘的 session 已是该值，覆盖是幂等的；
          //   - 修复前落盘的 legacy session（partition=`tabtin:env:default`）
          //     在此被迁移到隔离 partition，从而不再共享真实登录态 Cookie；
          //   - partition 字段缺失的 session 也被补成隔离值（而非 env 兜底）。
          config.partition = buildSessionPartition(config.crawlspaceId)
        } else if (!config.partition) {
          // 历史兼容兜底：localStorage 中老 workspace 可能 partition 字段为
          // 空。本地化退役 Wave 2 之后通过 BES 镜像按 spaceId 解析；启动期
          // 镜像未就绪时返回默认 env partition（`tabtin:env:default`）。
          // 镜像加载完成后，`tabsSlice` 注册的 listener 会把这条 workspace
          // 的 partition 升级到正确的绑定 env partition。
          const cfgSpaceId = config.spaceId ?? config.projectId
          config.partition = getPartitionForSpaceSync(cfgSpaceId)
        }
        ;(normalizedTab as any).metadata = {
          ...normalizedTab.metadata,
          crawlspaceConfig: config,
        }
      }
    }

    return normalizedTab
  })
}

export function normalizeViewSeed(
  view: any,
  index: number,
  csId: string,
): CrawlspacePersistedViewSeed | null {
  const viewId = typeof view?.viewId === 'string' ? view.viewId : ''
  if (!viewId) return null
  const rawTitle = view?.title
  const rawUrl = view?.url
  const title =
    typeof rawTitle === 'string' && rawTitle.trim()
      ? rawTitle
      : i18n.t('context:label.newTab')
  const url = typeof rawUrl === 'string' ? rawUrl : 'about:blank'
  const createdAtValue = Number(view?.createdAt)
  const createdAt = Number.isFinite(createdAtValue) && createdAtValue > 0
    ? createdAtValue
    : Date.now() + index
  return {
    viewId,
    title,
    url,
    favicon: typeof view?.favicon === 'string' ? view.favicon : undefined,
    runId: typeof view?.runId === 'string' ? view.runId : undefined,
    kind: view?.kind === 'normal-view' ? 'normal-view' : 'workspace-view',
    crawlspaceId: csId,
    isPreview: Boolean(view?.isPreview),
    isActive: Boolean(view?.isActive),
    createdAt,
    position: typeof view?.position === 'number' ? view.position : undefined,
    lastAccessedAt: typeof view?.lastAccessedAt === 'number' ? view.lastAccessedAt : undefined,
    // ：file:// 预览放行根必须跨重启保留——丢了不仅恢复重建被主进程
    // 门禁拒绝（tab 空白），下一次 partialize 回写还会把 localStorage 里的
    // root 永久冲掉。
    localPreviewRoot:
      typeof view?.localPreviewRoot === 'string' && view.localPreviewRoot
        ? view.localPreviewRoot
        : undefined,
    openIntentHints: normalizeOpenIntentHints(view?.openIntentHints),
  }
}

export function normalizePersistedViews(
  rawPersisted: Record<string, any[]>,
): Record<string, CrawlspacePersistedViewSeed[]> {
  const result: Record<string, CrawlspacePersistedViewSeed[]> = {}
  Object.entries(rawPersisted).forEach(([csId, rawViews]) => {
    if (!Array.isArray(rawViews) || rawViews.length === 0) return
    const normalized = rawViews
      .map((view: any, index: number) => normalizeViewSeed(view, index, csId))
      .filter(Boolean) as CrawlspacePersistedViewSeed[]
    if (normalized.length > 0) {
      result[csId] = normalized
    }
  })
  return result
}

export function deriveColdStartFlags(
  persisted: Record<string, CrawlspacePersistedViewSeed[]>,
): Record<string, boolean> {
  const flags: Record<string, boolean> = {}
  Object.keys(persisted).forEach(csId => {
    if (persisted[csId].length > 0) {
      flags[csId] = true
    }
  })
  return flags
}

export function deriveConfigFromTabs(
  workspaceTabs: CrawlTab[],
): Record<string, CrawlspaceConfig> {
  const configs: Record<string, CrawlspaceConfig> = {}
  workspaceTabs.forEach(tab => {
    const config = tab.metadata?.crawlspaceConfig
    if (config) {
      configs[tab.id] = config
    }
  })
  return configs
}

export function buildCacheFromSeeds(
  persisted: Record<string, CrawlspacePersistedViewSeed[]>,
): Record<string, CrawlspaceContextCache> {
  const cache: Record<string, CrawlspaceContextCache> = {}
  Object.entries(persisted).forEach(([csId, seeds]) => {
    if (seeds.length === 0) return
    const activeViewId = seeds.find(s => s.isActive)?.viewId ?? null
    cache[csId] = {
      activeViewId,
      viewList: seeds.map(seed => ({
        viewId: seed.viewId,
        title: seed.title || i18n.t('context:label.newTab'),
        url: seed.url || 'about:blank',
        favicon: seed.favicon,
        runId: seed.runId,
        kind: seed.kind || 'workspace-view',
        crawlspaceId: seed.crawlspaceId || csId,
        isPreview: seed.isPreview ?? false,
        openIntentHints: seed.openIntentHints,
        isClosing: false,
        isLoading: true,
        createdAt: seed.createdAt ?? Date.now(),
      })),
    }
  })
  return cache
}
