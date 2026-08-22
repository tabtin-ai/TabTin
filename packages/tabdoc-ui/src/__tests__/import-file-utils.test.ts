import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_IMPORT_MAX_BYTES,
  IMAGE_IMPORT_FILE_ACCEPT,
  IMAGE_IMPORT_MAX_BYTES,
  IMPORT_FILE_ACCEPT,
  TEXT_IMPORT_MAX_BYTES,
  buildImportedImageMarkdown,
  getTabDocImportMaxBytes,
  getTabDocImportFileKind,
  isSupportedTabDocImportFile,
  stripTabDocImportExtension,
} from '../editor/import-file-utils'

describe('tabdoc import file utils', () => {
  it('classifies text, document, and image imports separately', () => {
    expect(getTabDocImportFileKind('notes.md')).toBe('text')
    expect(getTabDocImportFileKind('notes.markdown')).toBe('text')
    expect(getTabDocImportFileKind('notes.mark')).toBe('text')
    expect(getTabDocImportFileKind('notes.txt')).toBe('text')
    expect(getTabDocImportFileKind('spec.DOC')).toBe('document')
    expect(getTabDocImportFileKind('spec.DOCX')).toBe('document')
    expect(getTabDocImportFileKind('spec.PDF')).toBe('unsupported')
    expect(getTabDocImportFileKind('data.JSON')).toBe('unsupported')
    expect(getTabDocImportFileKind('page.HTML')).toBe('unsupported')
    expect(getTabDocImportFileKind('image.PNG')).toBe('image')
    expect(getTabDocImportFileKind('photo.JPG')).toBe('image')
    expect(getTabDocImportFileKind('photo.jpeg')).toBe('image')
    expect(getTabDocImportFileKind('photo.webp')).toBe('image')
    expect(getTabDocImportFileKind('cover.bmp')).toBe('image')
    expect(getTabDocImportFileKind('photo.avif')).toBe('image')
    expect(getTabDocImportFileKind('icon.svg')).toBe('image')
    expect(getTabDocImportFileKind('photo.heic')).toBe('image')
    expect(getTabDocImportFileKind('scan.tiff')).toBe('image')
    expect(getTabDocImportFileKind('paste.bin', 'image/png')).toBe('image')
    expect(getTabDocImportFileKind('deck.pptx')).toBe('unsupported')
    expect(getTabDocImportFileKind('sheet.xlsx')).toBe('unsupported')
  })

  it('keeps document and toolbar image pickers on separate accept lists', () => {
    expect(IMPORT_FILE_ACCEPT).toBe('.md,.markdown,.mark,.txt,.doc,.docx')
    expect(IMAGE_IMPORT_FILE_ACCEPT).toBe('image/*')
    expect(isSupportedTabDocImportFile('notes.md')).toBe(true)
    expect(isSupportedTabDocImportFile('notes.mark')).toBe(true)
    expect(isSupportedTabDocImportFile('notes.txt')).toBe(true)
    expect(isSupportedTabDocImportFile('plan.doc')).toBe(true)
    expect(isSupportedTabDocImportFile('plan.docx')).toBe(true)
    expect(isSupportedTabDocImportFile('plan.pdf')).toBe(false)
    expect(isSupportedTabDocImportFile('data.json')).toBe(false)
    expect(isSupportedTabDocImportFile('page.html')).toBe(false)
    expect(isSupportedTabDocImportFile('image.png')).toBe(true)
    expect(isSupportedTabDocImportFile('image.jpg')).toBe(true)
    expect(isSupportedTabDocImportFile('image.webp')).toBe(true)
    expect(isSupportedTabDocImportFile('icon.svg')).toBe(true)
    expect(isSupportedTabDocImportFile('photo.heic')).toBe(true)
    expect(isSupportedTabDocImportFile('paste.bin', 'image/avif')).toBe(true)
    expect(isSupportedTabDocImportFile('deck.pptx')).toBe(false)
    expect(isSupportedTabDocImportFile('sheet.xlsx')).toBe(false)
  })

  it('strips supported import extensions for document titles', () => {
    expect(stripTabDocImportExtension('会议纪要.docx')).toBe('会议纪要')
    expect(stripTabDocImportExtension('会议纪要.doc')).toBe('会议纪要')
    expect(stripTabDocImportExtension('notes.mark')).toBe('notes')
    expect(stripTabDocImportExtension('notes.md')).toBe('notes')
    expect(stripTabDocImportExtension('截图.png')).toBe('截图')
    expect(stripTabDocImportExtension('icon.SVG')).toBe('icon')
    expect(stripTabDocImportExtension('需求说明.PDF')).toBe('需求说明.PDF')
    expect(stripTabDocImportExtension('archive.zip')).toBe('archive.zip')
  })

  it('keeps text, document, and image size limits aligned with their pipelines', () => {
    expect(TEXT_IMPORT_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(DOCUMENT_IMPORT_MAX_BYTES).toBe(50 * 1024 * 1024)
    expect(IMAGE_IMPORT_MAX_BYTES).toBe(20 * 1024 * 1024)
    expect(getTabDocImportMaxBytes('notes.md')).toBe(TEXT_IMPORT_MAX_BYTES)
    expect(getTabDocImportMaxBytes('plan.doc')).toBe(DOCUMENT_IMPORT_MAX_BYTES)
    expect(getTabDocImportMaxBytes('plan.docx')).toBe(DOCUMENT_IMPORT_MAX_BYTES)
    expect(getTabDocImportMaxBytes('image.png')).toBe(IMAGE_IMPORT_MAX_BYTES)
    expect(getTabDocImportMaxBytes('image.jpeg')).toBe(IMAGE_IMPORT_MAX_BYTES)
    expect(getTabDocImportMaxBytes('icon.svg')).toBe(IMAGE_IMPORT_MAX_BYTES)
  })

  it('builds markdown for imported images', () => {
    expect(buildImportedImageMarkdown('截图.png', 'https://cdn.example/a.png')).toBe(
      '![截图](https://cdn.example/a.png)',
    )
    expect(buildImportedImageMarkdown('weird[name].png', 'https://cdn.example/a.png')).toBe(
      '![weirdname](https://cdn.example/a.png)',
    )
  })
})
