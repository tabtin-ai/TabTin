import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import { acquireTableUndoRuntime } from '../tableUndoRuntime'

describe('TabData shared undo runtime', () => {
  it('同一 Y.Doc 的多个 surface 共用一份 UndoManager，最后释放才销毁', () => {
    const ydoc = new Y.Doc()
    const first = acquireTableUndoRuntime(ydoc)
    const second = acquireTableUndoRuntime(ydoc)
    const destroySpy = vi.spyOn(first.undoManager, 'destroy')

    expect(second.undoManager).toBe(first.undoManager)

    first.release()
    expect(destroySpy).not.toHaveBeenCalled()

    second.release()
    expect(destroySpy).toHaveBeenCalledTimes(1)
    ydoc.destroy()
  })
})
