import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import * as Y from 'yjs'
import type { Slide } from '../types/slides'
import {
  getPagesMap,
  getPageOrderArray,
  getPageOrderMap,
  getMetaMap,
} from '../collab/ydoc-schema'
import { getOrderedIds, setOrderedIds } from '../collab/utils'
import { migrateElementsToYMap } from '../collab/ydoc-slide-model'
import { yPageToSlide } from '../collab/ydoc-slide-read'

export interface PageChange {
  pageId: string
  field: string
  isLocal: boolean
}

export interface SlideRefreshFns {
  refreshPages: () => void
  refreshPageOrder: () => void
  refreshMeta: () => void
}

interface MetaSnapshot {
  version: number
  metaTheme: Record<string, unknown> | null
  metaName: string | null
  metaFontMeta: Record<string, unknown> | null
}

interface PageEventSummary {
  affectedPageIds: Set<string>
  changes: PageChange[]
  needsFullRefresh: boolean
}

function readPagesSnapshot(pagesMap: Y.Map<unknown>): Map<string, Slide> {
  const snapshot = new Map<string, Slide>()
  pagesMap.forEach((value, pageId) => {
    if (value instanceof Y.Map) {
      snapshot.set(pageId, yPageToSlide(pageId, value))
    }
  })
  return snapshot
}

function dedupePageOrder(
  ydoc: Y.Doc,
  pageOrderArr: Y.Array<string>,
  pageOrderMap: Y.Map<string>,
): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  const duplicateIndices: number[] = []

  for (let i = 0; i < pageOrderArr.length; i++) {
    const id = pageOrderArr.get(i)
    if (seen.has(id)) {
      duplicateIndices.push(i)
    } else {
      seen.add(id)
      order.push(id)
    }
  }

  if (duplicateIndices.length > 0) {
    ydoc.transact(() => {
      for (let k = duplicateIndices.length - 1; k >= 0; k--) {
        pageOrderArr.delete(duplicateIndices[k], 1)
      }
    }, 'local')
  }

  if (order.length > 0 && pageOrderMap.size === 0) {
    ydoc.transact(() => {
      setOrderedIds(pageOrderMap, order)
    }, 'local')
  }

  return order
}

function readPageOrder(ydoc: Y.Doc, pageOrderArr: Y.Array<string>): string[] {
  const pageOrderMap = getPageOrderMap(ydoc)
  if (pageOrderMap.size > 0) {
    return getOrderedIds(pageOrderMap)
  }
  return dedupePageOrder(ydoc, pageOrderArr, pageOrderMap)
}

function readMetaSnapshot(metaMap: Y.Map<unknown>): MetaSnapshot {
  const version = metaMap.get('version')
  const theme = metaMap.get('theme')
  const name = metaMap.get('project_name')
  const fontMeta = metaMap.get('font_meta')

  return {
    version: typeof version === 'number' ? version : 0,
    metaTheme: theme && typeof theme === 'object' ? theme as Record<string, unknown> : null,
    metaName: typeof name === 'string' ? name : null,
    metaFontMeta: fontMeta && typeof fontMeta === 'object' ? fontMeta as Record<string, unknown> : null,
  }
}

function addMapEventChanges(
  summary: PageEventSummary,
  pageId: string,
  event: Y.YMapEvent<unknown>,
): void {
  event.changes.keys.forEach((_change, field) => {
    summary.changes.push({ pageId, field, isLocal: false })
  })
}

function addRootPageEventChanges(
  summary: PageEventSummary,
  event: Y.YMapEvent<unknown>,
): void {
  event.changes.keys.forEach((change, pageId) => {
    summary.affectedPageIds.add(pageId)
    summary.changes.push({
      pageId,
      field: change.action === 'delete' ? '__deleted' : '__created',
      isLocal: false,
    })
  })
}

function addNestedPageEventChanges(
  summary: PageEventSummary,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: Y.YEvent<any>,
  pageId: string,
): void {
  summary.affectedPageIds.add(pageId)
  if (event.target instanceof Y.Map && event.path.length < 2) {
    addMapEventChanges(summary, pageId, event as Y.YMapEvent<unknown>)
    return
  }
  if (event.target instanceof Y.Map || event.target instanceof Y.Array) {
    summary.changes.push({ pageId, field: 'elements', isLocal: false })
  }
}

function collectPageEventSummary(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: Y.YEvent<any>[],
  pagesMap: Y.Map<unknown>,
): PageEventSummary {
  const summary: PageEventSummary = {
    affectedPageIds: new Set<string>(),
    changes: [],
    needsFullRefresh: false,
  }

  for (const event of events) {
    if (event.target === pagesMap) {
      addRootPageEventChanges(summary, event as Y.YMapEvent<unknown>)
      continue
    }

    const pageId = typeof event.path[0] === 'string' ? event.path[0] : null
    if (!pageId) {
      summary.needsFullRefresh = true
      continue
    }

    addNestedPageEventChanges(summary, event, pageId)
  }

  return summary
}

function updateAffectedPages(
  prev: Map<string, Slide>,
  affectedPageIds: Set<string>,
  pagesMap: Y.Map<unknown>,
): Map<string, Slide> {
  const next = new Map(prev)
  for (const pageId of affectedPageIds) {
    if (!pagesMap.has(pageId)) {
      next.delete(pageId)
      continue
    }
    const value = pagesMap.get(pageId)
    if (value instanceof Y.Map) {
      next.set(pageId, yPageToSlide(pageId, value))
    }
  }
  return next
}

function migrateAllPages(pagesMap: Y.Map<unknown>): void {
  pagesMap.forEach((value) => {
    if (value instanceof Y.Map) {
      migrateElementsToYMap(value as Y.Map<unknown>)
    }
  })
}

function runObserverSafely(label: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.error(`[TabSlide Collab] ${label} error:`, err)
  }
}

function notifyRemoteChanges(
  callbacksRef: MutableRefObject<Set<(changes: PageChange[]) => void>>,
  changes: PageChange[],
): void {
  callbacksRef.current.forEach(cb => {
    try { cb(changes) } catch { /* 忽略 */ }
  })
}

function handlePagesObserverEvents(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: Y.YEvent<any>[]
  pagesMap: Y.Map<unknown>
  refreshPages: () => void
  setPagesSnapshot: Dispatch<SetStateAction<Map<string, Slide>>>
  callbacksRef: MutableRefObject<Set<(changes: PageChange[]) => void>>
}): void {
  const summary = collectPageEventSummary(params.events, params.pagesMap)
  if (summary.needsFullRefresh) {
    params.refreshPages()
    return
  }
  if (summary.affectedPageIds.size > 0) {
    params.setPagesSnapshot(prev => updateAffectedPages(prev, summary.affectedPageIds, params.pagesMap))
  }
  if (summary.changes.length > 0) {
    notifyRemoteChanges(params.callbacksRef, summary.changes)
  }
}

export function useSlideYDocSnapshot(
  ydoc: Y.Doc | null,
  isFallback: boolean,
): {
  pagesSnapshot: Map<string, Slide>
  pageOrder: string[]
  version: number
  metaTheme: Record<string, unknown> | null
  metaName: string | null
  metaFontMeta: Record<string, unknown> | null
  refreshFnsRef: MutableRefObject<SlideRefreshFns | null>
  onRemoteChange: (callback: (changes: PageChange[]) => void) => () => void
} {
  const [pagesSnapshot, setPagesSnapshot] = useState<Map<string, Slide>>(new Map())
  const [pageOrder, setPageOrder] = useState<string[]>([])
  const [meta, setMeta] = useState<MetaSnapshot>({
    version: 0,
    metaTheme: null,
    metaName: null,
    metaFontMeta: null,
  })
  const remoteChangeCallbacksRef = useRef<Set<(changes: PageChange[]) => void>>(new Set())
  const refreshFnsRef = useRef<SlideRefreshFns | null>(null)

  useEffect(() => {
    if (!ydoc || isFallback) return

    const pagesMap = getPagesMap(ydoc)
    const pageOrderArr = getPageOrderArray(ydoc)
    const pageOrderMap = getPageOrderMap(ydoc)
    const metaMap = getMetaMap(ydoc)

    const refreshPages = () => setPagesSnapshot(readPagesSnapshot(pagesMap))
    const refreshPageOrder = () => setPageOrder(readPageOrder(ydoc, pageOrderArr))
    const refreshMeta = () => setMeta(readMetaSnapshot(metaMap))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pagesObserver = (events: Y.YEvent<any>[], txn: Y.Transaction) => {
      if (txn.origin === 'local') return
      runObserverSafely('pagesObserver', () => {
        handlePagesObserverEvents({ events, pagesMap, refreshPages, setPagesSnapshot, callbacksRef: remoteChangeCallbacksRef })
      })
    }

    const pageOrderObserver = (_event: Y.YArrayEvent<string>, txn: Y.Transaction) => {
      runObserverSafely('pageOrderObserver', () => {
        if (txn.origin !== 'local') refreshPageOrder()
      })
    }

    const pageOrderMapObserver = (_event: Y.YMapEvent<string>, txn: Y.Transaction) => {
      runObserverSafely('pageOrderMapObserver', () => {
        if (txn.origin !== 'local') refreshPageOrder()
      })
    }

    const metaObserver = (_event: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
      runObserverSafely('metaObserver', () => {
        if (txn.origin !== 'local') refreshMeta()
      })
    }

    pagesMap.observeDeep(pagesObserver)
    pageOrderArr.observe(pageOrderObserver)
    pageOrderMap.observe(pageOrderMapObserver)
    metaMap.observe(metaObserver)

    refreshPages()
    refreshPageOrder()
    refreshMeta()
    refreshFnsRef.current = { refreshPages, refreshPageOrder, refreshMeta }

    ydoc.transact(() => migrateAllPages(pagesMap), 'local')

    return () => {
      pagesMap.unobserveDeep(pagesObserver)
      pageOrderArr.unobserve(pageOrderObserver)
      pageOrderMap.unobserve(pageOrderMapObserver)
      metaMap.unobserve(metaObserver)
      refreshFnsRef.current = null
    }
  }, [ydoc, isFallback])

  const onRemoteChange = useCallback(
    (callback: (changes: PageChange[]) => void) => {
      remoteChangeCallbacksRef.current.add(callback)
      return () => {
        remoteChangeCallbacksRef.current.delete(callback)
      }
    },
    [],
  )

  return {
    pagesSnapshot,
    pageOrder,
    version: meta.version,
    metaTheme: meta.metaTheme,
    metaName: meta.metaName,
    metaFontMeta: meta.metaFontMeta,
    refreshFnsRef,
    onRemoteChange,
  }
}
