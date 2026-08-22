/**
 * useSlideCollabBridge 的纯同步工具：稳定序列化、内容指纹、内容 diff、
 * 元素逐项同步、页面字段同步。从桥接层的 React 生命周期中剥离，便于单测与复用。
 */
import type { UseSlideCollaborationResult } from '../hooks/useSlideCollaboration'
import type { Slide, PPTElement } from '../types/slides'

// ── 稳定序列化 ──

/**
 * 按键排序递归序列化，保证同一内容无论键插入顺序如何都产生相同字符串。
 * Y.js 对象与 Zustand 对象的键序可能不同，普通 JSON.stringify 会导致
 * 内容相同但字符串不同 → 指纹不匹配 → 无效全量更新。
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(v => stableStringify(v)).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

// ── 内容指纹 ──

/**
 * 为单个页面生成内容指纹。
 * 使用 stableStringify（键排序）确保 Y.js 与 Zustand 对象键序差异不影响指纹。
 */
export function computePageFingerprint(page: Slide): string {
  return stableStringify({
    id: page.id,
    elements: page.elements,
    background: page.background,
    remark: page.remark,
    turningMode: page.turningMode,
    animations: page.animations,
    masterElements: page.masterElements,
    layout: page.layout,
    notes: page.notes,
    sectionTag: page.sectionTag,
    slideType: page.slideType,
  })
}

export function safeStableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if ((typeof a === 'object' && a !== null) || (typeof b === 'object' && b !== null)) {
    try {
      return stableStringify(a) === stableStringify(b)
    } catch {
      return false
    }
  }
  return false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const NO_CHANGE = Symbol('no-change')

export function diffValue(
  oldVal: unknown,
  newVal: unknown,
): unknown | typeof NO_CHANGE {
  if (oldVal === newVal) return NO_CHANGE

  if (Array.isArray(oldVal) && Array.isArray(newVal)) {
    return safeStableEqual(oldVal, newVal) ? NO_CHANGE : newVal
  }

  if (isPlainObject(oldVal) && isPlainObject(newVal)) {
    const patch: Record<string, unknown> = {}
    const keys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)])
    for (const key of keys) {
      if (!(key in newVal)) {
        patch[key] = undefined
        continue
      }
      const child = diffValue(oldVal[key], newVal[key])
      if (child !== NO_CHANGE) {
        patch[key] = child
      }
    }
    return Object.keys(patch).length > 0 ? patch : NO_CHANGE
  }

  return safeStableEqual(oldVal, newVal) ? NO_CHANGE : newVal
}

/**
 * 将 Y.js pagesSnapshot + pageOrder 重建为 Zustand 的 pages 数组格式
 */
export function rebuildPagesFromYjs(
  pagesSnapshot: Map<string, Slide>,
  pageOrder: string[],
): Slide[] {
  const pages: Slide[] = []
  const seen = new Set<string>()
  for (const pageId of pageOrder) {
    if (seen.has(pageId)) continue
    seen.add(pageId)
    const slide = pagesSnapshot.get(pageId)
    if (slide) {
      pages.push(slide)
    }
  }
  return pages
}

/**
 * 比较两组页面的实际内容差异（基于指纹而非引用）。
 * 返回需要同步到 Y.js 的变更集。
 */
export function diffPagesByContent(
  oldPages: Slide[],
  newPages: Slide[],
  oldFingerprints: Map<string, string>,
): {
  added: Slide[]
  removed: string[]
  changed: Slide[]
  orderChanged: boolean
} {
  const oldById = new Map(oldPages.map(p => [p.id, p]))
  const newById = new Map(newPages.map(p => [p.id, p]))

  const added: Slide[] = []
  const removed: string[] = []
  const changed: Slide[] = []

  for (const page of newPages) {
    const old = oldById.get(page.id)
    if (!old) {
      added.push(page)
    } else if (old === page) {
      continue
    } else {
      // 不依赖引用比较，始终基于内容指纹判断
      const newFp = computePageFingerprint(page)
      const oldFp = oldFingerprints.get(page.id) ?? computePageFingerprint(old)
      if (newFp !== oldFp) changed.push(page)
    }
  }

  for (const page of oldPages) {
    if (!newById.has(page.id)) {
      removed.push(page.id)
    }
  }

  const oldOrder = oldPages.map(p => p.id)
  const newOrder = newPages.map(p => p.id)
  const orderChanged = oldOrder.length !== newOrder.length
    || oldOrder.some((id, i) => id !== newOrder[i])

  return { added, removed, changed, orderChanged }
}

/**
 * 逐元素同步 Zustand → Y.js（取代旧的 setPageElements 批量替换）。
 *
 * 利用 Immer 的引用不变性：未变的元素保持 === 原引用，只有被编辑的
 * 元素才是新对象。这让我们能精确地只更新变化的元素，避免清空重建。
 *
 * CRDT 收益：
 * - 用户 A 编辑元素 1、用户 B 编辑元素 2 → 各自只 touch 自己的元素
 * - Y.js 的 delete(idx)+insert(idx) 操作针对不同索引 → 自动合并
 */
export function syncElementChanges(
  collab: UseSlideCollaborationResult,
  pageId: string,
  oldElements: PPTElement[],
  newElements: PPTElement[],
): void {
  const oldById = new Map(oldElements.map(e => [e.id, e]))
  const newById = new Map(newElements.map(e => [e.id, e]))

  // 1. 删除的元素
  for (const oldEl of oldElements) {
    if (!newById.has(oldEl.id)) {
      collab.removeElement(pageId, oldEl.id)
    }
  }

  // 2. 新增的元素 — afterId 必须引用 Y.js 中已存在的元素
  const insertedIds = new Set<string>()
  for (let i = 0; i < newElements.length; i++) {
    const el = newElements[i]
    if (!oldById.has(el.id)) {
      let afterId: string | undefined
      for (let j = i - 1; j >= 0; j--) {
        const candidateId = newElements[j].id
        if (oldById.has(candidateId) || insertedIds.has(candidateId)) {
          afterId = candidateId
          break
        }
      }
      collab.insertElement(pageId, el, afterId)
      insertedIds.add(el.id)
    }
  }

  // 3. 变更的元素 — 计算深层属性 patch（支持嵌套对象的最小更新）
  for (const newEl of newElements) {
    const oldEl = oldById.get(newEl.id)
    if (!oldEl) continue

    const updates: Record<string, unknown> = {}
    const allKeys = new Set([...Object.keys(oldEl), ...Object.keys(newEl)])
    for (const key of allKeys) {
      if (key === 'id') continue
      const oldVal = (oldEl as unknown as Record<string, unknown>)[key]
      const newVal = (newEl as unknown as Record<string, unknown>)[key]
      const patch = diffValue(oldVal, newVal)
      if (patch !== NO_CHANGE) {
        updates[key] = patch
      }
    }
    if (Object.keys(updates).length > 0) {
      collab.updateElement(pageId, newEl.id, updates as Partial<PPTElement>)
    }
  }

  // 4. 顺序对齐 — 增删元素后 insertElement/removeElement 不保证最终顺序，
  // 始终比较并 reconcile（reconcileYArrayOrder 内部会跳过无变化的情况）
  const oldOrder = oldElements.map(e => e.id)
  const newOrder = newElements.map(e => e.id)
  if (newOrder.length !== oldOrder.length || newOrder.some((id, i) => id !== oldOrder[i])) {
    collab.reorderElements(pageId, newOrder)
  }
}

/**
 * 将 fromPage 相对 refPage 变化的页面级元数据字段（非 elements）推送到 Y.js。
 * 用于初始合并（本地→Y.js）与本地编辑同步（Zustand→Y.js）两条路径，避免重复 if 链。
 */
export function syncPageMetaFieldsToCollab(
  collab: UseSlideCollaborationResult,
  fromPage: Slide,
  refPage: Slide,
): void {
  const id = fromPage.id
  if (!safeStableEqual(fromPage.background, refPage.background)) {
    collab.updatePageField(id, 'background', fromPage.background ?? null)
  }
  if (!safeStableEqual(fromPage.remark, refPage.remark)) {
    collab.updatePageField(id, 'remark', fromPage.remark || '')
  }
  if (!safeStableEqual(fromPage.turningMode, refPage.turningMode)) {
    collab.updatePageField(id, 'turningMode', fromPage.turningMode || '')
  }
  if (!safeStableEqual(fromPage.animations, refPage.animations)) {
    collab.updatePageField(id, 'animations', fromPage.animations || [])
  }
  if (!safeStableEqual(fromPage.masterElements, refPage.masterElements)) {
    collab.updatePageField(id, 'masterElements', fromPage.masterElements || [])
  }
  if (!safeStableEqual(fromPage.layout, refPage.layout)) {
    collab.updatePageField(id, 'layout', fromPage.layout || null)
  }
  if (!safeStableEqual(fromPage.notes, refPage.notes)) {
    collab.updatePageField(id, 'notes', fromPage.notes || [])
  }
  if (!safeStableEqual(fromPage.sectionTag, refPage.sectionTag)) {
    collab.updatePageField(id, 'sectionTag', fromPage.sectionTag ?? null)
  }
  if (!safeStableEqual(fromPage.slideType, refPage.slideType)) {
    collab.updatePageField(id, 'slideType', fromPage.slideType ?? null)
  }
}

/**
 * 提取本地页面相对于 Y.js 页面的脏字段（用于初始合并时保留本地编辑）。
 * 返回只包含本地修改过的字段的 partial Slide，用于 spread 覆盖 Y.js 基准。
 */
export function getDirtyFields(local: Slide, yjs: Slide): Partial<Slide> {
  const dirty: Partial<Slide> = {}
  if (!safeStableEqual(local.elements, yjs.elements)) dirty.elements = local.elements
  if (!safeStableEqual(local.background, yjs.background)) dirty.background = local.background
  if (!safeStableEqual(local.remark, yjs.remark)) dirty.remark = local.remark
  if (!safeStableEqual(local.turningMode, yjs.turningMode)) dirty.turningMode = local.turningMode
  if (!safeStableEqual(local.animations, yjs.animations)) dirty.animations = local.animations
  if (!safeStableEqual(local.masterElements, yjs.masterElements)) dirty.masterElements = local.masterElements
  if (!safeStableEqual(local.layout, yjs.layout)) dirty.layout = local.layout
  if (!safeStableEqual(local.notes, yjs.notes)) dirty.notes = local.notes
  if (!safeStableEqual(local.sectionTag, yjs.sectionTag)) dirty.sectionTag = local.sectionTag
  if (!safeStableEqual(local.slideType, yjs.slideType)) dirty.slideType = local.slideType
  return dirty
}
