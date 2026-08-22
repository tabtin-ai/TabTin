import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { findTextInDoc, findTextInPlaintext, selectTitleFindMatch } from './doc-find'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    text: { group: 'inline' },
  },
})

function docWithParagraphs(...paragraphs: string[]) {
  return schema.nodes.doc.create(
    null,
    paragraphs.map(text => schema.nodes.paragraph.create(null, schema.text(text))),
  )
}

describe('findTextInDoc', () => {
  it('返回正文关键词的 ProseMirror range', () => {
    const doc = docWithParagraphs('开头文字', '这里有西湖龙井正文')

    const matches = findTextInDoc(doc, '西湖龙井')

    expect(matches).toHaveLength(1)
    expect(doc.textBetween(matches[0].from, matches[0].to)).toBe('西湖龙井')
  })

  it('大小写不敏感', () => {
    const doc = docWithParagraphs('Alpha Beta alpha')

    const matches = findTextInDoc(doc, 'alpha')

    expect(matches).toHaveLength(2)
    expect(matches.map(match => doc.textBetween(match.from, match.to))).toEqual(['Alpha', 'alpha'])
  })

  it('不会跨段落边界误命中', () => {
    const doc = docWithParagraphs('hello', 'world')

    expect(findTextInDoc(doc, 'lowo')).toEqual([])
  })
})

describe('findTextInPlaintext', () => {
  it('匹配文档标题中的关键词', () => {
    const matches = findTextInPlaintext('文档测试', '测试')

    expect(matches).toEqual([{ kind: 'title', start: 2, end: 4 }])
  })

  it('大小写不敏感', () => {
    const matches = findTextInPlaintext('CLI Smoke', 'smoke')

    expect(matches).toEqual([{ kind: 'title', start: 4, end: 9 }])
  })

  it('空标题或空查询返回空数组', () => {
    expect(findTextInPlaintext('', '测试')).toEqual([])
    expect(findTextInPlaintext('文档测试', '   ')).toEqual([])
  })
})

describe('selectTitleFindMatch', () => {
  it('不改变 document.activeElement', () => {
    const searchInput = document.createElement('input')
    const titleInput = document.createElement('input')
    document.body.append(searchInput, titleInput)
    searchInput.focus()

    const activeBefore = document.activeElement
    selectTitleFindMatch(titleInput, { kind: 'title', start: 0, end: 2 })

    expect(document.activeElement).toBe(activeBefore)

    searchInput.remove()
    titleInput.remove()
  })
})
