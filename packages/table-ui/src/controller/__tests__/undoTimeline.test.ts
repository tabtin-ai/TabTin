import { describe, it, expect, vi } from 'vitest'
import { createUndoTimeline } from '../undoTimeline'

describe('createUndoTimeline', () => {
  it('push 到 undo 时清空 redo 栈', () => {
    const tl = createUndoTimeline()
    tl.push('backend')
    tl.popUndo()
    expect(tl.peekRedo()).toBe('backend')
    expect(tl.getRedoDepth()).toBe(1)

    tl.push('collab')
    expect(tl.peekUndo()).toBe('collab')
    expect(tl.getRedoDepth()).toBe(0)
    expect(tl.peekRedo()).toBeNull()
  })

  it('popUndo / popRedo 对称推进标记', () => {
    const tl = createUndoTimeline()
    tl.push('backend')
    tl.push('collab')

    expect(tl.popUndo()).toBe('collab')
    expect(tl.peekRedo()).toBe('collab')
    expect(tl.peekUndo()).toBe('backend')

    expect(tl.popUndo()).toBe('backend')
    expect(tl.getUndoDepth()).toBe(0)
    expect(tl.getRedoDepth()).toBe(2)

    expect(tl.popRedo()).toBe('backend')
    expect(tl.peekUndo()).toBe('backend')
    expect(tl.peekRedo()).toBe('collab')
  })

  it('pushBackUndo 在失败后恢复 undo 顶', () => {
    const tl = createUndoTimeline()
    tl.push('backend')
    const source = tl.popUndo()
    expect(source).toBe('backend')
    expect(tl.getUndoDepth()).toBe(0)
    expect(tl.getRedoDepth()).toBe(1)

    tl.pushBackUndo('backend')
    expect(tl.peekUndo()).toBe('backend')
    expect(tl.getRedoDepth()).toBe(0)
  })

  it('pushBackRedo 对称恢复 redo 顶', () => {
    const tl = createUndoTimeline()
    tl.push('collab')
    tl.popUndo()
    const source = tl.popRedo()
    expect(source).toBe('collab')
    expect(tl.getRedoDepth()).toBe(0)

    tl.pushBackRedo('collab')
    expect(tl.peekRedo()).toBe('collab')
    expect(tl.getUndoDepth()).toBe(0)
  })

  it('clearCollabMarks 修剪 undo/redo 中的 collab 标记', () => {
    const tl = createUndoTimeline()
    tl.push('backend')
    tl.push('collab')
    tl.push('backend')
    tl.popUndo() // backend → redo
    // undo: [backend, collab]  redo: [backend]

    tl.clearCollabMarks()
    expect(tl.getUndoDepth()).toBe(1)
    expect(tl.peekUndo()).toBe('backend')
    expect(tl.getRedoDepth()).toBe(1)
    expect(tl.peekRedo()).toBe('backend')
  })

  it('clear 清空两侧栈', () => {
    const tl = createUndoTimeline()
    tl.push('backend')
    tl.push('collab')
    tl.popUndo()
    tl.clear()
    expect(tl.getUndoDepth()).toBe(0)
    expect(tl.getRedoDepth()).toBe(0)
    expect(tl.peekUndo()).toBeNull()
  })

  it('subscribe 在变更时通知', () => {
    const tl = createUndoTimeline()
    const listener = vi.fn()
    const unsub = tl.subscribe(listener)
    tl.push('collab')
    expect(listener).toHaveBeenCalledTimes(1)
    tl.popUndo()
    expect(listener).toHaveBeenCalledTimes(2)
    unsub()
    tl.push('backend')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
