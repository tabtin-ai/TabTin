import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Code2,
  Copy,
  Download,
  File,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  RefreshCcw,
  Search,
  Sparkles,
  Wand2,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ResourceCapability, ResourceCaptureStatus, ResourceCategory, ResourceRecord, ResourceSource } from '@tabtin/action-tools/types'
import { Skeleton, toast } from '@tabtin/smartsheet-ui'
import { useDownloadStore } from '@stores/useDownloadStore'

type ResourceSummary = {
  total: number
  byCategory: Partial<Record<string, number>>
  byCaptureStatus?: Partial<Record<string, number>>
}

interface BrowserResourceCenterProps {
  viewId: string
  open: boolean
  onClose: () => void
  summary?: ResourceSummary
}

const RESOURCE_LIST_DEFAULT_LIMIT = 300
const RESOURCE_POLL_INTERVAL_MS = 4000
const RESOURCE_GRID_CARD_MIN_WIDTH_PX = 160
const RESOURCE_SPLIT_LAYOUT_MIN_WIDTH_PX = 640
const RESOURCE_SPLIT_LIST_MIN_WIDTH_PX = 380
const RESOURCE_SPLIT_LIST_WIDTH_PERCENT = 40
const RESOURCE_GRID_STYLE: React.CSSProperties = {
  gridTemplateColumns: `repeat(auto-fill, minmax(min(${RESOURCE_GRID_CARD_MIN_WIDTH_PX}px, 100%), 1fr))`,
}
const RESOURCE_SPLIT_LIST_STYLE: React.CSSProperties = {
  flexBasis: `${RESOURCE_SPLIT_LIST_WIDTH_PERCENT}%`,
  minWidth: `min(${RESOURCE_SPLIT_LIST_MIN_WIDTH_PX}px, 100%)`,
}

type ResourceCategoryFilter = 'all' | ResourceRecord['category']

// 资源中心视觉 token（design-system §6.8/§10/§12）：布局流面板内一律中性灰底 +
// 背景色差分层，不画边框、不加投影；主题色只降饱和地落在文字/图标上。
/** 顶部/复制等纯图标 ghost 按钮（无边框，hover 背景差） */
const RESOURCE_ICON_BUTTON_CLASS =
  'inline-flex h-7 w-7 items-center justify-center rounded-interactive text-muted-foreground/60 transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]'
/** 详情区信息卡（L1 内中性灰底，无边框无投影） */
const RESOURCE_INFO_CARD_CLASS =
  'rounded-[12px] bg-foreground/[0.03] p-3 dark:bg-foreground/[0.05]'
/** 唯一满饱和主操作（下载 CTA） */
const RESOURCE_PRIMARY_ACTION_CLASS =
  'inline-flex items-center justify-center gap-1.5 rounded-interactive bg-primary px-4 py-2 text-body font-medium text-primary-foreground transition-colors hover:bg-primary/85 active:bg-primary/95'
/** 次操作按钮（捕获 / 解析流 / 取消：中性灰底，无边框无投影） */
const RESOURCE_SECONDARY_ACTION_CLASS =
  'inline-flex items-center justify-center gap-1.5 rounded-interactive bg-foreground/[0.06] px-4 py-2 text-body font-medium text-foreground transition-colors hover:bg-foreground/[0.1] dark:bg-foreground/[0.08] dark:hover:bg-foreground/[0.12]'

function getBadgeClass(type: 'category' | 'status'): string {
  return type === 'category'
    ? 'bg-foreground/[0.06] text-accent-text'
    : 'bg-muted text-muted-foreground'
}

function formatBytes(bytes: number | undefined, unknownLabel: string): string {
  if (!bytes || bytes <= 0) return unknownLabel
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 网页里嵌的 base64 图（典型 data:image/png;base64,...）整体长度可能数 KB 到数 MB；
// 普通 URL 的 pathname 也可能塞满 hash 段（CDN 文件名 = 长 base64 / sha 哈希）
// 让 readable filename 一旦撑爆就把整个资源中心的列表项 / 详情标题撑变形——三层防御：
//   1. data: URL 提取 mime 子类型作为可读标签（避免所有图全显示成 'data_uri_image'）
//   2. 整体 URL 过长时跳过 new URL parse 直接走 fallback
//   3. 解析出的 filename 过长时截断保留扩展名
const READABLE_FILENAME_MAX_URL_LENGTH = 4096
const READABLE_FILENAME_MAX_LENGTH = 80
const READABLE_FILENAME_FALLBACK_ID_LENGTH = 8

function truncateReadableFilename(name: string): string {
  if (name.length <= READABLE_FILENAME_MAX_LENGTH) return name
  const lastDot = name.lastIndexOf('.')
  // 仅当扩展名靠近末尾（≤10 字符）时认为是真实扩展名，否则按纯字符串截断
  if (lastDot > 0 && name.length - lastDot <= 10) {
    const ext = name.slice(lastDot)
    const headBudget = READABLE_FILENAME_MAX_LENGTH - ext.length - 1
    if (headBudget > 4) {
      return `${name.slice(0, headBudget)}…${ext}`
    }
  }
  return `${name.slice(0, READABLE_FILENAME_MAX_LENGTH - 1)}…`
}

function getReadableFilename(url: string, category: string, fallbackLabel: string, stableFallbackKey?: string): string {
  const stableFallbackLabel = stableFallbackKey
    ? stableFallbackKey.slice(-READABLE_FILENAME_FALLBACK_ID_LENGTH)
    : fallbackLabel
  try {
    if (url.startsWith('data:')) {
      const subtype = url.match(/^data:[^/;,]+\/([^;,]+)/i)?.[1]
      return subtype ? `data_uri_${category}_${subtype.toLowerCase()}` : `data_uri_${category}`
    }
    if (url.startsWith('blob:')) {
      return `blob_${category}`
    }
    if (url.length > READABLE_FILENAME_MAX_URL_LENGTH) {
      return `${category}_${stableFallbackLabel}`
    }
    const urlObj = new URL(url)
    const pathname = urlObj.pathname
    const filename = pathname.split('/').pop()
    if (filename && filename.includes('.')) {
      let decoded: string
      try {
        decoded = decodeURIComponent(filename)
      } catch {
        decoded = filename
      }
      return truncateReadableFilename(decoded)
    }
    return `${category}_${stableFallbackLabel}`
  } catch {
    return `${category}_${stableFallbackLabel}`
  }
}

function getResourceIcon(category: string) {
  switch (category) {
    case 'image': return <ImageIcon className="h-8 w-8 text-muted-foreground/60" />
    case 'video':
    case 'hls':
    case 'dash': return <Film className="h-8 w-8 text-muted-foreground/60" />
    case 'audio': return <Music className="h-8 w-8 text-muted-foreground/60" />
    case 'document': return <File className="h-8 w-8 text-muted-foreground/60" />
    default: return <File className="h-8 w-8 text-muted-foreground/60" />
  }
}

function isStreamResource(resource: ResourceRecord | null | undefined): resource is ResourceRecord {
  return Boolean(resource && (resource.category === 'hls' || resource.category === 'dash'))
}

function isActiveStreamPhase(status: 'resolving' | 'downloading' | 'merging' | 'completed' | 'failed') {
  return status === 'resolving' || status === 'downloading' || status === 'merging'
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export const BrowserResourceCenter: React.FC<BrowserResourceCenterProps> = ({
  viewId,
  open,
  onClose,
  summary
}) => {
  const { t } = useTranslation('crawl')
  const [resources, setResources] = useState<ResourceRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<ResourceCategoryFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busyActions, setBusyActions] = useState<Set<string>>(new Set())
  const [selectedQuality, setSelectedQuality] = useState<string>('best')
  const [contentWidth, setContentWidth] = useState(0)
  const isDeveloperMode = true
  const contentRef = useRef<HTMLDivElement>(null)
  const streamItems = useDownloadStore(state => state.streamItems)
  const cancelStream = useDownloadStore(state => state.cancelStream)
  const loadRequestIdRef = useRef(0)
  const autoParsedResourceIdsRef = useRef(new Set<string>())
  const fallbackFilenameLabel = t('resourceCenter.values.fallbackNameSuffix', 'resource')
  const unknownValueLabel = t('resourceCenter.values.unknown', 'Unknown')
  const unknownMimeLabel = t('resourceCenter.values.unknownMime', 'Unknown MIME')
  const noneLabel = t('resourceCenter.values.none', 'None')
  const formatResourceBytes = useCallback(
    (bytes?: number) => formatBytes(bytes, t('resourceCenter.values.unknownSize', 'Unknown')),
    [t]
  )
  const getCategoryLabel = useCallback((value: ResourceCategory) => {
    const fallback = value === 'hls' || value === 'dash' ? value.toUpperCase() : value
    return t(`resourceCenter.categories.${value}`, fallback)
  }, [t])
  const getCaptureStatusLabel = useCallback((value: ResourceCaptureStatus) => {
    return t(`resourceCenter.captureStatus.${value}`, value)
  }, [t])
  const getCapabilityLabel = useCallback((value: ResourceCapability) => {
    return t(`resourceCenter.capabilities.${value}`, value)
  }, [t])
  const getSourceLabel = useCallback((value?: ResourceSource) => {
    if (!value) return unknownValueLabel
    return t(`resourceCenter.sources.${value}`, value)
  }, [t, unknownValueLabel])
  const formatCapabilities = useCallback((values: ResourceCapability[]) => {
    if (values.length === 0) return noneLabel
    return values.map(value => getCapabilityLabel(value)).join(', ')
  }, [getCapabilityLabel, noneLabel])
  const getFilterLabel = useCallback((value: ResourceCategoryFilter) => {
    if (value === 'all') return t('resourceCenter.categories.all', 'All')
    return getCategoryLabel(value)
  }, [getCategoryLabel, t])

  useEffect(() => {
    const element = contentRef.current
    if (!element) return

    const updateWidth = (width: number) => {
      const roundedWidth = Math.round(width)
      setContentWidth(current => current === roundedWidth ? current : roundedWidth)
    }

    updateWidth(element.getBoundingClientRect().width)

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      updateWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const loadResources = useCallback(async (probeMedia = false) => {
    if (!viewId) return
    const currentRequestId = ++loadRequestIdRef.current
    setLoading(true)
    setError(null)

    try {
      const api = window.tabtin.resourceDetection
      const response = api.listResources
        ? await api.listResources({
            viewId,
            category: category === 'all' ? undefined : category,
            limit: RESOURCE_LIST_DEFAULT_LIMIT,
            probeMedia
          })
        : await api.getResources({
            viewId,
            category: category === 'all' ? undefined : category,
            limit: RESOURCE_LIST_DEFAULT_LIMIT,
            probeMedia
          })

      if (currentRequestId !== loadRequestIdRef.current) return

      if (!response?.success) {
        throw new Error(response?.error || t('resourceCenter.errors.loadFailed', 'Failed to load resources'))
      }

      const data = response.data || response
      const nextResources = (data.resources || []) as ResourceRecord[]
      setResources(nextResources)
      // 默认不选中任何资源——空态下只显示资源列表 + 占位提示，
      // 详情/预览区由用户主动点选某个资源后才填充。
      // 这里仅保留"已选中的资源仍在最新结果里就保持选中"的稳定性。
      setSelectedId((prev) => {
        if (prev && nextResources.some(resource => resource.resourceId === prev)) {
          return prev
        }
        return null
      })
    } catch (loadError) {
      if (currentRequestId !== loadRequestIdRef.current) return
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      if (currentRequestId === loadRequestIdRef.current) {
        setLoading(false)
      }
    }
  }, [category, t, viewId])

  useEffect(() => {
    if (!open) return
    void loadResources(true)
    const timer = window.setInterval(() => void loadResources(false), RESOURCE_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [open, loadResources])

  useEffect(() => {
    setSelectedQuality('best')
  }, [selectedId])

  useEffect(() => {
    autoParsedResourceIdsRef.current.clear()
  }, [open, viewId])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  const displayResources = useMemo(() => {
    if (isDeveloperMode) return resources
    return resources.filter(r => !r.isSegment)
  }, [resources, isDeveloperMode])

  const displaySummary = useMemo(() => {
    if (isDeveloperMode || !summary) return summary
    const byCategory: Partial<Record<string, number>> = {}
    for (const r of displayResources) {
      byCategory[r.category] = (byCategory[r.category] || 0) + 1
    }
    return { ...summary, total: displayResources.length, byCategory }
  }, [isDeveloperMode, summary, displayResources])

  const filteredResources = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return displayResources
    return displayResources.filter(resource => {
      const haystack = [
        resource.url,
        resource.resourceId,
        resource.mimeType,
        resource.category,
        resource.captureStatus
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(keyword)
    })
  }, [displayResources, search])

  const selectedResource = useMemo(
    () => filteredResources.find(resource => resource.resourceId === selectedId) || null,
    [filteredResources, selectedId]
  )
  const useSplitLayout = Boolean(selectedResource && contentWidth >= RESOURCE_SPLIT_LAYOUT_MIN_WIDTH_PX)

  const previewSrc = useMemo(() => {
    if (!selectedResource) return null
    if (selectedResource.contentRef?.kind === 'data_url') {
      return selectedResource.contentRef.data || null
    }
    return selectedResource.url
  }, [selectedResource])

  const selectedStreamDownload = useMemo(() => {
    if (!isStreamResource(selectedResource)) return null
    const matches = streamItems.filter(item =>
      item.resourceId === selectedResource.resourceId
      || (item.url && item.url === selectedResource.url)
    )
    if (matches.length === 0) return null

    return [...matches].sort((a, b) => {
      const aActive = isActiveStreamPhase(a.status)
      const bActive = isActiveStreamPhase(b.status)
      if (aActive !== bActive) return aActive ? -1 : 1
      return (b.startTime || 0) - (a.startTime || 0)
    })[0]
  }, [selectedResource, streamItems])

  const selectedStreamDownloadBusy = selectedResource
    ? busyActions.has(`stream-download:${selectedResource.resourceId}`)
    : false
  const selectedStreamParseBusy = selectedResource
    ? busyActions.has(`parse:${selectedResource.resourceId}`)
    : false

  const copyText = useCallback(async (text: string, successTitle: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast({ title: successTitle })
    } catch (copyError) {
      toast({
        title: t('resourceCenter.toasts.copyFailedTitle', 'Copy failed'),
        description: copyError instanceof Error ? copyError.message : String(copyError),
        variant: 'destructive'
      })
    }
  }, [t])

  const withBusyAction = useCallback(async (
    key: string,
    runner: () => Promise<void>,
    options?: { suppressErrorToast?: boolean }
  ) => {
    setBusyActions(prev => new Set(prev).add(key))
    try {
      await runner()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!options?.suppressErrorToast) {
        toast({
          title: t('resourceCenter.toasts.actionFailedTitle', 'Operation failed'),
          description: message,
          variant: 'destructive'
        })
      }
    } finally {
      setBusyActions(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [t])

  const handleDownload = useCallback(async (resource: ResourceRecord) => {
    await withBusyAction(`download:${resource.resourceId}`, async () => {
      const result = await window.tabtin.resourceDetection.downloadResource({
        resourceId: resource.resourceId,
        viewId
      })

      if (!result?.success) {
        throw new Error(result?.error || t('resourceCenter.errors.downloadFailed', 'Download failed'))
      }

      toast({
        title: t('resourceCenter.toasts.resourceDownloadedTitle', 'Resource downloaded'),
        description: result.data?.filePath || resource.url
      })
      await loadResources(false)
    })
  }, [loadResources, t, viewId, withBusyAction])

  const handleCapture = useCallback(async (resource: ResourceRecord) => {
    await withBusyAction(`capture:${resource.resourceId}`, async () => {
      const result = await window.tabtin.resourceDetection.captureResource({
        resourceId: resource.resourceId,
        viewId,
        force: true
      })

      if (!result?.success) {
        throw new Error(result?.error || t('resourceCenter.errors.captureFailed', 'Capture failed'))
      }

      toast({
        title: result.data?.captured
          ? t('resourceCenter.toasts.capturedTitle', 'Resource content captured')
          : t('resourceCenter.toasts.captureCachedTitle', 'Resource content already cached')
      })
      await loadResources(false)
    })
  }, [loadResources, t, viewId, withBusyAction])

  const handleParseStream = useCallback(async (
    resource: ResourceRecord,
    options?: { suppressSuccessToast?: boolean; suppressErrorToast?: boolean }
  ) => {
    await withBusyAction(`parse:${resource.resourceId}`, async () => {
      const result = await window.tabtin.resourceDetection.parseStream({
        resourceId: resource.resourceId,
        viewId
      })

      if (!result?.success) {
        throw new Error(result?.error || t('resourceCenter.errors.parseStreamFailed', 'Stream parsing failed'))
      }

      const variantCount = result.data?.variants?.length || 0
      if (!options?.suppressSuccessToast) {
        toast({
          title: t('resourceCenter.toasts.streamParsedTitle', 'Stream parsed'),
          description: variantCount > 0
            ? t('resourceCenter.toasts.streamParsedVariants', { count: variantCount })
            : t('resourceCenter.toasts.streamParsedUpdated', 'Stream metadata updated')
        })
      }
      await loadResources(false)
    }, { suppressErrorToast: options?.suppressErrorToast })
  }, [loadResources, t, viewId, withBusyAction])

  const handleDownloadStream = useCallback(async (resource: ResourceRecord) => {
    await withBusyAction(`stream-download:${resource.resourceId}`, async () => {
      const result = await window.tabtin.resourceDetection.downloadStream({
        resourceId: resource.resourceId,
        viewId,
        quality: selectedQuality !== 'best' ? selectedQuality : undefined
      })

      if (!result?.success) {
        throw new Error(result?.error || t('resourceCenter.errors.streamDownloadFailed', 'Stream download failed'))
      }

      toast({
        title: t('resourceCenter.toasts.streamDownloadedTitle', 'Stream downloaded'),
        description: result.data?.filePath || resource.url
      })
      await loadResources(false)
    })
  }, [loadResources, selectedQuality, t, viewId, withBusyAction])

  const getStreamPhaseLabel = useCallback((phase: 'resolving' | 'downloading' | 'merging' | 'completed' | 'failed') => {
    switch (phase) {
      case 'resolving':
        return t('resourceCenter.streamProgress.resolving', '正在解析流清单')
      case 'downloading':
        return t('resourceCenter.streamProgress.downloading', '正在下载分片')
      case 'merging':
        return t('resourceCenter.streamProgress.merging', '正在合并音视频')
      case 'completed':
        return t('resourceCenter.streamProgress.completed', '下载完成')
      case 'failed':
        return t('resourceCenter.streamProgress.failed', '下载失败')
      default:
        return phase
    }
  }, [t])

  useEffect(() => {
    if (!open || !isStreamResource(selectedResource) || selectedResource.streamInfo) {
      return
    }
    if (selectedStreamParseBusy) {
      return
    }
    if (autoParsedResourceIdsRef.current.has(selectedResource.resourceId)) {
      return
    }

    autoParsedResourceIdsRef.current.add(selectedResource.resourceId)
    void handleParseStream(selectedResource, {
      suppressSuccessToast: true,
      suppressErrorToast: true
    })
  }, [handleParseStream, open, selectedResource, selectedStreamParseBusy])

  const handleCopyCli = useCallback(async (resource: ResourceRecord) => {
    const cli = `tabtin browser resource inspect ${resource.resourceId} --tab ${viewId}`
    await copyText(cli, t('resourceCenter.toasts.cliCopiedTitle', 'CLI command copied'))
  }, [copyText, t, viewId])

  const handleCopyAgentPrompt = useCallback(async (resource: ResourceRecord) => {
    const prompt = JSON.stringify({
      resourceId: resource.resourceId,
      url: resource.url,
      category: resource.category,
      captureStatus: resource.captureStatus,
      capabilities: resource.capabilities
    }, null, 2)
    await copyText(prompt, t('resourceCenter.toasts.agentPromptCopiedTitle', 'Agent prompt copied'))
  }, [copyText, t])

  const categories = useMemo(() => ([
    ['all', getFilterLabel('all')],
    ['image', getCategoryLabel('image')],
    ['video', getCategoryLabel('video')],
    ['audio', getCategoryLabel('audio')],
    ['hls', getCategoryLabel('hls')],
    ['dash', getCategoryLabel('dash')],
    ['document', getCategoryLabel('document')]
  ]) as Array<[ResourceCategoryFilter, string]>, [getCategoryLabel, getFilterLabel])

  if (!open) return null

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex items-center justify-between border-b border-foreground/[0.06] px-4 py-3 dark:border-foreground/[0.08]">
        <div className="min-w-0">
          <div className="text-subtitle font-medium">{t('resourceCenter.title', 'Resource center')}</div>
          <div className="text-caption text-muted-foreground/60">
            {t('resourceCenter.count', { count: displaySummary?.total ?? displayResources.length })}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={RESOURCE_ICON_BUTTON_CLASS}
            onClick={() => void loadResources(true)}
            title={t('resourceCenter.actions.refresh', 'Refresh resources')}
            aria-label={t('resourceCenter.actions.refresh', 'Refresh resources')}
          >
            <RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            className={RESOURCE_ICON_BUTTON_CLASS}
            onClick={onClose}
            title={t('resourceCenter.actions.close', 'Close resource center')}
            aria-label={t('resourceCenter.actions.close', 'Close resource center')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="border-b border-foreground/[0.06] px-4 py-3 dark:border-foreground/[0.08]">
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
          <input
            className="w-full rounded-interactive bg-muted py-2 pl-8 pr-3 text-body placeholder:text-muted-foreground focus:bg-background focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ring"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('resourceCenter.searchPlaceholder', 'Search URL / resourceId / MIME')}
            aria-label={t('resourceCenter.searchInputLabel', 'Search resources')}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {categories.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`rounded-full px-2.5 py-1 text-body transition-colors ${
                category === value
                  ? 'surface-row-active font-medium text-foreground'
                  : 'text-muted-foreground/60 hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]'
              }`}
              onClick={() => setCategory(value)}
              aria-pressed={category === value}
              title={
                value === 'all'
                  ? t('resourceCenter.aria.filterAll', 'Show all resources')
                  : t('resourceCenter.aria.filterCategory', { category: label })
              }
              aria-label={
                value === 'all'
                  ? t('resourceCenter.aria.filterAll', 'Show all resources')
                  : t('resourceCenter.aria.filterCategory', { category: label })
              }
            >
              {label}
              {value !== 'all' && displaySummary?.byCategory?.[value] ? ` ${displaySummary.byCategory[value]}` : ''}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={contentRef}
        className={`flex min-h-0 flex-1 ${useSplitLayout ? 'flex-row' : 'flex-col'}`}
        data-testid="resource-center-content"
      >
        <div
          className={`min-h-0 overflow-y-auto p-3 ${
            selectedResource
              ? useSplitLayout
                ? 'flex-shrink-0 border-r border-foreground/[0.06] dark:border-foreground/[0.08]'
                : 'flex-[1.2] border-b border-foreground/[0.06] dark:border-foreground/[0.08]'
              : 'flex-1'
          }`}
          style={useSplitLayout ? RESOURCE_SPLIT_LIST_STYLE : undefined}
          data-testid="resource-list-panel"
        >
          {loading && filteredResources.length === 0 ? (
            <div
              className="grid gap-3"
              style={RESOURCE_GRID_STYLE}
              data-testid="resource-list-skeleton-grid"
            >
              {[1,2,3,4].map(i => (
                <div key={i} className="flex flex-col gap-2">
                  <Skeleton width="100%" height={96} rounded="md" />
                  <Skeleton width="80%" height={14} />
                  <Skeleton width="40%" height={12} />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="p-4 text-body text-destructive">{error}</div>
          ) : filteredResources.length === 0 ? (
            <div className="mt-10 p-4 text-center text-body text-muted-foreground">
              {t('resourceCenter.empty', 'No resources available on this page')}
            </div>
          ) : (
            <div
              className="grid gap-3"
              style={RESOURCE_GRID_STYLE}
              data-testid="resource-list-grid"
            >
              {filteredResources.map(resource => {
                const previewUrl = resource.contentRef?.kind === 'data_url' ? resource.contentRef.data : resource.url
                const isSelected = selectedResource?.resourceId === resource.resourceId
                const readableFilename = getReadableFilename(resource.url, resource.category, fallbackFilenameLabel, resource.resourceId)

                return (
                  <button
                    key={resource.resourceId}
                    type="button"
                    className={`flex flex-col overflow-hidden rounded-[12px] text-left transition-colors ${
                      isSelected
                        ? 'surface-row-active'
                        : 'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]'
                    }`}
                    onClick={() => setSelectedId(resource.resourceId)}
                    aria-pressed={isSelected}
                    title={readableFilename}
                    aria-label={t('resourceCenter.aria.selectResource', { name: readableFilename })}
                  >
                    <div className="flex h-24 w-full items-center justify-center bg-muted/30 overflow-hidden relative">
                      {(resource.category === 'hls' || resource.category === 'dash') ? (
                        <div className="flex flex-col items-center justify-center gap-1">
                          <Film className="h-10 w-10 text-accent-text" />
                          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-caption font-medium text-accent-text">
                            {resource.category === 'hls' ? 'HLS' : 'DASH'}
                          </span>
                        </div>
                      ) : resource.category === 'image' ? (
                        <img
                          src={previewUrl}
                          alt={resource.url}
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none'
                            e.currentTarget.parentElement?.classList.add('flex', 'items-center', 'justify-center')
                            const icon = document.createElement('div')
                            icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground/60"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>'
                            e.currentTarget.parentElement?.appendChild(icon)
                          }}
                        />
                      ) : (
                        getResourceIcon(resource.category)
                      )}
                      {isDeveloperMode && resource.isSegment && (
                        <div className="absolute top-1 left-1">
                          <span className="rounded bg-muted/90 px-1 py-0.5 text-caption text-muted-foreground backdrop-blur-sm">
                            {t('resourceCenter.segmentBadge', 'Segment')}
                          </span>
                        </div>
                      )}
                      {isDeveloperMode && (
                        <div className="absolute top-1 right-1 flex gap-1">
                          <span className="rounded bg-background/80 px-1 py-0.5 text-caption leading-none text-muted-foreground backdrop-blur-sm">
                            {getCaptureStatusLabel(resource.captureStatus)}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex w-full flex-col gap-1 p-2">
                      <div className="truncate text-body font-medium" title={readableFilename}>
                        {readableFilename}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="truncate text-caption text-muted-foreground">
                          {formatResourceBytes(resource.size)}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-caption font-medium text-muted-foreground uppercase">
                          {getCategoryLabel(resource.category)}
                        </span>
                      </div>
                      {(resource.category === 'hls' || resource.category === 'dash') && resource.streamInfo && (
                        <div className="flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
                          {resource.streamInfo.duration ? (
                            <span>{formatDuration(resource.streamInfo.duration)}</span>
                          ) : null}
                          {resource.streamInfo.segmentCount ? (
                            <span>· {t('resourceCenter.streamInfo.segmentCount', { count: resource.streamInfo.segmentCount })}</span>
                          ) : null}
                          {resource.streamInfo.variants?.[0]?.resolution ? (
                            <span>· {resource.streamInfo.variants[0].resolution}</span>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {selectedResource && (
          <div
            className={`min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/10 ${
              useSplitLayout
                ? ''
                : 'relative z-sticky shadow-[0_-4px_12px_hsl(var(--foreground)/0.08)]'
            }`}
            data-testid="resource-detail-panel"
          >
            <div className="flex h-full flex-col">
              {/* 1. 视觉预览置顶：固定预览区高度，媒体用 max-* + contain，避免撑破浮层 */}
              <div
                className="relative flex h-[240px] w-full shrink-0 items-center justify-center overflow-hidden border-b border-foreground/[0.06] bg-muted/30 dark:border-foreground/[0.08]"
                data-testid="resource-detail-preview"
              >
                {(selectedResource.category === 'image' || selectedResource.category === 'video' || selectedResource.category === 'audio') && previewSrc ? (
                  <>
                    {selectedResource.category === 'image' && (
                      <img
                        src={previewSrc}
                        alt={selectedResource.url}
                        className="max-h-full max-w-full object-contain"
                      />
                    )}
                    {selectedResource.category === 'video' && (
                      <video
                        src={previewSrc}
                        controls
                        className="max-h-full max-w-full bg-black/80 object-contain"
                      />
                    )}
                    {selectedResource.category === 'audio' && (
                      <div className="w-full max-w-full p-6">
                        <audio src={previewSrc} controls className="w-full" />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-10 text-muted-foreground/60">
                    {getResourceIcon(selectedResource.category)}
                    <span className="mt-2 text-caption">{t('resourceCenter.previewUnavailable', 'Preview unavailable')}</span>
                  </div>
                )}
              </div>

              <div className="p-5 flex flex-col gap-5">
                {/* 2. 易读的文件名与大小 */}
                <div>
                  <h3 className="text-title font-semibold break-words leading-tight">
                    {getReadableFilename(selectedResource.url, selectedResource.category, fallbackFilenameLabel, selectedResource.resourceId)}
                  </h3>
                  <div className="mt-1.5 flex items-center gap-2 text-body text-muted-foreground">
                    <span className="font-medium">{formatResourceBytes(selectedResource.size)}</span>
                    <span className="text-border">•</span>
                    <span className="uppercase">{getCategoryLabel(selectedResource.category)}</span>
                  </div>
                </div>

                {/* 3. 画质选择（HLS/DASH 且多 variant） */}
                {selectedResource.streamInfo?.variants && selectedResource.streamInfo.variants.length > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="text-caption text-muted-foreground shrink-0">
                      {t('resourceCenter.qualityLabel', '画质')}
                    </span>
                    <select
                      className="min-w-0 flex-1 rounded-interactive bg-muted px-2 py-1.5 text-body focus:bg-background focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ring"
                      value={selectedQuality}
                      onChange={(e) => setSelectedQuality(e.target.value)}
                    >
                      <option value="best">{t('resourceCenter.qualityBest', '最高画质')}</option>
                      {selectedResource.streamInfo.variants.map((v, i) => (
                        <option key={i} value={v.resolution || String(v.bandwidth)}>
                          {v.resolution || `${Math.round(v.bandwidth / 1000)}kbps`}
                          {v.codecs ? ` (${v.codecs})` : ''}
                        </option>
                      ))}
                      <option value="worst">{t('resourceCenter.qualityWorst', '最低画质')}</option>
                    </select>
                  </div>
                )}

                {isStreamResource(selectedResource) && selectedStreamParseBusy && !selectedResource.streamInfo && (
                  <div className={RESOURCE_INFO_CARD_CLASS}>
                    <div className="flex items-center gap-2 text-body font-medium">
                      <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
                      <span>{t('resourceCenter.streamProgress.resolving', '正在解析流清单')}</span>
                    </div>
                    <div className="mt-1 text-caption text-muted-foreground">
                      {t('resourceCenter.streamProgress.resolvingHint', '正在自动获取时长、分片和画质信息，无需手动先点“解析流”。')}
                    </div>
                  </div>
                )}

                {isStreamResource(selectedResource) && (selectedStreamDownload || selectedStreamDownloadBusy) && (
                  <div className={RESOURCE_INFO_CARD_CLASS}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-body font-medium">
                        {(selectedStreamDownloadBusy || selectedStreamDownload?.status === 'resolving' || selectedStreamDownload?.status === 'downloading' || selectedStreamDownload?.status === 'merging')
                          ? <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
                          : <Download className="h-4 w-4 text-accent-text" />}
                        <span>
                          {selectedStreamDownload
                            ? getStreamPhaseLabel(selectedStreamDownload.status)
                            : t('resourceCenter.streamProgress.preparing', '正在准备下载')}
                        </span>
                      </div>
                      <span className="text-caption text-muted-foreground">
                        {selectedStreamDownload ? `${Math.round(selectedStreamDownload.percent)}%` : '...'}
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-300"
                        style={{ width: `${selectedStreamDownload ? Math.max(0, Math.min(100, selectedStreamDownload.percent)) : 12}%` }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                      {selectedStreamDownload?.segments.total
                        ? <span>{selectedStreamDownload.segments.done} / {selectedStreamDownload.segments.total} {t('resourceCenter.streamProgress.segments', '分片')}</span>
                        : null}
                      {selectedStreamDownload?.speed
                        ? <span>· {formatResourceBytes(selectedStreamDownload.speed)}/s</span>
                        : null}
                      {selectedStreamDownload?.savePath && selectedStreamDownload.status === 'completed'
                        ? <span className="break-all">· {selectedStreamDownload.savePath}</span>
                        : null}
                    </div>
                    {selectedStreamDownload?.error && (
                      <div className="mt-2 text-caption text-destructive">
                        {selectedStreamDownload.error}
                      </div>
                    )}
                    {selectedStreamDownload && isActiveStreamPhase(selectedStreamDownload.status) && (
                      <div className="mt-3">
                        <button
                          type="button"
                          className={RESOURCE_SECONDARY_ACTION_CLASS}
                          onClick={() => void cancelStream(selectedStreamDownload.id)}
                          title={t('resourceCenter.actions.cancelStreamDownload', '取消下载')}
                          aria-label={t('resourceCenter.actions.cancelStreamDownload', '取消下载')}
                        >
                          <X className="h-4 w-4" />
                          {t('resourceCenter.actions.cancelStreamDownload', '取消下载')}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* 4. 核心操作区 */}
                <div className="flex flex-wrap gap-2">
                  {selectedResource.capabilities.includes('streamDownload') ? (
                    <button
                      type="button"
                      className={RESOURCE_PRIMARY_ACTION_CLASS}
                      onClick={() => void handleDownloadStream(selectedResource)}
                      title={
                        selectedResource.category === 'hls' || selectedResource.category === 'dash'
                          ? t('resourceCenter.actions.downloadCompleteVideo', 'Download complete video')
                          : t('resourceCenter.actions.downloadStream', 'Download stream')
                      }
                      aria-label={
                        selectedResource.category === 'hls' || selectedResource.category === 'dash'
                          ? t('resourceCenter.actions.downloadCompleteVideo', 'Download complete video')
                          : t('resourceCenter.actions.downloadStream', 'Download stream')
                      }
                    >
                      {busyActions.has(`stream-download:${selectedResource.resourceId}`) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      {selectedResource.category === 'hls' || selectedResource.category === 'dash'
                        ? t('resourceCenter.actions.downloadCompleteVideo', 'Download complete video')
                        : t('resourceCenter.actions.downloadStream', 'Download stream')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={RESOURCE_PRIMARY_ACTION_CLASS}
                      onClick={() => void handleDownload(selectedResource)}
                      title={t('resourceCenter.actions.downloadResource', 'Download resource')}
                      aria-label={t('resourceCenter.actions.downloadResource', 'Download resource')}
                    >
                      {busyActions.has(`download:${selectedResource.resourceId}`) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      {t('resourceCenter.actions.downloadResource', 'Download resource')}
                    </button>
                  )}
                  {(selectedResource.captureStatus === 'page_bound_blob' || selectedResource.url.startsWith('blob:')) && (
                    <button
                      type="button"
                      className={RESOURCE_SECONDARY_ACTION_CLASS}
                      onClick={() => void handleCapture(selectedResource)}
                      title={t('resourceCenter.actions.captureContent', 'Capture content')}
                      aria-label={t('resourceCenter.actions.captureContent', 'Capture content')}
                    >
                      {busyActions.has(`capture:${selectedResource.resourceId}`) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                      {t('resourceCenter.actions.captureContent', 'Capture content')}
                    </button>
                  )}
                  {isDeveloperMode && (selectedResource.category === 'hls' || selectedResource.category === 'dash') && (
                    <button
                      type="button"
                      className={RESOURCE_SECONDARY_ACTION_CLASS}
                      onClick={() => void handleParseStream(selectedResource)}
                      title={selectedResource.streamInfo
                        ? t('resourceCenter.actions.reparseStream', '重新解析流')
                        : t('resourceCenter.actions.parseStream', 'Parse stream')}
                      aria-label={selectedResource.streamInfo
                        ? t('resourceCenter.actions.reparseStream', '重新解析流')
                        : t('resourceCenter.actions.parseStream', 'Parse stream')}
                    >
                      {selectedStreamParseBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                      {selectedResource.streamInfo
                        ? t('resourceCenter.actions.reparseStream', '重新解析流')
                        : t('resourceCenter.actions.parseStream', 'Parse stream')}
                    </button>
                  )}
                </div>

                {(selectedResource.captureStatus === 'page_bound_blob' || selectedResource.url.startsWith('blob:')) && (
                  <div className={`${RESOURCE_INFO_CARD_CLASS} text-body text-muted-foreground`}>
                    {t('resourceCenter.hints.blobResource', 'This is a page-bound player resource. Click "Capture content" to fetch the data, then download.')}
                  </div>
                )}

                {selectedResource.streamInfo?.isEncrypted && (
                  <div className="rounded-[12px] border border-warning/30 bg-warning/10 p-3 text-body text-warning">
                    {t('resourceCenter.hints.encrypted', '此资源可能使用了 DRM 加密，下载后可能无法正常播放。')}
                  </div>
                )}

                {/* 5. 基础信息 (单行截断的 URL + 复制) */}
                <div className={`${RESOURCE_INFO_CARD_CLASS} flex flex-col gap-2`}>
                  <div className="text-caption font-medium text-muted-foreground/60">{t('resourceCenter.sourceUrlTitle', 'Source URL')}</div>
                  <div className="flex items-start gap-2">
                    <div
                      className={`text-body text-foreground flex-1 break-all ${!isDeveloperMode ? 'line-clamp-2' : ''}`}
                      title={selectedResource.url}
                    >
                      {selectedResource.url}
                    </div>
                    <button
                      type="button"
                      className="shrink-0 rounded-interactive p-1.5 text-muted-foreground/60 transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]"
                      onClick={() => void copyText(selectedResource.url, t('resourceCenter.toasts.linkCopiedTitle', 'Resource link copied'))}
                      title={t('resourceCenter.actions.copyLink', 'Copy link')}
                      aria-label={t('resourceCenter.actions.copyLink', 'Copy link')}
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* 5. 开发者高级信息 (仅开发者模式开启时可见) */}
                {isDeveloperMode && (
                  <div className="space-y-4 rounded-[12px] bg-foreground/[0.03] p-4 text-body dark:bg-foreground/[0.05] animate-in fade-in slide-in-from-top-2">
                    <div className="flex items-center gap-2 font-medium text-foreground">
                      <Code2 className="h-4 w-4 text-accent-text" />
                      {t('resourceCenter.developer.title', 'Developer details')}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-interactive bg-foreground/[0.06] px-2 py-1 text-caption text-foreground transition-colors hover:bg-foreground/[0.1] dark:bg-foreground/[0.08] dark:hover:bg-foreground/[0.12]"
                        onClick={() => void handleCopyCli(selectedResource)}
                        title={t('resourceCenter.actions.copyCliCommand', 'Copy CLI command')}
                        aria-label={t('resourceCenter.actions.copyCliCommand', 'Copy CLI command')}
                      >
                        <Copy className="h-3 w-3" />
                        {t('resourceCenter.actions.copyCliCommand', 'Copy CLI command')}
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-interactive bg-foreground/[0.06] px-2 py-1 text-caption text-foreground transition-colors hover:bg-foreground/[0.1] dark:bg-foreground/[0.08] dark:hover:bg-foreground/[0.12]"
                        onClick={() => void handleCopyAgentPrompt(selectedResource)}
                        title={t('resourceCenter.actions.copyAgentPrompt', 'Copy agent prompt')}
                        aria-label={t('resourceCenter.actions.copyAgentPrompt', 'Copy agent prompt')}
                      >
                        <Copy className="h-3 w-3" />
                        {t('resourceCenter.actions.copyAgentPrompt', 'Copy agent prompt')}
                      </button>
                    </div>

                    <div className="grid grid-cols-[80px_1fr] gap-y-2 gap-x-2 text-caption">
                      <div className="text-muted-foreground">{t('resourceCenter.developer.idLabel', 'ID')}</div>
                      <div className="font-mono break-all">{selectedResource.resourceId}</div>

                      <div className="text-muted-foreground">{t('resourceCenter.developer.mimeTypeLabel', 'MIME')}</div>
                      <div>{selectedResource.mimeType || unknownMimeLabel}</div>

                      <div className="text-muted-foreground">{t('resourceCenter.developer.statusLabel', 'Status')}</div>
                      <div>
                        <span className={`rounded px-1.5 py-0.5 ${getBadgeClass('status')}`}>
                          {getCaptureStatusLabel(selectedResource.captureStatus)}
                        </span>
                      </div>

                      <div className="text-muted-foreground">{t('resourceCenter.developer.capabilitiesLabel', 'Capabilities')}</div>
                      <div>{formatCapabilities(selectedResource.capabilities)}</div>

                      <div className="text-muted-foreground">{t('resourceCenter.developer.sourceLabel', 'Source')}</div>
                      <div>{getSourceLabel(selectedResource.source)}</div>
                    </div>

                    {selectedResource.mediaElementInfo?.usesMediaSource && (
                      <div className="rounded-interactive border border-warning/30 bg-warning/10 p-2 text-caption text-warning">
                        {t('resourceCenter.hints.pageBoundBlob', 'This resource comes from an in-page MediaSource/blob context and must be captured within the page before it can be downloaded reliably.')}
                      </div>
                    )}
                    {selectedResource.category === 'dash' && (
                      <div className="rounded-interactive bg-foreground/[0.05] p-2 text-caption text-muted-foreground dark:bg-foreground/[0.08]">
                        {t('resourceCenter.hints.dashReady', 'DASH 资源会自动解析流信息，下载时也会显示解析、分片下载和合并进度。')}
                      </div>
                    )}
                    {selectedResource.streamInfo && (
                      <div className="rounded-interactive bg-foreground/[0.05] p-2 text-caption dark:bg-foreground/[0.08]">
                        <div className="mb-1 font-medium">{t('resourceCenter.streamInfo.title', 'Stream info')}</div>
                        <div className="text-muted-foreground">
                          {selectedResource.streamInfo.isLive
                            ? t('resourceCenter.streamInfo.live', 'Live stream')
                            : t('resourceCenter.streamInfo.vod', 'On-demand stream')}
                          {selectedResource.streamInfo.duration ? ` · ${selectedResource.streamInfo.duration.toFixed(1)}s` : ''}
                          {selectedResource.streamInfo.segmentCount
                            ? ` · ${t('resourceCenter.streamInfo.segmentCount', { count: selectedResource.streamInfo.segmentCount })}`
                            : ''}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
