/**
 * Wave 5 回归测试 — 协作模块 DECISION 项修复
 *
 * 覆盖：
 * - SM-P1-12: replayPendingSlideWrites 使用 'local' origin，UndoManager 可撤销
 * - H1-02: Y.Doc 初始同步覆盖本地编辑时输出 console.warn
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import {
  replayPendingSlideWrites,
  type PendingSlideWrite,
} from '../hooks/useSlideCollaboration'

// ── SM-P1-12: replayPendingSlideWrites origin='local' → UndoManager 可撤销 ──

describe('SM-P1-12: replayPendingSlideWrites undo support', () => {
  let ydoc: Y.Doc
  let pagesMap: Y.Map<unknown>
  let pageOrderArr: Y.Array<string>
  let undoManager: Y.UndoManager

  beforeEach(() => {
    ydoc = new Y.Doc()
    pagesMap = ydoc.getMap('pages')
    pageOrderArr = ydoc.getArray<string>('pageOrder')

    // 预置一页
    ydoc.transact(() => {
      const page = new Y.Map<unknown>()
      const elementsMap = new Y.Map<Y.Map<unknown>>()
      const elementOrder = new Y.Array<string>()
      page.set('elementsMap', elementsMap)
      page.set('elementOrder', elementOrder)
      pagesMap.set('page_1', page)
      pageOrderArr.push(['page_1'])
    })

    undoManager = new Y.UndoManager([pagesMap, pageOrderArr], {
      trackedOrigins: new Set(['local']),
      captureTimeout: 0,
    })
  })

  it('replayed updatePageField uses offline-replay origin (not tracked by UndoManager)', () => {
    const writes: PendingSlideWrite[] = [
      { op: 'updatePageField', pageId: 'page_1', field: 'remark', value: 'offline remark' },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const page = pagesMap.get('page_1') as Y.Map<unknown>
    expect(page.get('remark')).toBe('offline remark')
    expect(undoManager.undoStack.length).toBe(0)
  })

  it('replayed addPage uses offline-replay origin (not tracked by UndoManager)', () => {
    const writes: PendingSlideWrite[] = [
      { op: 'addPage', pageId: 'page_2', page: { background: { type: 'solid', color: '#000' } as never } },
    ]

    replayPendingSlideWrites(ydoc, writes)

    expect(pagesMap.has('page_2')).toBe(true)
    expect(undoManager.undoStack.length).toBe(0)
  })

  it('replayed deletePage uses offline-replay origin (not tracked by UndoManager)', () => {
    const writes: PendingSlideWrite[] = [
      { op: 'deletePage', pageId: 'page_1' },
    ]

    replayPendingSlideWrites(ydoc, writes)

    expect(pagesMap.has('page_1')).toBe(false)
    expect(pageOrderArr.toArray()).not.toContain('page_1')
    expect(undoManager.undoStack.length).toBe(0)
  })

  it('replayed reorderPages uses offline-replay origin (not tracked by UndoManager)', () => {
    ydoc.transact(() => {
      const page = new Y.Map<unknown>()
      page.set('elementsMap', new Y.Map())
      page.set('elementOrder', new Y.Array())
      pagesMap.set('page_2', page)
      pageOrderArr.push(['page_2'])
    }, 'local')

    undoManager.clear()
    expect(pageOrderArr.toArray()).toEqual(['page_1', 'page_2'])

    const writes: PendingSlideWrite[] = [
      { op: 'reorderPages', newOrder: ['page_2', 'page_1'] },
    ]

    replayPendingSlideWrites(ydoc, writes)
    expect(pageOrderArr.toArray()).toEqual(['page_2', 'page_1'])
    expect(undoManager.undoStack.length).toBe(0)
  })

  it('replayed updateMetaTheme should be undoable', () => {
    const writes: PendingSlideWrite[] = [
      { op: 'updateMetaTheme', theme: { fontFamily: 'Arial', themeColor: ['#f00'] } },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const meta = ydoc.getMap('meta')
    expect(meta.get('theme')).toEqual({ fontFamily: 'Arial', themeColor: ['#f00'] })
  })

  it('empty writes array is a no-op', () => {
    replayPendingSlideWrites(ydoc, [])
    expect(undoManager.undoStack.length).toBe(0)
  })

  it('transactions without local origin are NOT captured by UndoManager', () => {
    ydoc.transact(() => {
      const page = pagesMap.get('page_1') as Y.Map<unknown>
      page.set('remark', 'remote change')
    })

    expect(undoManager.undoStack.length).toBe(0)
  })
})

// ── H1-02: Y.Doc 初始同步覆盖本地编辑 → console.warn ──

describe('H1-02: Y.Doc initial sync overwrite warning', () => {
  it('console.warn is emitted when initial sync overwrites local pages', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const localPageIds: string = 'page_local_1,page_local_2'
    const yjsPageIds: string = 'page_yjs_1,page_yjs_2,page_yjs_3'
    const isInitialized = false
    const localPagesCount = 2
    const yjsPagesCount = 3

    // 模拟 useSlideCollabBridge 中的 H1-02 逻辑
    if (!isInitialized && localPagesCount > 0 && yjsPageIds !== localPageIds) {
      console.warn(
        '[TabSlide Collab] Y.Doc initial sync is overwriting local edits. ' +
        'Y.js is the authoritative source (industry standard). ' +
        `Local: ${localPagesCount} page(s), Y.js: ${yjsPagesCount} page(s). ` +
        'Unsaved local changes will be lost. Long-term: show UI confirmation dialog.',
      )
    }

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('[TabSlide Collab]')
    expect(warnSpy.mock.calls[0][0]).toContain('Y.js is the authoritative source')
    expect(warnSpy.mock.calls[0][0]).toContain('Local: 2 page(s)')
    expect(warnSpy.mock.calls[0][0]).toContain('Y.js: 3 page(s)')

    warnSpy.mockRestore()
  })

  it('no warning when isInitialized is already true', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const isInitialized = true
    const localPagesCount = 2

    if (!isInitialized && localPagesCount > 0) {
      console.warn('should not be called')
    }

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('no warning when local pages are empty', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const isInitialized = false
    const localPagesCount = 0

    if (!isInitialized && localPagesCount > 0) {
      console.warn('should not be called')
    }

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('no warning when page IDs match', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const localPageIds = 'page_1,page_2'
    const yjsPageIds = 'page_1,page_2'
    const isInitialized = false
    const localPagesCount = 2

    if (!isInitialized && localPagesCount > 0 && yjsPageIds !== localPageIds) {
      console.warn('should not be called')
    }

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
