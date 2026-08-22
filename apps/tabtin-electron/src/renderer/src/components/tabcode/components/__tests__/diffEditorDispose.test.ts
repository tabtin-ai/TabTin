import { describe, expect, it, vi } from 'vitest'
import { disposeDiffEditorSafely } from '../disposeDiffEditor'

describe('disposeDiffEditorSafely', () => {
  it('先 setModel(null)，再 dispose TextModel，最后 dispose editor', () => {
    const order: string[] = []
    disposeDiffEditorSafely(
      {
        setModel: () => { order.push('setModel(null)') },
        dispose: () => { order.push('disposeEditor') },
      },
      { dispose: () => { order.push('disposeOriginal') } },
      { dispose: () => { order.push('disposeModified') } },
    )
    expect(order).toEqual([
      'setModel(null)',
      'disposeOriginal',
      'disposeModified',
      'disposeEditor',
    ])
  })

  it('setModel 抛错时仍继续清理 model 与 editor', () => {
    const disposeOriginal = vi.fn()
    const disposeModified = vi.fn()
    const disposeEditor = vi.fn()
    disposeDiffEditorSafely(
      {
        setModel: () => { throw new Error('already broken') },
        dispose: disposeEditor,
      },
      { dispose: disposeOriginal },
      { dispose: disposeModified },
    )
    expect(disposeOriginal).toHaveBeenCalledTimes(1)
    expect(disposeModified).toHaveBeenCalledTimes(1)
    expect(disposeEditor).toHaveBeenCalledTimes(1)
  })
})
