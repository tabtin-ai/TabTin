import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import {
  adjustBlockMoveInsertPos,
  normalizeDragNodePos,
  selectionSpansMultipleBlocks,
} from './global-drag-handle'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    blockquote: {
      group: 'block',
      content: 'block+',
      toDOM: () => ['blockquote', 0],
      parseDOM: [{ tag: 'blockquote' }],
    },
    text: { group: 'inline' },
  },
})

describe('normalizeDragNodePos', () => {
  it('把长段落内部坐标归一化为整段 block 起点', () => {
    const longText = '这是一个很长的段落。'.repeat(80)
    const first = schema.nodes.paragraph.create(null, schema.text('前置段落'))
    const target = schema.nodes.paragraph.create(null, schema.text(longText))
    const doc = schema.nodes.doc.create(null, [first, target])
    const targetStart = first.nodeSize
    const posInsideTargetText = targetStart + Math.floor(longText.length / 2)

    expect(normalizeDragNodePos(posInsideTargetText, doc)).toBe(targetStart)
  })

  it('保留已有顶层 block 起点', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, schema.text('第一段')),
      schema.nodes.paragraph.create(null, schema.text('第二段')),
    ])
    const secondStart = doc.child(0).nodeSize

    expect(normalizeDragNodePos(secondStart, doc)).toBe(secondStart)
  })

  it('嵌套块沿用原插件语义，定位到最内层 block', () => {
    const nestedParagraph = schema.nodes.paragraph.create(null, schema.text('引用里的段落'))
    const quote = schema.nodes.blockquote.create(null, [nestedParagraph])
    const doc = schema.nodes.doc.create(null, [quote])
    const posInsideNestedParagraph = 3

    expect(normalizeDragNodePos(posInsideNestedParagraph, doc)).toBe(1)
  })

  it('同一长段落内部文本选择不算多块选区', () => {
    const longText = '这是一个很长的段落。'.repeat(80)
    const target = schema.nodes.paragraph.create(null, schema.text(longText))
    const doc = schema.nodes.doc.create(null, [target])
    const selectionFromInsideText = Math.floor(longText.length / 3)
    const selectionToInsideText = Math.floor(longText.length / 2)

    expect(selectionSpansMultipleBlocks(selectionFromInsideText, selectionToInsideText, doc)).toBe(false)
  })

  it('跨多个段落文本选择时识别为多块选区', () => {
    const first = schema.nodes.paragraph.create(null, schema.text('第一段'))
    const second = schema.nodes.paragraph.create(null, schema.text('第二段很长很长'))
    const third = schema.nodes.paragraph.create(null, schema.text('第三段'))
    const doc = schema.nodes.doc.create(null, [first, second, third])
    const secondStart = first.nodeSize
    const thirdStart = first.nodeSize + second.nodeSize
    const selectionFromInsideSecond = secondStart + 2
    const selectionToInsideThird = thirdStart + 2

    expect(selectionSpansMultipleBlocks(selectionFromInsideSecond, selectionToInsideThird, doc)).toBe(true)
  })

  it('空选区不隐藏块拖拽手柄', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, schema.text('第一段')),
    ])

    expect(selectionSpansMultipleBlocks(2, 2, doc)).toBe(false)
  })

  it('计算鼠标 fallback 移动块时的插入位置', () => {
    expect(adjustBlockMoveInsertPos(10, 20, 4)).toBe(4)
    expect(adjustBlockMoveInsertPos(10, 20, 30)).toBe(20)
    expect(adjustBlockMoveInsertPos(10, 20, 10)).toBeNull()
    expect(adjustBlockMoveInsertPos(10, 20, 15)).toBeNull()
    expect(adjustBlockMoveInsertPos(10, 20, 20)).toBeNull()
  })
})
