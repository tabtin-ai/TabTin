import { describe, expect, it } from 'vitest'

import { removeLeadingImportedTitleBlock, shouldApplyImportedTitle } from './import-title'
import { UNTITLED_DOCUMENT_FALLBACK } from './titleSync'

describe('shouldApplyImportedTitle', () => {
  it('only fills the document title when the current document is untitled', () => {
    expect(shouldApplyImportedTitle('', 'Imported title')).toBe(true)
    expect(shouldApplyImportedTitle(UNTITLED_DOCUMENT_FALLBACK, 'Imported title')).toBe(true)
    expect(shouldApplyImportedTitle('Existing title', 'Imported title')).toBe(false)
    expect(shouldApplyImportedTitle(UNTITLED_DOCUMENT_FALLBACK, '')).toBe(false)
  })
})

describe('removeLeadingImportedTitleBlock', () => {
  it('removes the first heading when it duplicates the imported title', () => {
    const titleNode = {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'H1 Document title style / 一级标题' }],
    }
    const bodyNode = {
      type: 'paragraph',
      content: [{ type: 'text', text: '正文' }],
    }

    expect(removeLeadingImportedTitleBlock(
      [titleNode, bodyNode],
      'H1 Document title style / 一级标题',
    )).toEqual([bodyNode])
  })

  it('keeps later headings that are real document sections', () => {
    const introNode = {
      type: 'paragraph',
      content: [{ type: 'text', text: '开头' }],
    }
    const sectionNode = {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'H1 Document title style / 一级标题' }],
    }

    expect(removeLeadingImportedTitleBlock(
      [introNode, sectionNode],
      'H1 Document title style / 一级标题',
    )).toEqual([introNode, sectionNode])
  })

  it('does not remove a different first heading', () => {
    const headingNode = {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: '真正的章节标题' }],
    }

    expect(removeLeadingImportedTitleBlock([headingNode], '文档标题')).toEqual([headingNode])
  })

  it('returns an empty body when the imported content only contains the title heading', () => {
    const titleNode = {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: '文档标题' }],
    }

    expect(removeLeadingImportedTitleBlock([titleNode], '文档标题')).toEqual([])
  })

  it('keeps an empty imported content array empty', () => {
    expect(removeLeadingImportedTitleBlock([], '文档标题')).toEqual([])
  })
})
