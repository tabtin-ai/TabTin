import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection, NodeSelection } from '@tiptap/pm/state'
import {
  buildCommentAnchorFromSelection,
  enrichCommentAnchorWithNodeId,
  markAnchorDetachedStatus,
  resolveCommentAnchor,
} from './anchor'
import type { CommentYjsCodec } from './yjs-codec'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: { blockId: { default: null } },
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { blockId: { default: null }, level: { default: 1 } },
      toDOM: () => ['h1', 0],
      parseDOM: [{ tag: 'h1' }],
    },
    htmlBlock: {
      group: 'block',
      atom: true,
      attrs: { blockId: { default: null } },
      toDOM: () => ['div', { 'data-html-block': '1' }],
      parseDOM: [{ tag: 'div[data-html-block]' }],
    },
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: {
        blockId: { default: null },
        src: { default: null },
        alt: { default: null },
        title: { default: null },
      },
      toDOM: (node) => ['img', node.attrs],
      parseDOM: [{ tag: 'img' }],
    },
    table: {
      group: 'block',
      content: 'table_row+',
      attrs: { blockId: { default: null } },
      toDOM: () => ['table', ['tbody', 0]],
      parseDOM: [{ tag: 'table' }],
    },
    table_row: {
      content: 'table_cell+',
      toDOM: () => ['tr', 0],
      parseDOM: [{ tag: 'tr' }],
    },
    table_cell: {
      content: 'block+',
      isolating: true,
      toDOM: () => ['td', 0],
      parseDOM: [{ tag: 'td' }],
    },
    text: { group: 'inline' },
  },
})

function makeDoc() {
  return schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('你好世界')),
    schema.nodes.paragraph.create({ blockId: 'p2' }, schema.text('第二段文字')),
    schema.nodes.htmlBlock.create({ blockId: 'html-1' }),
    schema.nodes.paragraph.create(
      { blockId: 'image-paragraph' },
      schema.nodes.image.create({ src: 'https://example.com/diagram.png', alt: 'diagram.png' }),
    ),
    schema.nodes.paragraph.create({ blockId: 'p3' }, schema.text('可匹配上下文的唯一片段XYZ')),
  ])
}

function findTextRange(doc: ReturnType<typeof makeDoc>, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null
  doc.descendants((node, pos) => {
    if (found || !node.isText || !node.text) return true
    const index = node.text.indexOf(needle)
    if (index >= 0) {
      found = { from: pos + index, to: pos + index + needle.length }
      return false
    }
    return true
  })
  if (!found) throw new Error(`text not found: ${needle}`)
  return found
}

function editorWithTextSelection(needle: string) {
  const doc = makeDoc()
  const range = findTextRange(doc, needle)
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, range.from, range.to),
  })
  return { state, doc, range }
}

describe('buildCommentAnchorFromSelection', () => {
  it('单块文字选区记录 block_ids 与 offset', () => {
    const { state } = editorWithTextSelection('世界')
    const built = buildCommentAnchorFromSelection({ state }, { yjsCodec: null })
    expect(built?.scope).toBe('text_range')
    expect(built?.selected_text).toBe('世界')
    expect(built?.anchor.block_ids).toEqual(['p1'])
    expect(typeof built?.anchor.start_offset).toBe('number')
    expect(typeof built?.anchor.end_offset).toBe('number')
  })

  it('跨块选区保留有序 block_ids', () => {
    const doc = makeDoc()
    const endOfP1 = findTextRange(doc, '世界').to
    const startOfP2 = findTextRange(doc, '第二').from
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, endOfP1 - 2, startOfP2 + 2),
    })
    const built = buildCommentAnchorFromSelection({ state }, { yjsCodec: null })
    expect(built?.anchor.block_ids).toEqual(['p1', 'p2'])
  })

  it('整块 htmlBlock 使用 scope=block', () => {
    const doc = makeDoc()
    let htmlPos = -1
    doc.descendants((node, pos) => {
      if (node.type.name === 'htmlBlock') {
        htmlPos = pos
        return false
      }
      return true
    })
    const state = EditorState.create({
      doc,
      selection: NodeSelection.create(doc, htmlPos),
    })
    const built = buildCommentAnchorFromSelection({ state }, { yjsCodec: null })
    expect(built?.scope).toBe('block')
    expect(built?.anchor.block_ids).toEqual(['html-1'])
    expect(built?.anchor.block_type).toBe('htmlBlock')
  })

  it('行内图片节点选择生成带图片引用内容的块锚点', () => {
    const doc = makeDoc()
    let imagePos = -1
    doc.descendants((node, pos) => {
      if (node.type.name === 'image') {
        imagePos = pos
        return false
      }
      return true
    })
    const state = EditorState.create({
      doc,
      selection: NodeSelection.create(doc, imagePos),
    })

    const built = buildCommentAnchorFromSelection({ state }, { yjsCodec: null })

    expect(built).toMatchObject({
      scope: 'block',
      selected_text: '图片：diagram.png',
      anchor: {
        block_ids: ['image-paragraph'],
        block_type: 'image',
        selected_text: '图片：diagram.png',
      },
    })
  })

  it('图片与文字同段时评论锚点只覆盖图片节点', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(
        { blockId: 'mixed-image-paragraph' },
        [
          schema.text('图片前文字'),
          schema.nodes.image.create({
            src: 'https://example.com/diagram.png',
            alt: 'diagram.png',
          }),
          schema.text('图片后文字'),
        ],
      ),
    ])
    let imagePos = -1
    doc.descendants((node, pos) => {
      if (node.type.name !== 'image') return true
      imagePos = pos
      return false
    })
    const state = EditorState.create({
      doc,
      selection: NodeSelection.create(doc, imagePos),
    })

    const built = buildCommentAnchorFromSelection({ state }, { yjsCodec: null })!
    const resolved = resolveCommentAnchor(doc, built.anchor, { yjsCodec: null })

    expect(resolved).toMatchObject({ from: imagePos, to: imagePos + 1 })
    expect(built.anchor).toMatchObject({ node_offset: imagePos, node_size: 1 })
    expect(built.selected_text).toBe('图片：diagram.png')

    const legacyAnchor = { ...built.anchor }
    delete legacyAnchor.node_offset
    delete legacyAnchor.node_size
    expect(resolveCommentAnchor(doc, legacyAnchor, { yjsCodec: null })).toMatchObject({
      from: imagePos,
      to: imagePos + 1,
    })
  })

  it('图片节点删除后精确锚点失效', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(
        { blockId: 'mixed-image-paragraph' },
        [
          schema.text('图片前文字'),
          schema.nodes.image.create({
            src: 'https://example.com/diagram.png',
            alt: 'diagram.png',
          }),
          schema.text('图片后文字'),
        ],
      ),
    ])
    let imagePos = -1
    doc.descendants((node, pos) => {
      if (node.type.name !== 'image') return true
      imagePos = pos
      return false
    })
    const state = EditorState.create({
      doc,
      selection: NodeSelection.create(doc, imagePos),
    })
    const built = buildCommentAnchorFromSelection({ state }, { yjsCodec: null })!
    const withoutImage = state.tr.delete(imagePos, imagePos + 1).doc

    expect(resolveCommentAnchor(withoutImage, built.anchor, { yjsCodec: null })).toBeNull()
  })

  it('图片跨段移动后评论锚点跟随图片节点', () => {
    const image = schema.nodes.image.create({
      blockId: 'image-1',
      src: 'https://example.com/diagram.png',
      alt: 'diagram.png',
    })
    const originalDoc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, [schema.text('前文'), image]),
      schema.nodes.paragraph.create({ blockId: 'p2' }, schema.text('后文')),
    ])
    let originalImagePos = -1
    originalDoc.descendants((node, pos) => {
      if (node.type.name !== 'image') return true
      originalImagePos = pos
      return false
    })
    const state = EditorState.create({
      doc: originalDoc,
      selection: NodeSelection.create(originalDoc, originalImagePos),
    })
    const built = buildCommentAnchorFromSelection({ state }, { yjsCodec: null })!
    const movedDoc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('前文')),
      schema.nodes.paragraph.create({ blockId: 'p2' }, [schema.text('后文'), image]),
    ])
    let movedImagePos = -1
    movedDoc.descendants((node, pos) => {
      if (node.type.name !== 'image') return true
      movedImagePos = pos
      return false
    })

    expect(built.anchor).toMatchObject({ node_id: 'image-1' })
    expect(resolveCommentAnchor(movedDoc, built.anchor, { yjsCodec: null })).toMatchObject({
      from: movedImagePos,
      to: movedImagePos + 1,
    })

    const legacyAnchor = { ...built.anchor }
    delete legacyAnchor.node_id
    const enriched = enrichCommentAnchorWithNodeId(originalDoc, legacyAnchor, { yjsCodec: null })
    expect(enriched.node_id).toBe('image-1')
    expect(resolveCommentAnchor(movedDoc, enriched, { yjsCodec: null })).toMatchObject({
      from: movedImagePos,
      to: movedImagePos + 1,
    })
  })

  it('旧图片评论在同名图片重复出现时仍从原段落补齐稳定节点标识', () => {
    const targetImage = schema.nodes.image.create({
      blockId: 'target-image',
      src: 'https://example.com/first/image.png',
      alt: 'image.png',
    })
    const duplicateImage = schema.nodes.image.create({
      blockId: 'duplicate-image',
      src: 'https://example.com/second/image.png',
      alt: 'image.png',
    })
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, targetImage),
      schema.nodes.paragraph.create({ blockId: 'p2' }, duplicateImage),
    ])
    const state = EditorState.create({
      doc,
      selection: NodeSelection.create(doc, 1),
    })
    const built = buildCommentAnchorFromSelection({ state }, { yjsCodec: null })!
    const legacyAnchor = { ...built.anchor }
    delete legacyAnchor.node_id

    expect(enrichCommentAnchorWithNodeId(doc, legacyAnchor, { yjsCodec: null })).toMatchObject({
      node_id: 'target-image',
      block_ids: ['p1'],
      selected_text: '图片：image.png',
    })
  })

  it('段落重排后文字评论仍跟随原段落', () => {
    const originalDoc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('第一段锚点文字')),
      schema.nodes.paragraph.create({ blockId: 'p2' }, schema.text('第二段')),
    ])
    const range = findTextRange(originalDoc, '锚点文字')
    const state = EditorState.create({
      doc: originalDoc,
      selection: TextSelection.create(originalDoc, range.from, range.to),
    })
    const built = buildCommentAnchorFromSelection({ state }, { yjsCodec: null })!
    const movedDoc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p2' }, schema.text('第二段')),
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('第一段锚点文字')),
    ])
    const movedRange = findTextRange(movedDoc, '锚点文字')

    expect(resolveCommentAnchor(movedDoc, built.anchor, { yjsCodec: null })).toMatchObject({
      from: movedRange.from,
      to: movedRange.to,
    })
  })

  it('表格重排后整表评论仍跟随原表格', () => {
    const createTable = () => schema.nodes.table.create(
      { blockId: 'table-1' },
      schema.nodes.table_row.create(
        null,
        schema.nodes.table_cell.create(
          null,
          schema.nodes.paragraph.create({ blockId: 'cell-p1' }, schema.text('表格内容')),
        ),
      ),
    )
    const originalDoc = schema.nodes.doc.create(null, [
      createTable(),
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('表格后段落')),
    ])
    const state = EditorState.create({
      doc: originalDoc,
      selection: NodeSelection.create(originalDoc, 0),
    })
    const built = buildCommentAnchorFromSelection({ state }, { yjsCodec: null })!
    const movedDoc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('表格后段落')),
      createTable(),
    ])
    let movedTablePos = -1
    movedDoc.descendants((node, pos) => {
      if (node.type.name !== 'table') return true
      movedTablePos = pos
      return false
    })

    expect(resolveCommentAnchor(movedDoc, built.anchor, { yjsCodec: null })).toMatchObject({
      from: movedTablePos,
      to: movedTablePos + movedDoc.nodeAt(movedTablePos)!.nodeSize,
    })
  })

  it('优先写入 Yjs 相对位置（注入 codec）', () => {
    const codec: CommentYjsCodec = {
      encode: (pos) => `enc:${pos}`,
      decode: (encoded) => Number(String(encoded).replace('enc:', '')),
    }
    const { state, range } = editorWithTextSelection('你好')
    const built = buildCommentAnchorFromSelection({ state }, { yjsCodec: codec })
    expect(built?.anchor.yjs_from).toBe(`enc:${range.from}`)
    expect(built?.anchor.yjs_to).toBe(`enc:${range.to}`)
  })
})

describe('resolveCommentAnchor', () => {
  it('Yjs 优先于 block_offset', () => {
    const doc = makeDoc()
    const expectedRange = findTextRange(doc, '你好')
    const codec: CommentYjsCodec = {
      encode: () => null,
      decode: (encoded) => (
        encoded === 'A'
          ? expectedRange.from
          : encoded === 'B'
            ? expectedRange.to
            : null
      ),
    }
    const state = EditorState.create({ doc })
    const resolved = resolveCommentAnchor(
      doc,
      {
        version: 1,
        yjs_from: 'A',
        yjs_to: 'B',
        block_ids: ['missing'],
        selected_text: '你好',
      },
      { yjsCodec: codec, state },
    )
    expect(resolved).toMatchObject({ ...expectedRange, strategy: 'yjs' })
  })

  it('Yjs 失败时回退 blockId/offset', () => {
    const { state, doc } = editorWithTextSelection('你好')
    const built = buildCommentAnchorFromSelection({ state }, { yjsCodec: null })!
    const resolved = resolveCommentAnchor(doc, built.anchor, { yjsCodec: null })
    expect(resolved?.strategy).toBe('block_offset')
    expect(doc.textBetween(resolved!.from, resolved!.to)).toBe(built.selected_text)
  })

  it('block 删除后上下文可唯一匹配则 context，否则 detached', () => {
    const doc = makeDoc()
    const selected = '可匹配上下文的唯一片段XYZ'
    const matches = (() => {
      // textContent 不含结构，改用 find via resolve path
      return resolveCommentAnchor(
        doc,
        {
          version: 1,
          block_ids: ['gone'],
          selected_text: selected,
          prefix_text: '',
          suffix_text: '',
        },
        { yjsCodec: null },
      )
    })()
    expect(matches?.strategy).toBe('context')
    expect(markAnchorDetachedStatus(matches)).toBe('attached')

    const detached = resolveCommentAnchor(
      doc,
      {
        version: 1,
        block_ids: ['gone'],
        selected_text: '第二段文字',
        // 文中有「第二段文字」但若再造歧义：同文出现两次时无上下文应失败
      },
      { yjsCodec: null },
    )
    // 唯一匹配仍可通过 context
    expect(detached?.strategy).toBe('context')

    const reallyDetached = resolveCommentAnchor(
      doc,
      { version: 1, block_ids: ['gone'], selected_text: '不存在的话' },
      { yjsCodec: null },
    )
    expect(reallyDetached).toBeNull()
    expect(markAnchorDetachedStatus(reallyDetached)).toBe('detached')
  })

  it('跨块 block_offset 在中间块删除后失效', () => {
    const doc = makeDoc()
    const resolved = resolveCommentAnchor(
      doc,
      {
        version: 1,
        block_ids: ['p1', 'missing', 'p2'],
        start_offset: 0,
        end_offset: 2,
      },
      { yjsCodec: null },
    )
    expect(resolved).toBeNull()
  })

  it('删除锚点前方文字后不高亮旧偏移，而是重新找到原引用', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('世界')),
    ])
    const resolved = resolveCommentAnchor(doc, {
      version: 1,
      block_ids: ['p1'],
      start_offset: 2,
      end_offset: 4,
      selected_text: '世界',
    }, { yjsCodec: null })

    expect(resolved?.strategy).toBe('context')
    expect(doc.textBetween(resolved!.from, resolved!.to)).toBe('世界')
  })

  it('原引用已删除时拒绝把相邻文字当成锚点', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('你好旁边')),
    ])
    const resolved = resolveCommentAnchor(doc, {
      version: 1,
      block_ids: ['p1'],
      start_offset: 2,
      end_offset: 4,
      selected_text: '世界',
    }, { yjsCodec: null })

    expect(resolved).toBeNull()
  })

  it('Yjs 映射范围仍非空时跟随局部删除后的剩余文字', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('前缀锚词后缀')),
    ])
    const remainingRange = findTextRange(doc, '锚词')
    const codec: CommentYjsCodec = {
      encode: () => null,
      decode: (encoded) => encoded === 'A' ? remainingRange.from : remainingRange.to,
    }
    const state = EditorState.create({ doc })

    const resolved = resolveCommentAnchor(doc, {
      version: 1,
      yjs_from: 'A',
      yjs_to: 'B',
      block_ids: ['p1'],
      start_offset: 2,
      end_offset: 5,
      selected_text: '锚点词',
    }, { yjsCodec: codec, state })

    expect(resolved?.strategy).toBe('yjs')
    expect(doc.textBetween(resolved!.from, resolved!.to)).toBe('锚词')
  })

  it('Yjs 映射范围收缩为空时判定锚点失效', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('前缀后缀')),
    ])
    const collapsedPos = findTextRange(doc, '后缀').from
    const codec: CommentYjsCodec = {
      encode: () => null,
      decode: () => collapsedPos,
    }
    const state = EditorState.create({ doc })

    const resolved = resolveCommentAnchor(doc, {
      version: 1,
      yjs_from: 'A',
      yjs_to: 'B',
      block_ids: ['p1'],
      start_offset: 2,
      end_offset: 5,
      selected_text: '锚点词',
    }, { yjsCodec: codec, state })

    expect(resolved).toBeNull()
  })
})
