import { Schema } from '@tiptap/pm/model'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { isImageNodeEventTarget, isImageNodeSelection } from './image-selection-menu'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: { src: { default: null } },
    },
  },
})

describe('isImageNodeSelection', () => {
  it('只让图片节点选区进入图片操作栏', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text('前'),
        schema.nodes.image.create({ src: 'https://example.com/image.png' }),
        schema.text('后'),
      ]),
    ])

    expect(isImageNodeSelection(NodeSelection.create(doc, 2))).toBe(true)
    expect(isImageNodeSelection(TextSelection.create(doc, 1, 2))).toBe(false)
  })
})

describe('isImageNodeEventTarget', () => {
  it('识别图片节点内部的点击目标', () => {
    document.body.innerHTML = `
      <span class="react-renderer node-image tabdoc-comment-highlight">
        <span class="tabdoc-image-node-view"><img alt="image.png" /></span>
      </span>
      <span class="tabdoc-comment-block-badge">评论</span>
    `

    expect(isImageNodeEventTarget(document.querySelector('img'))).toBe(true)
    expect(isImageNodeEventTarget(document.querySelector('.tabdoc-comment-block-badge'))).toBe(false)
  })
})
