import type { SlidePreset, SlidePresentation } from '@tabtin/tabslide'
import { apiService } from '@/services/api'

const MAX_RETRY_DELAY_MS = 30000

export interface RefLike<T> {
  current: T
}

export interface SaveContext {
  organizationId?: string | null
  spaceId?: string | null
}

export interface SaveBaseline {
  pageOrder: string[]
  pageFingerprints: Record<string, string>
  pageRefs: Map<string, SlidePresentation['pages'][number]>
  themeFingerprint: string
}

export interface IncrementalSaveDiff {
  changedPageIds: string[]
  deletedPageIds: string[]
  pageOrderChanged: boolean
  hasPagePayload: boolean
  hasAnyPageChange: boolean
  themeChanged: boolean
  nextBaseline: SaveBaseline
}

export function calcRetryDelay(attempt: number, baseDelay: number): number {
  const safeAttempt = Math.max(1, attempt)
  return Math.min(baseDelay * (2 ** (safeAttempt - 1)), MAX_RETRY_DELAY_MS)
}

export function unwrapEnvelope(envelope: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (envelope && typeof envelope === 'object' && 'data' in envelope && envelope.data && typeof envelope.data === 'object') {
    return envelope.data as Record<string, unknown>
  }
  return envelope || {}
}

function toStableSerializable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => toStableSerializable(item))
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const ordered: Record<string, unknown> = {}
    const keys = Object.keys(source).sort((a, b) => a.localeCompare(b))
    for (const key of keys) {
      const item = source[key]
      if (item === undefined) continue
      ordered[key] = toStableSerializable(item)
    }
    return ordered
  }
  return value
}

function stableStringify(value: unknown): string {
  return JSON.stringify(toStableSerializable(value))
}

export function buildFirstSlideFingerprint(data: SlidePresentation): string {
  const firstPage = data.pages[0]
  if (!firstPage) return ''
  try {
    // 缩略图只依赖可视内容，排除备注/批注等非视觉字段，避免无意义的上传。
    return stableStringify({
      canvasWidth: data.canvasWidth,
      canvasHeight: data.canvasHeight,
      theme: data.theme,
      page: {
        id: firstPage.id,
        background: firstPage.background,
        elements: firstPage.elements,
      },
    })
  } catch {
    return `${firstPage.id}:${firstPage.elements.length}:${firstPage.background?.type || ''}`
  }
}

function buildPageSaveFingerprint(page: SlidePresentation['pages'][number]): string {
  try {
    return stableStringify({
      id: page.id,
      elements: page.elements,
      background: page.background,
      remark: page.remark,
      turningMode: page.turningMode,
      animations: page.animations,
      masterElements: page.masterElements,
      layout: page.layout,
    })
  } catch {
    return `${page.id}:${page.elements.length}:${page.background?.type || ''}`
  }
}

export function buildSaveBaseline(
  data: SlidePresentation,
  prevBaseline?: SaveBaseline | null,
): SaveBaseline {
  const pageOrder: string[] = []
  const pageFingerprints: Record<string, string> = {}
  const pageRefs = new Map<string, SlidePresentation['pages'][number]>()

  for (const page of data.pages) {
    pageOrder.push(page.id)
    pageRefs.set(page.id, page)

    const cachedRef = prevBaseline?.pageRefs.get(page.id)
    const cachedFingerprint = prevBaseline?.pageFingerprints[page.id]
    if (cachedRef === page && cachedFingerprint !== undefined) {
      pageFingerprints[page.id] = cachedFingerprint
      continue
    }

    pageFingerprints[page.id] = buildPageSaveFingerprint(page)
  }

  let themeFingerprint = 'null'
  try {
    themeFingerprint = stableStringify(data.theme || null)
  } catch {
    // theme 保底使用空值指纹，确保不会因为异常中断保存流程
  }

  return {
    pageOrder,
    pageFingerprints,
    pageRefs,
    themeFingerprint,
  }
}

function hasPageOrderChanged(prev: string[], next: string[]): boolean {
  if (prev.length !== next.length) return true
  for (let i = 0; i < prev.length; i += 1) {
    if (prev[i] !== next[i]) return true
  }
  return false
}

export function diffIncrementalSave(
  data: SlidePresentation,
  baseline: SaveBaseline | null | undefined,
): IncrementalSaveDiff {
  const nextBaseline = buildSaveBaseline(data, baseline)
  if (!baseline) {
    const changedPageIds = nextBaseline.pageOrder.slice()
    const hasPagePayload = changedPageIds.length > 0
    const pageOrderChanged = nextBaseline.pageOrder.length > 0
    return {
      changedPageIds,
      deletedPageIds: [],
      pageOrderChanged,
      hasPagePayload,
      hasAnyPageChange: hasPagePayload || pageOrderChanged,
      themeChanged: false,
      nextBaseline,
    }
  }

  const changedPageIds: string[] = []
  for (const pageId of nextBaseline.pageOrder) {
    const nextFp = nextBaseline.pageFingerprints[pageId]
    const prevFp = baseline.pageFingerprints[pageId]
    if (nextFp !== prevFp) {
      changedPageIds.push(pageId)
    }
  }

  const deletedPageIds = baseline.pageOrder.filter((pageId) => !(pageId in nextBaseline.pageFingerprints))
  const pageOrderChanged = hasPageOrderChanged(baseline.pageOrder, nextBaseline.pageOrder)
  const hasPagePayload = changedPageIds.length > 0 || deletedPageIds.length > 0

  return {
    changedPageIds,
    deletedPageIds,
    pageOrderChanged,
    hasPagePayload,
    hasAnyPageChange: hasPagePayload || pageOrderChanged,
    themeChanged: baseline.themeFingerprint !== nextBaseline.themeFingerprint,
    nextBaseline,
  }
}

/**
 * 确保项目已在服务端创建，返回 projectId。
 *
 * createProjectPromiseRef 作为互斥锁，避免并发保存时重复创建多个项目。
 */
export async function ensureProjectId(
  data: SlidePresentation,
  serverIdRef: RefLike<string | null>,
  createProjectPromiseRef: RefLike<Promise<string | null> | null>,
  createProjectSessionRef: RefLike<number | null>,
  saveSessionRef: RefLike<number>,
  session: number,
  toBackendPreset: (preset: SlidePreset) => string,
  getContext: () => SaveContext,
  getCreatePayload?: () => Record<string, unknown> | null,
): Promise<string | null> {
  if (session !== saveSessionRef.current) return null
  if (serverIdRef.current) return serverIdRef.current
  if (createProjectPromiseRef.current && createProjectSessionRef.current === session) {
    return createProjectPromiseRef.current
  }

  // 旧 session 的创建锁已不再可信，直接丢弃引用（旧请求会自然完成，但结果不会再被复用）。
  if (createProjectPromiseRef.current && createProjectSessionRef.current !== session) {
    createProjectPromiseRef.current = null
    createProjectSessionRef.current = null
  }

  const createPromise = (async () => {
    if (session !== saveSessionRef.current) return null
    const { organizationId, spaceId } = getContext()

    if (!organizationId) {
      console.warn('[SlideEditorHost] 保存跳过：未选中组织')
      return null
    }
    if (!spaceId) {
      console.warn('[SlideEditorHost] 保存跳过：未选中 Space')
      return null
    }

    const extraCreatePayload = getCreatePayload?.() || {}
    const envelope = await apiService.request<Record<string, unknown>>({
      method: 'POST',
      url: '/tabslide/projects/',
      data: {
        organization_id: organizationId,
        space_id: spaceId,
        name: data.name,
        preset: toBackendPreset(data.preset),
        canvas_width: data.canvasWidth,
        canvas_height: data.canvasHeight,
        theme: data.theme,
        ...extraCreatePayload,
      },
    })

    if (session !== saveSessionRef.current) return null
    const res = unwrapEnvelope(envelope)
    const newId = (res.id as string) || ''

    if (!newId) {
      console.error('[SlideEditorHost] 创建项目未返回 ID')
      return null
    }

    if (session !== saveSessionRef.current) return null
    serverIdRef.current = newId
    return newId
  })()
    .catch((err) => {
      console.error('[SlideEditorHost] 创建项目失败:', err)
      return null
    })
    .finally(() => {
      if (createProjectPromiseRef.current === createPromise) {
        createProjectPromiseRef.current = null
        createProjectSessionRef.current = null
      }
    })

  createProjectPromiseRef.current = createPromise
  createProjectSessionRef.current = session
  return createPromise
}
