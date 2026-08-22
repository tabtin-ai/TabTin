/**
 * useSlideCollaboration — TabSlide Y.js 实时协作 Hook
 *
 * 基于 @tabtin/collab-core 的 useCollabProvider:
 * - 连接到 collab-live /slide-collaboration 端点
 * - Y.Doc 数据模型: pages (Y.Map), pageOrder (Y.Array), meta (Y.Map)
 * - 监听 Y.Doc 变更驱动 Zustand Store 更新
 * - 页面级增量同步（只更新变更的页面）
 * - Feature flag 降级到旧链路
 *
 * 使用方式:
 *   const collab = useSlideCollaboration({
 *     projectId: 'xxx',
 *     enabled: true,
 *     getToken: () => authToken,
 *     user: { id: '...', name: '...' },
 *   })
 */

import { useEffect, useCallback, useRef } from 'react'
import * as Y from 'yjs'
import {
  useOfflineReplay,
  CollabStatus,
  type CollabPeerState,
  type CollabSyncMode,
  type CollabSyncModeReason,
} from '@tabtin/collab-core'
import type { Slide, PPTElement } from '../types/slides'
import { useT } from '../i18n'
import {
  appendPendingWrite,
  loadPendingOverflow,
  registerTabSlideOverflowBucket,
  type PendingSlideWrite,
} from '../collab/pending-slide-writes'
import {
  replayPendingSlideWrites,
  transactSlideWrite,
} from '../collab/ydoc-slide-writes'
import {
  useSlideYDocSnapshot,
  type PageChange,
} from './useSlideYDocSnapshot'
import { useSlideCollabUndo } from './useSlideCollabUndo'
import { useSlideCollabConnection } from './useSlideCollabConnection'
import type { UseSlideCollaborationInput } from './useSlideCollaborationTypes'

export {
  PENDING_WRITES_MAX,
  appendPendingWrite,
  compactPendingQueue,
  spillToLocalStorage,
  loadPendingOverflow,
  registerTabSlideOverflowBucket,
} from '../collab/pending-slide-writes'
export type { PendingSlideWrite } from '../collab/pending-slide-writes'
export { replayPendingSlideWrites } from '../collab/ydoc-slide-writes'
export type { PageChange } from './useSlideYDocSnapshot'

// 模块加载即注册——任何 import 本 hook 的代码（renderer 端）都会让 bucket 立即可见。
registerTabSlideOverflowBucket()

export type { UseSlideCollaborationInput } from './useSlideCollaborationTypes'

export interface UseSlideCollaborationResult {
  /** 连接状态 */
  status: CollabStatus
  /** 是否协作在线 */
  isOnline: boolean
  /** 服务端协作连接是否只读 */
  readOnly: boolean
  /** 当前协作连接是否允许编辑 */
  canEdit: boolean
  /** 是否已降级到旧链路 */
  isFallback: boolean
  /** 资源级同步模式；collab 模式下旧业务 delta 不参与领域状态更新 */
  syncMode: CollabSyncMode
  /** 进入 legacy 模式的原因；collab 模式下为空 */
  syncModeReason?: CollabSyncModeReason
  /** WebSocket 断连、降级到本地缓存模式（协作已启用但连接中断） */
  isHttpFallback: boolean
  /** 服务端持久化（store）失败，需提示用户 */
  storeFailed: boolean
  /** 在线协作者 */
  peers: CollabPeerState[]
  /** Y.Doc 实例 */
  ydoc: Y.Doc | null

  // ── 数据读取 ──

  /** 所有页面的最新快照 */
  pagesSnapshot: Map<string, Slide>
  /** 页面顺序 */
  pageOrder: string[]
  /** 项目版本号 */
  version: number
  /** meta: 远端主题 */
  metaTheme: Record<string, unknown> | null
  /** meta: 远端项目名 */
  metaName: string | null
  /** meta: 远端字体嵌入元数据 */
  metaFontMeta: Record<string, unknown> | null

  // ── 数据操作 ──

  /** 更新指定页面的元素列表（CRDT 安全：相同结构时逐元素 diff） */
  setPageElements: (pageId: string, elements: PPTElement[]) => void
  /** 更新指定页面的单个属性 */
  updatePageField: (pageId: string, field: string, value: unknown) => void
  /** 更新元素属性（定位到目标元素，merge updates） */
  updateElement: (pageId: string, elementId: string, updates: Partial<PPTElement>) => void
  /** 批量更新页面（事务式） */
  batchUpdatePages: (changes: Array<{ pageId: string; field: string; value: unknown }>) => void
  /** 添加新页面 */
  addPage: (pageId: string, page: Partial<Slide>, afterPageId?: string) => void
  /** 删除页面 */
  deletePage: (pageId: string) => void
  /** 重排页面顺序（CRDT 安全：最小操作而非清空重建） */
  reorderPages: (newOrder: string[]) => void
  /** 删除指定页面中的单个元素 */
  removeElement: (pageId: string, elementId: string) => void
  /** 在指定页面中插入新元素 */
  insertElement: (pageId: string, element: PPTElement, afterElementId?: string) => void
  /** 仅重排指定页面的元素顺序（不触碰元素内容，CRDT 安全） */
  reorderElements: (pageId: string, newElementOrder: string[]) => void
  /** 更新 meta 中的 theme */
  updateMetaTheme: (theme: Record<string, unknown>) => void
  /** 更新 meta 中的 project_name */
  updateMetaName: (name: string) => void
  /** 更新 meta 中的 font_meta */
  updateMetaFontMeta: (fontMeta: Record<string, unknown>) => void

  // ── 回调 ──

  /** 远程变更回调 */
  onRemoteChange: (callback: (changes: PageChange[]) => void) => () => void

  // ── Presence ──

  /** CC-014：高频 Awareness 状态（绕过 fingerprint 节流，实时光标） */
  awarenessPeers: CollabPeerState[]
  /** 更新自己的 Awareness 字段 */
  setAwareness: (key: string, value: unknown) => void
  /** 广播当前选中页面 + 元素 */
  broadcastSelection: (pageId: string | null, elementIds: string[]) => void

  // ── CC-016 离线检测 ──

  /** CC-016: 是否检测到长时间离线后重连 */
  longOfflineDetected: boolean
  /** CC-016: 确认长离线提示（消费后重置） */
  acknowledgeLongOffline: () => void

  // ── Undo/Redo ──

  collabUndo: () => void
  collabRedo: () => void
  collabCanUndo: boolean
  collabCanRedo: boolean
}

export function useSlideCollaboration(
  input: UseSlideCollaborationInput
): UseSlideCollaborationResult {
  const translate = useT()
  const userLabel = translate('label.user')
  const {
    enabled,
    collab,
    collabOptions,
    awarenessPeers,
    isFallback,
    isOnline,
    isHttpFallback,
  } = useSlideCollabConnection(input, userLabel)

  // ：协作连接只读时禁止本地写入。canWriteRef 跟踪最新 canEdit，
  // 所有写操作在 commitWrite 单一入口处统一门禁（等价于逐函数拦截，但集中一处）。
  const canWriteRef = useRef(false)
  canWriteRef.current = collab.canEdit

  // ── 连接状态 & 断线降级（必须在 useCallback 之前声明，避免 TDZ） ──
  const isHttpFallbackRef = useRef(false)
  isHttpFallbackRef.current = isHttpFallback
  // CO-47: 在 token 未就绪（collabOptions=null）窗口期也缓存写操作，重连后回放
  const shouldBufferWritesRef = useRef(false)
  shouldBufferWritesRef.current = isHttpFallback || (enabled && !collabOptions)
  const pendingWritesRef = useRef<PendingSlideWrite[]>([])
  // CO-45: projectId 切换时清空 pendingWritesRef，防止旧项目操作污染新项目
  const prevProjectIdRef = useRef(input.projectId)
  if (prevProjectIdRef.current !== input.projectId) {
    prevProjectIdRef.current = input.projectId
    pendingWritesRef.current = []
  }
  const prevOnlineRef = useRef(isOnline)
  const {
    pagesSnapshot,
    pageOrder,
    version,
    metaTheme,
    metaName,
    metaFontMeta,
    refreshFnsRef,
    onRemoteChange,
  } = useSlideYDocSnapshot(collab.ydoc as Y.Doc | null, isFallback)

  // ── Y.Doc 操作方法 ──

  const _appendPending = useCallback(
    (write: PendingSlideWrite) =>
      appendPendingWrite(pendingWritesRef.current, write, input.projectId ?? undefined),
    [input.projectId],
  )

  const commitWrite = useCallback(
    (write: PendingSlideWrite) => {
      // ：viewer 只读连接不产生本地写入（服务端 connection.readOnly 是最终边界）。
      if (!canWriteRef.current) return
      if (shouldBufferWritesRef.current || !collab.ydoc) {
        _appendPending(write)
        return
      }
      transactSlideWrite(collab.ydoc, write)
    },
    [collab.ydoc, _appendPending],
  )

  const setPageElements = useCallback((pageId: string, elements: PPTElement[]) => {
    commitWrite({ op: 'setPageElements', pageId, elements })
  }, [commitWrite])

  const updatePageField = useCallback((pageId: string, field: string, value: unknown) => {
    commitWrite({ op: 'updatePageField', pageId, field, value })
  }, [commitWrite])

  const updateElement = useCallback(
    (pageId: string, elementId: string, updates: Partial<PPTElement>) => {
      commitWrite({ op: 'updateElement', pageId, elementId, updates })
    },
    [commitWrite],
  )

  const batchUpdatePages = useCallback(
    (changes: Array<{ pageId: string; field: string; value: unknown }>) => {
      commitWrite({ op: 'batchUpdatePages', changes })
    },
    [commitWrite],
  )

  const addPage = useCallback(
    (pageId: string, page: Partial<Slide>, afterPageId?: string) => {
      commitWrite({ op: 'addPage', pageId, page, afterPageId })
    },
    [commitWrite],
  )

  const deletePage = useCallback((pageId: string) => {
    commitWrite({ op: 'deletePage', pageId })
  }, [commitWrite])

  const reorderPages = useCallback((newOrder: string[]) => {
    commitWrite({ op: 'reorderPages', newOrder })
  }, [commitWrite])

  const removeElement = useCallback((pageId: string, elementId: string) => {
    commitWrite({ op: 'removeElement', pageId, elementId })
  }, [commitWrite])

  const insertElement = useCallback(
    (pageId: string, element: PPTElement, afterElementId?: string) => {
      commitWrite({ op: 'insertElement', pageId, element, afterElementId })
    },
    [commitWrite],
  )

  const reorderElements = useCallback((pageId: string, newElementOrder: string[]) => {
    commitWrite({ op: 'reorderElements', pageId, newElementOrder })
  }, [commitWrite])

  // ── Meta 写接口 ──

  const updateMetaTheme = useCallback((theme: Record<string, unknown>) => {
    commitWrite({ op: 'updateMetaTheme', theme })
  }, [commitWrite])

  const updateMetaName = useCallback((name: string) => {
    commitWrite({ op: 'updateMetaName', name })
  }, [commitWrite])

  const updateMetaFontMeta = useCallback((fontMeta: Record<string, unknown>) => {
    commitWrite({ op: 'updateMetaFontMeta', fontMeta })
  }, [commitWrite])

  // ── Presence ──

  const setAwareness = useCallback(
    (key: string, value: unknown) => {
      collab.setAwareness(key, value)
    },
    [collab.setAwareness]
  )

  const broadcastSelection = useCallback(
    (pageId: string | null, elementIds: string[]) => {
      collab.setAwareness('cursor', {
        module: 'tabslide' as const,
        pageId,
        elementIds,
        timestamp: Date.now(),
      })
    },
    [collab.setAwareness]
  )

  const {
    collabUndo,
    collabRedo,
    collabCanUndo,
    collabCanRedo,
  } = useSlideCollabUndo(collab.ydoc as Y.Doc | null, isFallback, collab.canEdit)

  // ── Awareness 生命周期清理 ──
  useEffect(() => {
    if (!enabled || isFallback) {
      collab.setAwareness('cursor', null)
      return
    }

    return () => {
      collab.setAwareness('cursor', null)
    }
  }, [enabled, isFallback, collab.setAwareness])

  // ── 离线回放（含 localStorage 溢出数据恢复） ──
  const replayWithOverflow = useCallback(
    (ydoc: Y.Doc, pending: PendingSlideWrite[]) => {
      const overflow = loadPendingOverflow(input.projectId ?? undefined)
      const combined = overflow.length > 0 ? [...overflow, ...pending] : pending
      replayPendingSlideWrites(ydoc, combined)
    },
    [input.projectId],
  )
  useOfflineReplay({
    // ：只读连接不回放本地写入，避免 viewer 离线编辑重连后被拒。
    isOnline: isOnline && !isFallback && collab.canEdit,
    ydoc: collab.ydoc as any,
    pendingRef: pendingWritesRef,
    replay: replayWithOverflow as any,
  })

  // ── 重连后全量刷新 React state（备用刷新，observer 已因 'offline-replay' origin 触发更新） ──
  // E3-03: 通过 queueMicrotask 延迟刷新，确保 useOfflineReplay 的同步回放
  // 及其触发的 Y.Doc observer 回调全部完成后再执行全量刷新，
  // 避免读取到回放前的旧数据。
  useEffect(() => {
    const wasOffline = !prevOnlineRef.current
    prevOnlineRef.current = isOnline

    if (wasOffline && isOnline && !isFallback && refreshFnsRef.current) {
      const fns = refreshFnsRef.current
      queueMicrotask(() => {
        fns.refreshPages()
        fns.refreshPageOrder()
        fns.refreshMeta()
      })
    }
  }, [isOnline, isFallback])

  return {
    status: collab.status,
    isOnline,
    readOnly: collab.readOnly,
    canEdit: collab.canEdit,
    isFallback,
    syncMode: collab.syncMode,
    syncModeReason: collab.syncModeReason,
    isHttpFallback,
    storeFailed: collab.storeFailed,
    peers: collab.peers,
    ydoc: isFallback ? null : collab.ydoc as any,

    pagesSnapshot,
    pageOrder,
    version,
    metaTheme,
    metaName,
    metaFontMeta,

    setPageElements,
    updatePageField,
    updateElement,
    batchUpdatePages,
    addPage,
    deletePage,
    reorderPages,
    removeElement,
    insertElement,
    reorderElements,
    updateMetaTheme,
    updateMetaName,
    updateMetaFontMeta,

    onRemoteChange,

    awarenessPeers,
    setAwareness,
    broadcastSelection,

    longOfflineDetected: collab.longOfflineDetected,
    acknowledgeLongOffline: collab.acknowledgeLongOffline,

    collabUndo,
    collabRedo,
    collabCanUndo,
    collabCanRedo,
  }
}
