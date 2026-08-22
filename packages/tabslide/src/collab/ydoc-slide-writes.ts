import * as Y from 'yjs'
import type { Slide, PPTElement } from '../types/slides'
import {
  getPagesMap,
  getPageOrderArray,
  getPageOrderMap,
  getMetaMap,
} from './ydoc-schema'
import {
  detectSingleItemMove,
  getOrderedIds,
  setOrderedIds,
  reorderItem,
} from './utils'
import {
  createElementStorage,
  elementToYMap,
  ensureElementStorage,
  readYArrayOrder,
  reconcileYArrayOrder,
  reconcileYJsonArrayById,
  syncElementsCollection,
  updateYMapElement,
} from './ydoc-slide-model'
import type { PendingSlideWrite } from './pending-slide-writes'

interface SlideWriteContext {
  ydoc: Y.Doc
  pagesMap: Y.Map<unknown>
  pageOrderArr: Y.Array<string>
  pageOrderMap: Y.Map<string>
  overwriteExistingInsertElement: boolean
}

function createWriteContext(
  ydoc: Y.Doc,
  options: { overwriteExistingInsertElement: boolean },
): SlideWriteContext {
  return {
    ydoc,
    pagesMap: getPagesMap(ydoc),
    pageOrderArr: getPageOrderArray(ydoc),
    pageOrderMap: getPageOrderMap(ydoc),
    overwriteExistingInsertElement: options.overwriteExistingInsertElement,
  }
}

function upsertJsonArrayField(
  pageYMap: Y.Map<unknown>,
  field: string,
  value: unknown[],
): void {
  const existing = pageYMap.get(field)
  if (existing instanceof Y.Array) {
    reconcileYJsonArrayById(existing, value)
    return
  }

  const arr = new Y.Array<unknown>()
  if (value.length > 0) arr.push(value)
  pageYMap.set(field, arr)
}

function writePageField(pageYMap: Y.Map<unknown>, field: string, value: unknown): void {
  if (field === 'elements' && Array.isArray(value)) {
    syncElementsCollection(pageYMap, value as PPTElement[])
    return
  }

  if ((field === 'animations' || field === 'masterElements' || field === 'notes') && Array.isArray(value)) {
    upsertJsonArrayField(pageYMap, field, value)
    return
  }

  pageYMap.set(field, value)
}

function pushJsonArrayIfPresent(
  pageYMap: Y.Map<unknown>,
  field: string,
  value: unknown[] | undefined,
): void {
  if (!Array.isArray(value) || value.length === 0) return
  const arr = new Y.Array<unknown>()
  for (const item of value) arr.push([item])
  pageYMap.set(field, arr)
}

function createPageYMapFromPartial(page: Partial<Slide>): Y.Map<unknown> {
  const pageYMap = new Y.Map<unknown>()
  const { elementsMap, elementOrder } = createElementStorage(pageYMap)
  const ids: string[] = []

  if (Array.isArray(page.elements)) {
    for (const el of page.elements) {
      elementsMap.set(el.id, elementToYMap(el))
      ids.push(el.id)
    }
    elementOrder.push(ids)
  }

  if (page.background !== undefined) pageYMap.set('background', page.background)
  if (page.remark !== undefined) pageYMap.set('remark', page.remark)
  if (page.turningMode !== undefined) pageYMap.set('turningMode', page.turningMode)
  if (page.layout !== undefined) pageYMap.set('layout', page.layout)
  pushJsonArrayIfPresent(pageYMap, 'masterElements', page.masterElements)
  pushJsonArrayIfPresent(pageYMap, 'animations', page.animations)
  pushJsonArrayIfPresent(pageYMap, 'notes', page.notes)
  if (page.sectionTag !== undefined) pageYMap.set('sectionTag', page.sectionTag)
  if (page.slideType !== undefined) pageYMap.set('slideType', page.slideType)
  return pageYMap
}

function insertPageIdInOrder(
  pageOrderArr: Y.Array<string>,
  pageId: string,
  afterPageId?: string,
): void {
  const currentOrder = readYArrayOrder(pageOrderArr)
  if (currentOrder.includes(pageId)) return

  if (afterPageId) {
    const idx = currentOrder.indexOf(afterPageId)
    pageOrderArr.insert(idx >= 0 ? idx + 1 : pageOrderArr.length, [pageId])
    return
  }

  pageOrderArr.push([pageId])
}

function updatePageOrderPosition(ctx: SlideWriteContext, pageId: string): void {
  const order = readYArrayOrder(ctx.pageOrderArr)
  if (ctx.pageOrderMap.size === 0) {
    setOrderedIds(ctx.pageOrderMap, order)
    return
  }

  const idx = order.indexOf(pageId)
  const before = idx > 0 ? order[idx - 1] : null
  const after = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null
  reorderItem(ctx.pageOrderMap, pageId, before, after)
}

function deletePageIdFromOrder(ctx: SlideWriteContext, pageId: string): void {
  for (let i = 0; i < ctx.pageOrderArr.length; i++) {
    if (ctx.pageOrderArr.get(i) === pageId) {
      ctx.pageOrderArr.delete(i, 1)
      break
    }
  }
  if (ctx.pageOrderMap.has(pageId)) {
    ctx.pageOrderMap.delete(pageId)
  }
}

function removeElementFromPage(pageYMap: Y.Map<unknown>, elementId: string): void {
  const { elementsMap, elementOrder } = ensureElementStorage(pageYMap)
  elementsMap.delete(elementId)
  for (let i = 0; i < elementOrder.length; i++) {
    if (elementOrder.get(i) === elementId) {
      elementOrder.delete(i, 1)
      break
    }
  }
}

function insertElementIntoPage(
  pageYMap: Y.Map<unknown>,
  element: PPTElement,
  afterElementId?: string,
  overwriteExisting: boolean = true,
): void {
  const { elementsMap, elementOrder } = ensureElementStorage(pageYMap)
  if (!overwriteExisting && elementsMap.has(element.id)) return

  elementsMap.set(element.id, elementToYMap(element))
  const alreadyInOrder = readYArrayOrder(elementOrder).includes(element.id)
  if (alreadyInOrder) return

  if (afterElementId) {
    for (let i = 0; i < elementOrder.length; i++) {
      if (elementOrder.get(i) === afterElementId) {
        elementOrder.insert(i + 1, [element.id])
        return
      }
    }
  }
  elementOrder.push([element.id])
}

type WriteHandler<Op extends PendingSlideWrite['op']> = (
  ctx: SlideWriteContext,
  write: Extract<PendingSlideWrite, { op: Op }>,
) => void

const writeHandlers: { [Op in PendingSlideWrite['op']]: WriteHandler<Op> } = {
  setPageElements(ctx, write) {
    const pageYMap = ctx.pagesMap.get(write.pageId) as Y.Map<unknown> | undefined
    if (pageYMap) syncElementsCollection(pageYMap, write.elements)
  },
  updatePageField(ctx, write) {
    const pageYMap = ctx.pagesMap.get(write.pageId) as Y.Map<unknown> | undefined
    if (pageYMap) writePageField(pageYMap, write.field, write.value)
  },
  updateElement(ctx, write) {
    const pageYMap = ctx.pagesMap.get(write.pageId) as Y.Map<unknown> | undefined
    if (!pageYMap) return
    const { elementsMap } = ensureElementStorage(pageYMap)
    const elementYMap = elementsMap.get(write.elementId)
    if (elementYMap instanceof Y.Map) {
      updateYMapElement(elementYMap, write.updates as Record<string, unknown>)
    }
  },
  batchUpdatePages(ctx, write) {
    for (const { pageId, field, value } of write.changes) {
      const pageYMap = ctx.pagesMap.get(pageId) as Y.Map<unknown> | undefined
      if (pageYMap) writePageField(pageYMap, field, value)
    }
  },
  addPage(ctx, write) {
    if (ctx.pagesMap.has(write.pageId)) return
    ctx.pagesMap.set(write.pageId, createPageYMapFromPartial(write.page))
    insertPageIdInOrder(ctx.pageOrderArr, write.pageId, write.afterPageId)
    updatePageOrderPosition(ctx, write.pageId)
  },
  deletePage(ctx, write) {
    if (ctx.pagesMap.has(write.pageId)) ctx.pagesMap.delete(write.pageId)
    deletePageIdFromOrder(ctx, write.pageId)
  },
  reorderPages(ctx, write) {
    reconcileYArrayOrder(ctx.pageOrderArr, write.newOrder)
    const currentOrder = getOrderedIds(ctx.pageOrderMap)
    const singleMove = detectSingleItemMove(currentOrder, write.newOrder)
    if (singleMove) {
      reorderItem(ctx.pageOrderMap, singleMove.itemId, singleMove.beforeId, singleMove.afterId)
    } else {
      setOrderedIds(ctx.pageOrderMap, write.newOrder)
    }
  },
  reorderElements(ctx, write) {
    const pageYMap = ctx.pagesMap.get(write.pageId) as Y.Map<unknown> | undefined
    if (!pageYMap) return
    const { elementOrder } = ensureElementStorage(pageYMap)
    reconcileYArrayOrder(elementOrder, write.newElementOrder)
  },
  removeElement(ctx, write) {
    const pageYMap = ctx.pagesMap.get(write.pageId) as Y.Map<unknown> | undefined
    if (pageYMap) removeElementFromPage(pageYMap, write.elementId)
  },
  insertElement(ctx, write) {
    const pageYMap = ctx.pagesMap.get(write.pageId) as Y.Map<unknown> | undefined
    if (pageYMap) {
      insertElementIntoPage(
        pageYMap,
        write.element,
        write.afterElementId,
        ctx.overwriteExistingInsertElement,
      )
    }
  },
  updateMetaTheme(ctx, write) {
    getMetaMap(ctx.ydoc).set('theme', write.theme)
  },
  updateMetaName(ctx, write) {
    getMetaMap(ctx.ydoc).set('project_name', write.name)
  },
  updateMetaFontMeta(ctx, write) {
    getMetaMap(ctx.ydoc).set('font_meta', write.fontMeta)
  },
}

function applySlideWrite(ctx: SlideWriteContext, write: PendingSlideWrite): void {
  const handler = writeHandlers[write.op] as (ctx: SlideWriteContext, write: PendingSlideWrite) => void
  handler(ctx, write)
}

export function transactSlideWrite(
  ydoc: Y.Doc,
  write: PendingSlideWrite,
  origin: string = 'local',
): void {
  const ctx = createWriteContext(ydoc, { overwriteExistingInsertElement: true })
  ydoc.transact(() => applySlideWrite(ctx, write), origin)
}

// 断线降级：重连时回放缓存的写操作到 Y.Doc
export function replayPendingSlideWrites(ydoc: Y.Doc, writes: PendingSlideWrite[]): void {
  if (writes.length === 0) return

  const ctx = createWriteContext(ydoc, { overwriteExistingInsertElement: false })
  for (const write of writes) {
    try {
      ydoc.transact(() => applySlideWrite(ctx, write), 'offline-replay')
    } catch (err) {
      console.error('[TabSlide Collab] offline-replay failed for op:', write.op, err)
    }
  }
}
