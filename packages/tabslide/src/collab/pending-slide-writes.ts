import { registerStorageBucket } from '@tabtin/storage-manager'
import type { Slide, PPTElement } from '../types/slides'

export const PENDING_WRITES_MAX = 300

export type PendingSlideWrite =
  | { op: 'setPageElements'; pageId: string; elements: PPTElement[] }
  | { op: 'updatePageField'; pageId: string; field: string; value: unknown }
  | { op: 'updateElement'; pageId: string; elementId: string; updates: Partial<PPTElement> }
  | { op: 'batchUpdatePages'; changes: Array<{ pageId: string; field: string; value: unknown }> }
  | { op: 'addPage'; pageId: string; page: Partial<Slide>; afterPageId?: string }
  | { op: 'deletePage'; pageId: string }
  | { op: 'reorderPages'; newOrder: string[] }
  | { op: 'removeElement'; pageId: string; elementId: string }
  | { op: 'insertElement'; pageId: string; element: PPTElement; afterElementId?: string }
  | { op: 'reorderElements'; pageId: string; newElementOrder: string[] }
  | { op: 'updateMetaTheme'; theme: Record<string, unknown> }
  | { op: 'updateMetaName'; name: string }
  | { op: 'updateMetaFontMeta'; fontMeta: Record<string, unknown> }

const PENDING_OVERFLOW_STORAGE_PREFIX = 'tabslide_pending_overflow'

function overflowKey(projectId?: string): string {
  return projectId
    ? `${PENDING_OVERFLOW_STORAGE_PREFIX}:${projectId}`
    : PENDING_OVERFLOW_STORAGE_PREFIX
}

/**
 * Compact the queue by merging updateElement ops targeting the same
 * (pageId, elementId). Later updates win; the merged entry keeps the
 * union of all partial patches with last-writer-wins per field.
 *
 * Returns number of entries removed.
 */
export function compactPendingQueue(queue: PendingSlideWrite[]): number {
  const seenUpdateKeys = new Map<string, number>()
  const toRemove: number[] = []

  for (let i = queue.length - 1; i >= 0; i--) {
    const w = queue[i]
    if (w.op === 'updateElement') {
      const key = `${w.pageId}:${w.elementId}`
      const laterIdx = seenUpdateKeys.get(key)
      if (laterIdx !== undefined) {
        const later = queue[laterIdx] as Extract<PendingSlideWrite, { op: 'updateElement' }>
        later.updates = { ...(w.updates as Record<string, unknown>), ...(later.updates as Record<string, unknown>) } as Partial<PPTElement>
        toRemove.push(i)
      } else {
        seenUpdateKeys.set(key, i)
      }
    }
  }

  for (const idx of toRemove.sort((a, b) => b - a)) {
    queue.splice(idx, 1)
  }
  return toRemove.length
}

/**
 * Persist overflow writes to localStorage so data is not lost even if
 * the in-memory queue is full. Reads back via loadPendingOverflow().
 * Storage key is isolated per projectId to prevent cross-project collisions.
 */
export function spillToLocalStorage(
  overflow: PendingSlideWrite[],
  projectId?: string,
): void {
  if (!overflow.length) return
  try {
    const key = overflowKey(projectId)
    const existing = localStorage.getItem(key)
    const prev: PendingSlideWrite[] = existing ? JSON.parse(existing) : []
    const merged = [...prev, ...overflow]
    localStorage.setItem(key, JSON.stringify(merged))
  } catch {
    console.error(
      '[tabslide] localStorage overflow spill failed, operations may be lost:',
      overflow.length,
    )
  }
}

/**
 * Load and clear any overflow writes from localStorage.
 * Should be called during reconnection to recover spilled data.
 */
export function loadPendingOverflow(projectId?: string): PendingSlideWrite[] {
  try {
    const key = overflowKey(projectId)
    const raw = localStorage.getItem(key)
    if (raw) {
      localStorage.removeItem(key)
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as PendingSlideWrite[]
    }
  } catch {
    // ignore parse errors
  }
  return []
}

/**
 * 将新写操作追加到 pending 队列，同 pageId 的 setPageElements 保留最新一条。
 * 超过 PENDING_WRITES_MAX 时先尝试合并同元素 updateElement 操作压缩队列，
 * 仍然超限则将溢出写入 localStorage 临时缓存，绝不静默丢弃。
 */
export function appendPendingWrite(
  queue: PendingSlideWrite[],
  write: PendingSlideWrite,
  projectId?: string,
): void {
  if (write.op === 'setPageElements') {
    for (let i = queue.length - 1; i >= 0; i--) {
      const existing = queue[i]
      if (existing.op === 'setPageElements' && existing.pageId === write.pageId) {
        queue.splice(i, 1)
      }
    }
  }
  queue.push(write)
  if (queue.length > PENDING_WRITES_MAX) {
    compactPendingQueue(queue)
  }
  if (queue.length > PENDING_WRITES_MAX) {
    const excess = queue.length - PENDING_WRITES_MAX
    const overflow = queue.splice(0, excess)
    spillToLocalStorage(overflow, projectId)
  }
}

// localStorage 不暴露 keys() 迭代器以外的批量 API，单 key 只能取 .length（字符数）。
// 这里按 UTF-8 字节估算（汉字/emoji 远超 1 byte），保证 UI 容量数字不严重低估。
function enumerateOverflowKeys(): string[] {
  if (typeof localStorage === 'undefined') return []
  const keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key && isOverflowStorageKey(key)) {
        keys.push(key)
      }
    }
  } catch {
    // localStorage 访问被禁（隐私窗口）— 视为空
  }
  return keys
}

function isOverflowStorageKey(key: string): boolean {
  return key === PENDING_OVERFLOW_STORAGE_PREFIX
    || key.startsWith(`${PENDING_OVERFLOW_STORAGE_PREFIX}:`)
}

function readOverflowEntry(key: string): { bytes: number; opCount: number } {
  if (typeof localStorage === 'undefined') return { bytes: 0, opCount: 0 }
  const raw = localStorage.getItem(key)
  if (!raw) return { bytes: 0, opCount: 0 }
  let bytes = 0
  try {
    bytes = new TextEncoder().encode(raw).byteLength
  } catch {
    bytes = raw.length
  }
  let opCount = 0
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) opCount = parsed.length
  } catch {
    // ignore parse failure — 仅影响 opCount 元信息
  }
  return { bytes, opCount }
}

function readOverflowTotals(keys: string[]): { bytes: number; itemCount: number } {
  let bytes = 0
  let itemCount = 0
  for (const key of keys) {
    const entry = readOverflowEntry(key)
    bytes += entry.bytes
    itemCount += entry.opCount
  }
  return { bytes, itemCount }
}

async function getOverflowSize(): Promise<{ bytes: number; itemCount: number }> {
  return readOverflowTotals(enumerateOverflowKeys())
}

async function listOverflowItems(): Promise<Array<{
  id: string
  label: string
  bytes: number
  metadata: { opCount: number }
}>> {
  return enumerateOverflowKeys().map((key) => {
    const entry = readOverflowEntry(key)
    const projectId = key.startsWith(`${PENDING_OVERFLOW_STORAGE_PREFIX}:`)
      ? key.slice(PENDING_OVERFLOW_STORAGE_PREFIX.length + 1)
      : '(未知项目)'
    return {
      id: key,
      label: `演示文稿 ${projectId}`,
      bytes: entry.bytes,
      metadata: { opCount: entry.opCount },
    }
  })
}

function selectOverflowKeys(itemIds?: string[]): string[] {
  const keys = enumerateOverflowKeys()
  return itemIds && itemIds.length > 0
    ? keys.filter((key) => itemIds.includes(key))
    : keys
}

function clearOverflowKeys(keys: string[]): string[] | undefined {
  const errors: string[] = []
  for (const key of keys) {
    try {
      localStorage.removeItem(key)
    } catch (err) {
      errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return errors.length ? errors : undefined
}

async function clearOverflowItems(options?: {
  itemIds?: string[]
  dryRun?: boolean
}): Promise<{
  clearedItemCount: number
  freedBytes: number
  errors?: string[]
}> {
  const target = selectOverflowKeys(options?.itemIds)
  const totals = readOverflowTotals(target)
  if (options?.dryRun) {
    return { clearedItemCount: totals.itemCount, freedBytes: totals.bytes }
  }
  return {
    clearedItemCount: totals.itemCount,
    freedBytes: totals.bytes,
    errors: clearOverflowKeys(target),
  }
}

export function registerTabSlideOverflowBucket(): () => void {
  if (typeof localStorage === 'undefined') return () => undefined

  let unregister: (() => void) | undefined
  try {
    unregister = registerStorageBucket({
      id: 'tabslide:offline-overflow',
      category: 'data',
      group: 'business-app',
      displayName: 'TabSlide 未同步的演示文稿编辑',
      description: '断网 / 高峰协作时排队等上传、还没同步到云端的 PPT 编辑操作。',
      warnings: [
        '断网期间累积的 PPT 编辑操作（增删页 / 改元素 / 改主题等）会永久丢失',
        '若你最近编辑过 PPT 但没看到协作上线提示，请先打开对应演示文稿等待重连同步完再清理',
      ],
      requiresConfirmation: 'soft',
      sizeFn: getOverflowSize,
      listFn: listOverflowItems,
      clearFn: clearOverflowItems,
    })
  } catch (err) {
    try { unregister?.() } catch { /* swallow */ }
    if (typeof console !== 'undefined') {
      console.warn('[tabslide] storage-manager bucket registration skipped:', err)
    }
    return () => undefined
  }

  return () => {
    try { unregister?.() } catch { /* swallow */ }
  }
}
