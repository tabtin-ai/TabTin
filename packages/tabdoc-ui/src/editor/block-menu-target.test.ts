import { Schema } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import {
  captureBlockMenuTarget,
  resolveCapturedBlockMenuTarget,
  setBlockMenuTarget,
} from './block-menu-target'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    text: { group: 'inline' },
  },
})

describe('block menu target', () => {
  it('captures and clears the exact node shown beside the handle', () => {
    const first = schema.node('paragraph', null, schema.text('第一段'))
    const second = schema.node('paragraph', null, schema.text('第二段'))
    const doc = schema.node('doc', null, [first, second])
    const handle = document.createElement('div')
    const target = { nodePos: first.nodeSize, node: doc.nodeAt(first.nodeSize)! }

    setBlockMenuTarget(handle, target)

    expect(handle.dataset.blockPos).toBe(String(first.nodeSize))
    expect(captureBlockMenuTarget(handle)).toBe(target)
    expect(resolveCapturedBlockMenuTarget(target, doc)).toBe(first.nodeSize)

    setBlockMenuTarget(handle, null)

    expect(handle.hasAttribute('data-block-pos')).toBe(false)
    expect(captureBlockMenuTarget(handle)).toBeNull()
  })

  it('rejects a position when a different node now occupies it', () => {
    const original = schema.node('paragraph', null, schema.text('原目标'))
    const replacement = schema.node('paragraph', null, schema.text('替换目标'))
    const target = { nodePos: 0, node: original }

    expect(resolveCapturedBlockMenuTarget(target, schema.node('doc', null, [replacement])))
      .toBeNull()
    expect(resolveCapturedBlockMenuTarget({ ...target, nodePos: -1 }, schema.node('doc', null, [original])))
      .toBeNull()
  })
})
