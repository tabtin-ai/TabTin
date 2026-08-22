import { joinApiPath } from '@tabtin/config'
import React, { useCallback, useState, useEffect, useRef, useMemo } from 'react'
import {
  SlideEditor,
  TabSlideI18nProvider,
  createDefaultPresentation,
  useSlideCollaboration,
  setRuntimeFontFamilies,
  useSlideCollabBridge,
  type SlidePresentation,
  type SlidePreset,
  type SlideShowOptions,
  useSlideStore,
} from '@tabtin/tabslide'
import {
  convertBackendToPresentation,
  SlideRenderer,
  type BackendProjectDetail,
  type BackendSlidePage,
  type Slide,
  type SlideTheme,
} from '@tabtin/tabslide/viewer'
import type { ImportResult, PPTXExportWarning } from '@tabtin/tabslide/exports'
import { apiService } from '@/services/api'
import { directUpload } from '@/services/oss-direct-uploader'
import { validateUploadFile, UPLOAD_PRESETS, formatFileSize } from '@/constants/upload'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useVersionPanel } from '@/components/collab/useVersionPanel'
import { fetchVersionPreview, CollabStatus, type CollabPeerState, type VersionHistoryItem, type VersionPreviewData } from '@tabtin/collab-core'
import { OVERLAY_SURFACE_CLASS, ScrollArea, PanelErrorBoundary, ModuleErrorBoundary } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { Presentation, Sparkles } from 'lucide-react'
import { requestAgentForSlide } from './requestAgentForSlide'
import { COLLAB_WS_URLS, API_BASE_URL } from '@/config/api'
import {
  unwrapEnvelope,
  buildFirstSlideFingerprint,
  buildSaveBaseline,
  calcRetryDelay,
  type SaveBaseline,
} from './autosave-utils'
import {
  normalizeFontEmbeddingMeta,
  hasFontEmbeddingMeta,
  extractLegacyFontMetaFromTheme,
  injectEmbeddedFonts,
  injectThemeFonts,
  applyRuntimeFontFamilies,
  buildThemeFontsFromPresentationTheme,
  type FontEmbeddingMeta,
} from './slide-font-utils'
import {
  getSlideSaveContext,
  saveToServer,
  fireAndForgetSave,
  syncUnifiedResourceTitle,
  type SavedMetaBaseline,
} from './slide-save'
import { downloadFromUrl, requestBackendPptxExport } from './slide-export'
import { registerFlushHandler } from './slide-flush-registry'
import { toast } from '@tabtin/smartsheet-ui'
import { WifiOff } from 'lucide-react'
import { useRetryOnRecovery } from '@/hooks/useRetryOnRecovery'
import { useScopedResizeObserver } from '@hooks/spaceActivity'
import { DUPLICATE_NAME_ERROR_TITLE, isDuplicateNameErrorMessage } from '@/lib/duplicateNameError'

interface SlideEditorHostProps {
  slideId?: string
  className?: string
  tabScopeKey?: string | null
  /** 只读模式（viewer 角色），禁用版本还原等写操作 */
  isReadonly?: boolean
}

interface SlideEditorHostInnerProps extends SlideEditorHostProps {
  onVersionRestored?: () => void
}

type ToastMessage = { type: 'success' | 'warning' | 'error' | 'info'; text: string }
type SaveQueueWaiter = {
  resolve: (projectId: string) => void
  reject: (error: Error) => void
}

type TabslideExportsRuntime = typeof import('@tabtin/tabslide/exports')
type TabslideImageReuploadRuntime = typeof import('@tabtin/tabslide/image-reupload')
type SlideImportAdapterRuntime = typeof import('./slide-import-adapter')

let tabslideExportsRuntimePromise: Promise<TabslideExportsRuntime> | null = null
let tabslideImageReuploadRuntimePromise: Promise<TabslideImageReuploadRuntime> | null = null
let slideImportAdapterRuntimePromise: Promise<SlideImportAdapterRuntime> | null = null

const loadTabslideExportsRuntime = () => {
  if (!tabslideExportsRuntimePromise) {
    tabslideExportsRuntimePromise = import('@tabtin/tabslide/exports')
  }
  return tabslideExportsRuntimePromise
}

const loadTabslideImageReuploadRuntime = () => {
  if (!tabslideImageReuploadRuntimePromise) {
    tabslideImageReuploadRuntimePromise = import('@tabtin/tabslide/image-reupload')
  }
  return tabslideImageReuploadRuntimePromise
}

const loadSlideImportAdapterRuntime = () => {
  if (!slideImportAdapterRuntimePromise) {
    slideImportAdapterRuntimePromise = import('./slide-import-adapter')
  }
  return slideImportAdapterRuntimePromise
}

const AUTOSAVE_DEBOUNCE_MS = 2000
const THUMBNAIL_DEBOUNCE_MS = 4000
const THUMBNAIL_QUIET_WINDOW_MS = 6000
const THUMBNAIL_HIDDEN_RECHECK_MS = 1500
const THUMBNAIL_IDLE_TIMEOUT_MS = 2500
const THUMBNAIL_WIDTH = 480
const SAVE_RETRY_BASE_MS = 2000
const SAVE_MAX_RETRIES = 20
const THUMBNAIL_RETRY_BASE_MS = 3000
const THUMBNAIL_MAX_RETRIES = 10
type IdleSchedulerWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout?: number },
  ) => number
  cancelIdleCallback?: (handle: number) => void
}

function isCancelledImportError(raw?: string | null): boolean {
  if (!raw) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === '已取消' || normalized === 'canceled' || normalized === 'cancelled'
}

// ─── 字体/导入/保存逻辑已提取到同目录下的独立模块 ────
// slide-font-utils.ts  — 字体类型、清洗、CSS 注入
// slide-import-adapter.ts — 后端 PPTX 导入适配器
// slide-save.ts — saveToServer / fireAndForgetSave

/** 版本预览中每页缩略图之间的水平间距（对应 grid gap-3 = 12px） */
const SLIDE_PREVIEW_GRID_GAP = 12
/** 一次最多直接渲染的页数，超出折叠到「展示全部」按钮后 */
const SLIDE_PREVIEW_PAGE_THRESHOLD = 20

/**
 * SlideThumbnailCard — 用 SlideRenderer 把单页渲染成等比缩放的只读缩略图。
 *
 * SlideRenderer 以画布原始像素尺寸绘制并通过 transform: scale 缩放，
 * 因此外层需给定固定宽高的裁剪容器（colWidth × colWidth*画布高宽比）。
 */
function SlideThumbnailCard({
  page,
  theme,
  canvasWidth,
  canvasHeight,
  colWidth,
  label,
  elementCountLabel,
}: {
  page: Slide
  theme?: SlideTheme
  canvasWidth: number
  canvasHeight: number
  colWidth: number
  label: string
  elementCountLabel: string
}) {
  const scale = colWidth > 0 ? colWidth / canvasWidth : 0
  const thumbHeight = canvasHeight * scale

  return (
    <div className="group relative overflow-hidden rounded-lg border bg-card transition-colors hover:bg-muted/50">
      <div
        className="relative w-full overflow-hidden bg-muted/30"
        style={{ height: thumbHeight || undefined, aspectRatio: scale > 0 ? undefined : `${canvasWidth} / ${canvasHeight}` }}
      >
        {scale > 0 && (
          <div style={{ pointerEvents: 'none' }}>
            <SlideRenderer
              page={page}
              theme={theme}
              scale={scale}
              canvasWidth={canvasWidth}
              canvasHeight={canvasHeight}
              thumbnail
            />
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-caption font-medium text-muted-foreground/80">{label}</span>
        <span className="text-caption text-muted-foreground/60">{elementCountLabel}</span>
      </div>
    </div>
  )
}

/** SlideVersionPreview — 版本面板中的幻灯片预览组件 */
function SlideVersionPreview({ versionId, version }: { versionId: string; version?: VersionHistoryItem }) {
  const [preview, setPreview] = useState<VersionPreviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [colWidth, setColWidth] = useState(0)
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null)
  const token = useAuthStore((s) => s.accessToken)
  const { t } = useTranslation('collab')
  const { t: tabslideT, i18n } = useTranslation('tabslide')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setPreview(null)
    setShowAll(false)
    fetchVersionPreview(joinApiPath(API_BASE_URL, `/collab/v1`), versionId, token || '')
      .then((data) => { if (!cancelled) setPreview(data) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [versionId, token])

  // 将后端完整页面数据转换为可渲染的 SlidePresentation（含元素/主题/画布尺寸）。
  // 画布尺寸缺失（旧 list 格式快照）时传 0，由 convertBackendToPresentation
  // 内部统一兜底，避免在此重复硬编码默认尺寸。
  const presentation = useMemo<SlidePresentation | null>(() => {
    if (!preview || preview.preview_unavailable || preview.type !== 'slide') return null
    if (!Array.isArray(preview.pages)) return null
    try {
      const backendDetail: BackendProjectDetail = {
        id: versionId,
        name: version?.name || '',
        pages: preview.pages as unknown as BackendSlidePage[],
        canvas_width: preview.canvas_width ?? 0,
        canvas_height: preview.canvas_height ?? 0,
        ...(preview.preset ? { preset: preview.preset } : {}),
        ...(preview.theme ? { theme: preview.theme } : {}),
      }
      return convertBackendToPresentation(backendDetail)
    } catch (err) {
      console.warn('[SlideVersionPreview] 转换版本数据失败:', err)
      return null
    }
  }, [preview, versionId, version?.name])

  // 监听网格宽度，计算两列缩略图各自的像素宽度（用于 SlideRenderer 等比缩放）。
  // ResizeObserver 在 observe 时即回调一次，故无需单独的首帧测量。
  useScopedResizeObserver(gridEl, (entries) => {
    const w = entries[0]?.contentRect.width ?? 0
    setColWidth(w > 0 ? Math.max(0, (w - SLIDE_PREVIEW_GRID_GAP) / 2) : 0)
  })

  if (!version) return <div className="text-body text-muted-foreground py-2">{t('version.loadingInfo', '加载版本信息...')}</div>

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    )
  }

  if (!presentation) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/60">
        <Presentation className="h-8 w-8" />
        <span className="text-body">{t('version.previewUnavailable', '此版本暂不支持内容预览')}</span>
      </div>
    )
  }

  const pages = presentation.pages
  const pageCount = preview?.page_count ?? pages.length
  const visiblePages = showAll ? pages : pages.slice(0, SLIDE_PREVIEW_PAGE_THRESHOLD)

  return (
    <TabSlideI18nProvider value={{ t: (key, options) => tabslideT(key, options), language: i18n.resolvedLanguage || i18n.language }}>
      <ScrollArea className="h-full">
        <div className="px-6 py-4">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Presentation className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div className="text-body font-medium">
                {t('version.pageCount', '共 {{count}} 页', { count: pageCount })}
              </div>
              {version.created_at && (
                <div className="text-caption text-muted-foreground/60">
                  {new Date(version.created_at).toLocaleString()}
                </div>
              )}
            </div>
          </div>

          {version.editor_type && (
            <div className="mb-3 flex items-center gap-2 text-caption text-muted-foreground/80">
              <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${
                version.editor_type === 'agent'
                  ? 'bg-type-agent/10 text-type-agent'
                  : version.editor_type === 'system'
                    ? 'bg-muted text-muted-foreground'
                    : 'bg-primary/10 text-primary'
              }`}>
                {version.editor_type === 'agent'
                  ? t('version.editorAgent', 'AI 编辑')
                  : version.editor_type === 'system'
                    ? t('version.editorSystem', '系统')
                    : t('version.editorHuman', '用户编辑')}
              </span>
              {version.name && (
                <span className="font-medium text-foreground">{version.name}</span>
              )}
            </div>
          )}

          <div ref={setGridEl} className="grid grid-cols-2 gap-3">
            {visiblePages.map((page, index) => (
              <SlideThumbnailCard
                key={page.id || index}
                page={page}
                theme={presentation.theme}
                canvasWidth={presentation.canvasWidth}
                canvasHeight={presentation.canvasHeight}
                colWidth={colWidth}
                label={`${t('version.slidePageLabel', '页面')} ${index + 1}`}
                elementCountLabel={t('version.slideElementCount', '{{count}} 个元素', { count: page.elements.length })}
              />
            ))}
          </div>

          {!showAll && pages.length > SLIDE_PREVIEW_PAGE_THRESHOLD && (
            <button
              onClick={() => setShowAll(true)}
              className="mt-3 w-full rounded-lg border border-dashed border-border py-2 text-body text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            >
              {t('version.showAllPages', '展示全部 {{count}} 页', { count: pages.length })}
            </button>
          )}
        </div>
      </ScrollArea>
    </TabSlideI18nProvider>
  )
}

/**
 * SlideEditorHost — TabSlide 编辑器宿主
 *
 * 使用 @tabtin/tabslide 的 SlideEditor 替代旧的 Penpot iframe。
 *
 * 工作流程：
 * 1. 新建演示文稿 → createDefaultPresentation() → 本地编辑
 * 2. 已有演示文稿 → 从后端 API 加载 → 转换为 SlidePresentation → 编辑
 * 3. onChange 时自动保存到后端（debounce）
 *
 * PPTX 导入策略：
 * - 导入时按需注册后端 ImportAdapter，importPPTXFromDialog
 *   通过 /tabslide/parse-pptx/ API 使用 python-pptx 进行高保真解析
 */
export const SlideEditorHost: React.FC<SlideEditorHostProps> = (props) => {
  const [restoreKey, setRestoreKey] = useState(0)
  return <SlideEditorHostInner key={`slide-restore-${restoreKey}`} {...props} onVersionRestored={() => setRestoreKey((k) => k + 1)} />
}

const SlideEditorHostInner: React.FC<SlideEditorHostInnerProps> = ({
  slideId,
  className = '',
  tabScopeKey,
  isReadonly,
  onVersionRestored,
}) => {
  const { t: tabslideT, i18n } = useTranslation('tabslide')
  const isNew = !slideId || slideId.startsWith('new-')
  const [presentation, setPresentation] = useState<SlidePresentation | null>(null)
  const [isLoading, setIsLoading] = useState(!isNew)
  const [error, setError] = useState<string | null>(null)
  const [showPresetPicker, setShowPresetPicker] = useState(isNew)
  const [isImporting, setIsImporting] = useState(false)
  const [importMessage, setImportMessage] = useState<ToastMessage | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const thumbnailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const thumbnailRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasFiredLeaveSaveRef = useRef(false)
  const serverIdRef = useRef<string | null>(isNew ? null : (slideId || null))
  // activeSlideId 是 serverIdRef 的 state 镜像，用于触发 React 重渲染
  const [activeSlideId, setActiveSlideId] = useState<string | null>(isNew ? null : (slideId || null))
  // 追踪当前组件在 context tabs store 中对应的 tabKey，用于身份替换
  const currentTabKeyRef = useRef(`tabslide:${slideId || ''}`)
  const createProjectPromiseRef = useRef<Promise<string | null> | null>(null)
  const createProjectSessionRef = useRef<number | null>(null)
  const saveSessionRef = useRef(0)
  const latestPresentationRef = useRef<SlidePresentation | null>(null)
  const pendingSaveRef = useRef<SlidePresentation | null>(null)
  const saveRetryAttemptRef = useRef(0)
  const isSavingRef = useRef(false)
  const pendingThumbnailRef = useRef<SlidePresentation | null>(null)
  const thumbnailRetryAttemptRef = useRef(0)
  const isSyncingThumbnailRef = useRef(false)
  const lastEditAtRef = useRef<number>(Date.now())
  const thumbnailIdleTaskRef = useRef<number | null>(null)
  const lastThumbnailFingerprintRef = useRef<string>('')
  const fontEmbeddingMetaRef = useRef<FontEmbeddingMeta>({ embeddedFonts: [], themeFonts: {} })
  const fontEmbeddingMetaDirtyRef = useRef(false)
  const lastSavedBaselineRef = useRef<SaveBaseline | null>(null)
  const lastSavedMetaRef = useRef<SavedMetaBaseline | null>(null)
  const saveQueueWaitersRef = useRef<SaveQueueWaiter[]>([])
  /** 上次已同步到 context tab / 资源列表的标题，避免每次画布编辑都重复写 store */
  const lastSyncedTitleRef = useRef<string | null>(null)

  const autoRetryTrigger = useRetryOnRecovery({ hasError: !!error, enabled: !isNew && !!slideId })

  // ── Y.js 实时协作 ──
  const authUser = useAuthStore((s) => s.user)
  const authToken = useAuthStore((s) => s.accessToken)

  const getCollabToken = useCallback(
    () => authToken || '',
    [authToken],
  )

  const collabUser = useMemo(() => {
    if (!authUser) return undefined
    return {
      id: String(authUser.id),
      name: authUser.nickname || authUser.username || tabslideT('label.user'),
      email: authUser.email,
    }
  }, [authUser, tabslideT])

  const collab = useSlideCollaboration({
    projectId: isNew ? null : (slideId || null),
    enabled: !isNew && !!slideId,
    serverUrl: COLLAB_WS_URLS.slide,
    getToken: getCollabToken,
    user: collabUser,
  })
  const effectiveReadonly = Boolean(isReadonly || collab.readOnly)

  const slideRestoreRef = useRef<(() => void) | undefined>(undefined)

  const versionPanel = useVersionPanel({
    resourceType: 'slide',
    resourceId: activeSlideId,
    resourceName: presentation?.name || undefined,
    isReadonly: effectiveReadonly,
    DiffPreview: SlideVersionPreview,
    onRestoreComplete: () => {
      slideRestoreRef.current?.()
    },
    footerNotice: tabslideT('host.versionMigrationNotice', '更早的版本正在迁移中，部分旧版本可能暂时不可见'),
  })

  // 桥接层：Zustand ↔ Y.js 双向同步
  useSlideCollabBridge({
    collab,
    enabled: !collab.isFallback && !isNew,
  })

  // P3-11: 远端 font_meta 变更 → 更新本地 fontEmbeddingMetaRef 并重新注入字体
  useEffect(() => {
    if (collab.isFallback || isNew || !collab.metaFontMeta) return
    const remoteMeta = collab.metaFontMeta as Record<string, unknown>
    const normalized = normalizeFontEmbeddingMeta(remoteMeta)
    const current = fontEmbeddingMetaRef.current
    if (
      JSON.stringify(normalized.embeddedFonts) === JSON.stringify(current.embeddedFonts)
      && JSON.stringify(normalized.themeFonts) === JSON.stringify(current.themeFonts)
    ) return
    fontEmbeddingMetaRef.current = normalized
    fontEmbeddingMetaDirtyRef.current = false
    injectEmbeddedFonts(normalized.embeddedFonts)
    injectThemeFonts(normalized.themeFonts)
    const pres = useSlideStore.getState().presentation
    if (pres) applyRuntimeFontFamilies({ presentation: pres })
  }, [collab.isFallback, isNew, collab.metaFontMeta])

  // CC-016: 长时间离线后重连 toast 提示（与 TabDoc 保持一致）
  useEffect(() => {
    if (collab.longOfflineDetected) {
      toast({
        title: tabslideT('host.longOfflineWarning', '您已离线较长时间'),
        description: tabslideT('host.longOfflineWarningDesc', '建议检查演示文稿内容是否与预期一致，离线期间的编辑已自动合并。'),
      })
      collab.acknowledgeLongOffline()
    }
  }, [collab.longOfflineDetected, collab.acknowledgeLongOffline, tabslideT])

  // C12: 服务端持久化失败 toast 通知
  useEffect(() => {
    if (collab.storeFailed) {
      toast.warning(tabslideT('host.storeFailedWarning', '内容保存失败，请检查网络连接'))
    }
  }, [collab.storeFailed, tabslideT])

  // --- Collab: disconnection banner (debounce 3s, aligned with Design) ---
  const isSlideCollabEligible = !isNew && !!slideId
  const [showDisconnectedBanner, setShowDisconnectedBanner] = useState(false)
  const prevCollabOnlineRef = useRef(collab.status === CollabStatus.SYNCED)
  useEffect(() => {
    if (!isSlideCollabEligible) return
    const isOnline = collab.status === CollabStatus.SYNCED || collab.status === CollabStatus.SYNCING
    const wasOnline = prevCollabOnlineRef.current
    prevCollabOnlineRef.current = isOnline

    if (isOnline) {
      setShowDisconnectedBanner(false)
      return
    }
    if (wasOnline && !isOnline) {
      const timer = setTimeout(() => setShowDisconnectedBanner(true), 3000)
      return () => clearTimeout(timer)
    }
  }, [collab.status, isSlideCollabEligible])

  // CC-014: 从 awarenessPeers（高频）或 peers（降级）构建远端协作者数据
  const activePeers = collab.awarenessPeers.length > 0 ? collab.awarenessPeers : collab.peers
  const remotePeers = useMemo(
    () =>
      activePeers
        .filter((p: CollabPeerState) => p.cursor && p.user)
        .map((p: CollabPeerState) => ({
          userId: p.user.id,
          userName: p.user.name,
          userColor: p.user.color || '#808080',
          userType: (p.user.type === 'agent' ? 'agent' : 'user') as 'user' | 'agent',
          pageId: (p.cursor as { pageId?: string | null } | null | undefined)?.pageId ?? null,
          elementIds: (p.cursor as { elementIds?: string[] } | null | undefined)?.elementIds ?? [],
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activePeers],
  )

  // P2-13: 并发编辑检测 — 当本地选中的元素同时被远端 peer 编辑时，显示 warning toast
  const concurrentEditToastRef = useRef<Map<string, number>>(new Map())
  const CONCURRENT_EDIT_COOLDOWN_MS = 30000

  useEffect(() => {
    const localSelectedIds = useSlideStore.getState().selectedElementIds
    if (localSelectedIds.length === 0 || remotePeers.length === 0) return

    const localSet = new Set(localSelectedIds)
    const conflictingPeer = remotePeers.find((peer) =>
      peer.elementIds.some((eid: string) => localSet.has(eid)),
    )
    if (!conflictingPeer) return

    const conflictKey = conflictingPeer.elementIds.filter((eid: string) => localSet.has(eid)).sort().join(',')
    const now = Date.now()
    const lastToastTime = concurrentEditToastRef.current.get(conflictKey) ?? 0
    if (now - lastToastTime < CONCURRENT_EDIT_COOLDOWN_MS) return

    concurrentEditToastRef.current.set(conflictKey, now)
    toast.warning(tabslideT('host.concurrentEditWarning', '其他协作者也在编辑此元素，修改可能被覆盖'))
  }, [remotePeers, tabslideT])

  const isCollabActiveRef = useRef(false)
  useEffect(() => {
    isCollabActiveRef.current = !collab.isFallback && !isNew
  }, [collab.isFallback, isNew])

  // Electron 真全屏（利用 BrowserWindow.setFullScreen）
  const fullscreenOptions = useMemo<SlideShowOptions>(() => ({
    onEnterFullscreen: () => {
      window.tabtin?.slideshow?.enterFullscreen()
    },
    onExitFullscreen: () => {
      window.tabtin?.slideshow?.exitFullscreen()
    },
  }), [])

  const cancelThumbnailIdleTask = useCallback(() => {
    const idleHandle = thumbnailIdleTaskRef.current
    if (idleHandle === null) return
    const idleWindow = window as IdleSchedulerWindow
    if (typeof idleWindow.cancelIdleCallback === 'function') {
      idleWindow.cancelIdleCallback(idleHandle)
    } else {
      clearTimeout(idleHandle)
    }
    thumbnailIdleTaskRef.current = null
  }, [])

  useEffect(() => {
    // replaceTabKey 将临时 ID 替换为真实 ID 后，renderPane 会传入新的 slideId。
    // 此时 serverIdRef 已经是该真实 ID，无需重新加载——只同步 ref 和 state。
    if (slideId && serverIdRef.current === slideId) {
      currentTabKeyRef.current = `tabslide:${slideId}`
      setActiveSlideId(slideId)
      return
    }

    // ── 离场保存：在重置 session 之前，同步捕获旧文稿的最后编辑并发送 ──
    // 这里用值拷贝（而非 ref）确保切换后旧保存不会被新 session 拦截。
    // 协作模式下跳过 REST 保存，避免 Y.js 覆盖后的空数据被写回后端。
    const prevServerId = serverIdRef.current
    const prevLatest = latestPresentationRef.current
    const prevBaseline = lastSavedBaselineRef.current
    if (prevServerId && prevLatest && !isCollabActiveRef.current) {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      fireAndForgetSave(prevLatest, prevServerId, prevBaseline)
    }

    saveSessionRef.current += 1
    setRuntimeFontFamilies([])
    injectEmbeddedFonts([])
    injectThemeFonts({})
    const initialId = isNew ? null : (slideId || null)
    serverIdRef.current = initialId
    setActiveSlideId(initialId)
    currentTabKeyRef.current = `tabslide:${slideId || ''}`
    createProjectPromiseRef.current = null
    createProjectSessionRef.current = null
    pendingSaveRef.current = null
    pendingThumbnailRef.current = null
    latestPresentationRef.current = null
    lastThumbnailFingerprintRef.current = ''
    fontEmbeddingMetaRef.current = { embeddedFonts: [], themeFonts: {} }
    fontEmbeddingMetaDirtyRef.current = false
    lastSavedBaselineRef.current = null
    lastSavedMetaRef.current = null

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (thumbnailTimerRef.current) {
      clearTimeout(thumbnailTimerRef.current)
      thumbnailTimerRef.current = null
    }
    cancelThumbnailIdleTask()
    if (saveRetryTimerRef.current) {
      clearTimeout(saveRetryTimerRef.current)
      saveRetryTimerRef.current = null
    }
    if (thumbnailRetryTimerRef.current) {
      clearTimeout(thumbnailRetryTimerRef.current)
      thumbnailRetryTimerRef.current = null
    }
    saveRetryAttemptRef.current = 0
    thumbnailRetryAttemptRef.current = 0
  }, [cancelThumbnailIdleTask, isNew, slideId])

  const syncProjectThumbnail = useCallback(async (data: SlidePresentation) => {
    const projectId = serverIdRef.current
    if (!projectId || data.pages.length === 0) return

    const fingerprint = buildFirstSlideFingerprint(data)
    if (!fingerprint || fingerprint === lastThumbnailFingerprintRef.current) return

    const { exportPageToImage } = await loadTabslideExportsRuntime()
    const canvasHsl = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()
    const image = await exportPageToImage(data, 0, {
      format: 'jpeg',
      quality: 0.82,
      width: THUMBNAIL_WIDTH,
      scale: 1.5,
      backgroundColor: canvasHsl ? `hsl(${canvasHsl})` : '#f8f7f5',
    })

    const file = new File([image.blob], `tabslide-thumbnail-${projectId}.jpg`, { type: 'image/jpeg' })

    // 系统自动生成的缩略图（exportPageToImage 产出），类型/大小可控，跳过 validateUploadFile
    const uploadResult = await directUpload(file, file.name, {
      folder: 'tabslide/thumbnails',
      module: 'tabslide',
      contextType: 'project',
      contextId: projectId,
      maxRetries: 3,
      isPublic: true,
    })

    const thumbnailUrl = uploadResult.accessUrl
    if (!thumbnailUrl) return

    try {
      await apiService.request({
        method: 'PATCH',
        url: `/tabslide/projects/${projectId}/`,
        data: { thumbnail: thumbnailUrl },
      }, {
        maxRetries: 5,
        retryDelay: 1000,
        retryBackoff: 2,
        retryableStatuses: [408, 429, 500, 502, 503, 504],
      })
    } catch (patchErr) {
      if (uploadResult.fileId) {
        apiService.request({
          method: 'DELETE',
          url: `/services/oss/files/${uploadResult.fileId}/`,
        }).catch(() => {})
      }
      throw patchErr
    }

    lastThumbnailFingerprintRef.current = fingerprint
    if (latestPresentationRef.current) {
      latestPresentationRef.current = {
        ...latestPresentationRef.current,
        thumbnail: thumbnailUrl,
      }
    }
  }, [])

  const runThumbnailQueue = useCallback(() => {
    if (isSyncingThumbnailRef.current) return
    isSyncingThumbnailRef.current = true

    void (async () => {
      let retryScheduled = false
      try {
        while (pendingThumbnailRef.current) {
          const snapshot = pendingThumbnailRef.current
          pendingThumbnailRef.current = null
          try {
            await syncProjectThumbnail(snapshot)
            thumbnailRetryAttemptRef.current = 0
          } catch (err) {
            console.warn('[SlideEditorHost] 缩略图同步失败:', err)
            if (!pendingThumbnailRef.current) pendingThumbnailRef.current = snapshot
            thumbnailRetryAttemptRef.current += 1
            if (thumbnailRetryAttemptRef.current > THUMBNAIL_MAX_RETRIES) {
              console.error('[SlideEditorHost] 缩略图同步重试次数已达上限，停止重试')
              pendingThumbnailRef.current = null // 清空 pending，避免死循环
              break
            }
            const delay = calcRetryDelay(thumbnailRetryAttemptRef.current, THUMBNAIL_RETRY_BASE_MS)
            if (thumbnailRetryTimerRef.current) {
              clearTimeout(thumbnailRetryTimerRef.current)
            }
            thumbnailRetryTimerRef.current = setTimeout(() => {
              thumbnailRetryTimerRef.current = null
              runThumbnailQueue()
            }, delay)
            retryScheduled = true
            break
          }
        }
      } finally {
        isSyncingThumbnailRef.current = false
        if (pendingThumbnailRef.current && !retryScheduled) runThumbnailQueue()
      }
    })()
  }, [syncProjectThumbnail])

  const scheduleThumbnailSync = useCallback((data: SlidePresentation) => {
    if (thumbnailTimerRef.current) {
      clearTimeout(thumbnailTimerRef.current)
    }
    cancelThumbnailIdleTask()

    pendingThumbnailRef.current = data

    const tryDispatch = () => {
      const quietElapsed = Date.now() - lastEditAtRef.current
      const isVisible = typeof document === 'undefined' || document.visibilityState === 'visible'
      if (!isVisible || quietElapsed < THUMBNAIL_QUIET_WINDOW_MS) {
        const delay = !isVisible
          ? THUMBNAIL_HIDDEN_RECHECK_MS
          : Math.max(THUMBNAIL_HIDDEN_RECHECK_MS, THUMBNAIL_QUIET_WINDOW_MS - quietElapsed)
        thumbnailTimerRef.current = setTimeout(() => {
          thumbnailTimerRef.current = null
          tryDispatch()
        }, delay)
        return
      }

      if (thumbnailRetryTimerRef.current) {
        clearTimeout(thumbnailRetryTimerRef.current)
        thumbnailRetryTimerRef.current = null
      }
      thumbnailRetryAttemptRef.current = 0
      const idleWindow = window as IdleSchedulerWindow
      if (typeof idleWindow.requestIdleCallback === 'function') {
        thumbnailIdleTaskRef.current = idleWindow.requestIdleCallback(() => {
          thumbnailIdleTaskRef.current = null
          runThumbnailQueue()
        }, { timeout: THUMBNAIL_IDLE_TIMEOUT_MS })
        return
      }
      thumbnailIdleTaskRef.current = window.setTimeout(() => {
        thumbnailIdleTaskRef.current = null
        runThumbnailQueue()
      }, 0)
    }

    thumbnailTimerRef.current = setTimeout(() => {
      thumbnailTimerRef.current = null
      tryDispatch()
    }, THUMBNAIL_DEBOUNCE_MS)
  }, [cancelThumbnailIdleTask, runThumbnailQueue])

  const settleSaveQueueWaiters = useCallback((projectId: string | null, error?: Error | null) => {
    if (saveQueueWaitersRef.current.length === 0) return
    const waiters = saveQueueWaitersRef.current.splice(0)
    if (projectId && !error) {
      waiters.forEach((waiter) => waiter.resolve(projectId))
      return
    }
    const reason = error || new Error(tabslideT(
      'host.export.saveBeforeExportFailed',
      '导出前保存失败，请检查网络后重试',
    ))
    waiters.forEach((waiter) => waiter.reject(reason))
  }, [tabslideT])

  const runSaveQueue = useCallback(() => {
    if (isSavingRef.current) return
    isSavingRef.current = true
    const savingPid = serverIdRef.current || undefined
    useSlideStore.getState().setSaveStatus('saving', undefined, savingPid)

    void (async () => {
      let retryScheduled = false
      let lastSavedProjectId: string | null = null
      let terminalError: Error | null = null
      try {
        while (pendingSaveRef.current) {
          const snapshot = pendingSaveRef.current
          pendingSaveRef.current = null
          const session = saveSessionRef.current
          const saveResult = await saveToServer(
            snapshot,
            serverIdRef,
            createProjectPromiseRef,
            createProjectSessionRef,
            saveSessionRef,
            fontEmbeddingMetaRef,
            fontEmbeddingMetaDirtyRef,
            lastSavedBaselineRef,
            lastSavedMetaRef,
            session,
          )
          if (saveResult?.projectId && session === saveSessionRef.current) {
            const projectId = saveResult.projectId
            lastSavedProjectId = projectId
            saveRetryAttemptRef.current = 0
            if (saveResult.metaError && isDuplicateNameErrorMessage(saveResult.metaError.message)) {
              const rollbackName = lastSavedMetaRef.current?.name || presentation?.name || tabslideT('untitled')
              const rolledBackSnapshot = { ...snapshot, name: rollbackName }
              useSlideStore.getState().updatePresentationMeta({ name: rollbackName })
              setPresentation(prev => (prev ? { ...prev, name: rollbackName } : rolledBackSnapshot))
              latestPresentationRef.current = rolledBackSnapshot
              syncUnifiedResourceTitle(projectId, rollbackName)
              lastSyncedTitleRef.current = rollbackName
              toast.error(undefined, {
                title: DUPLICATE_NAME_ERROR_TITLE,
                duration: 6000,
              })
            }
            useSlideStore.getState().setSaveStatus('saved', undefined, projectId)
            if (typeof saveResult.version === 'number') {
              useSlideStore.getState().setVersion(saveResult.version)
            }
            // 首次获得服务端 ID：将临时 tabKey 替换为真实 ID
            const expectedTabKey = `tabslide:${projectId}`
            if (currentTabKeyRef.current !== expectedTabKey) {
              const tabScope = tabScopeKey || useSpaceStore.getState().selectedSpace?.id
              if (tabScope) {
                useSpaceContextTabsStore.getState().replaceTabKey(
                  tabScope, currentTabKeyRef.current, expectedTabKey, projectId,
                )
                currentTabKeyRef.current = expectedTabKey
              }
              setActiveSlideId(projectId)
            }

            // tabKey 替换后再同步标题，确保 syncOpenResourceTabTitle 命中已打开 tab
            if (!saveResult.metaError) {
              syncUnifiedResourceTitle(projectId, snapshot.name)
            }

            scheduleThumbnailSync(snapshot)
            continue
          }

          if (session !== saveSessionRef.current) continue

          const { organizationId, spaceId: spaceIdInStore } = getSlideSaveContext()
          const hasContext = Boolean(organizationId && spaceIdInStore)
          if (!hasContext) {
            if (!pendingSaveRef.current) pendingSaveRef.current = snapshot
            saveRetryAttemptRef.current += 1
            if (saveRetryAttemptRef.current > SAVE_MAX_RETRIES) {
              console.error('[SlideEditorHost] 保存重试次数已达上限，停止重试。请检查网络或刷新页面。')
              const message = tabslideT('host.error.saveMissingContext')
              useSlideStore.getState().setSaveStatus('error', message, savingPid)
              terminalError = new Error(message)
              pendingSaveRef.current = null // 清空 pending，避免死循环
              break
            }
            const delay = calcRetryDelay(saveRetryAttemptRef.current, SAVE_RETRY_BASE_MS)
            if (saveRetryTimerRef.current) {
              clearTimeout(saveRetryTimerRef.current)
            }
            saveRetryTimerRef.current = setTimeout(() => {
              saveRetryTimerRef.current = null
              runSaveQueue()
            }, delay)
            retryScheduled = true
            console.warn('[SlideEditorHost] 保存失败且缺少 organization/project 上下文，已保留快照并等待上下文恢复后重试')
            break
          }

          if (!pendingSaveRef.current) pendingSaveRef.current = snapshot
          saveRetryAttemptRef.current += 1
          if (saveRetryAttemptRef.current > SAVE_MAX_RETRIES) {
            console.error('[SlideEditorHost] 保存重试次数已达上限，停止重试。请检查网络或刷新页面。')
            const message = tabslideT('host.error.saveRetryExceeded')
            useSlideStore.getState().setSaveStatus('error', message, savingPid)
            terminalError = new Error(message)
            pendingSaveRef.current = null // 清空 pending，避免死循环
            break
          }
          const delay = calcRetryDelay(saveRetryAttemptRef.current, SAVE_RETRY_BASE_MS)
          if (saveRetryTimerRef.current) {
            clearTimeout(saveRetryTimerRef.current)
          }
          saveRetryTimerRef.current = setTimeout(() => {
            saveRetryTimerRef.current = null
            runSaveQueue()
          }, delay)
          retryScheduled = true
          break
        }
      } finally {
        isSavingRef.current = false
        if (pendingSaveRef.current && !retryScheduled) {
          runSaveQueue()
        } else if (!pendingSaveRef.current && !retryScheduled) {
          settleSaveQueueWaiters(lastSavedProjectId, terminalError)
        }
      }
    })()
  }, [presentation?.name, scheduleThumbnailSync, settleSaveQueueWaiters, tabslideT])

  const enqueueSave = useCallback((data: SlidePresentation) => {
    if (saveRetryTimerRef.current) {
      clearTimeout(saveRetryTimerRef.current)
      saveRetryTimerRef.current = null
    }
    saveRetryAttemptRef.current = 0
    pendingSaveRef.current = data
    runSaveQueue()
  }, [runSaveQueue])

  const flushLatestSave = useCallback(() => {
    if (isCollabActiveRef.current) return
    const latest = latestPresentationRef.current
    if (!latest) return

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (saveRetryTimerRef.current) {
      clearTimeout(saveRetryTimerRef.current)
      saveRetryTimerRef.current = null
    }
    saveRetryAttemptRef.current = 0
    pendingSaveRef.current = latest
    runSaveQueue()
  }, [runSaveQueue])

  const flushPresentationForExport = useCallback((snapshot: SlidePresentation): Promise<string> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (saveRetryTimerRef.current) {
      clearTimeout(saveRetryTimerRef.current)
      saveRetryTimerRef.current = null
    }
    saveRetryAttemptRef.current = 0
    pendingSaveRef.current = snapshot
    return new Promise((resolve, reject) => {
      saveQueueWaitersRef.current.push({ resolve, reject })
      runSaveQueue()
    })
  }, [runSaveQueue])

  const handleModuleCrash = useCallback(async () => {
    try {
      flushLatestSave()
      return { saved: true }
    } catch {
      return { saved: false }
    }
  }, [flushLatestSave])

  const handleModuleReload = useCallback(() => {
    window.dispatchEvent(new CustomEvent('tabtin:collab-resource-restored', { detail: { resourceTypes: ['slide'] } }))
  }, [])

  const resetSavePipeline = useCallback(() => {
    settleSaveQueueWaiters(null, new Error(tabslideT(
      'host.export.saveBeforeExportCancelled',
      '导出前保存已取消',
    )))
    saveSessionRef.current += 1
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (thumbnailTimerRef.current) {
      clearTimeout(thumbnailTimerRef.current)
      thumbnailTimerRef.current = null
    }
    if (saveRetryTimerRef.current) {
      clearTimeout(saveRetryTimerRef.current)
      saveRetryTimerRef.current = null
    }
    if (thumbnailRetryTimerRef.current) {
      clearTimeout(thumbnailRetryTimerRef.current)
      thumbnailRetryTimerRef.current = null
    }
    cancelThumbnailIdleTask()
    pendingSaveRef.current = null
    pendingThumbnailRef.current = null
    saveRetryAttemptRef.current = 0
    thumbnailRetryAttemptRef.current = 0
    createProjectPromiseRef.current = null
    createProjectSessionRef.current = null
    lastSavedBaselineRef.current = null
    lastSavedMetaRef.current = null
    lastSyncedTitleRef.current = null
  }, [cancelThumbnailIdleTask, settleSaveQueueWaiters, tabslideT])

  // NEW-003: onRestoreSuccess 触发 forceReconnect（remount），与 TabVideo 保持一致。
  // resetSavePipeline 在 remount 前清理保存管道，避免旧 timer 在新实例中触发。
  slideRestoreRef.current = () => {
    resetSavePipeline()
    onVersionRestored?.()
  }

  // 聊天回退后自动刷新：监听 checkpoint 回滚事件（payload 为 { resourceTypes: string[] }）
  useEffect(() => {
    if (!activeSlideId) return
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail?.resourceTypes || detail.resourceTypes.includes('slide')) {
        slideRestoreRef.current?.()
      }
    }
    window.addEventListener('tabtin:collab-resource-restored', handler)
    return () => window.removeEventListener('tabtin:collab-resource-restored', handler)
  }, [activeSlideId])

  // ── 从后端加载已有演示文稿 ──
  useEffect(() => {
    if (isNew || !slideId) return

    let cancelled = false
    setIsLoading(true)
    setError(null)

    apiService
      .request<Record<string, unknown>>({
        method: 'GET',
        url: `/tabslide/projects/${slideId}/`,
      })
      .then((envelope) => {
        if (cancelled) return
        const res = unwrapEnvelope(envelope)

        // 使用统一的 convertBackendToPresentation 进行元素格式转换
        const data = convertBackendToPresentation({
          id: slideId,
          name: (res.name as string) || tabslideT('untitled'),
          preset: res.preset as string,
          //  canvas 统一：兜底 1280×720（与 html-spec / PPTX EMU 1:1）
          canvas_width: (res.canvas_width as number) || 1280,
          canvas_height: (res.canvas_height as number) || 720,
          page_count: res.page_count as number,
          pages: (res.pages as any) || [],
          theme: res.theme as Record<string, unknown>,
          thumbnail: res.thumbnail as string,
          created_at: res.created_at as string,
          updated_at: res.updated_at as string,
        })

        const responseFontMeta = normalizeFontEmbeddingMeta({
          embeddedFonts: res.embedded_fonts,
          themeFonts: res.theme_fonts,
        })
        const legacyFontMeta = extractLegacyFontMetaFromTheme(res.theme as SlidePresentation['theme'])
        const effectiveFontMeta: FontEmbeddingMeta = {
          embeddedFonts: responseFontMeta.embeddedFonts.length > 0
            ? responseFontMeta.embeddedFonts
            : legacyFontMeta.embeddedFonts,
          themeFonts: Object.keys(responseFontMeta.themeFonts).length > 0
            ? responseFontMeta.themeFonts
            : legacyFontMeta.themeFonts,
        }

        serverIdRef.current = slideId
        setActiveSlideId(slideId)
        latestPresentationRef.current = data
        lastThumbnailFingerprintRef.current = data.thumbnail ? buildFirstSlideFingerprint(data) : ''
        fontEmbeddingMetaRef.current = effectiveFontMeta
        fontEmbeddingMetaDirtyRef.current = false
        const baseline = buildSaveBaseline(data)
        lastSavedBaselineRef.current = baseline
        lastSavedMetaRef.current = {
          name: data.name,
          themeFingerprint: baseline.themeFingerprint,
        }

        // 先渲染内容，字体注入延迟到下一帧执行（消除加载阻塞）
        syncUnifiedResourceTitle(slideId, data.name)
        lastSyncedTitleRef.current = data.name?.trim() || null
        setPresentation(data)
        setIsLoading(false)

        // 字体注入放到渲染之后，避免阻塞首帧
        requestAnimationFrame(() => {
          injectEmbeddedFonts(effectiveFontMeta.embeddedFonts)
          const resolvedThemeFonts = Object.keys(effectiveFontMeta.themeFonts).length > 0
            ? effectiveFontMeta.themeFonts
            : buildThemeFontsFromPresentationTheme(data)
          injectThemeFonts(resolvedThemeFonts)
          applyRuntimeFontFamilies({
            embeddedFonts: effectiveFontMeta.embeddedFonts,
            themeFonts: resolvedThemeFonts,
            presentation: data,
          })
        })
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[SlideEditorHost] 加载失败:', err)
        setError(tabslideT('host.error.loadFailedRetry'))
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [slideId, isNew, tabslideT, retryKey, autoRetryTrigger])

  // ── 新建演示文稿 ──
  const handleCreate = useCallback((preset: SlidePreset) => {
    const data = createDefaultPresentation(preset, tabslideT('untitled'))
    fontEmbeddingMetaRef.current = { embeddedFonts: [], themeFonts: {} }
    fontEmbeddingMetaDirtyRef.current = false
    injectEmbeddedFonts([])
    injectThemeFonts(buildThemeFontsFromPresentationTheme(data))
    applyRuntimeFontFamilies({ presentation: data })
    setPresentation(data)
    latestPresentationRef.current = data
    lastThumbnailFingerprintRef.current = ''
    const baseline = buildSaveBaseline(data)
    // 新建演示此时后端还没有页面；首次 autosave 必须走全量 save-pages。
    lastSavedBaselineRef.current = null
    lastSavedMetaRef.current = {
      name: data.name,
      themeFingerprint: baseline.themeFingerprint,
    }
    setShowPresetPicker(false)
  }, [tabslideT])

  // ── 数据变更 → 自动保存（debounce 2s） ──
  // 当 Y.js 协作活跃时，跳过 REST 保存（由 Hocuspocus onStore 负责持久化）
  const syncPresentationTitleToChrome = useCallback((data: SlidePresentation) => {
    const resourceId = serverIdRef.current || slideId || null
    const nextName = data.name?.trim() ?? ''
    if (!resourceId || nextName === lastSyncedTitleRef.current) return
    syncUnifiedResourceTitle(resourceId, nextName)
    lastSyncedTitleRef.current = nextName
  }, [slideId])

  const handleChange = useCallback(
    (data: SlidePresentation) => {
      latestPresentationRef.current = data
      lastEditAtRef.current = Date.now()

      // 顶栏标签 / 侧栏资源列表即时跟演示名，不等待 autosave（协作模式也不走 REST 保存）
      syncPresentationTitleToChrome(data)

      if (isCollabActiveRef.current) return

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }

      saveTimerRef.current = setTimeout(() => {
        const latest = latestPresentationRef.current
        if (latest) enqueueSave(latest)
      }, AUTOSAVE_DEBOUNCE_MS)
    },
    [enqueueSave, syncPresentationTitleToChrome],
  )

  // ── 导入完成提示自动消失 ──
  useEffect(() => {
    if (!importMessage) return
    const timer = setTimeout(() => setImportMessage(null), 4000)
    return () => clearTimeout(timer)
  }, [importMessage])

  const applyImportedPresentation = useCallback((
    result: ImportResult & { fontMeta?: FontEmbeddingMeta },
    options?: { closePresetPicker?: boolean },
  ) => {
    if (!result.presentation) return

    const importedFontMeta = normalizeFontEmbeddingMeta(
      result.fontMeta || extractLegacyFontMetaFromTheme(result.presentation.theme),
    )

    resetSavePipeline()
    setPresentation(result.presentation)
    latestPresentationRef.current = result.presentation
    lastThumbnailFingerprintRef.current = ''
    if (options?.closePresetPicker) {
      setShowPresetPicker(false)
    }
    setActiveSlideId(null)
    fontEmbeddingMetaRef.current = importedFontMeta
    fontEmbeddingMetaDirtyRef.current = hasFontEmbeddingMeta(importedFontMeta)
    // P3-11: 推送 font_meta 到 Y.Doc（协作同步）
    if (hasFontEmbeddingMeta(importedFontMeta) && !collab.isFallback) {
      collab.updateMetaFontMeta(importedFontMeta as unknown as Record<string, unknown>)
    }
    lastSavedBaselineRef.current = null
    lastSavedMetaRef.current = null
    enqueueSave(result.presentation)
  }, [enqueueSave, resetSavePipeline, collab.isFallback, collab.updateMetaFontMeta])

  const runImportPPTX = useCallback(async (options?: { closePresetPicker?: boolean }) => {
    setIsImporting(true)
    setImportMessage(null)
    try {
      const [{ importPPTXFromDialog }, { ensureBackendImportAdapterRegistered }] = await Promise.all([
        loadTabslideExportsRuntime(),
        loadSlideImportAdapterRuntime(),
      ])
      ensureBackendImportAdapterRegistered()
      // 注：importPPTXFromDialog 是 tabslide 包内的导入器（非 IPC envelope）；
      // 返 `{success, presentation, error?, stats?}` —— cancelled 路径会有 error
      // 但不视为业务失败。contract W2-β 重命名变量避开字面 result.success 形态，
      // 双分支语义（成功显示 stats / 错误显示原因）不适合 throw。
      const importRes = await importPPTXFromDialog()
      if (importRes.success && importRes.presentation) {
        applyImportedPresentation(importRes as ImportResult & { fontMeta?: FontEmbeddingMeta }, options)
        const stats = importRes.stats
        setImportMessage({
          type: 'success',
          text: tabslideT('host.import.successWithStats', {
            slides: stats?.totalSlides || 0,
            elements: stats?.totalElements || 0,
          }),
        })
      } else if (importRes.error && !isCancelledImportError(importRes.error)) {
        setImportMessage({
          type: 'error',
          text: tabslideT('host.import.failedWithReason', { reason: importRes.error }),
        })
      }
    } catch (err) {
      setImportMessage({
        type: 'error',
        text: tabslideT('host.import.failedWithReason', { reason: (err as Error).message }),
      })
    } finally {
      setIsImporting(false)
    }
  }, [applyImportedPresentation, tabslideT])

  // ── 导入 PPTX ──
  const handleImportPPTX = useCallback(() => runImportPPTX(), [runImportPPTX])

  // ── 导出 PPTX（后端 pptx_io 统一导出） ──
  const handleExportPPTX = useCallback(async () => {
    const currentPresentation = latestPresentationRef.current || presentation
    if (!currentPresentation) return
    setImportMessage(null)
    try {
      const projectId = await flushPresentationForExport(currentPresentation)
      const { downloadUrl, filename } = await requestBackendPptxExport(
        projectId,
        apiService.request.bind(apiService),
      )
      downloadFromUrl(downloadUrl, filename)
    } catch (err) {
      console.error('[SlideEditorHost] PPTX 导出失败:', err)
      const reason = (err as Error).message === 'missing download_url'
        ? tabslideT('host.export.missingDownloadUrl', '导出服务未返回下载地址')
        : (err as Error).message
      setImportMessage({
        type: 'error',
        text: tabslideT('host.export.failedWithReason', { reason }),
      })
    }
  }, [flushPresentationForExport, presentation, tabslideT])

  // ── 导出 PDF（客户端导出） ──
  const handleExportPDF = useCallback(async () => {
    const currentPresentation = latestPresentationRef.current || presentation
    if (!currentPresentation) return
    try {
      const { downloadAsPDF } = await loadTabslideExportsRuntime()
      await downloadAsPDF(currentPresentation)
    } catch (err) {
      console.error('[SlideEditorHost] PDF 导出失败:', err)
    }
  }, [presentation])

  // ── 导出图片 ──
  const handleExportImages = useCallback(async () => {
    const currentPresentation = latestPresentationRef.current || presentation
    if (!currentPresentation) return
    try {
      const { downloadAllPagesAsImages } = await loadTabslideExportsRuntime()
      await downloadAllPagesAsImages(currentPresentation)
    } catch (err) {
      console.error('[SlideEditorHost] 图片导出失败:', err)
      setImportMessage({
        type: 'error',
        text: tabslideT('host.export.failedWithReason', { reason: (err as Error).message }),
      })
    }
  }, [presentation, tabslideT])

  // ── 图片上传到 OSS（前端直传） ──
  const handleUploadImage = useCallback(async (file: File): Promise<string> => {
    const validation = validateUploadFile(file, 'IMAGE')
    if (!validation.valid) {
      throw new Error(tabslideT('host.error.uploadValidation'))
    }
    let projectId = serverIdRef.current
    if (!projectId && createProjectPromiseRef.current) {
      projectId = await createProjectPromiseRef.current
    }
    const result = await directUpload(file, file.name, {
      folder: 'tabslide/images',
      module: 'tabslide',
      contextType: 'project',
      contextId: projectId || `tabslide_pending_${Date.now()}`,
      isPublic: true,
    })
    if (!result.accessUrl) throw new Error(tabslideT('host.error.uploadEmptyUrl'))
    return result.accessUrl
  }, [tabslideT])

  const handleImageError = useCallback((type: string, message: string) => {
    let text = ''
    if (type === 'validation') {
      text = message === 'too_large'
        ? tabslideT('host.error.imageTooLarge', { maxSize: formatFileSize(UPLOAD_PRESETS.IMAGE.maxSize) })
        : tabslideT('host.error.imageTypeNotSupported')
    } else if (type === 'upload' && message === 'fallback_base64') {
      text = tabslideT('host.error.imageUploadFallback')
    } else {
      text = tabslideT('host.error.imageLoadFailed')
    }
    const msgType = message === 'fallback_base64' ? 'success' : 'warning'
    if (text) setImportMessage({ type: msgType, text })
  }, [tabslideT])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current)
      if (saveRetryTimerRef.current) clearTimeout(saveRetryTimerRef.current)
      if (thumbnailRetryTimerRef.current) clearTimeout(thumbnailRetryTimerRef.current)
      cancelThumbnailIdleTask()
      if (hasFiredLeaveSaveRef.current) return
      hasFiredLeaveSaveRef.current = true
      if (isCollabActiveRef.current) return
      const serverId = serverIdRef.current
      const latest = latestPresentationRef.current
      const baseline = lastSavedBaselineRef.current
      if (serverId && latest) {
        fireAndForgetSave(latest, serverId, baseline)
      }
    }
  }, [cancelThumbnailIdleTask])

  // Electron 窗口关闭保护：通过全局 flush 注册表协调多 keepAlive 编辑器
  useEffect(() => {
    const editorId = currentTabKeyRef.current
    const unregister = registerFlushHandler(editorId, () => {
      if (isCollabActiveRef.current) return Promise.resolve()
      const serverId = serverIdRef.current
      const latest = latestPresentationRef.current
      const baseline = lastSavedBaselineRef.current
      if (serverId && latest) {
        return fireAndForgetSave(latest, serverId, baseline)
      }
      return Promise.resolve()
    })
    return () => { unregister() }
  }, [])

  // ── 联网后重传离线 base64 图片 ──
  useEffect(() => {
    const handleOnline = () => {
      void loadTabslideImageReuploadRuntime()
        .then(({ reuploadOfflineImages }) => reuploadOfflineImages(handleUploadImage, () => {
          const latest = useSlideStore.getState().presentation
          if (latest) enqueueSave(latest)
        }))
        .then((result) => {
          if (result.total === 0) return
          const failed = result.total - result.success
          if (failed === 0) {
            setImportMessage({
              type: 'success',
              text: tabslideT('host.reupload.success', { count: result.success }),
            })
          } else if (result.success === 0) {
            setImportMessage({
              type: 'error',
              text: tabslideT('host.reupload.failed', { count: failed }),
            })
          } else {
            setImportMessage({
              type: 'error',
              text: tabslideT('host.reupload.partialFailed', { success: result.success, failed }),
            })
          }
        })
        .catch((err) => {
          console.warn('[SlideEditorHost] 联网后图片重传初始化失败:', err)
        })
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [handleUploadImage, tabslideT, enqueueSave])

  useEffect(() => {
    const fireLeaveSaveOnce = () => {
      if (hasFiredLeaveSaveRef.current) return
      hasFiredLeaveSaveRef.current = true
      if (isCollabActiveRef.current) return
      const serverId = serverIdRef.current
      const latest = latestPresentationRef.current
      const baseline = lastSavedBaselineRef.current
      if (serverId && latest) {
        fireAndForgetSave(latest, serverId, baseline)
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushLatestSave()
      }
    }

    window.addEventListener('beforeunload', fireLeaveSaveOnce)
    window.addEventListener('pagehide', fireLeaveSaveOnce)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('beforeunload', fireLeaveSaveOnce)
      window.removeEventListener('pagehide', fireLeaveSaveOnce)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [flushLatestSave])

  // ── 从预设选择器导入 PPTX ──
  const handleImportFromPicker = useCallback(
    () => runImportPPTX({ closePresetPicker: true }),
    [runImportPPTX],
  )

  // ── 新建选择器 ──
  if (showPresetPicker) {
    return (
      <div className={`relative flex h-full w-full items-center justify-center bg-[hsl(var(--tabslide-canvas,0_0%_96%))] ${className}`}>
        {isImporting && (
          <div className="absolute inset-0 z-modal flex items-center justify-center overlay-backdrop-blur">
            <div className={`flex flex-col items-center gap-3 rounded-xl px-8 py-6 ${OVERLAY_SURFACE_CLASS}`}>
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
              <span className="text-body font-medium text-foreground">{tabslideT('host.importing.title')}</span>
              <span className="text-body text-muted-foreground">{tabslideT('host.importing.description')}</span>
            </div>
          </div>
        )}
        <div className="w-[520px] rounded-xl border border-border bg-card p-8 text-card-foreground">
          <h2 className="mb-2 text-title font-semibold">{tabslideT('host.preset.title')}</h2>
          <p className="mb-6 text-body text-muted-foreground">{tabslideT('host.preset.description')}</p>
          <div className="flex gap-4">
            {([
              {
                preset: '16:9' as const,
                labelKey: 'host.preset.option.widescreen.label',
                descKey: 'host.preset.option.widescreen.description',
                h: 54,
              },
              {
                preset: '4:3' as const,
                labelKey: 'host.preset.option.classic.label',
                descKey: 'host.preset.option.classic.description',
                h: 72,
              },
              {
                preset: 'xiaohongshu' as const,
                labelKey: 'host.preset.option.xiaohongshu.label',
                descKey: 'host.preset.option.xiaohongshu.description',
                h: 88,
              },
            ]).map(({ preset, labelKey, descKey, h }) => (
              <button
                key={preset}
                className="group flex flex-1 flex-col items-center gap-3 rounded-lg border border-border bg-background p-5 transition-colors hover:border-primary hover:bg-accent/5"
                onClick={() => handleCreate(preset)}
              >
                <div
                  className="w-[96px] rounded bg-muted/60 transition-colors group-hover:bg-muted"
                  style={{ height: h }}
                />
                <span className="text-body font-medium text-foreground">{tabslideT(labelKey)}</span>
                <span className="text-caption text-muted-foreground">{tabslideT(descKey)}</span>
              </button>
            ))}
          </div>
          <div className="mt-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-body text-muted-foreground">{tabslideT('host.preset.or')}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <button
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background py-3 text-body text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            onClick={handleImportFromPicker}
          >
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {tabslideT('host.preset.importButton')}
          </button>
          {/* M1 人机交互闭环：在新建选择器里加"让 Agent 帮忙"作为次要选项；
              主路径仍是直接选画幅比进空白编辑器（PPT 用户的肌肉记忆不动），
              这里点了之后把当前临时编辑器 tab 关闭、唤起侧栏对话 + 注入
              tabslide.createSlide preset 表单。 */}
          <button
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-accent/40 bg-accent/5 py-3 text-body text-accent transition-colors hover:border-accent hover:bg-accent/10"
            onClick={() => {
              const spaceId = useSpaceStore.getState().selectedSpace?.id
              if (!spaceId) {
                toast({
                  title: tabslideT('host.preset.agentButton.noSpace', { defaultValue: '当前没有选中的 Space，无法发起对话' }),
                  variant: 'destructive',
                })
                return
              }
              setShowPresetPicker(false)
              // 关闭这个还没保存的临时 tab，让用户的视觉焦点落到侧栏对话上
              const tempTabKey = currentTabKeyRef.current
              useSpaceContextTabsStore.getState().closeTab(spaceId, tempTabKey)
              requestAgentForSlide(spaceId, { source: 'preset_picker' })
            }}
          >
            <Sparkles className="h-4 w-4" />
            {tabslideT('host.preset.agentButton', { defaultValue: '让 Agent 帮我搭大纲' })}
          </button>
        </div>
      </div>
    )
  }

  // ── 加载中 ──
  if (isLoading) {
    return (
      <div className={`flex h-full w-full items-center justify-center bg-[hsl(var(--tabslide-canvas,0_0%_96%))] ${className}`}>
        <div className="flex flex-col items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-primary" />
          <span className="text-body text-muted-foreground">{tabslideT('host.loading')}</span>
        </div>
      </div>
    )
  }

  // ── 错误 ──
  if (error) {
    return (
      <div className={`flex h-full w-full items-center justify-center bg-[hsl(var(--tabslide-canvas,0_0%_96%))] ${className}`}>
        <div className="flex flex-col items-center gap-3">
          <p className="text-body text-muted-foreground">{error}</p>
          <button
            className="rounded-md border border-border bg-background px-4 py-1.5 text-body text-foreground transition-colors hover:bg-muted"
            onClick={() => {
              setError(null)
              setIsLoading(true)
              setRetryKey(k => k + 1)
            }}
          >
            {tabslideT('host.reload')}
          </button>
        </div>
      </div>
    )
  }

  // ── 编辑器 ──
  if (!presentation) return null

  return (
    <ModuleErrorBoundary
      moduleName="TabSlide"
      onCrash={handleModuleCrash}
      onReload={handleModuleReload}
    >
      <div className={`relative h-full w-full flex flex-col ${className}`}>
        {showDisconnectedBanner && (
          <div className="shrink-0 flex items-center justify-center gap-2 bg-warning/90 px-3 py-1.5 text-body font-medium text-white shadow-sm">
            <WifiOff className="size-3.5 shrink-0" />
            <span>{tabslideT('host.collabDisconnected', '协作连接已断开，编辑将在重连后同步')}</span>
          </div>
        )}
        {/* 保存状态指示器已移到 packages/tabslide 的 SlideTitle 组件 */}
        <div className="flex-1 min-h-0 relative">
          <TabSlideI18nProvider
            value={{
              t: (key, options) => tabslideT(key, options),
              language: i18n.resolvedLanguage || i18n.language,
            }}
          >
            <PanelErrorBoundary name="slide-editor">
              <SlideEditor
                data={presentation}
                onChange={handleChange}
                fullscreenOptions={fullscreenOptions}
                onImportPPTX={handleImportPPTX}
                onExportPPTX={handleExportPPTX}
                onExportPDF={handleExportPDF}
                onExportImages={handleExportImages}
                onUploadImage={handleUploadImage}
                onImageError={handleImageError}
                onOpenVersionHistory={activeSlideId ? versionPanel.toggle : undefined}
                remotePeers={remotePeers}
                onSelectionChange={collab.isFallback ? undefined : collab.broadcastSelection}
              />
            </PanelErrorBoundary>
          </TabSlideI18nProvider>
        </div>

        {/* 版本历史侧栏面板 */}
        {versionPanel.renderPanel()}

        {/* 导入中遮罩 */}
        {isImporting && (
          <div className="absolute inset-0 z-modal flex items-center justify-center overlay-backdrop-blur">
            <div className={`flex flex-col items-center gap-3 rounded-xl px-8 py-6 ${OVERLAY_SURFACE_CLASS}`}>
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
              <span className="text-body font-medium text-foreground">{tabslideT('host.importing.title')}</span>
              <span className="text-body text-muted-foreground">{tabslideT('host.importing.description')}</span>
            </div>
          </div>
        )}

        {/* 导入结果提示 */}
        {importMessage && (
          <div
            className={`absolute left-1/2 top-4 z-modal -translate-x-1/2 rounded-lg border px-4 py-2 text-body transition-all ${
              importMessage.type === 'success'
                ? 'border-success/20 bg-success/10 text-success'
                : importMessage.type === 'warning'
                  ? 'border-warning/20 bg-warning/10 text-warning'
                  : importMessage.type === 'info'
                    ? 'border-primary/20 bg-primary/10 text-primary'
                    : 'border-destructive/20 bg-destructive/10 text-destructive'
            }`}
          >
            {importMessage.text}
          </div>
        )}
      </div>
    </ModuleErrorBoundary>
  )
}
