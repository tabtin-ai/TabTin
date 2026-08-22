import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { isPristineEmptyDocumentBody } from './empty-document-body'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block' },
    hardBreak: { inline: true, group: 'inline' },
    embed: { atom: true, group: 'block' },
  },
})

function paragraph(...content: ProseMirrorNode[]): ProseMirrorNode {
  return schema.node('paragraph', null, content)
}

function documentBody(...content: ProseMirrorNode[]): ProseMirrorNode {
  return schema.node('doc', null, content)
}

describe('isPristineEmptyDocumentBody', () => {
  it('treats the single default empty paragraph as pristine', () => {
    expect(isPristineEmptyDocumentBody(documentBody(paragraph()))).toBe(true)
  })

  it('treats multiple empty paragraphs as non-empty structure', () => {
    expect(isPristineEmptyDocumentBody(documentBody(paragraph(), paragraph()))).toBe(false)
    expect(isPristineEmptyDocumentBody(documentBody(paragraph(), paragraph(), paragraph()))).toBe(false)
  })

  it('treats text, whitespace, and hard breaks as content', () => {
    expect(isPristineEmptyDocumentBody(documentBody(paragraph(schema.text('正文'))))).toBe(false)
    expect(isPristineEmptyDocumentBody(documentBody(paragraph(schema.text(' '))))).toBe(false)
    expect(isPristineEmptyDocumentBody(documentBody(paragraph(schema.node('hardBreak'))))).toBe(false)
  })

  it('treats non-paragraph blocks as authored structure', () => {
    expect(isPristineEmptyDocumentBody(documentBody(schema.node('heading')))).toBe(false)
    expect(isPristineEmptyDocumentBody(documentBody(schema.node('embed')))).toBe(false)
  })
})
