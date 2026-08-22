/**
 * useSpaceResources — 当前选中 Space 的文档 / 表格资源 Store（单一数据源）
 *
 * SpaceHome 主区与侧边栏资源面板（SpaceResourcePanel）共享同一份数据：
 * 谁先挂载谁触发加载，另一处复用缓存，刷新也只刷一次，避免重复请求 + 列表不同步。
 *
 * 数据来源与 SpaceHome 原实现一致：
 *   - 文档：@tabtin/tabdoc-ui/api-client listDocuments
 *   - 表格：@tabtin/table-core TableApiService.getTablesBySpace
 */

import { create } from 'zustand'
import { TableApiService, type Table } from '@tabtin/table-core'
import { listDocuments, type TabdocDocument } from '@tabtin/tabdoc-ui/api-client'
import { useTableViewUiStore } from '@tabtin/table-ui'
import { getSharedAppHostClient } from '@/adapters/sharedAppHostClient'
import { configureWebTableRuntime } from '@/features/table/bootstrap'
import i18n from '@/i18n'

interface SpaceResourcesState {
  organizationId: string | null
  spaceId: string | null
  documents: TabdocDocument[]
  tables: Table[]
  isLoading: boolean
  docsError: string | null
  tablesError: string | null
  /** 当前 target 是否已完成至少一次加载（用于区分「加载中空态」与「真空态」） */
  loaded: boolean
  load: (
    organizationId: string | null | undefined,
    spaceId: string | null | undefined,
    opts?: { force?: boolean },
  ) => Promise<void>
  reset: () => void
}

// 模块级请求序号：用于丢弃过期请求（切换 Space / reset / 强制刷新会作废旧响应）。
let requestSeq = 0

export const useSpaceResources = create<SpaceResourcesState>((set, get) => ({
  organizationId: null,
  spaceId: null,
  documents: [],
  tables: [],
  isLoading: false,
  docsError: null,
  tablesError: null,
  loaded: false,

  reset: () => {
    requestSeq += 1
    set({
      organizationId: null,
      spaceId: null,
      documents: [],
      tables: [],
      isLoading: false,
      docsError: null,
      tablesError: null,
      loaded: false,
    })
  },

  load: async (organizationId, spaceId, opts) => {
    const force = opts?.force ?? false
    if (!organizationId || !spaceId) {
      get().reset()
      return
    }

    const state = get()
    const sameTarget = state.organizationId === organizationId && state.spaceId === spaceId
    // 已加载或正在加载同一 target 时跳过（实现 SpaceHome 与侧栏的请求去重）。
    if (sameTarget && !force && (state.loaded || state.isLoading)) return

    const requestId = ++requestSeq
    configureWebTableRuntime({ organizationId, spaceId })

    set({
      organizationId,
      spaceId,
      isLoading: true,
      docsError: null,
      tablesError: null,
      documents: sameTarget ? state.documents : [],
      tables: sameTarget ? state.tables : [],
      loaded: sameTarget ? state.loaded : false,
    })

    const client = getSharedAppHostClient()
    const [docsResult, tablesResult] = await Promise.allSettled([
      listDocuments(client, { organizationId, spaceId, page: 1, pageSize: 100 }),
      TableApiService.getTablesBySpace(organizationId, spaceId),
    ])

    // 过期响应（已切换 target / reset / 新一轮刷新）直接丢弃。
    if (requestId !== requestSeq) return

    const patch: Partial<SpaceResourcesState> = { isLoading: false, loaded: true }

    if (docsResult.status === 'fulfilled') {
      patch.documents = docsResult.value.documents
      patch.docsError = null
    } else {
      patch.docsError =
        docsResult.reason instanceof Error
          ? docsResult.reason.message
          : i18n.t('home.loadDocsFailed', { ns: 'space' })
    }

    if (tablesResult.status === 'fulfilled') {
      patch.tables = tablesResult.value.tables
      patch.tablesError = null
      const loadedTableIds = tablesResult.value.tables.map((table) => table.id)
      if (loadedTableIds.length > 0) {
        useTableViewUiStore.getState().cleanupStaleScopes(loadedTableIds)
      }
    } else {
      patch.tablesError =
        tablesResult.reason instanceof Error
          ? tablesResult.reason.message
          : i18n.t('home.loadTablesFailed', { ns: 'space' })
    }

    set(patch)
  },
}))
