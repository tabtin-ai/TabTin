/**
 * useSlideCollabBridge — Zustand ↔ Y.js 双向同步桥接层
 *
 * NOTE: Y.js 已成为 TabSlide 默认链路。此桥接层将在后续版本中
 * 简化为单向 Y.js→Zustand 数据流（Zustand 仅作 derived state）。
 *
 * 数据流：
 *   Y.js (协作态唯一数据源)
 *     ↕  observeDeep / transact('local')
 *   useSlideCollaboration (React state: pagesSnapshot, pageOrder)
 *     ↕  本桥接层
 *   useSlideStore (Zustand, 驱动 UI 渲染)
 *
 * 防循环策略（三层防护）：
 *   L1 — 同步标记：isApplyingRemote 在 Zustand set() 期间保持 true，
 *         subscribe 回调同步检查后跳过。无 queueMicrotask 时序依赖。
 *   L2 — 内容指纹：每页维护 JSON 指纹（pageFingerprints），只有指纹
 *         变化才实际推送到 Y.js，防止引用变化但内容不变的误触发。
 *   L3 — 手术式更新：Y.js→Zustand 方向使用 produce() 仅替换实际变化
 *         的页面对象，未变化的页面保持原引用，从根源减少 subscribe 误触发。
 */

import { useEffect, useRef, useCallback } from 'react'
import { produce } from 'immer'
import type { UseSlideCollaborationResult, PageChange } from './useSlideCollaboration'
import { useSlideStore } from '../store/slide'
import type { Slide } from '../types/slides'
import { resolveThemeColorByKey } from '../utils/background'
import {
  stableStringify,
  computePageFingerprint,
  safeStableEqual,
  diffPagesByContent,
  rebuildPagesFromYjs,
  syncElementChanges,
  syncPageMetaFieldsToCollab,
  getDirtyFields,
} from '../collab/bridge-sync-utils'

// stableStringify 重新导出，保留既有 import 路径（指纹键序稳定性测试依赖）
export { stableStringify }

interface UseSlideCollabBridgeOptions {
  collab: UseSlideCollaborationResult
  enabled: boolean
}

export function useSlideCollabBridge({ collab, enabled }: UseSlideCollabBridgeOptions) {
  // L1: 同步防循环标记（在 Zustand set() 期间保持 true）
  const isApplyingRemoteRef = useRef(false)
  // L2: 页面内容指纹缓存（pageId → JSON fingerprint）
  const pageFingerprintsRef = useRef<Map<string, string>>(new Map())
  // 指纹对应的页面对象缓存（pageId → page ref），用于跳过未变页面的重复 stringify
  const pageRefCacheRef = useRef<Map<string, Slide>>(new Map())
  const isInitializedRef = useRef(false)

  /**
   * 更新指纹缓存（基于当前 pages 数组）
   */
  const updateFingerprints = useCallback((pages: Slide[]) => {
    const prevFps = pageFingerprintsRef.current
    const prevRefs = pageRefCacheRef.current
    const fps = new Map<string, string>()
    const refs = new Map<string, Slide>()
    for (const page of pages) {
      const prevRef = prevRefs.get(page.id)
      const prevFp = prevFps.get(page.id)
      if (prevRef === page && prevFp !== undefined) {
        fps.set(page.id, prevFp)
      } else {
        fps.set(page.id, computePageFingerprint(page))
      }
      refs.set(page.id, page)
    }
    pageFingerprintsRef.current = fps
    pageRefCacheRef.current = refs
  }, [])

  // ── 1. Y.js → Zustand：远程变更同步（手术式更新） ──
  useEffect(() => {
    if (!enabled || collab.isFallback) return

    const { pagesSnapshot, pageOrder } = collab
    if (pagesSnapshot.size === 0 && pageOrder.length === 0) return

    const yjsPages = rebuildPagesFromYjs(pagesSnapshot, pageOrder)
    if (yjsPages.length === 0) return

    const store = useSlideStore.getState()
    if (!store.presentation) return

    const currentPages = store.presentation.pages
    const yjsPageIds = yjsPages.map(p => p.id).join(',')
    const currentPageIds = currentPages.map(p => p.id).join(',')
    const structureChanged = yjsPageIds !== currentPageIds || !isInitializedRef.current

    // [SP1-07] Y.Doc 初始同步保护：检测 isDirty，若有未保存本地修改则合并到 Y.js
    // 合并后构建 mergedPages 用于 Zustand 更新，避免用旧 yjsPages 覆盖刚推送的本地数据
    let mergedPages = yjsPages
    if (!isInitializedRef.current && currentPages.length > 0 && store.isDirty) {
      const yjsPageIdSet = new Set(yjsPages.map(p => p.id))
      const yjsPageMap = new Map(yjsPages.map(p => [p.id, p]))

      // 将仅存在于本地的页面推送到 Y.js（离线新建的草稿），保持相对顺序
      for (let i = 0; i < currentPages.length; i++) {
        const localPage = currentPages[i]
        if (yjsPageIdSet.has(localPage.id)) continue
        const afterPageId = i > 0 ? currentPages[i - 1].id : undefined
        collab.addPage(localPage.id, localPage, afterPageId)
      }

      // 对两端都有的页面，将本地更新的字段推送到 Y.js（本地编辑优先）
      for (const localPage of currentPages) {
        if (!yjsPageIdSet.has(localPage.id)) continue
        const yjsPage = yjsPageMap.get(localPage.id)
        if (!yjsPage) continue
        const localFp = computePageFingerprint(localPage)
        const yjsFp = computePageFingerprint(yjsPage)
        if (localFp !== yjsFp) {
          syncElementChanges(collab, localPage.id, yjsPage.elements, localPage.elements)
          syncPageMetaFieldsToCollab(collab, localPage, yjsPage)
        }
      }

      // 构建合并后的页面列表：以本地页面为基础，补入仅存在于 Y.js 的页面
      const localPageIdSet = new Set(currentPages.map(p => p.id))
      const mergedList: Slide[] = currentPages.map(p =>
        yjsPageMap.has(p.id) ? { ...yjsPageMap.get(p.id)!, ...getDirtyFields(p, yjsPageMap.get(p.id)!) } : p,
      )
      for (const yjsPage of yjsPages) {
        if (!localPageIdSet.has(yjsPage.id)) {
          mergedList.push(yjsPage)
        }
      }
      mergedPages = mergedList

      console.info(
        '[TabSlide Collab] SP1-07: Merged local dirty edits into Y.Doc during initial sync. ' +
        `Local: ${currentPages.length} page(s), Y.js: ${yjsPages.length} page(s), ` +
        `local-only pages pushed: ${currentPages.filter(p => !yjsPageIdSet.has(p.id)).length}.`,
      )
    }

    // L1: 同步标记 — subscribe 回调在 set() 期间同步触发，此时标记为 true
    isApplyingRemoteRef.current = true
    try {
      if (structureChanged) {
        // 页面增删或顺序变化 → 全量替换 pages 数组（但不调 setPresentation 避免重置 UI 状态）
        useSlideStore.setState(
          produce((s) => {
            if (!s.presentation) return
            s.presentation.pages = mergedPages

            // [SP1-08] 远端页面删除/增加后校正 currentPageIndex，防止越界或意外跳转
            if (mergedPages.length > 0) {
              const currentId = currentPages[s.currentPageIndex]?.id
              if (currentId) {
                const newIdx = mergedPages.findIndex(p => p.id === currentId)
                if (newIdx >= 0) {
                  s.currentPageIndex = newIdx
                } else {
                  s.currentPageIndex = Math.max(0, Math.min(s.currentPageIndex, mergedPages.length - 1))
                }
              } else {
                s.currentPageIndex = Math.max(0, Math.min(s.currentPageIndex, mergedPages.length - 1))
              }
            } else {
              s.currentPageIndex = 0
            }
          }),
        )
        isInitializedRef.current = true
      } else {
        // 页面结构相同 → L3: 手术式更新，只替换内容真正变化的页面
        const currentFps = pageFingerprintsRef.current
        let hasContentChange = false

        for (let i = 0; i < yjsPages.length; i++) {
          const yjsPage = yjsPages[i]
          const newFp = computePageFingerprint(yjsPage)
          const oldFp = currentFps.get(yjsPage.id)
          if (newFp !== oldFp) {
            hasContentChange = true
            break
          }
        }

        if (hasContentChange) {
          useSlideStore.setState(
            produce((s) => {
              if (!s.presentation) return
              const currentFps = pageFingerprintsRef.current
              for (let i = 0; i < yjsPages.length; i++) {
                const yjsPage = yjsPages[i]
                const newFp = computePageFingerprint(yjsPage)
                const oldFp = currentFps.get(yjsPage.id)
                if (newFp !== oldFp) {
                  // 仅替换内容变化的页面，其他保持原引用
                  s.presentation.pages[i] = yjsPage
                }
              }
            }),
          )
        }
      }

      // 更新指纹缓存
      const finalPages = useSlideStore.getState().presentation?.pages
      if (finalPages) {
        updateFingerprints(finalPages)
      }
    } finally {
      // L1: 同步重置 — set() 已返回，subscribe 已执行完毕，安全重置
      // 不使用 queueMicrotask：Zustand subscribe 是同步的，无需延迟
      isApplyingRemoteRef.current = false
    }
  }, [enabled, collab.isFallback, collab.pagesSnapshot, collab.pageOrder, updateFingerprints])

  // ── 2. Zustand → Y.js：本地编辑同步（内容指纹去重） ──
  useEffect(() => {
    if (!enabled || collab.isFallback || !collab.ydoc) return

    const unsubscribe = useSlideStore.subscribe((state, prevState) => {
      // L1: 同步标记检查 — 远程更新触发的 subscribe 在此被拦截
      if (isApplyingRemoteRef.current) return

      const prevPages = prevState.presentation?.pages
      const currPages = state.presentation?.pages
      if (!prevPages || !currPages || prevPages === currPages) return

      // L2: 基于指纹的内容 diff（非引用 diff）
      const diff = diffPagesByContent(prevPages, currPages, pageFingerprintsRef.current)

      if (diff.removed.length === 0 && diff.added.length === 0
        && diff.changed.length === 0 && !diff.orderChanged) {
        return
      }

      for (const pageId of diff.removed) {
        collab.deletePage(pageId)
      }

      for (const page of diff.added) {
        const insertIdx = currPages.findIndex(p => p.id === page.id)
        const afterPageId = insertIdx > 0 ? currPages[insertIdx - 1].id : undefined
        collab.addPage(page.id, page, afterPageId)
      }

      for (const page of diff.changed) {
        const oldPage = prevPages.find(p => p.id === page.id)
        if (!oldPage) continue

        // 元素变更：逐元素 diff 而非整页替换（CRDT 安全）
        // Immer 保证：未变的元素保持原引用，变了的元素是新引用
        if (!safeStableEqual(oldPage.elements, page.elements)) {
          syncElementChanges(collab, page.id, oldPage.elements, page.elements)
        }
        syncPageMetaFieldsToCollab(collab, page, oldPage)
      }

      if (diff.orderChanged && diff.added.length === 0 && diff.removed.length === 0) {
        collab.reorderPages(currPages.map(p => p.id))
      }

      // 更新指纹缓存
      updateFingerprints(currPages)
    })

    return unsubscribe
  }, [
    enabled,
    collab.isFallback,
    collab.ydoc,
    collab.addPage,
    collab.deletePage,
    collab.setPageElements,
    collab.updatePageField,
    collab.updateElement,
    collab.removeElement,
    collab.insertElement,
    collab.reorderElements,
    collab.reorderPages,
    updateFingerprints,
  ])

  // ── 2b. Meta Y.js → Zustand：远端 theme/name 变更 → 更新 Zustand ──
  useEffect(() => {
    if (!enabled || collab.isFallback) return

    const { metaTheme, metaName } = collab
    if (metaTheme === null && metaName === null) return

    const store = useSlideStore.getState()
    if (!store.presentation) return

    isApplyingRemoteRef.current = true
    try {
      useSlideStore.setState(
        produce((s) => {
          if (!s.presentation) return
          const themeChanged = metaTheme !== null && !safeStableEqual(s.presentation.theme, metaTheme)
          if (themeChanged) {
            s.presentation.theme = metaTheme as typeof s.presentation.theme
            for (const page of s.presentation.pages) {
              const bg = page.background
              if (bg?.type === 'theme' && bg.theme?.key) {
                const resolved = resolveThemeColorByKey(bg.theme.key, s.presentation.theme)
                if (resolved) bg.theme.color = resolved
              }
            }
          }
          if (metaName !== null && s.presentation.name !== metaName) {
            s.presentation.name = metaName
          }
        }),
      )
    } finally {
      isApplyingRemoteRef.current = false
    }
  }, [enabled, collab.isFallback, collab.metaTheme, collab.metaName])

  // ── 2c. Meta Zustand → Y.js：本地 theme/name 变更 → 推送到 Y.js ──
  useEffect(() => {
    if (!enabled || collab.isFallback || !collab.ydoc) return

    const unsubscribeMeta = useSlideStore.subscribe((state, prevState) => {
      if (isApplyingRemoteRef.current) return
      if (!state.presentation || !prevState.presentation) return

      if (!safeStableEqual(state.presentation.theme, prevState.presentation.theme)
        && state.presentation.theme) {
        collab.updateMetaTheme(state.presentation.theme as unknown as Record<string, unknown>)
      }
      if (state.presentation.name !== prevState.presentation.name
        && state.presentation.name) {
        collab.updateMetaName(state.presentation.name)
      }
    })

    return unsubscribeMeta
  }, [enabled, collab.isFallback, collab.ydoc, collab.updateMetaTheme, collab.updateMetaName])

  // ── 3. 远程变更回调：标记 dirty ──
  useEffect(() => {
    if (!enabled || collab.isFallback) return

    const unsubscribe = collab.onRemoteChange((_changes: PageChange[]) => {
      const store = useSlideStore.getState()
      if (store.presentation) {
        store.markDirty()
      }
    })

    return unsubscribe
  }, [enabled, collab.isFallback, collab.onRemoteChange])

  // ── 4. 清理 ──
  useEffect(() => {
    if (!enabled || collab.isFallback) {
      isInitializedRef.current = false
      pageFingerprintsRef.current = new Map()
      pageRefCacheRef.current = new Map()
    }
  }, [enabled, collab.isFallback])

  // ── 5. Presence: 监听 currentPageIndex / selectedElementIds 变化 → broadcastSelection ──
  // S2-09-06: Bridge 层响应 Zustand 选区/页面切换，触发 Awareness cursor 广播
  useEffect(() => {
    if (!enabled || collab.isFallback) return

    const unsubscribe = useSlideStore.subscribe((state, prevState) => {
      // 跳过远程更新触发的 subscribe 回调（防止远端变化误触发本端广播）
      if (isApplyingRemoteRef.current) return

      const prevPageIndex = prevState.currentPageIndex
      const currPageIndex = state.currentPageIndex
      const prevSelectedIds = prevState.selectedElementIds
      const currSelectedIds = state.selectedElementIds

      if (prevPageIndex === currPageIndex && prevSelectedIds === currSelectedIds) return

      const currPage = state.presentation?.pages[currPageIndex]
      collab.broadcastSelection(currPage?.id ?? null, currSelectedIds)
    })

    return unsubscribe
  }, [enabled, collab.isFallback, collab.broadcastSelection])
}
