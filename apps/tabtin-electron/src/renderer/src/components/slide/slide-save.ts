import { joinApiPath } from '@tabtin/config'
import React from 'react'
import {
  type SlidePresentation,
  type SlidePreset,
} from '@tabtin/tabslide'
import { convertPagesToBackend } from '@tabtin/tabslide/exports'
import { apiService } from '@/services/api'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import {
  ensureProjectId,
  diffIncrementalSave,
  unwrapEnvelope,
  type SaveBaseline,
} from './autosave-utils'
import {
  hasFontEmbeddingMeta,
  buildFontMetaRequestPayload,
  type FontEmbeddingMeta,
} from './slide-font-utils'

// ─── 类型 ──────────────────────────────────────────────

export type SavedMetaBaseline = {
  name: string
  themeFingerprint: string
}

// ─── 工具函数 ──────────────────────────────────────────

export function toBackendPreset(preset: SlidePreset): string {
  switch (preset) {
    case '16:9':
      return 'ppt'
    case '4:3':
      return '4:3'
    case 'custom':
      return 'custom'
    case 'xiaohongshu':
      return 'xiaohongshu'
    case 'poster':
      return 'poster'
    default:
      return 'ppt'
  }
}

export { syncUnifiedResourceTitle } from './slide-resource-title-sync'

// ─── 保存到后端 ─────────────────────────────────────────

export interface SaveResult {
  projectId: string
  version?: number
  metaError?: Error
  failedMetaName?: string
}

/**
 * 新建 Slide 必须使用同一组织下的 Space。组织切换尚未完成时，旧 Space 不能和
 * 新前台组织混搭创建项目；返回空上下文让上层保留保存快照并在新 Space 就绪后重试。
 */
export function getSlideSaveContext(): { organizationId: string | null; spaceId: string | null } {
  const selectedSpace = useSpaceStore.getState().selectedSpace
  const organizationId = useOrganizationStore.getState().getEffectiveOrganizationId()
  if (!selectedSpace?.id || selectedSpace.organization_id !== organizationId) {
    return { organizationId: null, spaceId: null }
  }
  return { organizationId, spaceId: selectedSpace.id }
}

/**
 * 保存到后端。
 *
 * 返回值：
 * - { projectId, version? }: 保存成功
 * - null: 保存失败
 */
export async function saveToServer(
  data: SlidePresentation,
  serverIdRef: React.MutableRefObject<string | null>,
  createProjectPromiseRef: React.MutableRefObject<Promise<string | null> | null>,
  createProjectSessionRef: React.MutableRefObject<number | null>,
  saveSessionRef: React.MutableRefObject<number>,
  fontEmbeddingMetaRef: React.MutableRefObject<FontEmbeddingMeta>,
  fontEmbeddingMetaDirtyRef: React.MutableRefObject<boolean>,
  lastSavedBaselineRef: React.MutableRefObject<SaveBaseline | null>,
  lastSavedMetaRef: React.MutableRefObject<SavedMetaBaseline | null>,
  session: number,
): Promise<SaveResult | null> {
  try {
    if (session !== saveSessionRef.current) return null
    const hadServerIdBeforeEnsure = Boolean(serverIdRef.current)
    const createPayloadMeta = fontEmbeddingMetaRef.current
    const createPayload = hasFontEmbeddingMeta(createPayloadMeta)
      ? buildFontMetaRequestPayload(createPayloadMeta)
      : null

    const projectId = await ensureProjectId(
      data,
      serverIdRef,
      createProjectPromiseRef,
      createProjectSessionRef,
      saveSessionRef,
      session,
      toBackendPreset,
      getSlideSaveContext,
      () => createPayload,
    )
    if (!projectId) return null
    if (session !== saveSessionRef.current) return null
    if (!hadServerIdBeforeEnsure && createPayload) {
      fontEmbeddingMetaDirtyRef.current = false
    }

    const saveDiff = diffIncrementalSave(data, lastSavedBaselineRef.current)
    const canUseIncremental = hadServerIdBeforeEnsure
      && Boolean(lastSavedBaselineRef.current)
      && !saveDiff.themeChanged
    const isReorderOnly = saveDiff.pageOrderChanged
      && saveDiff.changedPageIds.length === 0
      && saveDiff.deletedPageIds.length === 0
    let pagesSaved = false
    let savedVersion: number | undefined

    if (canUseIncremental && saveDiff.hasPagePayload && !isReorderOnly) {
      const pageById = new Map(data.pages.map((page) => [page.id, page] as const))
      const changedPagesPayload: Record<string, Record<string, unknown>> = {}
      for (const pageId of saveDiff.changedPageIds) {
        const page = pageById.get(pageId)
        if (!page) continue
        const converted = convertPagesToBackend([page], data.theme)[0]
        if (!converted) continue
        changedPagesPayload[pageId] = converted as unknown as Record<string, unknown>
      }

      if (Object.keys(changedPagesPayload).length > 0 || saveDiff.deletedPageIds.length > 0) {
        try {
          if (session !== saveSessionRef.current) return null
          const v2Resp = await apiService.request<Record<string, unknown>>({
            method: 'POST',
            url: `/tabslide/projects/${projectId}/save-pages-v2/`,
            data: {
              changed_pages: changedPagesPayload,
              ...(saveDiff.deletedPageIds.length > 0 ? { deleted_page_ids: saveDiff.deletedPageIds } : {}),
              ...(saveDiff.pageOrderChanged ? { page_order: saveDiff.nextBaseline.pageOrder } : {}),
            },
          }, {
            maxRetries: 3,
            retryDelay: 800,
            retryBackoff: 2,
            retryableStatuses: [408, 429, 500, 502, 503, 504],
          })
          pagesSaved = true
          const v2Data = unwrapEnvelope(v2Resp)
          if (typeof v2Data.version === 'number') savedVersion = v2Data.version
        } catch (err) {
          console.warn('[SlideEditorHost] 增量保存失败，回退全量保存:', err)
        }
      }
    }

    if (!pagesSaved) {
      const shouldSkipPageSave = !saveDiff.themeChanged && !saveDiff.hasAnyPageChange
      if (!shouldSkipPageSave) {
        const backendPages = convertPagesToBackend(data.pages, data.theme)
        if (session !== saveSessionRef.current) return null
        const fullResp = await apiService.request<Record<string, unknown>>({
          method: 'POST',
          url: `/tabslide/projects/${projectId}/save-pages/`,
          data: { pages: backendPages },
        }, {
          maxRetries: 5,
          retryDelay: 1000,
          retryBackoff: 2,
          retryableStatuses: [408, 429, 500, 502, 503, 504],
        })
        const fullData = unwrapEnvelope(fullResp)
        if (typeof fullData.version === 'number') savedVersion = fullData.version
      }
    }
    if (session !== saveSessionRef.current) return null
    lastSavedBaselineRef.current = saveDiff.nextBaseline

    const shouldSyncFontMeta = fontEmbeddingMetaDirtyRef.current
    const prevMetaBaseline = lastSavedMetaRef.current
    const shouldSyncMeta = shouldSyncFontMeta
      || !prevMetaBaseline
      || prevMetaBaseline.name !== data.name
      || prevMetaBaseline.themeFingerprint !== saveDiff.nextBaseline.themeFingerprint

    if (shouldSyncMeta) {
      const updatePayload: Record<string, unknown> = {
        name: data.name,
        theme: data.theme,
      }
      if (shouldSyncFontMeta) {
        const meta = fontEmbeddingMetaRef.current
        if (hasFontEmbeddingMeta(meta)) {
          Object.assign(updatePayload, buildFontMetaRequestPayload(meta))
        } else {
          updatePayload.embedded_fonts = []
          updatePayload.theme_fonts = {}
        }
      }

      let metaSaved = false
      let metaError: Error | undefined
      await apiService.request({
        method: 'PUT',
        url: `/tabslide/projects/${projectId}/`,
        data: updatePayload,
      }).then(() => {
        metaSaved = true
      }).catch((err) => {
        metaError = err instanceof Error ? err : new Error(String(err))
        // 元数据更新失败不影响主流程（页面已保存）
      })
      if (metaSaved) {
        lastSavedMetaRef.current = {
          name: data.name,
          themeFingerprint: saveDiff.nextBaseline.themeFingerprint,
        }
        if (shouldSyncFontMeta) {
          fontEmbeddingMetaDirtyRef.current = false
        }
      }
      if (metaError) {
        console.warn('[SlideEditorHost] 元数据保存失败:', metaError)
        return { projectId, version: savedVersion, metaError, failedMetaName: data.name }
      }
    }

    console.log('[SlideEditorHost] 保存成功:', projectId)
    return { projectId, version: savedVersion }
  } catch (err) {
    console.error('[SlideEditorHost] 保存失败:', err)
    return null
  }
}

/**
 * 离场保存 — 组件卸载或切换文稿时，火速发送最后一次编辑。
 *
 * 与 saveToServer 的区别：
 * 1. 使用值拷贝的 serverId 而非 ref（避免 ref 已被新文稿覆写）
 * 2. 不检查 session（调用方已确保是旧文稿的最终保存）
 * 3. 仅在检测到页面/主题变化时保存 pages，不更新元数据
 */
export function fireAndForgetSave(
  data: SlidePresentation,
  serverId: string,
  baseline: SaveBaseline | null = null,
): Promise<void> {
  try {
    if (baseline) {
      const saveDiff = diffIncrementalSave(data, baseline)
      if (!saveDiff.hasAnyPageChange && !saveDiff.themeChanged) {
        return Promise.resolve()
      }
    }
    const hasAnyElements = data.pages.some(p => p.elements && p.elements.length > 0)
    if (data.pages.length > 0 && !hasAnyElements) {
      console.warn('[SlideEditorHost] 离场保存跳过: 所有页面 elements 为空，可能是数据未加载')
      return Promise.resolve()
    }
    const backendPages = convertPagesToBackend(data.pages, data.theme)
    const isElectronEnv = typeof window !== 'undefined' && !!window.electron

    if (!isElectronEnv && typeof fetch === 'function') {
      try {
        const { API_CONFIG } = require('@/config/api')
        const url = joinApiPath(API_CONFIG.baseURL, `/tabslide/projects/${serverId}/save-pages/`)
        // 非 Electron 环境（web preview / 调试 BrowserWindow）下离场保存必须用
        // browser fetch + keepalive：electronFetch 走 IPC，page unload 后 IPC 通道
        // 立即关闭，最后一次保存会丢。这条分支在 Electron 主窗口里不会触发。
        // eslint-disable-next-line tabtin/no-direct-fetch-in-renderer -- 非 Electron 环境 + fetch keepalive 语义保证 page unload 时仍能完成最后一次保存
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pages: backendPages }),
          keepalive: true,
          credentials: 'include',
        }).then(() => {
          console.log('[SlideEditorHost] 离场保存(keepalive)成功:', serverId)
        }).catch((err) => {
          console.warn('[SlideEditorHost] 离场保存(keepalive)失败:', err)
        })
        return Promise.resolve()
      } catch {
        // keepalive fetch failed to initiate, fall through to apiService
      }
    }

    return apiService.request({
      method: 'POST',
      url: `/tabslide/projects/${serverId}/save-pages/`,
      data: { pages: backendPages },
    }, {
      maxRetries: 2,
      retryDelay: 500,
      retryBackoff: 2,
      retryableStatuses: [408, 429, 500, 502, 503, 504],
    }).then(() => {
      console.log('[SlideEditorHost] 离场保存成功:', serverId)
    }).catch((err) => {
      console.warn('[SlideEditorHost] 离场保存失败:', err)
    })
  } catch (err) {
    console.warn('[SlideEditorHost] 离场保存序列化失败:', err)
    return Promise.resolve()
  }
}
