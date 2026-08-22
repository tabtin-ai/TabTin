/**
 * V2 P0 回归测试 — 状态管理模块
 *
 * 覆盖：
 * - E3-01: 离线回放 origin 不应被 UndoManager trackedOrigins 跟踪
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'

// ═══════════════════════════════════════════════════════════════════
// E3-01: 离线回放 origin 不被 UndoManager 跟踪
// ═══════════════════════════════════════════════════════════════════

import { replayPendingSlideWrites } from '../hooks/useSlideCollaboration'
import type { PendingSlideWrite } from '../hooks/useSlideCollaboration'
import { getPagesMap, getPageOrderArray, getMetaMap } from '../collab/ydoc-schema'

describe('E3-01: replayPendingSlideWrites — offline-replay origin', () => {
  it('uses offline-replay origin so UndoManager does not track the transaction', () => {
    const ydoc = new Y.Doc()

    const pagesMap = getPagesMap(ydoc)
    const pageOrderArr = getPageOrderArray(ydoc)

    // 预置一个页面
    ydoc.transact(() => {
      const pageYMap = new Y.Map<unknown>()
      pageYMap.set('background', { type: 'solid', color: '#fff' })
      const elMap = new Y.Map<Y.Map<unknown>>()
      const elOrder = new Y.Array<string>()
      pageYMap.set('elementsMap', elMap)
      pageYMap.set('elementOrder', elOrder)
      pagesMap.set('page_1', pageYMap)
      pageOrderArr.push(['page_1'])
    }, 'local')

    // UndoManager 跟踪 'local' origin
    const um = new Y.UndoManager([pagesMap, pageOrderArr], {
      trackedOrigins: new Set(['local']),
    })
    um.clear()

    // 回放离线写操作
    const writes: PendingSlideWrite[] = [
      {
        op: 'updatePageField',
        pageId: 'page_1',
        field: 'remark',
        value: 'offline note',
      },
    ]
    replayPendingSlideWrites(ydoc, writes)

    // 'offline-replay' 不在 trackedOrigins 中，undo 栈不应增加
    expect(um.undoStack.length).toBe(0)

    // 验证数据确实已写入
    const pm = pagesMap.get('page_1') as Y.Map<unknown>
    expect(pm.get('remark')).toBe('offline note')

    um.destroy()
    ydoc.destroy()
  })

  it('local origin transactions ARE tracked by UndoManager (control test)', () => {
    const ydoc = new Y.Doc()
    const pagesMap = getPagesMap(ydoc)
    const pageOrderArr = getPageOrderArray(ydoc)

    ydoc.transact(() => {
      const pageYMap = new Y.Map<unknown>()
      const elMap = new Y.Map<Y.Map<unknown>>()
      const elOrder = new Y.Array<string>()
      pageYMap.set('elementsMap', elMap)
      pageYMap.set('elementOrder', elOrder)
      pagesMap.set('page_1', pageYMap)
      pageOrderArr.push(['page_1'])
    }, 'local')

    const um = new Y.UndoManager([pagesMap, pageOrderArr], {
      trackedOrigins: new Set(['local']),
    })
    um.clear()

    // 用 'local' origin 直接写 — 应被跟踪
    ydoc.transact(() => {
      const pm = pagesMap.get('page_1') as Y.Map<unknown>
      pm.set('remark', 'tracked note')
    }, 'local')

    expect(um.undoStack.length).toBe(1)
    um.undo()
    const pm = pagesMap.get('page_1') as Y.Map<unknown>
    expect(pm.get('remark')).toBeUndefined()

    um.destroy()
    ydoc.destroy()
  })

  it('replays addPage without polluting undo stack', () => {
    const ydoc = new Y.Doc()
    const pagesMap = getPagesMap(ydoc)
    const pageOrderArr = getPageOrderArray(ydoc)

    const um = new Y.UndoManager([pagesMap, pageOrderArr], {
      trackedOrigins: new Set(['local']),
    })

    const writes: PendingSlideWrite[] = [
      {
        op: 'addPage',
        pageId: 'page_offline',
        page: {
          elements: [],
          background: { type: 'solid' as const, color: '#000' },
        },
      },
    ]
    replayPendingSlideWrites(ydoc, writes)

    expect(um.undoStack.length).toBe(0)
    expect(pagesMap.has('page_offline')).toBe(true)
    expect(pageOrderArr.toArray()).toContain('page_offline')

    um.destroy()
    ydoc.destroy()
  })

  it('replays updateMetaName without polluting undo stack', () => {
    const ydoc = new Y.Doc()
    const pagesMap = getPagesMap(ydoc)
    const pageOrderArr = getPageOrderArray(ydoc)

    const um = new Y.UndoManager([pagesMap, pageOrderArr], {
      trackedOrigins: new Set(['local']),
    })

    const writes: PendingSlideWrite[] = [
      { op: 'updateMetaName', name: 'Offline Title' },
    ]
    replayPendingSlideWrites(ydoc, writes)

    expect(um.undoStack.length).toBe(0)
    const meta = getMetaMap(ydoc)
    expect(meta.get('project_name')).toBe('Offline Title')

    um.destroy()
    ydoc.destroy()
  })

  it('skips replay when writes array is empty', () => {
    const ydoc = new Y.Doc()
    const spy = new Y.UndoManager([getPagesMap(ydoc), getPageOrderArray(ydoc)], {
      trackedOrigins: new Set(['local']),
    })

    replayPendingSlideWrites(ydoc, [])
    expect(spy.undoStack.length).toBe(0)

    spy.destroy()
    ydoc.destroy()
  })
})
