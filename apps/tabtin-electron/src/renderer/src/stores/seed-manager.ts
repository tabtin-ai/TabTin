/**
 * 🌱 种子管理器（SeedManager）
 *
 * 统一管理 crawlspacePersistedViews（重启恢复种子）的读写操作。
 *
 * 设计目的：
 * - 消除种子读写散布在 5+ 个不同文件中的问题
 * - 提供双通道读取（zustand state + localStorage fallback）
 * - 封装冷启动状态查询和标记
 * - 所有种子操作通过统一 API 进行
 *
 * 注意：种子的实际存储仍在 useCrawlTabStore 中（由 zustand persist 管理），
 * 本模块是对 store 操作的语义封装，不引入新的存储层。
 */

import {
  useCrawlTabStore,
  readPersistedSeedsFromStorage,
  type CrawlspacePersistedViewSeed
} from './useCrawlTabStore'
import type { OpenIntentHints } from '@shared/open-intent'

export const seedManager = {
  /**
   * 获取种子（双通道：zustand state + localStorage fallback）
   *
   * 优先从 zustand state 读取；若为空，则直接从 localStorage 读取原始 JSON，
   * 彻底绕过 zustand hydration 链路的潜在故障。
   */
  getSeeds(crawlspaceId: string): CrawlspacePersistedViewSeed[] {
    const storeSeeds = useCrawlTabStore.getState().crawlspacePersistedViews[crawlspaceId] || []
    if (storeSeeds.length > 0) return storeSeeds
    return readPersistedSeedsFromStorage(crawlspaceId)
  },

  /**
   * 获取种子来源（用于调试日志）
   */
  getSeedsWithSource(crawlspaceId: string): {
    seeds: CrawlspacePersistedViewSeed[]
    storeCount: number
    directCount: number
    source: 'zustand-state' | 'localStorage-direct' | 'none'
  } {
    const storeSeeds = useCrawlTabStore.getState().crawlspacePersistedViews[crawlspaceId] || []
    if (storeSeeds.length > 0) {
      return {
        seeds: storeSeeds,
        storeCount: storeSeeds.length,
        directCount: storeSeeds.length,
        source: 'zustand-state'
      }
    }
    const directSeeds = readPersistedSeedsFromStorage(crawlspaceId)
    return {
      seeds: directSeeds,
      storeCount: 0,
      directCount: directSeeds.length,
      source: directSeeds.length > 0 ? 'localStorage-direct' : 'none'
    }
  },

  /**
   * 是否处于冷启动（merge 恢复种子后为 true，restorePersistedViews 完成后为 false）
   */
  isColdStart(crawlspaceId: string): boolean {
    return Boolean(useCrawlTabStore.getState()._coldStartPendingByCS[crawlspaceId])
  },

  /**
   * 标记恢复完成，解除 applyCrawlspaceContextSnapshot 的种子保护
   */
  markRestored(crawlspaceId: string): void {
    useCrawlTabStore.getState().markColdStartComplete(crawlspaceId)
  },

  /**
   * 获取活跃种子的 viewId（用于恢复时确定初始激活视图）
   */
  getActiveSeedViewId(crawlspaceId: string): string | null {
    const seeds = seedManager.getSeeds(crawlspaceId)
    return seeds.find(seed => seed.isActive)?.viewId || null
  },

  /**
   * 立即写入种子（no-clobber），用于 createView 成功后崩溃恢复。
   *
   * 调用时机：ipcAdapter.createView() 返回 true 之后立即调用，
   * 确保在 Context 快照到达之前种子就已持久化到 localStorage。
   * 如果种子已存在（viewId 匹配），则不做任何操作。
   */
  ensureSeed(crawlspaceId: string, seed: {
    viewId: string
    url: string
    title?: string
    favicon?: string
    runId?: string
    localPreviewRoot?: string
    openIntentHints?: OpenIntentHints
  }): void {
    useCrawlTabStore.getState().ensureViewSeed(crawlspaceId, {
      viewId: seed.viewId,
      url: seed.url,
      title: seed.title,
      favicon: seed.favicon,
      runId: seed.runId,
      localPreviewRoot: seed.localPreviewRoot,
      openIntentHints: seed.openIntentHints,
    })
  }
}

export type { CrawlspacePersistedViewSeed }
