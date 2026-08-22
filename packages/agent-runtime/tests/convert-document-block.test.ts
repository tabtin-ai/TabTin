import { describe, expect, it } from 'vitest'
import { convertDocumentBlock } from '../src/providers/proxy-provider.js'
import type { DocumentBlock } from '../src/engine/contracts/conversation.js'

describe('convertDocumentBlock ', () => {
  it('DocumentBlock url → OpenAI file + file_url part', () => {
    const block: DocumentBlock = {
      type: 'document',
      source: { type: 'url', url: 'https://cdn.example.com/a.pdf' },
      title: 'a.pdf',
      mime_type: 'application/pdf',
    }
    expect(convertDocumentBlock(block)).toEqual({
      type: 'file',
      file_url: { url: 'https://cdn.example.com/a.pdf' },
      file_name: 'a.pdf',
    })
  })

  it('无 title 时不带 file_name', () => {
    const block: DocumentBlock = {
      type: 'document',
      source: { type: 'url', url: 'https://cdn.example.com/deck.pptx' },
    }
    expect(convertDocumentBlock(block)).toEqual({
      type: 'file',
      file_url: { url: 'https://cdn.example.com/deck.pptx' },
    })
  })

  it('base64 source → data URL', () => {
    const block: DocumentBlock = {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'AAA',
      },
      title: 'inline.pdf',
    }
    expect(convertDocumentBlock(block)).toEqual({
      type: 'file',
      file_url: { url: 'data:application/pdf;base64,AAA' },
      file_name: 'inline.pdf',
    })
  })
})
