import { describe, expect, it } from 'vitest'

import {
  TABDOC_IMPORT_ACCEPT,
  TABDOC_IMPORT_EXTENSIONS,
  TABDOC_IMPORT_MAX_SIZE_BY_EXTENSION,
  isStructuredTabDocImportExtension,
  isTruncatedFetchResultEnvelope,
  shouldInspectTabDocImportForFetchEnvelope,
} from '../tabdocImportRouting'

describe('tabdocImportRouting', () => {
  it('routes Word formats through structured import', () => {
    expect(isStructuredTabDocImportExtension('doc')).toBe(true)
    expect(isStructuredTabDocImportExtension('DOC')).toBe(true)
    expect(isStructuredTabDocImportExtension('docx')).toBe(true)
  })

  it('keeps markdown, text, PDF, and spreadsheets off the structured import path', () => {
    expect(isStructuredTabDocImportExtension('md')).toBe(false)
    expect(isStructuredTabDocImportExtension('markdown')).toBe(false)
    expect(isStructuredTabDocImportExtension('mark')).toBe(false)
    expect(isStructuredTabDocImportExtension('txt')).toBe(false)
    expect(isStructuredTabDocImportExtension('pdf')).toBe(false)
    expect(isStructuredTabDocImportExtension('pptx')).toBe(false)
    expect(isStructuredTabDocImportExtension('xlsx')).toBe(false)
  })

  it('inspects every text-readable TabDoc format before choosing its import path', () => {
    for (const extension of ['md', 'markdown', 'txt', 'json', 'html', 'htm']) {
      expect(shouldInspectTabDocImportForFetchEnvelope(extension)).toBe(true)
    }
    expect(shouldInspectTabDocImportForFetchEnvelope('HTML')).toBe(true)
    expect(shouldInspectTabDocImportForFetchEnvelope('pdf')).toBe(false)
    expect(shouldInspectTabDocImportForFetchEnvelope('docx')).toBe(false)
    expect(shouldInspectTabDocImportForFetchEnvelope('png')).toBe(false)
  })

  it('exposes text and structured formats in the TabDoc file picker allowlist', () => {
    expect(TABDOC_IMPORT_EXTENSIONS).toEqual([
      'md',
      'markdown',
      'mark',
      'txt',
      'doc',
      'docx',
    ])
    expect(TABDOC_IMPORT_ACCEPT).toBe('.md,.markdown,.mark,.txt,.doc,.docx')
    expect(TABDOC_IMPORT_ACCEPT).not.toContain('.pdf')
    expect(TABDOC_IMPORT_ACCEPT).not.toContain('.pptx')
    expect(TABDOC_IMPORT_ACCEPT).not.toContain('.xlsx')
  })

  it('keeps Word imports on the larger file size limit path', () => {
    expect(TABDOC_IMPORT_MAX_SIZE_BY_EXTENSION.doc).toBe(50 * 1024 * 1024)
    expect(TABDOC_IMPORT_MAX_SIZE_BY_EXTENSION.docx).toBe(50 * 1024 * 1024)
    expect(TABDOC_IMPORT_MAX_SIZE_BY_EXTENSION.pdf).toBeUndefined()
    expect(TABDOC_IMPORT_MAX_SIZE_BY_EXTENSION.pptx).toBeUndefined()
    expect(TABDOC_IMPORT_MAX_SIZE_BY_EXTENSION.xlsx).toBeUndefined()
  })

  it('detects truncated fetch result envelopes saved with a document extension', () => {
    expect(isTruncatedFetchResultEnvelope(JSON.stringify({
      ok: true,
      data: {
        content: 'head [... truncated ...]',
        title: 'Fetched page',
        url: 'https://example.com/large-page',
        wordCount: 3,
        quality: { ok: true },
        fallback_used: 'none',
        truncated: true,
        content_length: 75_356,
        full_content_path: 'C:\\Temp\\tabtin-fetch-results\\fetch-full.txt',
      },
    }))).toBe(true)
  })

  it('does not reject normal HTML or unrelated truncated JSON', () => {
    expect(isTruncatedFetchResultEnvelope('<html><body>完整正文</body></html>')).toBe(false)
    expect(isTruncatedFetchResultEnvelope(JSON.stringify({
      ok: true,
      data: { content: '完整正文', truncated: false },
    }))).toBe(false)
    expect(isTruncatedFetchResultEnvelope(JSON.stringify({
      truncated: true,
      full_content_path: '/tmp/full.txt',
    }))).toBe(false)
  })

  it.each([
    ['title', undefined],
    ['url', undefined],
    ['url', 'file:///tmp/page.html'],
    ['wordCount', undefined],
    ['quality', undefined],
    ['fallback_used', undefined],
    ['content_length', undefined],
    ['content_length', 2],
  ])('requires the platform fetch signature field %s', (field, value) => {
    const data: Record<string, unknown> = {
      content: 'truncated content',
      title: 'Fetched page',
      url: 'https://example.com/large-page',
      wordCount: 2,
      quality: { ok: true },
      fallback_used: 'none',
      truncated: true,
      content_length: 10_000,
      full_content_path: '/tmp/tabtin-fetch-results/fetch-full.txt',
      [field]: value,
    }

    expect(isTruncatedFetchResultEnvelope(JSON.stringify({ ok: true, data }))).toBe(false)
  })
})
