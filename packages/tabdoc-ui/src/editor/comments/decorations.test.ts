import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import {
  commentDecorationsPluginKey,
  computeCommentDecorations,
  createCommentDecorationsPlugin,
  COMMENT_HIGHLIGHT_CLASS,
} from './decorations'
import { findCommentThreadsAtPos } from './locate'

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
    image: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: {
        blockId: { default: null },
        src: { default: null },
        alt: { default: null },
      },
      toDOM: node => ['img', node.attrs],
      parseDOM: [{ tag: 'img' }],
    },
    text: { group: 'inline' },
  },
})

describe('computeCommentDecorations + locate', () => {
  it('为 open 文本线程生成高亮，并支持正文→线程定位', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('批注目标文字')),
    ])
    let from = 0
    let to = 0
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return true
      const index = node.text.indexOf('目标')
      if (index >= 0) {
        from = pos + index
        to = from + 2
        return false
      }
      return true
    })

    const state = computeCommentDecorations(doc, [
      {
        id: 't1',
        scope: 'text_range',
        status: 'open',
        anchor_status: 'attached',
        anchor: {
          version: 1,
          block_ids: ['p1'],
          start_offset: 2,
          end_offset: 4,
          selected_text: '目标',
        },
      },
      {
        id: 't-resolved',
        scope: 'text_range',
        status: 'resolved',
        anchor_status: 'attached',
        anchor: {
          version: 1,
          block_ids: ['p1'],
          start_offset: 0,
          end_offset: 2,
          selected_text: '批注',
        },
      },
    ], 't1', { yjsCodec: null })

    expect(state.resolved.has('t1')).toBe(true)
    expect(state.resolved.has('t-resolved')).toBe(false)
    expect(state.decorations.find().some((d) => {
      // Decoration.inline stores attrs differently; localFrom/localTo check
      return d.from === from && d.to === to
    })).toBe(true)

    expect(findCommentThreadsAtPos(state.resolved, from + 1)).toEqual(['t1'])
    expect(COMMENT_HIGHLIGHT_CLASS).toBe('tabdoc-comment-highlight')
  })

  it('失效锚点不生成装饰', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('hello')),
    ])
    const state = computeCommentDecorations(doc, [
      {
        id: 'orphan',
        scope: 'text_range',
        status: 'open',
        anchor_status: 'orphaned',
        anchor: { version: 1, block_ids: ['missing'], selected_text: 'nope' },
      },
    ], null, { yjsCodec: null })
    expect(state.resolved.size).toBe(0)
    expect(state.anchorStatuses.get('orphan')).toBe('detached')
    expect(state.decorations.find()).toHaveLength(0)
  })

  it('图片评论只装饰图片节点而不是所在段落', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(
        { blockId: 'p-image' },
        [
          schema.text('前文'),
          schema.nodes.image.create({ src: 'image.png', alt: 'diagram.png' }),
          schema.text('后文'),
        ],
      ),
    ])
    let imagePos = -1
    doc.descendants((node, pos) => {
      if (node.type.name !== 'image') return true
      imagePos = pos
      return false
    })

    const state = computeCommentDecorations(doc, [{
      id: 'image-thread',
      scope: 'block',
      status: 'open',
      anchor_status: 'attached',
      anchor: {
        version: 1,
        block_ids: ['p-image'],
        block_type: 'image',
        node_offset: imagePos,
        node_size: 1,
        selected_text: '图片：diagram.png',
      },
    }], 'image-thread', { yjsCodec: null })

    expect(state.resolved.get('image-thread')).toMatchObject({
      from: imagePos,
      to: imagePos + 1,
    })
    expect(state.decorations.find().some(decoration => (
      decoration.from === imagePos && decoration.to === imagePos + 1
    ))).toBe(true)
    expect(state.decorations.find().some(decoration => (
      decoration.from === imagePos && decoration.to === imagePos
    ))).toBe(false)
    expect(state.decorations.find().some(decoration => (
      decoration.from === 0 && decoration.to === doc.firstChild?.nodeSize
    ))).toBe(false)
  })

  it('同一事务把图片移动到另一段后评论仍保持关联', () => {
    const image = schema.nodes.image.create({
      blockId: 'image-1',
      src: 'image.png',
      alt: 'diagram.png',
    })
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, [schema.text('前文'), image]),
      schema.nodes.paragraph.create({ blockId: 'p2' }, schema.text('后文')),
    ])
    let imagePos = -1
    doc.descendants((node, pos) => {
      if (node.type.name !== 'image') return true
      imagePos = pos
      return false
    })
    const plugin = createCommentDecorationsPlugin({ resolveOptions: { yjsCodec: null } })
    let editorState = EditorState.create({ doc, plugins: [plugin] })
    editorState = editorState.apply(editorState.tr.setMeta(commentDecorationsPluginKey, {
      type: 'setThreads',
      threads: [{
        id: 'image-thread',
        scope: 'block',
        status: 'open',
        anchor_status: 'attached',
        anchor: {
          version: 1,
          block_ids: ['p1'],
          block_type: 'image',
          node_offset: imagePos,
          node_size: 1,
          node_id: 'image-1',
          selected_text: '图片：diagram.png',
        },
      }],
    }))

    const targetPos = editorState.doc.content.size - 1
    const move = editorState.tr.delete(imagePos, imagePos + 1).insert(targetPos - 1, image)
    editorState = editorState.apply(move)
    const pluginState = commentDecorationsPluginKey.getState(editorState)!
    const resolved = pluginState.resolved.get('image-thread')!

    expect(pluginState.anchorStatuses.get('image-thread')).toBe('attached')
    expect(editorState.doc.nodeAt(resolved.from)?.attrs.blockId).toBe('image-1')
    expect(pluginState.decorations.find().some(decoration => (
      decoration.from === resolved.from && decoration.to === resolved.to
    ))).toBe(true)
  })

  it('同一事务移动段落后文字评论仍跟随原段落', () => {
    const commentedParagraph = schema.nodes.paragraph.create(
      { blockId: 'p1' },
      schema.text('段落中的锚点文字'),
    )
    const doc = schema.nodes.doc.create(null, [
      commentedParagraph,
      schema.nodes.paragraph.create({ blockId: 'p2' }, schema.text('第二段')),
    ])
    const plugin = createCommentDecorationsPlugin({ resolveOptions: { yjsCodec: null } })
    let editorState = EditorState.create({ doc, plugins: [plugin] })
    editorState = editorState.apply(editorState.tr.setMeta(commentDecorationsPluginKey, {
      type: 'setThreads',
      threads: [{
        id: 'text-thread',
        scope: 'text_range',
        status: 'open',
        anchor_status: 'attached',
        anchor: {
          version: 1,
          block_ids: ['p1'],
          start_offset: 5,
          end_offset: 9,
          selected_text: '锚点文字',
        },
      }],
    }))

    const move = editorState.tr.delete(0, commentedParagraph.nodeSize)
    move.insert(move.doc.content.size, commentedParagraph)
    editorState = editorState.apply(move)
    const pluginState = commentDecorationsPluginKey.getState(editorState)!
    const resolved = pluginState.resolved.get('text-thread')!

    expect(pluginState.anchorStatuses.get('text-thread')).toBe('attached')
    expect(editorState.doc.textBetween(resolved.from, resolved.to)).toBe('锚点文字')
    expect(resolved.blockIds).toEqual(['p1'])
  })

  it('原引用删除后把服务端仍为 attached 的线程标为本地失效', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('替代文字')),
    ])
    const state = computeCommentDecorations(doc, [{
      id: 'stale-attached',
      scope: 'text_range',
      status: 'open',
      anchor_status: 'attached',
      anchor: {
        version: 1,
        block_ids: ['p1'],
        start_offset: 0,
        end_offset: 2,
        selected_text: '已删除',
      },
    }], null, { yjsCodec: null })

    expect(state.anchorStatuses.get('stale-attached')).toBe('detached')
    expect(state.resolved.has('stale-attached')).toBe(false)
    expect(state.decorations.find()).toHaveLength(0)
  })

  it('文档事务让文本锚点跟随剩余文字，并在范围删空后失效', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ blockId: 'p1' }, schema.text('开头真实跟随范围结尾')),
    ])
    let from = -1
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return true
      const index = node.text.indexOf('真实跟随范围')
      if (index < 0) return true
      from = pos + index
      return false
    })

    const plugin = createCommentDecorationsPlugin({ resolveOptions: { yjsCodec: null } })
    let editorState = EditorState.create({ doc, plugins: [plugin] })
    const threads = [{
      id: 'follow-range',
      scope: 'text_range' as const,
      status: 'open' as const,
      anchor_status: 'attached' as const,
      anchor: {
        version: 1 as const,
        block_ids: ['p1'],
        start_offset: 2,
        end_offset: 8,
        selected_text: '真实跟随范围',
      },
    }]
    editorState = editorState.apply(editorState.tr.setMeta(commentDecorationsPluginKey, {
      type: 'setThreads',
      threads,
    }))

    editorState = editorState.apply(editorState.tr.delete(from + 2, from + 3))
    let pluginState = commentDecorationsPluginKey.getState(editorState)!
    const range = pluginState.resolved.get('follow-range')!
    expect(editorState.doc.textBetween(range.from, range.to)).toBe('真实随范围')
    expect(pluginState.anchorStatuses.get('follow-range')).toBe('attached')

    editorState = editorState.apply(editorState.tr.delete(range.from, range.to))
    pluginState = commentDecorationsPluginKey.getState(editorState)!
    expect(pluginState.resolved.has('follow-range')).toBe(false)
    expect(pluginState.anchorStatuses.get('follow-range')).toBe('detached')
    expect(pluginState.decorations.find()).toHaveLength(0)
  })
})
