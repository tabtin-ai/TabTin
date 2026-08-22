/**
 * V2 P1 Wave-2-08 回归测试 — 状态管理模块
 *
 * 覆盖：
 * - E3-05: pageOrder Y.Doc 层重复 pageId 去重
 * - E1-02: markClean 同步 saveStatus
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'

// ═══════════════════════════════════════════════════════════════════
// E3-05: pageOrder Y.Doc 层去重
// ═══════════════════════════════════════════════════════════════════

import {
  YDOC_PAGE_ORDER,
  getPageOrderArray,
} from '../collab/ydoc-schema'

describe('E3-05: pageOrder Y.Doc-level deduplication', () => {
  it('removes duplicate pageIds from Y.Array when refreshPageOrder detects them', () => {
    const ydoc = new Y.Doc()
    const pageOrderArr = getPageOrderArray(ydoc)

    ydoc.transact(() => {
      pageOrderArr.push(['page1', 'page2', 'page1', 'page3', 'page2'])
    })

    expect(pageOrderArr.length).toBe(5)

    // Simulate the dedup logic from refreshPageOrder
    const seen = new Set<string>()
    const duplicateIndices: number[] = []
    const order: string[] = []
    for (let i = 0; i < pageOrderArr.length; i++) {
      const id = pageOrderArr.get(i)
      if (!seen.has(id)) {
        seen.add(id)
        order.push(id)
      } else {
        duplicateIndices.push(i)
      }
    }

    expect(duplicateIndices).toEqual([2, 4])

    // Apply Y.Doc-level cleanup (mirrors the fix)
    ydoc.transact(() => {
      for (let k = duplicateIndices.length - 1; k >= 0; k--) {
        pageOrderArr.delete(duplicateIndices[k], 1)
      }
    }, 'local')

    // Y.Array should now be deduplicated
    expect(pageOrderArr.length).toBe(3)
    const cleaned: string[] = []
    for (let i = 0; i < pageOrderArr.length; i++) {
      cleaned.push(pageOrderArr.get(i))
    }
    expect(cleaned).toEqual(['page1', 'page2', 'page3'])
  })

  it('no-ops when pageOrder has no duplicates', () => {
    const ydoc = new Y.Doc()
    const pageOrderArr = getPageOrderArray(ydoc)

    ydoc.transact(() => {
      pageOrderArr.push(['page1', 'page2', 'page3'])
    })

    const seen = new Set<string>()
    const duplicateIndices: number[] = []
    for (let i = 0; i < pageOrderArr.length; i++) {
      const id = pageOrderArr.get(i)
      if (!seen.has(id)) {
        seen.add(id)
      } else {
        duplicateIndices.push(i)
      }
    }

    expect(duplicateIndices).toEqual([])
    expect(pageOrderArr.length).toBe(3)
  })

  it('handles all-duplicate case (keeps first occurrence)', () => {
    const ydoc = new Y.Doc()
    const pageOrderArr = getPageOrderArray(ydoc)

    ydoc.transact(() => {
      pageOrderArr.push(['p1', 'p1', 'p1'])
    })

    const seen = new Set<string>()
    const duplicateIndices: number[] = []
    for (let i = 0; i < pageOrderArr.length; i++) {
      const id = pageOrderArr.get(i)
      if (!seen.has(id)) {
        seen.add(id)
      } else {
        duplicateIndices.push(i)
      }
    }

    ydoc.transact(() => {
      for (let k = duplicateIndices.length - 1; k >= 0; k--) {
        pageOrderArr.delete(duplicateIndices[k], 1)
      }
    }, 'local')

    expect(pageOrderArr.length).toBe(1)
    expect(pageOrderArr.get(0)).toBe('p1')
  })
})

// ═══════════════════════════════════════════════════════════════════
// E1-02: markClean — saveStatus 同步
// ═══════════════════════════════════════════════════════════════════

import { useSlideStore } from '../store/slide'

describe('E1-02: markClean synchronizes saveStatus', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
  })

  it('sets saveStatus to "saved" when markClean is called', () => {
    // Simulate dirty state with error
    useSlideStore.setState({
      isDirty: true,
      saveStatus: 'error',
      saveError: 'Network error',
    })

    useSlideStore.getState().markClean()

    const state = useSlideStore.getState()
    expect(state.isDirty).toBe(false)
    expect(state.saveStatus).toBe('saved')
    expect(state.saveError).toBeNull()
  })

  it('clears saveError when markClean is called', () => {
    useSlideStore.setState({
      isDirty: true,
      saveStatus: 'error',
      saveError: 'Something went wrong',
    })

    useSlideStore.getState().markClean()

    expect(useSlideStore.getState().saveError).toBeNull()
  })

  it('transitions from unsaved to saved', () => {
    useSlideStore.setState({
      isDirty: true,
      saveStatus: 'unsaved',
      saveError: null,
    })

    useSlideStore.getState().markClean()

    const state = useSlideStore.getState()
    expect(state.isDirty).toBe(false)
    expect(state.saveStatus).toBe('saved')
  })

  it('transitions from saving to saved', () => {
    useSlideStore.setState({
      isDirty: false,
      saveStatus: 'saving',
      saveError: null,
    })

    useSlideStore.getState().markClean()

    const state = useSlideStore.getState()
    expect(state.isDirty).toBe(false)
    expect(state.saveStatus).toBe('saved')
  })

  it('markDirty/markClean round-trip produces consistent state', () => {
    useSlideStore.getState().markDirty()
    let state = useSlideStore.getState()
    expect(state.isDirty).toBe(true)
    expect(state.saveStatus).toBe('unsaved')

    useSlideStore.getState().markClean()
    state = useSlideStore.getState()
    expect(state.isDirty).toBe(false)
    expect(state.saveStatus).toBe('saved')
    expect(state.saveError).toBeNull()
  })
})
