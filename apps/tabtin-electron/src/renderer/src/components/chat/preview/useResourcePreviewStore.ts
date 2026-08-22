/** @store-category ui */

/**
 * 聊天资源预览 store
 *
 * 单实例 Lightbox 状态：当前是否打开、资源列表、当前索引。
 * 不持久化（关闭即弃）。
 *
 * **globalThis 单例**：ChatResourcePreviewModal 经 React.lazy 异步 chunk 加载时，
 * Vite/HMR 可能把本模块解析成两份（RichImage 点 A 店、Modal 订 B 店），
 * 表现为「点击放大无反应」。钉到 globalThis 保证跨 chunk 同一实例。
 *
 * IM 邻图换链复用 generation + patchResourceUrl / removeResource；
 * showNavMeta 控制是否展示底部 2/2 · 来源计数（IM 默认关）。
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { useChatStore } from '../../../stores/chat/useChatStore'
import type { PreviewResource } from './types'
import { collectTurnResources, locateResourceIndex } from './collectTurnResources'

export interface ResourcePreviewOpenOptions {
  /** 是否展示底部索引 / 来源消息数；IM 传 false，仅保留左右切换 */
  showNavMeta?: boolean
}

interface ResourcePreviewState {
  isOpen: boolean
  resources: PreviewResource[]
  currentIndex: number
  /** 每次 open 递增；异步补齐结果若世代过期则丢弃（IM 图库） */
  generation: number
  /** 底部 2/2 · 来自 N 条消息；IM 关闭 */
  showNavMeta: boolean

  /** 直接打开任意资源列表（命中 index）。供"无消息上下文"场景使用。返回是否打开 */
  open: (
    resources: PreviewResource[],
    index?: number,
    options?: ResourcePreviewOpenOptions,
  ) => boolean
  /**
   * 从消息上下文打开：store 自己根据 (sessionId, messageId) 从 chat-store
   * 取消息列表并聚合同回合资源；命中 hint（url 或 resourceId）。
   * 返回 true 表示已打开；false 表示消息或资源不存在，调用方可降级到 open()。
   */
  openFromMessage: (
    sessionId: string,
    messageId: string,
    hint?: { url?: string; resourceId?: string },
  ) => boolean
  /** 在弹层仍打开且世代匹配时替换资源列表，优先保持用户当前正在看的项 */
  replaceResources: (
    resources: PreviewResource[],
    generation: number,
    preferSourceMessageId?: string,
  ) => void
  /** 惰性换链完成后补丁单项 URL，不改动当前选中 */
  patchResourceUrl: (sourceMessageId: string, url: string, generation: number) => void
  /** 换链失败时移出占位项，尽量保持用户当前选中 */
  removeResource: (sourceMessageId: string, generation: number) => void
  close: () => void
  next: () => void
  prev: () => void
  goTo: (index: number) => void
}

type ResourcePreviewStore = UseBoundStore<StoreApi<ResourcePreviewState>>

// v3：showNavMeta；换 key 避免 HMR / 旧 chunk 仍挂无新字段的单例。
const GLOBAL_STORE_KEY = '__tabtinResourcePreviewStore_v3__'

declare global {
  var __tabtinResourcePreviewStore_v3__: ResourcePreviewStore | undefined
}

function resolvePreferredIndex(
  resources: PreviewResource[],
  preferSourceMessageId: string | undefined,
  previous: PreviewResource | undefined,
): number {
  // 异步补齐完成时，优先保留用户等待期间已经切到的项。
  if (previous?.sourceMessageId) {
    const byPreviousId = resources.findIndex(
      (resource) => resource.sourceMessageId === previous.sourceMessageId,
    )
    if (byPreviousId >= 0) return byPreviousId
  }
  if (previous?.id) {
    const byId = resources.findIndex((resource) => resource.id === previous.id)
    if (byId >= 0) return byId
  }
  if (previous?.url) {
    const byUrl = resources.findIndex((resource) => resource.url === previous.url)
    if (byUrl >= 0) return byUrl
  }
  if (preferSourceMessageId) {
    const byPrefer = resources.findIndex(
      (resource) => resource.sourceMessageId === preferSourceMessageId,
    )
    if (byPrefer >= 0) return byPrefer
  }
  return 0
}

function createResourcePreviewStore(): ResourcePreviewStore {
  return create<ResourcePreviewState>((set, get) => ({
    isOpen: false,
    resources: [],
    currentIndex: 0,
    generation: 0,
    showNavMeta: true,

    open: (resources, index = 0, options) => {
      if (resources.length === 0) return false
      const safeIndex = Math.max(0, Math.min(index, resources.length - 1))
      const generation = get().generation + 1
      set({
        isOpen: true,
        resources,
        currentIndex: safeIndex,
        generation,
        showNavMeta: options?.showNavMeta ?? true,
      })
      return true
    },

    openFromMessage: (sessionId, messageId, hint) => {
      const messages = useChatStore.getState().messagesBySessionId[sessionId] ?? []
      const anchor = messages.find(m => m.id === messageId)
      if (!anchor) return false
      //  阶段 5：collectTurnResources 默认读 message.blocks（统一读入口，含流式
      // 镜像 + 历史回退），不再注入 runtime resolver 补丁。
      const resources = collectTurnResources(messages, anchor)
      if (resources.length === 0) return false
      const index = locateResourceIndex(resources, anchor.id, hint)
      const generation = get().generation + 1
      set({
        isOpen: true,
        resources,
        currentIndex: index,
        generation,
        showNavMeta: true,
      })
      return true
    },

    replaceResources: (resources, generation, preferSourceMessageId) => {
      const state = get()
      if (!state.isOpen || state.generation !== generation || resources.length === 0) return
      const previous = state.resources[state.currentIndex]
      const nextIndex = resolvePreferredIndex(resources, preferSourceMessageId, previous)
      set({ resources, currentIndex: nextIndex })
    },

    patchResourceUrl: (sourceMessageId, url, generation) => {
      const state = get()
      if (!state.isOpen || state.generation !== generation || !url) return
      let changed = false
      const resources = state.resources.map((resource) => {
        if (resource.sourceMessageId !== sourceMessageId || resource.url === url) return resource
        changed = true
        return { ...resource, url }
      })
      if (changed) set({ resources })
    },

    removeResource: (sourceMessageId, generation) => {
      const state = get()
      if (!state.isOpen || state.generation !== generation) return
      const previous = state.resources[state.currentIndex]
      const resources = state.resources.filter(
        (resource) => resource.sourceMessageId !== sourceMessageId,
      )
      if (resources.length === 0 || resources.length === state.resources.length) return
      set({
        resources,
        currentIndex: resolvePreferredIndex(resources, undefined, previous),
      })
    },

    close: () => {
      set({ isOpen: false, resources: [], currentIndex: 0, showNavMeta: true })
    },

    next: () => {
      const { resources, currentIndex } = get()
      if (resources.length <= 1) return
      set({ currentIndex: (currentIndex + 1) % resources.length })
    },

    prev: () => {
      const { resources, currentIndex } = get()
      if (resources.length <= 1) return
      set({ currentIndex: (currentIndex - 1 + resources.length) % resources.length })
    },

    goTo: (index) => {
      const { resources } = get()
      if (resources.length === 0) return
      const safeIndex = Math.max(0, Math.min(index, resources.length - 1))
      set({ currentIndex: safeIndex })
    },
  }))
}

export const useResourcePreviewStore: ResourcePreviewStore =
  globalThis[GLOBAL_STORE_KEY] ??
  (globalThis[GLOBAL_STORE_KEY] = createResourcePreviewStore())
